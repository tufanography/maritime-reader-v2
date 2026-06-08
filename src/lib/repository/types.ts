// Domain shape the site renders. Independent of any storage backend.

export type Article = {
  id: string;
  title: string;
  url: string;
  excerpt: string | null;
  publishedAt: string | null; // ISO 8601
  sourceName: string | null;
  documentType: string | null;
  segments: string[];
  themes: string[];
  imageUrl: string | null;
};
