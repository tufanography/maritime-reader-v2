import { supabase } from '../supabase';
import type { Article } from './types';
import type { ArticleRepository } from './ArticleRepository';
import { ARTICLE_PAGE_LIMIT } from '../config';

// The Supabase project caps PostgREST responses at 1,000 rows (proven
// 2026-05-31: listVisible(4000) returned exactly 1000). To build more than
// 1,000 article pages we must page the fetch in 1,000-row windows via
// .range() and accumulate. PAGE_FETCH_CHUNK is that window.
// 2026-06-05: dropped 1000 -> 500. Under Nano Disk-IO saturation a single
// 1000-row keyset query exceeded statement_timeout mid-build (57014, killed
// the article getStaticPaths after reaching 2026-05-15). Halving the window
// halves each query's work so it clears the timeout even when the DB is
// busy; it doubles the query count but each is far likelier to individually
// succeed. Must stay <= 1000 (PostgREST response cap).
const PAGE_FETCH_CHUNK = 500;

// Build-time memo of the full visible read. The static build asks for the full
// visible set several times (article pages, sitemap, pagination, count) — on the
// Nano compute each full read burns Disk-IO burst budget, so we read it ONCE per
// build process and serve every caller from this in-memory copy. Keyed by the
// limit requested (the build uses one large limit everywhere → one entry). A
// fresh build process starts with this null; it is NEVER used at runtime (the
// deployed site is static, no DB).
let _visibleMemo: { limit: number; rows: Article[] } | null = null;
let _feedMemo: Article[] | null = null;  // listVisible minus inferred-date rows (homepage feed), computed once
let _countMemo: number | null = null; // visible total, computed once per build (see countVisible)

// Build resilience. The Supabase connection from the build machine has
// shown INTERMITTENT upstream timeouts this session (countVisible failing
// with an EMPTY error message — it killed a whole static build at
// page/[n] getStaticPaths). A single transient timeout must not fail the
// entire daily build. Retry transient errors with exponential backoff;
// surface the empty-message case explicitly so future failures are legible
// (the previous `${error.message}` rendered a useless "countVisible:").
async function withRetry<T extends { error: unknown }>(
  label: string,
  fn: () => PromiseLike<T>,
  tries = 6,
): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < tries; i++) {
    const r = await fn();
    if (!r.error) return r;
    last = r;
    // 2026-06-05: 4->6 tries, base 300ms->500ms. A statement_timeout under
    // Nano saturation can persist for several seconds; the old ~2.1s total
    // backoff exhausted before the spike passed. 500*2^i = 0.5/1/2/4/8s
    // (~15.5s total) rides out a multi-second saturation window.
    if (i < tries - 1) await new Promise((res) => setTimeout(res, 500 * 2 ** i));
  }
  return last as T;
}

// Render a Supabase error that may carry an empty `.message` (the timeout
// signature) into something diagnosable.
function errText(e: { message?: string; code?: string; details?: string } | null | undefined): string {
  if (!e) return '(no error object)';
  return e.message?.trim()
    ? `${e.message}${e.code ? ` [${e.code}]` : ''}`
    : `(empty message — likely upstream/network timeout)${e.code ? ` [${e.code}]` : ''}${e.details ? ` ${e.details}` : ''}`;
}

type Row = {
  id: string;
  title: string;
  url: string;
  raw_excerpt: string | null;
  published_at: string | null;
  published_at_source: string | null;
  document_type: string | null;
  segments: string[] | null;
  semantic_themes: string[] | null;
  keywords: string[] | null;
  image_url: string | null;
  sources: { name: string } | { name: string }[] | null;
};

function sourceName(r: Row): string | null {
  if (!r.sources) return null;
  if (Array.isArray(r.sources)) return r.sources[0]?.name ?? null;
  return r.sources.name ?? null;
}

function toArticle(r: Row): Article {
  return {
    id: r.id,
    title: r.title,
    url: r.url,
    excerpt: r.raw_excerpt,
    publishedAt: r.published_at,
    publishedAtSource: r.published_at_source,
    sourceName: sourceName(r),
    documentType: r.document_type,
    segments: r.segments ?? [],
    themes: r.semantic_themes ?? [],
    keywords: r.keywords ?? [],
    imageUrl: r.image_url,
  };
}

const SELECT =
  'id, title, url, raw_excerpt, published_at, published_at_source, document_type, segments, semantic_themes, keywords, image_url, sources(name)';

// Shared visibility predicate — kept in one place so every list query is
// consistent. If we ever add a new "list by X" method, it goes through
// here too.
//
// 2026-05-31: aligned with v1's lib/v3/articles-query.ts predicate
// `content_quality.is.null,content_quality.in.(visible,pending)` — i.e.
// admit a row UNLESS it's been explicitly hidden. The previous v2-only
// `eq('content_quality','visible')` was stricter than v1 by 3,604 rows
// (≈3,589 pending + 15 null), which the user noticed when comparing
// the homepage count to maritimereader.com's "~49.5k" badge. Pending
// rows are real articles waiting on Phase 3 AI enrichment; null is the
// legacy state from before content_quality existed — both stay visible.
function baseVisible() {
  return supabase
    .from('articles')
    .select(SELECT)
    .or('content_quality.is.null,content_quality.in.(visible,pending)')
    .not('published_at', 'is', null)
    .lte('published_at', new Date().toISOString());
}

