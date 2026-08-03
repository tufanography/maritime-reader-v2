// GOLDEN SEARCH TEST — behaviour regression guard for SearchFilter.astro.
//
// The search's core logic lives in `is:inline` scripts that Astro does NOT
// type-check, so tsc cannot protect it — its ONLY guard is a behaviour test.
// This runs the exact cases we hand-verified while fixing the semantic-injector
// race, the rankMap order, and the 2-char backstop, and asserts them as PASS/FAIL.
//
// Each of these HARD assertions corresponds to a real bug that shipped:
//   G1  semantic cards must NEVER land in #sf-best (the injector reordered Best,
//       putting a Li-ion page on top of "enclosed space").
//   G2  multi-word Best must be ranked (rankMap), not the score-1 phrase order
//       ("speed and consumption" → "Speed and Consumption Claim" on top).
//   G3  "enclosed space" must surface enclosed-space docs, never the Li-ion page.
//   G4  trimming a settled multi-word search to 2 chars must NOT graft the
//       2-char query's semantic cards onto the stale results (backstop bug).
// SOFT checks (embed-worker dependent, warn only): semantic appears in Broader;
// the T-backstop fires under a large delay seam.
//
// Requires: npm i -D playwright && npx playwright install chromium
// Run:      SEARCH_BASE=https://maritimereader.com node scripts/golden-search.mjs
// Exit 1 on any HARD failure (CI gate).

