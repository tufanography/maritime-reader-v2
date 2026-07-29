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
// just the archive cap. The base build sets 95000 (deploy-base.yml); the
// visible archive is ~63.3k (MEASURED 2026-07-29), so 95000 has headroom.
// ⚠ This fixed number is INTERIM. It is not a real limit — the base build
// wants "the whole visible archive", full stop. A hand-bumped ceiling silently
// truncated the tail once already (60000 vs 62,975, see the STRICT guard in
// SupabaseArticleRepository). Planned: replace it with a >20%-change guard so
// the build tracks the archive instead of a number nobody remembers to raise.
// (Was temporarily 2100 on 2026-06-05/06 for two feed-only hotfix builds while
// the Nano DB was saturated.) Env-overridable so the pipeline can run a LIGHT
// feed-only build (delta: ARTICLE_PAGE_LIMIT=2100 — a SCOPE "last N", not a
// limit) vs the FULL base build (95000 = the whole visible archive).
// Build-time only (getStaticPaths runs in Node), so process.env is correct.
export const ARTICLE_PAGE_LIMIT = Number(process.env.ARTICLE_PAGE_LIMIT) || 60000;

// When '1' (set by the base build), hitting ARTICLE_PAGE_LIMIT is a HARD ERROR,
// not a silent tail-cut — the base build is meant to cover the WHOLE archive.
// The delta/feed build leaves this unset: its low limit (2100) is a deliberate
// cap, so exactly-limit rows are expected there and must NOT fail the build.
export const ARTICLE_LIMIT_STRICT = process.env.ARTICLE_LIMIT_STRICT === '1';
