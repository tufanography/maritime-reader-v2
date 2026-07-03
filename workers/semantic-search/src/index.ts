/**
 * maritime-semantic-search — Cloudflare Worker (FREE Workers plan)
 *
 * Single job: embed the user's QUERY into a 384-dim vector using Workers AI
 * (@cf/baai/bge-small-en-v1.5) and return it. The client does the actual search
 * (brute-force cosine over the int8 corpus artifact + RRF merge with Pagefind).
 *
 * Security / abuse controls (see README for the full list):
 *   - Method allowlist (POST + OPTIONS only)          -> 405 otherwise
 *   - Strict CORS (reflect Origin only if allowlisted)
 *   - Content-Type must be application/json            -> 415 otherwise
 *   - Body size cap 2KB                                -> 413 otherwise
 *   - Input validation (q: 1..200 chars, k: 1..50)     -> 400 otherwise
 *   - Native rate limiting keyed on CF-Connecting-IP   -> 429 otherwise
 *   - Edge cache (~300s) keyed on normalized query
 *   - No API key in code (Workers AI via the AI binding)
 *   - Never logs full queries; no stack traces to client
 *
 * IMPORTANT: the corpus vectors were built with the bge query prefix
 * "Represent this sentence for searching relevant passages: ". We prepend the
 * SAME prefix here so query and corpus vectors live in the same space.
 */

// ------------------------------- Config --------------------------------------

const MODEL = "@cf/baai/bge-small-en-v1.5" as const;
const EMBED_DIM = 384;
const BGE_QUERY_PREFIX =
  "Represent this sentence for searching relevant passages: ";
const MAX_BODY_BYTES = 2 * 1024; // 2KB
const MAX_Q_LEN = 200;
const CACHE_TTL_SECONDS = 300;

// ------------------------------- Env -----------------------------------------

interface RateLimiter {
  // Cloudflare native rate-limit binding (unstable API).
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface AiBinding {
  run(
    model: string,
    input: { text: string[] }
  ): Promise<{ data?: number[][]; shape?: number[] }>;
}

export interface Env {
  /** Workers AI binding (no API key in code — auth handled by the binding). */
  AI: AiBinding;
  /** Native rate-limit binding (configured in wrangler.toml unsafe bindings). */
  RATE_LIMITER?: RateLimiter;
  /** Comma-separated CORS allowlist, e.g. "https://maritimereader.com,...". */
  ALLOWED_ORIGINS: string;
}

// ------------------------------- Helpers -------------------------------------

function parseAllowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Build CORS headers. Reflects Origin ONLY if it is in the allowlist. */
function corsHeaders(env: Env, origin: string | null): Headers {
  const h = new Headers();
  const allowed = parseAllowedOrigins(env);
  if (origin && allowed.includes(origin)) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Vary", "Origin");
    h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    h.set("Access-Control-Allow-Headers", "Content-Type");
    h.set("Access-Control-Max-Age", "86400");
  }
  // For disallowed origins we intentionally omit the CORS headers, so the
  // browser blocks the response for cross-origin callers.
  return h;
}

/** JSON response with the given CORS headers merged in. */
function json(
  body: unknown,
  status: number,
  cors: Headers,
  extra?: Record<string, string>
): Response {
  const h = new Headers(cors);
  h.set("Content-Type", "application/json; charset=utf-8");
  if (extra) for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return new Response(JSON.stringify(body), { status, headers: h });
}

function errorResponse(
  message: string,
  status: number,
  cors: Headers
): Response {
  // Safe, generic messages only — never leak internals or stack traces.
  return json({ error: message }, status, cors);
}

/** Normalize query for stable cache keys: lowercase + collapse whitespace. */
function normalizeQuery(q: string): string {
  return q.toLowerCase().trim().replace(/\s+/g, " ");
}

