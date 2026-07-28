// SALT-OKUNUR. R2'de duran ama veritabaninda ARTIK OLMAYAN makale sayfalarini SAYAR.
// Hicbir sey silmez, hicbir sey yuklemez.
//
// Neden gerekli: deploy-r2.mjs bilerek hicbir seyi silmez ("Non-destructive
// (never deletes) ... Orphaned fragments from removed articles accumulate
// harmlessly; periodic cleanup is a separate chore"). O periyodik temizlik
// bugune kadar hic yapilmamis olabilir — yani v2 yayina girdiginden beri silinen
// HER makalenin sayfasi R2'de duruyor olabilir. Kac tane oldugunu kimse bilmiyor.
// Bu script tahmin etmez, sayar.
//
//   node scripts/count-orphans.mjs
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';

// deploy-r2.mjs ile AYNI varsayilanlar: sadece anahtarlar secret'tan gelir.
const ENDPOINT = process.env.R2_ENDPOINT || 'https://da00a5f5079a0a6b134c03573460d6f5.r2.cloudflarestorage.com';
const BUCKET = process.env.R2_BUCKET || 'maritime-pagefind';
const need = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) { console.error('eksik env: ' + missing.join(', ')); process.exit(1); }

const s3 = new S3Client({
  region: 'auto',
  endpoint: ENDPOINT,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});

// 1) R2 manifesti: bucket'taki her dosyanin anahtari
let manifest;
try {
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: '_deploy/manifest.json' }));
  manifest = JSON.parse(await r.Body.transformToString());
} catch (e) {
  console.error('manifest okunamadi: ' + (e?.message ?? e));
  process.exit(1);
}
const keys = Object.keys(manifest);
console.log(`R2 manifesti: ${keys.length} dosya`);

// 2) article/<uuid>/ altindaki sayfalar
const UUID = /^article\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i;
const r2Articles = new Map();     // uuid -> [key,...]
for (const k of keys) {
  const m = k.match(UUID);
  if (!m) continue;
  const id = m[1].toLowerCase();
  if (!r2Articles.has(id)) r2Articles.set(id, []);
  r2Articles.get(id).push(k);
}
console.log(`R2'de makale sayfasi: ${r2Articles.size} makale, ${[...r2Articles.values()].flat().length} dosya`);

// 3) Veritabanindaki makale kimlikleri (keyset + hata kontrolu)
const sbUrl = process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.PUBLIC_SUPABASE_ANON_KEY;
if (!sbUrl || !sbKey) { console.error('Supabase env yok (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)'); process.exit(1); }
const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } });

const live = new Set();
let cur = '00000000-0000-0000-0000-000000000000';
for (;;) {
  const { data, error } = await sb.from('articles').select('id').gt('id', cur).order('id', { ascending: true }).limit(1000);
  if (error) { console.error('Supabase HATASI: ' + error.message); process.exit(1); }
  if (!data || data.length === 0) break;
  for (const r of data) live.add(r.id.toLowerCase());
  cur = data[data.length - 1].id;
  if (data.length < 1000) break;
}
const { count: expected } = await sb.from('articles').select('id', { count: 'exact', head: true });
if (live.size > expected || expected - live.size > 50) {
  console.error(`cekim tutarsiz: ${live.size} / ${expected} — sayim yapilmadi`);
  process.exit(1);
}
console.log(`veritabaninda makale : ${live.size}`);

// 4) Karsilastir
const orphanIds = [...r2Articles.keys()].filter((id) => !live.has(id));
const orphanFiles = orphanIds.flatMap((id) => r2Articles.get(id));
console.log(`\n=== OKSUZ (R2'de var, veritabaninda YOK) ===`);
console.log(`   makale : ${orphanIds.length}`);
console.log(`   dosya  : ${orphanFiles.length}`);
const missingPages = [...live].filter((id) => !r2Articles.has(id)).length;
console.log(`\nters yon — veritabaninda var ama R2'de sayfasi YOK: ${missingPages}`);
console.log(`   (bunlar bir sonraki TAM derlemede uretilecek)`);

if (orphanIds.length) {
  console.log(`\nilk 5 oksuz makale kimligi:`);
  for (const id of orphanIds.slice(0, 5)) console.log(`   ${id}   (${r2Articles.get(id).length} dosya)`);
}
