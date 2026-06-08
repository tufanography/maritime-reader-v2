// Incremental R2 deploy for maritime-reader-v2 (auto-rebuild pipeline, 2026-06-08).
//
// WHY incremental: a full deploy is ~104k R2 PUTs (52,505 _pagefind + 51,696
// site). Doing that daily would blow R2's 1M-Class-A free tier (~3M/mo ≈ $9.5).
// MEASURED 2026-06-08 (D16, D:/tmp/pf-incr-test): Pagefind is DETERMINISTIC and
// fragment files for UNCHANGED articles are byte-identical across rebuilds — only
// NEW articles add fragments. So if we upload ONLY the files whose content
// changed, a daily rebuild pushes ~the day's new articles (~105 fragments + ~105
// HTML) + the ~990 small index files ≈ <2k PUTs/day ≈ ~40k/mo → FREE (~$0).
//
// HOW: keep a manifest (R2 key -> md5) at `_deploy/manifest.json` in the bucket.
// Each run: GET manifest, walk dist, upload only files whose md5 differs, PUT the
// updated manifest. Non-destructive (never deletes) → worst case is a redundant
// upload, never data loss. Orphaned fragments from removed articles accumulate
// harmlessly (search index never references them); periodic cleanup is a separate
// chore. A GitHub Actions `concurrency:` group keeps feed+full from racing the
// manifest.
//
// MODES (env DEPLOY_MODE):
//   full  (default) — whole dist (site HTML + _astro + _pagefind). Daily build.
//   feed            — ONLY index.html + sitemap.xml + page/** + _astro/**.
//                     NEVER article/** or _pagefind/** — a feed build uses a low
//                     ARTICLE_PAGE_LIMIT so dist has a PARTIAL article set + a
//                     partial/empty _pagefind; uploading those would corrupt the
//                     live full archive + search index. Scope is enforced here.
//   seed            — compute md5 of the whole dist and PUT the manifest WITHOUT
//                     uploading anything. Run ONCE right after a known-good full
//                     deploy (dist == what's on R2) so the first real incremental
//                     run is a near-no-op instead of re-uploading all 104k files.
//
// Other env: DRY_RUN=1 (report only, no PUTs), R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
//   R2_ENDPOINT, R2_BUCKET (defaults baked for convenience).
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..', 'dist');
const MODE = (process.env.DEPLOY_MODE || 'full').toLowerCase();
const DRY = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const ENDPOINT = process.env.R2_ENDPOINT || 'https://da00a5f5079a0a6b134c03573460d6f5.r2.cloudflarestorage.com';
const BUCKET = process.env.R2_BUCKET || 'maritime-pagefind';
const MANIFEST_KEY = '_deploy/manifest.json';
const CONCURRENCY = 24;
const CREDS_FILE = 'D:/tmp/r2-creds.txt'; // local fallback only (gitignored, never on GHA)

// ---- creds: env first (GH Secrets), local file fallback for manual runs ----
function loadCreds() {
  let id = process.env.R2_ACCESS_KEY_ID, secret = process.env.R2_SECRET_ACCESS_KEY;
  if ((!id || !secret) && fs.existsSync(CREDS_FILE)) {
    const env = Object.fromEntries(fs.readFileSync(CREDS_FILE, 'utf8').split(/\r?\n/)
      .filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
    id = id || env.R2_ACCESS_KEY_ID; secret = secret || env.R2_SECRET_ACCESS_KEY;
  }
  if (!id || !secret) { console.error('MISSING R2 creds (set R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY or have', CREDS_FILE + ')'); process.exit(1); }
  return { id, secret };
}
const { id: accessKeyId, secret: secretAccessKey } = loadCreds();

const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: CONCURRENCY + 8 });
const s3 = new S3Client({ region: 'auto', endpoint: ENDPOINT, credentials: { accessKeyId, secretAccessKey },
  requestHandler: new NodeHttpHandler({ httpsAgent: keepAliveAgent }) });

const CT = { '.html': 'text/html; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.pf_fragment': 'application/octet-stream',
  '.pf_index': 'application/octet-stream', '.pf_meta': 'application/octet-stream', '.pf_filter': 'application/octet-stream' };

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cache-Control by key. The delta index is rebuilt every 3h; its fixed-name
// entry file (pagefind-entry.json / pagefind.js) keeps the SAME name with NEW
// content, so a CDN that caches it would serve a stale delta → new articles
// invisible despite the rebuild (the real risk the 7-perspective review surfaced,
// 2026-06-08). So: fixed-name Pagefind entries → no-cache (always revalidate,
// tiny files); content-hashed assets (_astro/*.hash.*, _pagefind*/fragment|index
// with hashed names) → immutable 1yr; HTML → short 5-min (fresh enough without a
// human Ctrl+F5, still some edge caching).
function cacheControlFor(key) {
  const base = key.split('/').pop();
  if (base === 'pagefind-entry.json' || base === 'pagefind.js' || base === 'pagefind-highlight.js') return 'no-cache';
  if (key.startsWith('_pagefind') || key.startsWith('_astro/')) return 'public, max-age=31536000, immutable';
  if (key.endsWith('.html') || key.endsWith('.xml')) return 'public, max-age=300';
  return 'public, max-age=3600';
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) walk(fp, out); else out.push(fp);
  }
  return out;
}
const keyOf = (fp) => path.relative(SRC, fp).split(path.sep).join('/');