import { chromium } from 'playwright';
const BASE = (process.env.SEARCH_BASE || 'https://maritimereader.com').replace(/\/$/, '') + '/';
const fails = [];
const soft = [];
const HARD = (name, ok, detail) => { console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) fails.push(name); };
const SOFT = (name, ok, detail) => { console.log(`  ${ok ? '·✓' : '·~'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) soft.push(name); };

async function newPage(browser, delay) {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.goto(BASE + (delay ? '?sfxDelayBroader=' + delay : ''), { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#sf-q', { timeout: 15000 });
  await page.click('#sf-q');   // focus → init + artifact prefetch (fill-before-init renders empty)
  try { await page.waitForResponse(r => /\/semantic\/cards\.json/.test(r.url()), { timeout: 25000 }); } catch (e) {}
  await page.waitForTimeout(400);
  return { ctx, page };
}
const bestTop = (page, n = 6) => page.evaluate((n) => [].slice.call(document.querySelectorAll('#sf-best > article.group:not([data-sfx])')).slice(0, n).map(a => (a.querySelector('h3')?.textContent || '').replace(/\s+/g, ' ').trim()), n);
const counts = (page) => page.evaluate(() => ({
  sfxBest: document.querySelectorAll('#sf-best article.group[data-sfx]').length,
  broaderSfx: document.querySelectorAll('#sf-broader article.group[data-sfx]').length,
  path: window.__sfxLastPath || '',
}));

async function main() {
  const browser = await chromium.launch({ headless: true });
  console.log(`\n=== GOLDEN SEARCH · ${BASE} ===`);

  // G1 + G2 + SOFT semantic-in-broader — "speed and consumption", seam 1200, 3 runs
  console.log('\n[speed and consumption · seam 1200 ×3]');
  let anyBestSfx = false, top1ok = 0, anyBroaderSfx = false;
  for (let i = 0; i < 3; i++) {
    const { ctx, page } = await newPage(browser, 1200);
    await page.fill('#sf-q', 'speed and consumption');
    try { await page.waitForFunction(() => document.querySelector('#sf-best article.group'), { timeout: 20000 }); } catch (e) {}
    let maxBestSfx = 0, broaderSfx = 0;
    for (let t = 0; t < 40; t++) { const c = await counts(page); maxBestSfx = Math.max(maxBestSfx, c.sfxBest); broaderSfx = c.broaderSfx; await page.waitForTimeout(250); }
    if (maxBestSfx > 0) anyBestSfx = true;
    if (broaderSfx > 0) anyBroaderSfx = true;
    const top = await bestTop(page, 3);
    if ((top[0] || '').indexOf('Speed and Consumption Claim') === 0) top1ok++;
    await ctx.close();
  }
  HARD('G1 semantic never in #sf-best (0/3 runs)', !anyBestSfx);
  HARD('G2 rankMap: Best top1 = "Speed and Consumption Claim" (3/3)', top1ok === 3, `${top1ok}/3`);
  SOFT('semantic appears in #sf-broader', anyBroaderSfx);

  // G3 — "enclosed space" Best top-6: enclosed-space, NEVER Li-ion
  console.log('\n[enclosed space]');
  { const { ctx, page } = await newPage(browser, 0);
    await page.fill('#sf-q', 'enclosed space');
    try { await page.waitForFunction(() => document.querySelector('#sf-best article.group'), { timeout: 20000 }); } catch (e) {}
    await page.waitForTimeout(4000);
    const top = await bestTop(page, 6); const joined = top.join(' | ').toLowerCase();
    HARD('G3 no Li-ion fire page in Best top-6', !/li-?ion/.test(joined), top[0]?.slice(0, 40));
    HARD('G3 Best top-6 are enclosed-space', top.filter(t => /enclosed|space|fatal/i.test(t)).length >= 3, `${top.filter(t => /enclosed|space|fatal/i.test(t)).length}/6 on-topic`);
    await ctx.close();
  }

  // G4 — 2-char backstop: trim settled multi-word to 2 chars → no wrong-query inject
  console.log('\n[2-char backstop regression]');
  { const { ctx, page } = await newPage(browser, 0);
    await page.fill('#sf-q', 'speed and consumption');
    try { await page.waitForFunction(() => document.querySelectorAll('#sf-broader article.group[data-sfx]').length > 0, { timeout: 20000 }); } catch (e) {}
    await page.waitForTimeout(1500);
    const before = await page.evaluate(() => [].slice.call(document.querySelectorAll('#sf-broader article.group[data-sfx] a[href]')).map(a => (a.getAttribute('href') || '').match(/\/article\/([^/]+)/)?.[1]).filter(Boolean));
    await page.fill('#sf-q', 'sp');
    let sawTimeout = false;
    for (let t = 0; t < 46; t++) { const c = await counts(page); if (c.path === 'timeout') sawTimeout = true; await page.waitForTimeout(250); }
    const after = await page.evaluate(() => [].slice.call(document.querySelectorAll('#sf-broader article.group[data-sfx] a[href]')).map(a => (a.getAttribute('href') || '').match(/\/article\/([^/]+)/)?.[1]).filter(Boolean));
    const bset = new Set(before); const newCards = after.filter(x => !bset.has(x));
    HARD('G4 no wrong-query cards grafted after 2-char trim', !(after.length > 0 && newCards.length > 0) && !sawTimeout, `before=${before.length} after=${after.length} newSfx=${newCards.length} timeout=${sawTimeout}`);
    await ctx.close();
  }

  // SOFT — timeout backstop fires under seam 12000; zero-keyword shows semantic
  console.log('\n[soft: timeout backstop · zero-keyword]');
  { const { ctx, page } = await newPage(browser, 12000);
    await page.fill('#sf-q', 'speed and consumption');
    let sawT = false, bsfx = 0;
    for (let t = 0; t < 100; t++) { const c = await counts(page); if (c.path === 'timeout') sawT = true; bsfx = Math.max(bsfx, c.broaderSfx); await page.waitForTimeout(250); }
    SOFT('T-backstop fires under seam 12000 + semantic in broader', sawT && bsfx > 0, `timeout=${sawT} broaderSfx=${bsfx}`);
    await ctx.close();
  }
  { const { ctx, page } = await newPage(browser, 0);
    await page.fill('#sf-q', 'why do boats tip over when the load gets wet');
    let bsfx = 0; for (let t = 0; t < 40; t++) { bsfx = Math.max(bsfx, (await counts(page)).broaderSfx); await page.waitForTimeout(250); }
    SOFT('zero-keyword query still shows semantic (broader)', bsfx > 0, `broaderSfx=${bsfx}`);
    await ctx.close();
  }

  await browser.close();
  console.log(`\n=== HARD failures: ${fails.length}${fails.length ? ' → ' + fails.join(', ') : ''} ===`);
  if (soft.length) console.log(`(soft warnings: ${soft.join(', ')} — embed-worker dependent, not a gate)`);
  process.exit(fails.length ? 1 : 0);
}
main().catch(e => { console.error('GOLDEN ERR', e.message); process.exit(2); });