// ------------------------------- Worker --------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(env, origin);
    const method = request.method.toUpperCase();

    // 1) Method allowlist: preflight + POST only.
    if (method === "OPTIONS") {
      // CORS preflight. If origin wasn't allowlisted, cors is empty and the
      // browser will reject — which is what we want.
      return new Response(null, { status: 204, headers: cors });
    }
    if (method !== "POST") {
      return errorResponse("Method not allowed", 405, cors);
    }

    // 2) Content-Type must be application/json.
    const ct = request.headers.get("Content-Type") || "";
    if (!ct.toLowerCase().includes("application/json")) {
      return errorResponse("Unsupported Media Type", 415, cors);
    }

    // 3) Body size cap (2KB). Read as text so we can measure exactly.
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
      return errorResponse("Payload too large", 413, cors);
    }

    // 4) Parse + validate input.
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return errorResponse("Invalid JSON", 400, cors);
    }
    if (typeof parsed !== "object" || parsed === null) {
      return errorResponse("Invalid request body", 400, cors);
    }
    const body = parsed as { q?: unknown; k?: unknown };

    if (typeof body.q !== "string") {
      return errorResponse("Field 'q' must be a string", 400, cors);
    }
    const q = body.q.trim();
    if (q.length < 1 || q.length > MAX_Q_LEN) {
      return errorResponse("Field 'q' must be 1..200 chars", 400, cors);
    }

    // k: optional int, clamped 1..50, default 10. (Echoed for client convenience.)
    let k = 10;
    if (body.k !== undefined) {
      const n = Number(body.k);
      if (!Number.isFinite(n)) {
        return errorResponse("Field 'k' must be a number", 400, cors);
      }
      k = Math.min(50, Math.max(1, Math.floor(n)));
    }

    // 5) Rate limiting (native binding), keyed on the caller's IP.
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (env.RATE_LIMITER) {
      try {
        const { success } = await env.RATE_LIMITER.limit({ key: ip });
        if (!success) {
          return errorResponse("Rate limit exceeded", 429, cors);
        }
      } catch {
        // Fail-open on limiter errors so a limiter outage doesn't kill search,
        // but never crash the request. (Swap to fail-closed if preferred.)
      }
    }

    // 6) Edge cache: key off the normalized query (+ method) so identical
    // queries reuse the embedding for ~300s. Cache is per-colo but free.
    const normalized = normalizeQuery(q);
    const cache = caches.default;
    const cacheKey = new Request(
      new URL("/embed?q=" + encodeURIComponent(normalized), request.url).toString(),
      { method: "GET" }
    );
    const cached = await cache.match(cacheKey);
    if (cached) {
      // Re-attach CORS for THIS origin (cached copy is origin-agnostic).
      const h = new Headers(cached.headers);
      for (const [key, val] of cors.entries()) h.set(key, val);
      return new Response(cached.body, { status: cached.status, headers: h });
    }

    // 7) Embed the query. Apply the SAME bge prefix the corpus used.
    let vector: number[];
    try {
      const r = await env.AI.run(MODEL, { text: [BGE_QUERY_PREFIX + q] });
      const v = r?.data?.[0];
      if (!Array.isArray(v) || v.length !== EMBED_DIM) {
        // Do not log the query; log only shape info.
        console.error("embed_bad_shape", { got: v?.length ?? null });
        return errorResponse("Embedding failed", 502, cors);
      }
      vector = v;
    } catch {
      console.error("embed_error");
      return errorResponse("Embedding failed", 502, cors);
    }

    // 8) Build the response, cache the origin-agnostic copy, return with CORS.
    const payload = { vector, dim: EMBED_DIM, model: MODEL, k };
    const cacheControl = `public, max-age=${CACHE_TTL_SECONDS}`;

    // Store a CORS-free copy in the cache; CORS is added per-origin on serve.
    const toCache = new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": cacheControl,
      },
    });
    ctx.waitUntil(cache.put(cacheKey, toCache.clone()));

    return json(payload, 200, cors, { "Cache-Control": cacheControl });
  },
} satisfies ExportedHandler<Env>;
