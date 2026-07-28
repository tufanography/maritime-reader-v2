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

// live      = TUM makaleler (oksuz tespiti icin: R2'de var, DB'de hic yok)
// shouldHave = SITEDE GORUNMESI GEREKENLER (eksik tespiti icin)
// Ikisini ayirmak sart: site zaten 'hidden' makalelere sayfa uretmiyor, uretmemeli.
// Hepsini "eksik" saymak her hafta ayni ~2.500 rakamini uretir, rakam hic degismez,
// ucuncu haftada kimse bakmaz — sabit yanlis alarm, alarm degildir.
// Gorunurluk kurali sitenin kendi sorgusuyla AYNI:
//   SupabaseArticleRepository.ts:121
//   .or('content_quality.is.null,content_quality.in.(visible,pending)')
const live = new Set();
const shouldHave = new Set();
let cur = '00000000-0000-0000-0000-000000000000';
for (;;) {
  const { data, error } = await sb.from('articles').select('id,content_quality')
    .gt('id', cur).order('id', { ascending: true }).limit(1000);
  if (error) { console.error('Supabase HATASI: ' + error.message); process.exit(1); }
  if (!data || data.length === 0) break;
  for (const r of data) {
    const id = r.id.toLowerCase();
    live.add(id);
    const q = r.content_quality;
    if (q === null || q === undefined || q === 'visible' || q === 'pending') shouldHave.add(id);
  }
  cur = data[data.length - 1].id;
  if (data.length < 1000) break;
}
const { count: expected } = await sb.from('articles').select('id', { count: 'exact', head: true });
if (live.size > expected || expected - live.size > 50) {
  console.error(`cekim tutarsiz: ${live.size} / ${expected} — sayim yapilmadi`);
  process.exit(1);
}
console.log(`veritabaninda makale : ${live.size}`);
console.log(`  bunun SITEDE GORUNMESI gereken: ${shouldHave.size}  (gizli: ${live.size - shouldHave.size})`);

// 4) Karsilastir
const orphanIds = [...r2Articles.keys()].filter((id) => !live.has(id));
const orphanFiles = orphanIds.flatMap((id) => r2Articles.get(id));
console.log(`\n=== OKSUZ (R2'de var, veritabaninda YOK) ===`);
console.log(`   makale : ${orphanIds.length}`);
console.log(`   dosya  : ${orphanFiles.length}`);
const missingVisible = [...shouldHave].filter((id) => !r2Articles.has(id));
const missingHidden = [...live].filter((id) => !shouldHave.has(id) && !r2Articles.has(id)).length;
console.log(`\nters yon — R2'de sayfasi YOK:`);
console.log(`   GORUNMESI GEREKEN ama sayfasi yok : ${missingVisible.length}   <-- izlenecek sayi`);
console.log(`   gizli, sayfasi zaten olmamali     : ${missingHidden}   (dogru davranis)`);

if (orphanIds.length) {
  console.log(`\nilk 5 oksuz makale kimligi:`);
  for (const id of orphanIds.slice(0, 5)) console.log(`   ${id}   (${r2Articles.get(id).length} dosya)`);
}

