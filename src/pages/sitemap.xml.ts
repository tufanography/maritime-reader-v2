// XML sitemap INDEX — the engine of programmatic SEO. A single sitemap file
// caps at 50,000 URLs / 50 MB; the archive is now >50k, so /sitemap.xml is a
// sitemap INDEX that points to child sitemaps (one per publish-YEAR + a small
// "pages" child for the homepage + pagination window). Google reads the index
// and fetches every child automatically — you submit ONLY /sitemap.xml in GSC.
//
// WHY year-based children (not fixed-size chunks): a new article lands in its
// year's child by published_at, so old-year files NEVER change (no churn, CDN-
// friendly, Google re-fetches only the current year). Each year is well under
// the 50k/file cap at current volume; if a single year ever exceeds 50k it must
// be sub-split — not a concern at present scale.
//
// Emitted static at build time. listVisible() is memoized (one DB read shared by
// the index + all child routes + article pages), so this adds no Nano Disk-IO.
import type { APIRoute } from 'astro';
import { articleRepo } from '@/lib/repository/SupabaseArticleRepository';
import { ARTICLE_PAGE_LIMIT } from '@/lib/config';

export const GET: APIRoute = async ({ site }) => {
  const base = (site?.toString() ?? 'https://maritimereader.com').replace(/\/$/, '');
  const articles = await articleRepo.listVisible(ARTICLE_PAGE_LIMIT);

  // Distinct publish-years in DESC order (articles are already published_at DESC),
  // capturing each year's newest date for the child's <lastmod>.
  const years: string[] = [];
  const lastmodByYear: Record<string, string> = {};
  for (const a of articles) {
    if (!a.publishedAt) continue;
    const y = a.publishedAt.slice(0, 4);
    if (!(y in lastmodByYear)) { years.push(y); lastmodByYear[y] = a.publishedAt.slice(0, 10); }
  }

  const entries: string[] = [
    `<sitemap><loc>${base}/sitemaps/pages.xml</loc></sitemap>`,
    ...years.map((y) => `<sitemap><loc>${base}/sitemaps/${y}.xml</loc><lastmod>${lastmodByYear[y]}</lastmod></sitemap>`),
  ];

  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</sitemapindex>\n`;
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
