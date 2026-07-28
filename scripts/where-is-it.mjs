// Silinen MarineLink haberleri sitenin HANGI sayfalarinda hala duruyor?
// Tahmin yok: gercek sayfalari indirip metinde arar, ve bulunan her makale
// baglantisinin HTTP durumunu tek tek dener.
import { readFileSync } from 'node:fs';

const plan = JSON.parse(readFileSync('D:/maritime-reader-v2-ingestion/tmp/plan-delete.json', 'utf8'));
const silinenler = plan.rows.slice(0, 40);   // ilk 40 silinen makale
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36', 'Cache-Control': 'no-cache', Pragma: 'no-cache' };

const get = async (u) => {
  try { const r = await fetch(u, { headers: H, redirect: 'follow' }); return { s: r.status, t: await r.text() }; }
  catch (e) { return { s: 0, t: '' }; }
};

const SAYFALAR = [
  'https://maritimereader.com/',
  'https://maritimereader.com/page/2/',
  'https://maritimereader.com/page/3/',
  'https://maritimereader.com/source/marinelink/',
  'https://maritimereader.com/type/news/',
];

console.log('=== Silinen haberler hangi sayfada goruniyor? ===\n');
for (const url of SAYFALAR) {
  const r = await get(url);
  if (r.s !== 200) { console.log(`${url}\n   HTTP ${r.s} — atlandi\n`); continue; }
  const bulunan = silinenler.filter((a) => r.t.includes(a.title.slice(0, 45)));
  // sayfadaki article/<uuid> baglantilari
  const ids = [...new Set([...r.t.matchAll(/\/article\/([0-9a-f-]{36})\//g)].map((m) => m[1]))];
  const silinenIds = new Set(plan.rows.map((x) => x.id));
  const oluIds = ids.filter((i) => silinenIds.has(i));
  console.log(`${url}`);
  console.log(`   HTTP ${r.s}, ${(r.t.length / 1024).toFixed(0)} KB, ${ids.length} makale baglantisi`);
  console.log(`   silinen haber BASLIGI geciyor  : ${bulunan.length}/40`);
  console.log(`   silinen haber BAGLANTISI var   : ${oluIds.length}`);
  if (bulunan.length) {
    for (const a of bulunan.slice(0, 3)) {
      const st = await get(`https://maritimereader.com/article/${a.id}/`);
      console.log(`      "${a.title.slice(0, 52)}"`);
      console.log(`      https://maritimereader.com/article/${a.id}/  -> HTTP ${st.s}`);
    }
  }
  console.log('');
}

// Ayrica: ayni baslik ana sayfada KAC KEZ geciyor (tekrar hala var mi?)
const home = await get('https://maritimereader.com/');
console.log('=== Ana sayfada TEKRAR var mi? ===');
const sayac = new Map();
for (const m of home.t.matchAll(/\/article\/([0-9a-f-]{36})\//g)) sayac.set(m[1], (sayac.get(m[1]) ?? 0) + 1);
const tekrarli = [...sayac.entries()].filter(([, n]) => n > 2);
console.log(`   ana sayfada ${sayac.size} benzersiz makale baglantisi`);
console.log(`   2'den fazla gecen: ${tekrarli.length}`);
// Basliga gore tekrar (aynı baslik birden fazla kart)
const basliklar = [...home.t.matchAll(/<h[23][^>]*>([^<]{20,90})<\/h[23]>/g)].map((m) => m[1].trim());
const bs = new Map();
for (const b of basliklar) bs.set(b, (bs.get(b) ?? 0) + 1);
const tekrarliBaslik = [...bs.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
console.log(`   ayni baslik birden fazla kartta: ${tekrarliBaslik.length}`);
for (const [b, n] of tekrarliBaslik.slice(0, 5)) console.log(`      ${n}x  "${b.slice(0, 60)}"`);
