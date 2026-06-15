// Child sitemaps referenced by /sitemap.xml (the index). One file per publish
// year (URLs for that year's article pages) plus a "pages" file (homepage +
// the static pagination window). Keeps every file under the 50k-URL / 50MB cap.
//
// listVisible() is memoized → getStaticPaths + every child GET + the index +
// the article pages all share ONE DB read (no extra Nano Disk-IO).
import type { APIRoute, GetStaticPaths } from 'astro';
import { articleRepo } from '@/lib/repository/SupabaseArticleRepository';
import { ARTICLE_PAGE_LIMIT } from '@/lib/config';

const PAGE_SIZE = 20;
const MAX_PAGES = 100;

function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));
}

// One path per child file: 'pages' + every distinct publish year.
export const getStaticPaths: GetStaticPaths = async () => {
  const articles = await articleRepo.listVisible(ARTICLE_PAGE_LIMIT);
  const years = new Set<string>();
  for (const a of articles) if (a.publishedAt) years.add(a.publishedAt.slice(0, 4));
  return [{ params: { name: 'pages' } }, ...[...years].map((y) => ({ params: { name: y } }))];
};

export const GET: APIRoute = async ({ params, site }) => {
  const base = (site?.toString() ?? 'https://maritimereader.com').replace(/\/$/, '');
  const name = String(params.name);
  const articles = await articleRepo.listVisible(ARTICLE_PAGE_LIMIT);

  const urls: string[] = [];
  if (name === 'pages') {
    // Same nav window as index.astro / page/[n].astro: cap at MAX_PAGES, and use
    // the ACTUALLY-loaded count so a light build never lists /page/N that 404s.
    const navPages = Math.min(MAX_PAGES, Math.max(1, Math.ceil(articles.length / PAGE_SIZE)));
    urls.push(`<url><loc>${base}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>`);
    for (let n = 2; n <= navPages; n++) {
      urls.push(`<url><loc>${base}/page/${n}/</loc><changefreq>daily</changefreq><priority>0.4</priority></url>`);
    }
  } else {
    // A year child: every article whose published_at falls in that year.
    for (const a of articles) {
      if (!a.publishedAt || a.publishedAt.slice(0, 4) !== name) continue;
      const lastmod = `<lastmod>${a.publishedAt.slice(0, 10)}</lastmod>`;
      urls.push(`<url><loc>${base}/article/${xmlEscape(a.id)}/</loc>${lastmod}<changefreq>monthly</changefreq><priority>0.7</priority></url>`);
    }
  }

  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