export class SupabaseArticleRepository implements ArticleRepository {
  async listVisible(limit: number): Promise<Article[]> {
    // Memoized: serve from the one-per-process full read when possible (see
    // _visibleMemo). The build calls this many times with the same large limit
    // → one DB read, the rest are in-memory slices (minimises Nano Disk-IO).
    if (_visibleMemo && _visibleMemo.limit >= limit) return _visibleMemo.rows.slice(0, limit);
    const rows = await this._readVisibleKeyset(limit);
    _visibleMemo = { limit, rows };
    return rows;
  }

  // The actual keyset read (extracted so listVisible can memoize it).
  // KEYSET (cursor) pagination on (published_at, id) DESC.
  //
  // Replaces the previous offset `.range(off, end)` loop. At deep offsets
  // (~15k+) offset paging forces Postgres to sort the whole table and skip
  // N rows — O(offset) — which exceeded the Nano statement_timeout at full
  // 49.5k archive scale: `listVisible(range 15000-15999): canceling
  // statement due to statement timeout [57014]` killed the sitemap build
  // (measured 2026-06-03). Keyset reads each PAGE_FETCH_CHUNK window by a
  // (published_at, id) cursor — no deep sort/skip, O(page) per fetch — so it
  // stays well under statement_timeout regardless of how deep we page.
  //
  // The (published_at, id) COMPOSITE cursor is required: published_at is NOT
  // unique (multiple articles can share a timestamp), so a single-column
  // cursor would drop or duplicate rows at page boundaries. `baseVisible()`
  // already filters out `published_at IS NULL`, so no null rows reach the
  // cursor (nothing is silently skipped). The timestamp is double-quoted in
  // the .or() so its `:`/`+` chars are taken literally by PostgREST.
  private async _readVisibleKeyset(limit: number): Promise<Article[]> {
    const out: Row[] = [];
    let curTs: string | null = null;
    let curId: string | null = null;
    while (out.length < limit) {
      const pageSize = Math.min(PAGE_FETCH_CHUNK, limit - out.length);
      const r = await withRetry('listVisible', () => {
        let q = baseVisible()
          .order('published_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(pageSize);
        if (curTs !== null) {
          q = q.or(
            `published_at.lt."${curTs}",and(published_at.eq."${curTs}",id.lt.${curId})`,
          );
        }
        return q;
      });
      if (r.error)
        throw new Error(`listVisible(keyset after ${curTs}/${curId}): ${errText(r.error as any)}`);
      const rows = (r.data as Row[]) ?? [];
      if (rows.length === 0) break;
      out.push(...rows);
      const last = rows[rows.length - 1];
      curTs = last.published_at;
      curId = last.id;
      if (rows.length < pageSize) break; // short page ⇒ end of table
    }
    return out.map(toArticle);
  }

  async listVisiblePage(offset: number, limit: number): Promise<Article[]> {
    // Served from the memoized full read (no separate offset query). The full
    // list is already ordered published_at DESC, so a slice IS the page — this
    // also sidesteps the deep-offset statement_timeout entirely, at any depth.
    // FEED EXCLUDES inferred-date rows (published_at_source='scraper_default'):
    // their day is unknown (P&I circulars/press-releases the date-fallback dated),
    // so they'd pollute the newest-first feed with old content dated "today". They
    // stay in listVisible() → article pages built → Pagefind-searchable; only the
    // freshness feed drops them. (6 legacy scraper_default rows also drop — accepted.)
    const all = await this.listVisibleFeed();
    return all.slice(offset, offset + limit);
  }

  /** listVisible minus inferred-date rows — the homepage freshness feed.
   *  Memoized: pagination route generation calls listVisiblePage ~100× per build,
   *  so the O(n) filter over the full memo runs once, not once per page. */
  private async listVisibleFeed(): Promise<Article[]> {
    if (_feedMemo) return _feedMemo;
    const all = await this.listVisible(ARTICLE_PAGE_LIMIT);
    _feedMemo = all.filter((a) => a.publishedAtSource !== 'scraper_default');
    return _feedMemo;
  }

  // How many articles are ACTUALLY loaded into this build (capped by
  // ARTICLE_PAGE_LIMIT). Pagination route generation must use THIS, not the
  // full countVisible() — otherwise a light build (delta, limit 1500) emits
  // page routes for the whole archive and pages past the loaded slice render
  // empty ("no article"). Memoized read, so no extra DB cost.
  async loadedCount(): Promise<number> {
    // Feed pagination denominator → count the FEED (excludes inferred-date rows),
    // so page routes match what listVisiblePage actually serves.
    return (await this.listVisibleFeed()).length;
  }

  async countVisible(): Promise<number> {
    // Cheap PLANNER-ESTIMATE count (head:true → no rows/egress). MEASURED
    // 2026-06-08: count:'exact' over the visible filter returns null / hits
    // `canceling statement due to statement timeout` on Nano (full-table COUNT is
    // too heavy), but count:'estimated' returns ~51,534 in ~350ms — it uses the
    // query planner's row estimate, which is plenty accurate for a "~51k articles"
    // badge and light on Nano. Crucial for a FEED/DELTA build (ARTICLE_PAGE_LIMIT
    // lowered to ~1500): the old "length of the memoized read" returned 1500, not
    // the real ~51k (why it had to be hardcoded for hotfix builds). Memoized
    // (called ~3×/build). Falls back to the read length only if the estimate fails.
    if (_countMemo != null) return _countMemo;
    let estimate: number | null = null;
    try {
      const { count, error } = await supabase
        .from('articles')
        .select('id', { count: 'estimated', head: true })
        .or('content_quality.is.null,content_quality.in.(visible,pending)')
        .not('published_at', 'is', null)
        .lte('published_at', new Date().toISOString());
      if (!error && typeof count === 'number') estimate = count;
    } catch { /* fall through */ }

    // CLAMP the planner estimate to the EXACT total row count so the displayed
    // number can never exceed reality. The estimated visible-count drifts ABOVE
    // the true count during heavy UPDATE churn — e.g. backlog AI-classification
    // mutating thousands of rows inflates pg_class.reltuples until autovacuum
    // catches up (MEASURED 2026-06-21 mid-classification: estimate 60,025 vs
    // 57,968 total rows / 55,451 actually visible → hero wrongly read "60,000+").
    // An UNFILTERED count:'exact' is light enough on Nano (no per-row filter,
    // unlike the visible-filtered exact count which statement-timeouts) to serve
    // as a hard ceiling. Best-effort: if it fails we keep the raw estimate, so
    // this never regresses below today's behaviour.
    if (estimate != null) {
      let total: number | null = null;
      try {
        const { count, error } = await supabase
          .from('articles')
          .select('id', { count: 'exact', head: true });
        if (!error && typeof count === 'number') total = count;
      } catch { /* keep raw estimate */ }
      _countMemo = total != null ? Math.min(estimate, total) : estimate;
      return _countMemo;
    }

    // Both count paths unavailable → fall back to the loaded read length.
    const all = await this.listVisible(ARTICLE_PAGE_LIMIT);
    _countMemo = all.length;
    return _countMemo;
  }

  async getById(id: string): Promise<Article | null> {
    const { data, error } = await supabase
      .from('articles')
      .select(SELECT)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`getById: ${error.message}`);
    return data ? toArticle(data as Row) : null;
  }

