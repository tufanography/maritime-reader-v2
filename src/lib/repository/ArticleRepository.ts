import type { Article } from './types';

// Clean-architecture port. Pages depend on THIS, never on the Supabase
// implementation directly. Adding a method here (the port) before the
// adapter is the rule — it keeps storage-engine swap a one-file change.
//
// `allVisibleIds` was removed after Phase 0 review: it was only present
// to support an N+1 pattern in article/[id].astro's getStaticPaths.
// listVisible returns the full objects already, so per-id getById is
// unnecessary at build time.
export interface ArticleRepository {
  /** Newest visible articles, with published_at NOT NULL and not in future. */
  listVisible(limit: number): Promise<Article[]>;

  /** Paged version of listVisible — slice 2 of the v2 frontend port
   *  added this so the homepage can show "Page N of 2,476" / Older /
   *  Newer like v1 does. offset is 0-based. */
  listVisiblePage(offset: number, limit: number): Promise<Article[]>;

  /** Total count of rows that listVisible would include. Drives the
   *  "(~50k)" badge and the page-count denominator on pagination. */
  countVisible(): Promise<number>;

  /** Single article by id; null if missing or non-visible. */
  getById(id: string): Promise<Article | null>;

  /** Visible articles whose semantic_themes contains the given theme. */
  listByTheme(theme: string, limit: number): Promise<Article[]>;

  /** Visible articles whose segments contains the given segment. */
  listBySegment(segment: string, limit: number): Promise<Article[]>;

  /** Visible articles with the given document_type (single-value column). */
  listByDocumentType(docType: string, limit: number): Promise<Article[]>;

  /** Visible articles for a given source (by source name, case-sensitive). */
  listBySource(sourceName: string, limit: number): Promise<Article[]>;

  /** Distinct source names that have at least one visible article. */
  listAllSources(): Promise<string[]>;
}
