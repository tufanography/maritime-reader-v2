// Static-site server for Maritime Reader v2, backed by the maritime-site R2
// bucket. Maps an incoming request path to an R2 object key that mirrors the
// Astro `dist/` layout (build.format: 'directory'):
//
//   /                       -> index.html
//   /article/<uuid>/        -> article/<uuid>/index.html
//   /article/<uuid>         -> article/<uuid>/index.html   (no trailing slash)
//   /segment/tanker/        -> segment/tanker/index.html
//   /_astro/app.<hash>.css  -> _astro/app.<hash>.css        (asset, has ext)
//   /sitemap.xml            -> sitemap.xml
//
// Rationale: R2 has no file-count limit, so this sidesteps the Cloudflare
// Pages 20k/100k ceiling that blocked the 50,718-file deploy. The _pagefind
// index is NOT served here — it lives at cdn.maritimereader.com.

const CT = {
  html: 'text/html; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
};

// Map a URL pathname to its R2 key. Astro builds directory-style routes, so a
// route URL (no file extension) resolves to that directory's index.html
// whether or not the trailing slash is present; a path WITH an extension is a
// real asset and is used verbatim.
function resolveKey(pathname) {
  let p = decodeURIComponent(pathname);
  if (p.startsWith('/')) p = p.slice(1);
  if (p === '') return 'index.html';
  if (p.endsWith('/')) return p + 'index.html';
  const last = p.slice(p.lastIndexOf('/') + 1);
  if (!last.includes('.')) return p + '/index.html';
  return p;
}

function extOf(key) {
  const i = key.lastIndexOf('.');
  return i === -1 ? '' : key.slice(i + 1).toLowerCase();
}

function cacheControl(key) {
  // _astro assets are content-hashed -> cache forever, immutable.
  if (key.startsWith('_astro/')) return 'public, max-age=31536000, immutable';
  // Pagefind (base `_pagefind/` AND delta `_pagefind-delta/`). The delta index is
  // rewritten every 3h; `pagefind-entry.json` is the FIXED-NAME manifest Pagefind
  // reads first, so if it's edge-cached the rebuilt index is served stale and new
  // articles never appear in search (the real risk surfaced 2026-06-08) -> no-cache.
  // The data shards (.pf_fragment/.pf_index/.pf_meta/.pf_filter) have content-hashed
  // names -> immutable. Other fixed-name runtime files (pagefind.js/css) -> short.
  if (key.startsWith('_pagefind')) {
    const base = key.slice(key.lastIndexOf('/') + 1);
    if (base === 'pagefind-entry.json') return 'no-cache';
    if (/\.pf_(fragment|index|meta|filter)$/.test(key)) return 'public, max-age=31536000, immutable';
    return 'public, max-age=300';
  }
  // HTML changes on each rebuild -> short edge cache, revalidate.
  if (key.endsWith('.html')) return 'public, max-age=300, must-revalidate';
  return 'public, max-age=3600';
}

const NOT_FOUND_HTML =
  '<!doctype html><meta charset="utf-8"><title>404 — Not found</title>' +
  '<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#0f172a">' +
  '<h1 style="font-size:1.5rem">404 — Not found</h1>' +
  '<p>That page doesn’t exist. <a href="/" style="color:#2563eb">← Back to Maritime Reader</a></p></body>';

export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    }

    const url = new URL(request.url);
    const key = resolveKey(url.pathname);
    const object = await env.SITE.get(key);

    if (object === null) {
      return new Response(NOT_FOUND_HTML, {
        status: 404,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers); // restores content-type stored at upload
    headers.set('etag', object.httpEtag);
    if (!headers.has('content-type')) {
      headers.set('content-type', CT[extOf(key)] || 'application/octet-stream');
    }
    headers.set('cache-control', cacheControl(key));

    return new Response(request.method === 'HEAD' ? null : object.body, { headers });
  },
};