// DELTA mode (the every-3h job): upload everything EXCEPT the base index
// `_pagefind/` — that stays untouched between weekly base rebuilds. Includes the
// feed (index/page/sitemap/_astro), the recent article/** detail pages, and the
// `_pagefind-delta/` index. (A delta build uses build:feed which never writes
// `_pagefind/`, so this is belt-and-suspenders.)
function inScope(key) {
  if (MODE === 'delta') return !key.startsWith('_pagefind/');
  return true; // full
}
// upload referenced-before-referrer: css → html → fragments → index/entry (last),
// for BOTH the base (_pagefind/) and the delta (_pagefind-delta/) indexes.
function rank(key) {
  if (key.startsWith('_astro/')) return 0;
  if (key === 'index.html' || key === 'sitemap.xml' || key.startsWith('page/')) return 1;
  if (key.startsWith('article/')) return 2;
  if (/^_pagefind(-delta)?\/fragment\//.test(key)) return 3;
  if (/^_pagefind(-delta)?\//.test(key)) return 4; // index/entry/wasm/filter — reference the fragments
  return 2;
}

async function getManifest() {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: MANIFEST_KEY }));
    const txt = await r.Body.transformToString();
    return JSON.parse(txt);
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NoSuchKey') { console.log('no existing manifest → treating all as new'); return {}; }
    console.error('manifest GET failed:', e.message); return {};
  }
}

async function put(key, body, ct, tries = 5) {
  const cc = cacheControlFor(key);
  for (let a = 1; a <= tries; a++) {
    try { await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: ct, CacheControl: cc })); return true; }
    catch (e) { if (a === tries) { console.error(`  FAIL ${key}: ${e.message}`); return false; } await sleep(250 * 2 ** (a - 1)); }
  }
}

// ---- run ----
const t0 = Date.now();
console.log(`deploy-r2: mode=${MODE} dry=${DRY} src=${SRC} bucket=${BUCKET}`);
let files = walk(SRC).map((fp) => ({ fp, key: keyOf(fp) })).filter((f) => inScope(f.key));
console.log(`scanned ${files.length} files in scope`);

const manifest = MODE === 'seed' ? {} : await getManifest();

// hash + diff
const changed = [];
let seeded = 0;
for (const f of files) {
  const buf = fs.readFileSync(f.fp);
  const h = md5(buf);
  if (MODE === 'seed') { manifest[f.key] = h; seeded++; continue; }
  if (manifest[f.key] !== h) changed.push({ ...f, buf, h });
}

if (MODE === 'seed') {
  console.log(`seed: hashed ${seeded} files`);
  if (!DRY) await put(MANIFEST_KEY, JSON.stringify(manifest), CT['.json']);
  console.log(`DONE seed: manifest ${DRY ? '(dry, not written)' : 'written'} with ${seeded} entries in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  process.exit(0);
}

changed.sort((a, b) => rank(a.key) - rank(b.key));
console.log(`${changed.length} changed/new files to upload (${files.length - changed.length} unchanged, skipped)`);
if (DRY) {
  for (const c of changed.slice(0, 40)) console.log('  would upload:', c.key);
  if (changed.length > 40) console.log(`  …and ${changed.length - 40} more`);
  console.log(`DONE (dry): ${changed.length} would upload, 0 written`);
  process.exit(0);
}

let done = 0, failed = 0;
let idx = 0;
async function worker() {
  while (idx < changed.length) {
    const i = idx++; const c = changed[i];
    const ct = CT[path.extname(c.key).toLowerCase()] || 'application/octet-stream';
    const okPut = await put(c.key, c.buf, ct);
    if (okPut) { manifest[c.key] = c.h; if (++done % 2000 === 0) console.log(`  uploaded ${done}/${changed.length}`); }
    else failed++;
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// Persist manifest (only successfully-uploaded keys were updated above).
if (!failed) await put(MANIFEST_KEY, JSON.stringify(manifest), CT['.json']);
else { await put(MANIFEST_KEY, JSON.stringify(manifest), CT['.json']); console.error(`⚠️ ${failed} uploads failed — those keys stay out of the manifest so the next run retries them`); }

console.log(`DONE: uploaded ${done}, failed ${failed}, skipped ${files.length - changed.length}, in ${((Date.now()-t0)/1000).toFixed(1)}s`);
process.exit(failed > 0 ? 1 : 0);