// --- 5) EKSIKLERIN TARIH DAGILIMI ------------------------------------------
// "Gecikme mi, ariza mi?" sorusunun tek kesin cevabi. Hepsi son saatlerdeyse
// derleme gecikmesi; aylara yayilmissa sayfa uretiminde sistemli bir sorun var.
const missingIds = missingVisible;
if (missingIds.length) {
  const byDay = new Map();
  for (let i = 0; i < missingIds.length; i += 200) {
    const { data, error } = await sb.from('articles')
      .select('id,created_at,content_quality').in('id', missingIds.slice(i, i + 200));
    if (error) { console.error('tarih sorgusu HATASI: ' + error.message); break; }
    for (const r of data ?? []) {
      const k = String(r.created_at).slice(0, 10) + '|' + (r.content_quality ?? '-');
      byDay.set(k, (byDay.get(k) ?? 0) + 1);
    }
  }
  console.log(`\n=== R2'de sayfasi OLMAYAN ${missingIds.length} makale — gun + kalite ===`);
  const rows = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  for (const [k, c] of rows.slice(0, 20)) {
    const [d, q] = k.split('|');
    console.log(`   ${d}  ${String(q).padEnd(9)} ${String(c).padStart(6)}`);
  }
  if (rows.length > 20) console.log(`   ... ${rows.length - 20} satir daha`);
  const days = [...new Set(rows.map((r) => r[0].split('|')[0]))].sort();
  console.log(`   -> ${days.length} FARKLI GUN  (${days[0]} .. ${days[days.length - 1]})`);
}

// --- 6) SITEMAP CAPRAZ KONTROLU --------------------------------------------
// Bir sayfa ancak DUYURULUYORSA zarar verir. deploy-r2.mjs satir 114: delta modu
// sitemap.xml'e dokunmaz, yani sitemap yalnizca haftalik deploy-base ile tazelenir.
const probe = async (u) => {
  try { const r = await fetch(u, { headers: { 'Cache-Control': 'no-cache' } }); return r.status; }
  catch { return 0; }
};
let sitemapText = '';
try {
  const r = await fetch('https://maritimereader.com/sitemap.xml');
  sitemapText = await r.text();
  const kids = [...sitemapText.matchAll(/<loc>([^<]*sitemaps[^<]*)<\/loc>/g)].map((m) => m[1]);
  console.log(`\nsitemap.xml: HTTP ${r.status}, ${kids.length} alt sitemap`);
  for (const k of kids.slice(0, 15)) { try { sitemapText += await (await fetch(k)).text(); } catch { /* atla */ } }
  console.log(`   toplam sitemap metni: ${(sitemapText.length / 1024 / 1024).toFixed(1)} MB`);
} catch (e) { console.error('sitemap okunamadi: ' + e.message); }
const inSitemap = (id) => sitemapText.includes(id);

const tally = async (ids, label, highlight) => {
  const b = {};
  for (const id of ids.slice(0, 20)) {
    const st = await probe(`https://maritimereader.com/article/${id}/`);
    const k = `${inSitemap(id) ? 'sitemapte VAR' : 'sitemapte yok'} / HTTP ${st === 200 ? '200' : st}`;
    b[k] = (b[k] ?? 0) + 1;
  }
  console.log(`\n=== 20 ORNEK — ${label} ===`);
  for (const [k, v] of Object.entries(b)) {
    const warn = k.includes('VAR') && k.includes(highlight) ? '   <-- ' + (highlight === '404' ? 'KIRIK BAGLANTI' : 'GOOGLE HALA GORUYOR') : '';
    console.log(`   ${k.padEnd(30)} ${v}${warn}`);
  }
};
// Sitemap uyeligi TAM sayilir — metin bellekte, istek gerekmiyor. Orneklem
// yalnizca HTTP durumu icin gerekli (o istek gerektiriyor).
if (sitemapText.length > 1000) {
  const orphInSitemap = orphanIds.filter(inSitemap);
  const missInSitemap = missingIds.filter(inSitemap);
  console.log(`
=== SITEMAP TAM SAYIM (orneklem degil) ===`);
  console.log(`   silinen makalelerden sitemap'te olan : ${orphInSitemap.length}/${orphanIds.length}   <-- Google'a hala sunuluyor`);
  console.log(`   gorunmesi gerekip sayfasi olmayanlardan sitemap'te olan: ${missInSitemap.length}/${missingIds.length}   <-- kirik baglanti`);
}
if (missingIds.length) await tally(missingIds, "gorunmesi gereken ama sayfasi olmayanlar", '404');
if (orphanIds.length) await tally(orphanIds, 'silinen makaleler (oksuz)', '200');
