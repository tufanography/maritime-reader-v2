// R2'de duran OKSUZ makale sayfalarini siler — veritabaninda ARTIK OLMAYAN
// makalelerin sayfalari. --apply olmadan hicbir sey silmez.
//
//   kuru calisma : node scripts/delete-orphans.mjs
//   uygula       : node scripts/delete-orphans.mjs --apply
//
// NEDEN: deploy-r2.mjs bilerek hicbir seyi silmez (maliyet: tam dagitim ~104k
// Class-A islem). Sonuc: silinen her makalenin sayfasi R2'de kaliyor, dogrudan
// adresle aciliyor ve — OLCULDU 2026-07-28 — bir kismi hala sitemap'te duyuruluyor,
// cunku delta modu sitemap.xml'e dokunmuyor (deploy-r2.mjs:114) ve sitemap sadece
// haftalik deploy-base ile tazeleniyor.
//
// MANIFEST: silinen anahtarlar `_deploy/manifest.json`'dan da CIKARILIR. Yoksa
// manifest o dosyalari "yuklu" saymaya devam eder; ayni makale kimligi bir daha
// olusursa (ya da bir geri yukleme gerekirse) deploy atlar ve dosya eksik kalir.
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';

const APPLY = process.argv.includes('--apply');
const ENDPOINT = process.env.R2_ENDPOINT || 'https://da00a5f5079a0a6b134c03573460d6f5.r2.cloudflarestorage.com';
const BUCKET = process.env.R2_BUCKET || 'maritime-pagefind';
for (const k of ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
  if (!process.env[k]) { console.error('eksik env: ' + k); process.exit(1); }
}
const s3 = new S3Client({
  region: 'auto',
  endpoint: ENDPOINT,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});

// --- manifest
let manifest;
try {
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: '_deploy/manifest.json' }));
  manifest = JSON.parse(await r.Body.transformToString());
} catch (e) { console.error('manifest okunamadi: ' + (e?.message ?? e)); process.exit(1); }
console.log(`R2 manifesti: ${Object.keys(manifest).length} dosya`);

// --- R2'deki makale sayfalari
const UUID = /^article\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i;
const r2Articles = new Map();
for (const k of Object.keys(manifest)) {
  const m = k.match(UUID);
  if (!m) continue;
  const id = m[1].toLowerCase();
  if (!r2Articles.has(id)) r2Articles.set(id, []);
  r2Articles.get(id).push(k);
}

// --- veritabanindaki TUM makale kimlikleri (keyset + hata kontrolu + tamlik kontrolu)
const sbUrl = process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.PUBLIC_SUPABASE_ANON_KEY;
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
// EKSIK OKUMA = TOPLU YANLIS SILME. Bir sayfa kaybolursa o makaleler "veritabaninda
// yok" gorunur ve sayfalari silinir. Tamlik dogrulanmadan tek dosya silinmez.
if (live.size > expected || expected - live.size > 50) {
  console.error(`DUR: eksik okuma (${live.size} / ${expected}). Silme yapilmadi.`);
  process.exit(1);
}
console.log(`veritabani: ${live.size} makale (sayac ${expected})`);

const orphanIds = [...r2Articles.keys()].filter((id) => !live.has(id));
const orphanKeys = orphanIds.flatMap((id) => r2Articles.get(id));
console.log(`\nOKSUZ: ${orphanIds.length} makale, ${orphanKeys.length} dosya`);

// Emniyet siniri: beklenmedik bir toplu silmeyi engeller.
const LIMIT = Number(process.env.ORPHAN_LIMIT || 5000);
if (orphanKeys.length > LIMIT) {
  console.error(`DUR: ${orphanKeys.length} dosya > sinir ${LIMIT}. Once inceleyin (ORPHAN_LIMIT ile yukseltebilirsiniz).`);
  process.exit(1);
}
if (orphanKeys.length === 0) { console.log('silinecek bir sey yok.'); process.exit(0); }

console.log('\nilk 5:');
for (const k of orphanKeys.slice(0, 5)) console.log('   ' + k);

if (!APPLY) {
  console.log(`\nKURU CALISMA — hicbir sey silinmedi. Uygulamak icin --apply`);
  process.exit(0);
}

// --- SIL (R2 tek istekte en fazla 1000 anahtar kabul eder)
let deleted = 0;
for (let i = 0; i < orphanKeys.length; i += 1000) {
  const chunk = orphanKeys.slice(i, i + 1000);
  const res = await s3.send(new DeleteObjectsCommand({
    Bucket: BUCKET,
    Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
  }));
  if (res.Errors?.length) {
    console.error(`\nSILME HATALARI (${res.Errors.length}):`);
    for (const e of res.Errors.slice(0, 5)) console.error(`   ${e.Key}: ${e.Code} ${e.Message}`);
    console.error(`${deleted} dosya silindi, DURDURULDU. Manifest guncellenmedi.`);
    process.exit(1);
  }
  deleted += chunk.length;
  console.log(`  silinen: ${deleted}/${orphanKeys.length}`);
}

// --- MANIFESTI GUNCELLE (silinen anahtarlari cikar)
for (const k of orphanKeys) delete manifest[k];
await s3.send(new PutObjectCommand({
  Bucket: BUCKET,
  Key: '_deploy/manifest.json',
  Body: JSON.stringify(manifest),
  ContentType: 'application/json',
}));
console.log(`\nmanifest guncellendi: ${Object.keys(manifest).length} dosya kaldi`);
console.log(`\nBitti. ${deleted} oksuz sayfa silindi.`);
console.log(`NOT: sitemap.xml delta ile tazelenmiyor — silinen adresler haftalik`);
console.log(`     deploy-base calisana kadar sitemap'te kalabilir.`);
