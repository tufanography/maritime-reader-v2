// XML sitemap — the engine of programmatic SEO. Google/AI crawlers find
// every article via this file, not via on-site pagination (which is a
// capped UX window, not a discovery surface). One <url> per built article
// page + the homepage + the static pagination window. Emitted as a static
// dist/sitemap.xml at build time (no request-time cost).
//
// Sitemaps cap at 50,000 URLs / 50 MB per file; we're under both at
// ARTICLE_PAGE_LIMIT. If the built set ever exceeds 50k, this must become
// a sitemap index splitting into multiple child files.
import type { APIRoute } from 'astro';
import { articleRepo } from '@/lib/repository/SupabaseArticleRepository';
import { ARTICLE_PAGE_LIMIT } from '@/lib/config';

const PAGE_SIZE = 20;
const MAX_PAGES = 100;

function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));
}

export const GET: APIRoute = async ({ site }) => {
  const base = (site?.toString() ?? 'https://maritimereader.com').replace(/\/$/, '');
  const articles = await articleRepo.listVisible(ARTICLE_PAGE_LIMIT);
  const total = await articleRepo.countVisible();
  const navPages = Math.min(MAX_PAGES, Math.max(1, Math.ceil(total / PAGE_SIZE)));

  const urls: string[] = [];
  // Homepage (page 1)
  urls.push(`<url><loc>${base}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>`);
  // Static pagination window 2..navPages
  for (let n = 2; n <= navPages; n++) {
    urls.push(`<url><loc>${base}/page/${n}/</loc><changefreq>daily</changefreq><priority>0.4</priority></url>`);
  }
  // Every built article page
  for (const a of articles) {
    const lastmod = a.publishedAt ? `<lastmod>${a.publishedAt.slice(0, 10)}</lastmod>` : '';
    urls.push(`<url><loc>${base}/article/${xmlEscape(a.id)}/</loc>${lastmod}<changefreq>monthly</changefreq><priority>0.7</priority></url>`);
  }

  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
