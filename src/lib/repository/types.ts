// Domain shape the site renders. Independent of any storage backend.

export type Article = {
  id: string;
  title: string;
  url: string;
  excerpt: string | null;
  publishedAt: string | null; // ISO 8601
  publishedAtSource: string | null; // 'original'|'scraper_default'(=inferred date)|...
  sourceName: string | null;
  documentType: string | null;
  segments: string[];
  themes: string[];
  keywords: string[];
  /** Deterministic keyword-extractor output over the article body (migration 040).
   *  Rendered into the Pagefind body for search recall; not shown on the page. */
  contentTerms: string[];
  imageUrl: string | null;
};
