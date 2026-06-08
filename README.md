# Maritime Reader v2

Static-first rebuild of [maritime-pulse](../maritime-pulse). Designed to stay on $0 forever — see [`MARITIME_V2_HANDOFF.md`](../maritime-pulse/MARITIME_V2_HANDOFF.md) for the locked architecture, hard constraints, free-tier budget, and phased migration plan.

**Cardinal principle:** AI runs at build time only; the deployed site is plain static HTML/CSS/JS served from Cloudflare's CDN. If Claude / Supabase / the build server go down, the live site stays fully up.

## Phase 0 scaffold

- Astro 5 (SSG, `output: 'static'`)
- Clean-architecture data layer: `ArticleRepository` interface in `src/lib/repository/`; Supabase implementation behind it; swap with one file.
- Reads same Supabase DB as v1 via `PUBLIC_SUPABASE_URL` + `PUBLIC_SUPABASE_ANON_KEY` (RLS keeps it read-only).
- Two pages: `/` (latest 50 visible) and `/article/[id]/` (pre-rendered detail).

## Run

```sh
npm install
npm run build        # static output to dist/, queries Supabase at build time
npm run preview      # serve dist/ locally to inspect
```

## What this is NOT (yet)

Phase 0 only proves the read path renders from the live DB. Search, tag pages, source pages, full body extraction, newsletter signup, analytics, and the moved-to-local scrape pipeline come in later phases — see HANDOFF §8.
