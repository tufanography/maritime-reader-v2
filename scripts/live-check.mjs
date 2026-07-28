// SALT-OKUNUR canli site kontrolu. Uc soru:
//   1) Silinen bir haberin sayfasi R2'de hala duruyor mu? (oksuz teyidi)
//   2) Silinen haberin basligi liste sayfalarindan gitti mi? (delta calisti mi)
//   3) Veritabaninda olup R2'de sayfasi olmayan bir haber: listede gorunup
//      tiklaninca 404 mu veriyor? (2.684'luk sinifin gercek etkisi)
import { readFileSync } from 'node:fs';

const t = JSON.parse(readFileSync('D:/maritime-reader-v2-ingestion/tmp/test-ids.json', 'utf8'));
const H = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Cache-Control': 'no-cache',
};
const get = async (u) => {
  try { const r = await fetch(u, { headers: H, redirect: 'follow' }); return { s: r.status, t: await r.text() }; }
  catch (e) { return { s: 0, t: 'HATA ' + e.message }; }
};
const countIn = (hay, needle) => {
  let n = 0, i = 0;
  const h = hay.toLowerCase(), s = needle.toLowerCase();
  for (;;) { const j = h.indexOf(s, i); if (j === -1) break; n++; i = j + s.length; }
  return n;
};

const home = await get('https://maritimereader.com/');
console.log(`ana sayfa: HTTP ${home.s}, ${home.t.length} bayt\n`);

console.log('1) SILINEN haberin sayfasi hala R2\'de mi?');
const a = await get(`https://maritimereader.com/article/${t.silinen.id}/`);
console.log(`   HTTP ${a.s}  ${a.s === 200 ? '-> OKSUZ: silinen haber hala aciliyor' : '-> yok'}`);

console.log('\n2) SILINEN haberin basligi ana sayfada var mi?');
const n1 = countIn(home.t, t.silinen.title.slice(0, 40));
console.log(`   "${t.silinen.title.slice(0, 44)}"`);
console.log(`   gecis: ${n1}  ${n1 === 0 ? '-> delta temizlemis' : '-> HALA DURUYOR'}`);

console.log('\n3) YENI haber (DB\'de var, R2\'de sayfasi yok siniti):');
const b = await get(`https://maritimereader.com/article/${t.yeni.id}/`);
const n2 = countIn(home.t, t.yeni.title.slice(0, 35));
console.log(`   "${t.yeni.title.slice(0, 44)}"`);
console.log(`   sayfa   : HTTP ${b.s}  ${b.s === 404 ? '-> SAYFA YOK' : '-> aciliyor'}`);
console.log(`   listede : ${n2 > 0 ? 'GORUNUYOR' : 'gorunmuyor'}`);
if (n2 > 0 && b.s === 404) console.log('   => KIRIK BAGLANTI: listede duruyor, tiklaninca 404');
if (n2 === 0 && b.s === 404) console.log('   => tutarli: ne listede ne sayfasi var (henuz yayinlanmamis)');
