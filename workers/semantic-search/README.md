# maritime-semantic-search (Cloudflare Worker)

A tiny query-embedding Worker for Maritime Reader's semantic search. Its **only**
job is to turn the user's search query into a **384-dim** vector using Workers AI
(`@cf/baai/bge-small-en-v1.5`) and return it. The **client** holds the corpus
vectors (a ~23MB int8 artifact from R2) and does the brute-force cosine + RRF
merge itself. Because the Worker only makes a single AI-binding call and does no
heavy compute, it stays within the **FREE Workers plan** (the AI inference runs
on Cloudflare's fleet, not in the Worker's 10ms CPU budget).

## API

`POST /` (any path on the bound route)

Request (JSON, ≤ 2KB):

```json
{ "q": "container ship detention P&I", "k": 10 }
```

- `q` — string, 1..200 chars (trimmed). Required.
- `k` — optional int, clamped 1..50, default 10. Echoed back for the client.

Response:

```json
{
  "vector": [/* 384 floats */],
  "dim": 384,
  "model": "@cf/baai/bge-small-en-v1.5",
  "k": 10
}
```

`Cache-Control: public, max-age=300`.

> The Worker prepends the bge query prefix
> `"Represent this sentence for searching relevant passages: "` before embedding.
> The corpus vectors were built with this **same** prefix — do not remove it or
> query/corpus vectors will drift out of the same space.

## Deploy

This Worker is **additive and reversible**; deploying it does not touch the
static site. From `workers/semantic-search/`:

```sh
# 1) Install wrangler if needed
npm i -g wrangler   # or: npx wrangler ...

# 2) Log in (once)
wrangler login

# 3) Deploy
wrangler deploy
```

### Bindings / config the repo owner must set

- **AI binding** — already declared in `wrangler.toml` as `[ai] binding = "AI"`.
  No API key: Workers AI auth is handled by the binding. Just ensure Workers AI
  is enabled on the account (it is, on the free plan, with daily quota).
- **Rate-limit binding** — declared as an `unsafe` `ratelimit` binding named
  `RATE_LIMITER` (20 req / 10s). If your account/wrangler version rejects the
  `unsafe.bindings` form, either update wrangler or remove the block; the code
  **fails open** when `RATE_LIMITER` is absent, so the Worker still runs (just
  without native rate limiting). Pick a unique `namespace_id` per Worker.
- **Route / subdomain** — bind to a dedicated host or a path. Recommended:
  - `search.maritimereader.com/*` (dedicated subdomain), **or**
  - `maritimereader.com/api/embed` (path route on the apex zone).

  Uncomment and fill the `[[routes]]` block in `wrangler.toml`, then set
  `ALLOWED_ORIGINS` so it matches the site origins that will call it
  (already: `https://maritimereader.com,https://www.maritimereader.com`).
- **Secrets** — none. Do not add any; there is no API key in code or config.

## Security measures (implemented in `src/index.ts`)

1. **Method allowlist** — only `POST` and `OPTIONS` (preflight). Anything else → **405**.
2. **Strict CORS** — the request `Origin` is reflected in
   `Access-Control-Allow-Origin` **only if** it exactly matches an entry in
   `ALLOWED_ORIGINS`; otherwise CORS headers are omitted so browsers block the
   response. `Vary: Origin` is set. Preflight (`OPTIONS`) returns 204 with the
   same origin-checked CORS headers.
3. **Content-Type gate** — body must be `application/json` → else **415**.
4. **Body size cap** — request body read as text and rejected if > **2KB** → **413**.
5. **Input validation** — `q` must be a non-empty string, trimmed, length **1..200**
   (else **400**); `k` optional int clamped **1..50**, default **10**; malformed
   JSON → **400**.
6. **Rate limiting** — Cloudflare **native** ratelimit binding keyed on
   `CF-Connecting-IP`, **~20 requests / 10 seconds per IP** → **429** on limit.
   Fails open if the binding is unavailable (documented; flip to fail-closed if
   you prefer stricter behavior).
7. **Edge caching** — normalized query (lowercase + collapsed whitespace) is the
   cache key; embeddings cached ~**300s** via the Cache API. CORS is re-applied
   per-origin on cache hits so a cached copy can't leak the wrong origin.
8. **No API key in code** — Workers AI via the `AI` binding only.
9. **No sensitive logging** — full queries are never logged; only shape/error
   markers. Client-facing errors are generic (no stack traces).

## ⚠️ COMPATIBILITY CHECK (do this BEFORE go-live)

The corpus vectors are produced **locally** with `Xenova/bge-small-en-v1.5`
(transformers.js). The Worker produces query vectors with **Workers AI**
`@cf/baai/bge-small-en-v1.5`. These are the *same model family*, but different
runtimes/quantization can shift the embedding space. If the spaces don't match,
cosine similarity between query and corpus is meaningless.

**Verify before relying on it:**

1. Pick an identical test sentence, e.g.
   `"Represent this sentence for searching relevant passages: oil tanker collision liability"`.
2. Embed it **locally** with `Xenova/bge-small-en-v1.5` (mean-pool + L2-normalize,
   exactly as the corpus pipeline does).
3. Fetch the **Worker's** vector for the same sentence (deploy first; call
   `POST /` with `q = "oil tanker collision liability"` — the Worker adds the
   prefix itself, so pass the raw query).
4. Compute **cosine similarity** between the two 384-dim vectors.

**Pass:** cosine ≈ **1.0** (≥ ~0.98). Query and corpus share a space → ship it.

**Fail:** cosine noticeably < 1.0 (e.g. < 0.9). Do **NOT** rely on this Worker as
the source of query vectors. **Fallback:** embed the query **client-side** with
transformers.js (`Xenova/bge-small-en-v1.5`), identical to the corpus pipeline —
guaranteeing the same space at the cost of a one-time model download in the
browser. The Worker can then be dropped or kept only as an optional accelerator.

See `scripts/check-embedding-compat.md` for the runnable check.
