// "Related Knowledge" relatedness scoring + build-time index.
//
// Pure logic, no I/O — unit-testable and storage-agnostic. The site computes
// the related set ONCE per build (getStaticPaths, over the already-loaded
// visible array) and bakes related[] into each article page's props; the
// deployed site is fully static (no DB / no per-view compute).
//
// Scoring (user-specified 2026-06-22):
//   keywords  = Jaccard(A,B) * 10        // |A∩B| / |A∪B|, precise topical signal
//   themes    = sharedCount * 3
//   segments  = sharedCount * 2
//   docType   = same ? 1 : 0
//   recency   = small tiebreaker (0.0–0.5), never overpowers topical match
//
// Candidate generation buckets by theme/segment/keyword, so every candidate
// shares ≥1 of those → there is always real topical overlap (a same-docType-
// only pair is never surfaced; docType + recency only refine ranking).

// Structural shape — anything with these fields scores (the site's Article
// satisfies it). Kept local so this file has no import coupling.
export interface Relatable {
  id: string;
  title?: string;
  publishedAt: string | null;
  documentType: string | null;
  segments: string[];
  themes: string[];
  keywords: string[];
}

const KW_WEIGHT = 10;
const THEME_WEIGHT = 3;
const SEGMENT_WEIGHT = 2;
const DOCTYPE_WEIGHT = 1;
// Per-bucket candidate cap: only the most-recent CAP_K entries of a bucket are
// considered as candidates (buckets are fed in published_at DESC order). Bounds
// the cost of huge theme buckets (e.g. a theme on ~15k rows) without hurting
// quality — rare/precise keyword buckets are almost always under the cap, so
// old precise matches via specific keywords are preserved.
const CAP_K = 600;
// A candidate qualifies on keywords ALONE only when the overlap is strong
// (Jaccard ≥ this). A lone generic shared keyword ("China", "United States")
// gives a tiny Jaccard and must NOT surface an otherwise-unrelated article —
// the freshest articles have empty themes, so without this gate keyword noise
// dominated (user-reported 2026-06-23: irrelevant related on recent articles).
const KW_JACCARD_MIN = 0.3;

const norm = (s: string) => s.trim().toLowerCase();

function normSet(arr: string[] | null | undefined): Set<string> {
  const out = new Set<string>();
  if (arr) for (const x of arr) { const n = norm(x); if (n) out.add(n); }
  return out;
}

function intersectCount(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  return inter;
}

function jaccardFrom(a: Set<string>, b: Set<string>, inter: number): number {
  const uni = a.size + b.size - inter;
  return uni ? inter / uni : 0;
}

function sharedCount(a: string[], bSet: Set<string>): number {
  let n = 0;
  for (const x of a) if (bSet.has(x)) n++;
  return n;
}

function recencyBonus(publishedAt: string | null, nowMs: number): number {
  if (!publishedAt) return 0;
  const t = Date.parse(publishedAt);
  if (Number.isNaN(t)) return 0;
  const days = (nowMs - t) / 86_400_000;
  if (days <= 30) return 0.5;
  if (days <= 180) return 0.25;
  return 0;
}

// Precomputed scoring view of an article (sets built once).
interface Prepped {
  art: Relatable;
  themeSet: Set<string>;
  segSet: Set<string>;
  kwSet: Set<string>;
}

function prep(a: Relatable): Prepped {
  return { art: a, themeSet: normSet(a.themes), segSet: normSet(a.segments), kwSet: normSet(a.keywords) };
}

/**
 * Score candidate `c` against `a` AND decide whether it qualifies to be shown.
 * `ok` gates INCLUSION — a candidate is surfaced only with a genuine topical
 * tie: a shared theme, OR a shared segment AND a shared keyword, OR strong
 * keyword overlap (Jaccard ≥ KW_JACCARD_MIN). docType + recency only refine
 * RANKING; they can never carry a topically-weak match into the results.
 */
export function evaluate(a: Prepped, c: Prepped, nowMs: number): { score: number; ok: boolean } {
  if (a.art.id === c.art.id) return { score: 0, ok: false };
  const inter = intersectCount(a.kwSet, c.kwSet);
  const kwJac = jaccardFrom(a.kwSet, c.kwSet, inter);
  const th = sharedCount(a.art.themes, c.themeSet);
  const sg = sharedCount(a.art.segments, c.segSet);
  const ok = th >= 1 || (sg >= 1 && inter >= 1) || kwJac >= KW_JACCARD_MIN;
  if (!ok) return { score: 0, ok: false };
  const dt = a.art.documentType && a.art.documentType === c.art.documentType ? DOCTYPE_WEIGHT : 0;
  const score = kwJac * KW_WEIGHT + th * THEME_WEIGHT + sg * SEGMENT_WEIGHT + dt + recencyBonus(c.art.publishedAt, nowMs);
  return { score, ok: true };
}

/**
 * Build id -> related[] (up to `limit`) for the whole corpus in one pass.
 * `all` MUST be in published_at DESC order (the repository memo already is) so
 * bucket caps keep the most-recent candidates.
 */
export function buildRelatedIndex(
  all: Relatable[],
  opts: { limit?: number; nowMs: number; capK?: number },
): Map<string, Relatable[]> {
  const limit = opts.limit ?? 6;
  const capK = opts.capK ?? CAP_K;
  const prepped = all.map(prep);

  // Inverted indexes value -> ordered list of article indices (input order = DESC).
  const themeBucket = new Map<string, number[]>();
  const segBucket = new Map<string, number[]>();
  const kwBucket = new Map<string, number[]>();
  const push = (m: Map<string, number[]>, k: string, i: number) => {
    let a = m.get(k); if (!a) { a = []; m.set(k, a); } if (a.length < capK) a.push(i);
  };
  prepped.forEach((p, i) => {
    p.themeSet.forEach((t) => push(themeBucket, t, i));
    p.segSet.forEach((s) => push(segBucket, s, i));
    p.kwSet.forEach((k) => push(kwBucket, k, i));
  });

  const out = new Map<string, Relatable[]>();
  prepped.forEach((p, i) => {
    const cand = new Set<number>();
    const add = (m: Map<string, number[]>, keys: Set<string>) => {
      keys.forEach((k) => { const b = m.get(k); if (b) for (const j of b) if (j !== i) cand.add(j); });
    };
    add(themeBucket, p.themeSet);
    add(segBucket, p.segSet);
    add(kwBucket, p.kwSet);

    const scored: { j: number; s: number }[] = [];
    cand.forEach((j) => { const e = evaluate(p, prepped[j], opts.nowMs); if (e.ok) scored.push({ j, s: e.score }); });
    scored.sort((x, y) => {
      if (y.s !== x.s) return y.s - x.s;
      const tx = Date.parse(all[x.j].publishedAt ?? '') || 0;
      const ty = Date.parse(all[y.j].publishedAt ?? '') || 0;
      if (ty !== tx) return ty - tx;                 // newer first
      return all[x.j].id < all[y.j].id ? -1 : 1;     // stable, deterministic build
    });
    out.set(p.art.id, scored.slice(0, limit).map((x) => all[x.j]));
  });
  return out;
}
