// Fetch live raids near a point from pogocoordinates.com/map (free tier)
// by driving the real map page in headless Chromium and reading the
// raid data the page itself loads.
//
// Usage:
//   node raids/pogo_raids.js                       # Taipei Main Station
//   node raids/pogo_raids.js 25.0330,121.5654      # any lat,lng
//   node raids/pogo_raids.js 25.0478,121.5170 --watch   # refresh every 2 min
//   options: --json <file>  also write raw results to a JSON file
//            --tier <n>     only show this raid_level (e.g. 5, 6=Mega)
//            --hatched      only show hatched raids (boss known)
const { chromium } = require('playwright');
const fs = require('fs');

const args = process.argv.slice(2);
const pos = args.find(a => /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(a)) || '25.0478,121.5170';
const [LAT, LNG] = pos.split(',').map(Number);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const WATCH = args.includes('--watch');
const HATCHED = args.includes('--hatched');
const TIER = opt('--tier');
const JSON_OUT = opt('--json');
const REFRESH_MS = 120000; // the site's own raid refresh interval

const TEAMS = ['無', '藍(Mystic)', '紅(Valor)', '黃(Instinct)'];

function km(a, b, c, d) {
  const r = x => x * Math.PI / 180;
  const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
const tw = iso => new Date(iso).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, hour: '2-digit', minute: '2-digit' });
const mins = iso => Math.round((new Date(iso) - Date.now()) / 60000);

function show(results) {
  const now = Date.now();
  let rows = results
    .filter(r => new Date(r.raid_end) > now)
    .filter(r => !TIER || String(r.raid_level) === String(TIER))
    .filter(r => !HATCHED || !r.is_egg)
    .map(r => ({ ...r, dist: km(LAT, LNG, r.lat, r.lon) }))
    .sort((a, b) => a.dist - b.dist);

  console.log(`\n=== ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })} 台灣時間 | 中心 ${LAT},${LNG} | ${rows.length} 場進行中 ===`);
  for (const r of rows) {
    const hatched = new Date(r.raid_battle) <= now;
    const boss = r.pokemon_name ? `${r.pokemon_name}${r.form ? ` (${r.form})` : ''}` : (hatched ? '已孵化(未知)' : '蛋');
    const when = hatched
      ? `剩 ${mins(r.raid_end)} 分 (結束 ${tw(r.raid_end)})`
      : `${mins(r.raid_battle)} 分後孵化 (${tw(r.raid_battle)})`;
    const moves = r.fast_move ? ` | ${r.fast_move}/${r.charge_move}` : '';
    console.log(`${r.dist.toFixed(2).padStart(5)}km  ${String(r.tier_name || r.raid_level).padEnd(5)} ${boss.padEnd(16)} ${when.padEnd(26)} ${r.gym_name}  ${r.lat.toFixed(6)},${r.lon.toFixed(6)}${moves}${r.weather_boosted ? ' ☀加成' : ''}`);
  }
}

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  let latest = null;
  page.on('response', async r => {
    if (!r.url().includes('/map/lookup')) return;
    let body = {};
    try { body = JSON.parse(r.request().postData() || '{}'); } catch (e) {}
    if (body.mode !== 'raids') return;
    // ignore lookups for other map views (e.g. the default view before our search)
    if (!(body.s_lat <= LAT && LAT <= body.n_lat && body.w_lng <= LNG && LNG <= body.e_lng)) return;
    try { latest = (await r.json()).results || []; } catch (e) {}
  });

  await page.goto('https://pogocoordinates.com/map', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.selectOption('select >> nth=0', { label: 'Raids' });
  const inp = page.locator('input[placeholder*="lat,lng"]');
  await inp.click();
  await inp.pressSequentially(`${LAT},${LNG}`, { delay: 20 });
  await inp.press('Enter');

  const waitFor = async ms => {
    const t = Date.now();
    while (Date.now() - t < ms) { await page.waitForTimeout(500); }
  };

  do {
    const before = latest;
    const t0 = Date.now();
    while (latest === before && Date.now() - t0 < 30000) await page.waitForTimeout(500);
    await page.waitForTimeout(1500); // let the final lookup for the new view land
    if (!latest) { console.error('沒有拿到團體戰資料（網站可能暫時無法使用）'); }
    else {
      show(latest);
      if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(latest, null, 1));
    }
    if (WATCH) {
      await waitFor(REFRESH_MS);
      latest = null;
      await page.getByRole('button', { name: 'Refresh' }).click().catch(() => {});
    }
  } while (WATCH);

  await browser.close();
})();
