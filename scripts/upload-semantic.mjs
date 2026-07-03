// Upload the semantic-search artifacts to the SAME R2 bucket that serves the
// site (maritime-pagefind), under the `semantic/` prefix. deploy-r2.mjs is
// NON-DESTRUCTIVE (never deletes), so these keys persist across site deploys.
// Client fetches them from the pagefind base origin: `${PUBLIC_PAGEFIND_BASE}/semantic/…`.
//
// The two JSON files are gzip-compressed (Content-Encoding: gzip) — the browser's
// fetch() decompresses transparently. cards.json ~18.8MB → ~5MB over the wire;
// vectors.bin is int8 (high entropy) so it's uploaded raw.
//
// Creds: env (R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY) or D:/tmp/r2-creds.txt — same
// convention as deploy-r2.mjs. Source files staged in D:/tmp by the embed pipeline.
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import zlib from 'node:zlib';
import fs from 'node:fs';

const ENDPOINT = process.env.R2_ENDPOINT || 'https://da00a5f5079a0a6b134c03573460d6f5.r2.cloudflarestorage.com';
const BUCKET = process.env.R2_BUCKET || 'maritime-pagefind';
const CREDS_FILE = 'D:/tmp/r2-creds.txt';
const SRC_DIR = process.env.SEMANTIC_SRC || 'D:/tmp';

function loadCreds() {
  let id = process.env.R2_ACCESS_KEY_ID, secret = process.env.R2_SECRET_ACCESS_KEY;
  if ((!id || !secret) && fs.existsSync(CREDS_FILE)) {
    const env = Object.fromEntries(fs.readFileSync(CREDS_FILE, 'utf8').split(/\r?\n/)
      .filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
    id = id || env.R2_ACCESS_KEY_ID; secret = secret || env.R2_SECRET_ACCESS_KEY;
  }
  if (!id || !secret) { console.error('MISSING R2 creds'); process.exit(1); }
  return { id, secret };
}
const { id: accessKeyId, secret: secretAccessKey } = loadCreds();
const s3 = new S3Client({ region: 'auto', endpoint: ENDPOINT, credentials: { accessKeyId, secretAccessKey } });

const FILES = [
  { path: `${SRC_DIR}/vectors.bin`,       key: 'semantic/vectors.bin',       ct: 'application/octet-stream',       cc: 'public, max-age=3600', gz: false },
  { path: `${SRC_DIR}/vectors.meta.json`, key: 'semantic/vectors.meta.json', ct: 'application/json; charset=utf-8', cc: 'no-cache',            gz: false  },
  { path: `${SRC_DIR}/cards.json`,        key: 'semantic/cards.json',        ct: 'application/json; charset=utf-8', cc: 'public, max-age=3600', gz: false  },
];

for (const f of FILES) {
  if (!fs.existsSync(f.path)) { console.error(`MISSING ${f.path}`); process.exit(1); }
  let body = fs.readFileSync(f.path);
  const raw = body.length;
  const extra = {};
  if (f.gz) { body = zlib.gzipSync(body, { level: 9 }); extra.ContentEncoding = 'gzip'; }
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: f.key, Body: body, ContentType: f.ct, CacheControl: f.cc, ...extra }));
  console.log(`uploaded ${f.key}  ${(raw / 1e6).toFixed(2)}MB${f.gz ? ` → ${(body.length / 1e6).toFixed(2)}MB gz` : ''}`);
}
console.log('DONE: semantic artifacts on R2 → https://cdn.maritimereader.com/semantic/');