  // ── Filter views — all derived in-memory from the ONE memoized full read.
  // Previously each issued its own DB query; under Disk-IO pressure those
  // filtered queries hit statement_timeout and killed the build (measured
  // 2026-06-04: `listByTheme(cargo_risk): canceling statement due to statement
  // timeout`). Filtering the already-in-memory full list means the entire
  // static build performs exactly ONE database read (the keyset full read),
  // which is both the lightest possible Disk-IO footprint and robust to a
  // degraded/saturated DB. Order is preserved (the memo is published_at DESC).

  async listByTheme(theme: string, limit: number): Promise<Article[]> {
    const all = await this.listVisible(ARTICLE_PAGE_LIMIT);
    return all.filter((a) => a.themes.includes(theme)).slice(0, limit);
  }

  async listBySegment(segment: string, limit: number): Promise<Article[]> {
    const all = await this.listVisible(ARTICLE_PAGE_LIMIT);
    return all.filter((a) => a.segments.includes(segment)).slice(0, limit);
  }

  async listByDocumentType(docType: string, limit: number): Promise<Article[]> {
    const all = await this.listVisible(ARTICLE_PAGE_LIMIT);
    return all.filter((a) => a.documentType === docType).slice(0, limit);
  }

  async listBySource(name: string, limit: number): Promise<Article[]> {
    const all = await this.listVisible(ARTICLE_PAGE_LIMIT);
    return all.filter((a) => a.sourceName === name).slice(0, limit);
  }

  async listAllSources(): Promise<string[]> {
    // Distinct source names that have at least one VISIBLE article (derived
    // from the memo — only non-empty sources get a page, which is correct).
    const all = await this.listVisible(ARTICLE_PAGE_LIMIT);
    const names = new Set<string>();
    for (const a of all) if (a.sourceName) names.add(a.sourceName);
    return [...names].sort((x, y) => x.localeCompare(y));
  }
}

export const articleRepo: ArticleRepository = new SupabaseArticleRepository();
