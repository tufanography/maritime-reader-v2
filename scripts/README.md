# Deploy pipeline (auto-rebuild)

The site is static (Astro → R2, served by the site Worker; search via Pagefind on
`cdn.maritimereader.com`). Two GitHub Actions keep it fresh **for ~$0** using a
**split Pagefind index** (decided + measured 2026-06-08):

| Job | When | Reads from Nano | What it does |
|-----|------|-----------------|--------------|
| **deploy-delta** (`.github/workflows/deploy-delta.yml`) | every 3h | ~1500 rows (~3s, light) | `build:feed` (homepage + page/** + last ~1500 article pages) → `pagefind … _pagefind-delta` → incremental upload (DEPLOY_MODE=delta, base index untouched) |
| **deploy-base** (`.github/workflows/deploy-base.yml`) | weekly (Sun 04:00 UTC) | full ~51k (the one heavy read) | `npm run build` (+ postbuild `_pagefind`) → incremental upload (DEPLOY_MODE=full) |

The client (`SearchFilter.astro`) loads the static **base** index then
`pf.mergeIndex('/_pagefind-delta', { baseUrl: '/' })` so search covers the full
archive AND the last few days. Base+delta overlap is **deduped by `result.url`**.
Why this shape: the only thing that stresses Nano is the full 51k-row read, so we
do it weekly and read just the recent rows every 3h. Search is therefore ~3h-fresh
without daily heavy reads. See `memory/project_split_index_pipeline.md`.

## scripts/deploy-r2.mjs

Incremental R2 uploader. Keeps a manifest (`_deploy/manifest.json`, R2 key → md5)
and uploads only files whose content changed — so a daily/3-hourly rebuild pushes
~the new articles + small index files, not all 104k objects. Non-destructive
(never deletes). Sets `Cache-Control` (fixed-name Pagefind entries → `no-cache` so
a rebuilt delta is never served stale; hashed assets → immutable; HTML → 5 min).

Env:
- `DEPLOY_MODE` = `full` (whole dist) | `delta` (everything except base `_pagefind/`) | `seed` (write manifest from current dist, upload nothing — run once after a known-good full deploy)
- `DRY_RUN=1` — report only
- `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` — from GitHub Secrets in CI; locally falls back to `D:/tmp/r2-creds.txt`
- `R2_ENDPOINT` / `R2_BUCKET` — optional (defaults baked)

## Required GitHub Secrets

`PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY` (build), `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY` (deploy).

## Manual run

`gh workflow run deploy-delta.yml` / `gh workflow run deploy-base.yml`
(or the "Run workflow" button in the Actions tab).
