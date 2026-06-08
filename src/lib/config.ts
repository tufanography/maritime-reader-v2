// Single source of truth for how many article detail pages the static
// build emits. Each built article costs ~2 files toward Cloudflare Pages'
// 20,000-file free-tier deployment limit (1 HTML page + 1 Pagefind index
// fragment), plus ~190 fixed files (pagination cap, theme/segment/source
// pages, assets, Pagefind support). So the hard ceiling is roughly
// (20000 - 190) / 2 ≈ 9,900 articles. This is a MEASUREMENT value while we
// find the real ceiling + build time; the final number gets locked once
// the hybrid (static recent + Worker archive) design is decided.
// Max article detail pages the static build emits. v2 serves from R2 (no
// Cloudflare Pages file-count limit anymore — see site-worker/), so this is
// just the archive cap: 60000 comfortably covers the ~50.5k visible archive
// with headroom. (Was temporarily lowered to 2100 on 2026-06-05/06 for two
// feed-only hotfix builds while the Nano DB was saturated; restored here.)
// Env-overridable so the auto-rebuild pipeline can run a LIGHT feed-only build
// (e.g. ARTICLE_PAGE_LIMIT=2000 every 3h — reads only the recent rows, cheap on
// Nano) vs the daily FULL build (unset → 60000, the whole visible archive).
// Build-time only (getStaticPaths runs in Node), so process.env is correct.
export const ARTICLE_PAGE_LIMIT = Number(process.env.ARTICLE_PAGE_LIMIT) || 60000;
