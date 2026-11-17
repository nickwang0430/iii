// Fetch live raids near a point from pogocoordinates.com/map (free tier)
// by driving the real map page in headless Chromium and reading the
// raid data the page itself loads.
//
// Usage:
//   node raids/pogo_raids.js                  # auto: by Taiwan time (see SCHEDULE)
//   node raids/pogo_raids.js 25.0330,121.5654 # fixed lat,lng
//   node raids/pogo_raids.js --watch          # refresh every 2 min (auto-switches location)
//   options: --json <file>  also write raw results to a JSON file each refresh
//            --tier <n>     only show this raid_level (e.g. 5, 6=Mega)
//            --hatched      only show hatched raids (boss known)
//
// Requires: npm i playwright && npx playwright install chromium
const { chromium } = require('playwright');
const fs = require('fs');

// Auto location by Taiwan local hour (Asia/Taipei): [fromHour, toHour) -> place
const SCHEDULE = [
  { from: 7, to: 19, name: '台北車站', lat: 25.0477, lng: 121.5172 },
  { from: 19, to: 7, name: '紐約中央公園', lat: 40.773895, lng: -73.971130 },
];

const args = process.argv.slice(2);
const FIXED = args.find(a => /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(a));
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const WATCH = args.includes('--watch');
const HATCHED = args.includes('--hatched');
const TIER = opt('--tier');
const JSON_OUT = opt('--json');
const REFRESH_MS = 120000; // the site's own raid refresh interval

function taiwanHour() {
  return Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei', hour: '2-digit', hour12: false })) % 24;
}
function target() {
  if (FIXED) { const [lat, lng] = FIXED.split(',').map(Number); return { name: '指定座標', lat, lng }; }
  const h = taiwanHour();
  return SCHEDULE.find(s => (s.from < s.to ? h >= s.from && h < s.to : h >= s.from || h < s.to));
}

function km(a, b, c, d) {
  const r = x => x * Math.PI / 180;
  const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
const tw = iso => new Date(iso).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, hour: '2-digit', minute: '2-digit' });
const mins = iso => Math.round((new Date(iso) - Date.now()) / 60000);

function show(results, t) {
  const now = Date.now();
  const rows = results
    .filter(r => new Date(r.raid_end) > now)
    .filter(r => !TIER || String(r.raid_level) === String(TIER))
    .filter(r => !HATCHED || !r.is_egg)
    .map(r => ({ ...r, dist: km(t.lat, t.lng, r.lat, r.lon) }))
    .sort((a, b) => a.dist - b.dist);

  console.log(`\n=== ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })} 台灣時間 | ${t.name} ${t.lat},${t.lng} | ${rows.length} 場進行中 ===`);
  for (const r of rows) {
    const hatched = new Date(r.raid_battle) <= now;
    const boss = r.pokemon_name ? `${r.pokemon_name}${r.form ? ` (${r.form})` : ''}` : (hatched ? '已孵化(未知)' : '蛋');
    const when = hatched
      ? `剩 ${mins(r.raid_end)} 分 (結束 ${tw(r.raid_end)})`
      : `${mins(r.raid_battle)} 分後孵化 (${tw(r.raid_battle)})`;
    const moves = r.fast_move ? ` | ${r.fast_move}/${r.charge_move}` : '';
    console.log(`${r.dist.toFixed(2).padStart(5)}km  ${String(r.tier_name || r.raid_level).padEnd(5)} ${boss.padEnd(16)} ${when.padEnd(26)} ${r.gym_name}  ${r.lat.toFixed(6)},${r.lon.toFixed(6)}${moves}${r.weather_boosted ? ' ☀加成' : ''}`);
  }
  return rows;
}

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  let cur = target();
  let latest = null;
  page.on('response', async r => {
    if (!r.url().includes('/map/lookup')) return;
    let body = {};
    try { body = JSON.parse(r.request().postData() || '{}'); } catch (e) {}
    if (body.mode !== 'raids') return;
    // ignore lookups for other map views (e.g. the default view before our search)
    // (the map view after our search is centred on the target)
    const cLat = (body.n_lat + body.s_lat) / 2, cLng = (body.w_lng + body.e_lng) / 2;
    if (Math.abs(cLat - cur.lat) > 0.02 || Math.abs(cLng - cur.lng) > 0.02) return;
    try { latest = (await r.json()).results || []; } catch (e) {}
  });

  await page.goto('https://pogocoordinates.com/map', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.selectOption('select >> nth=0', { label: 'Raids' });
  const inp = page.locator('input[placeholder*="lat,lng"]');
  const search = async t => {
    latest = null;
    await inp.click();
    await inp.press('Control+A');
    await inp.press('Backspace');
    await inp.pressSequentially(`${t.lat},${t.lng}`, { delay: 20 });
    await inp.press('Enter');
  };
  await search(cur);

  while (true) {
    const t0 = Date.now();
    while (latest === null && Date.now() - t0 < 30000) await page.waitForTimeout(500);
    await page.waitForTimeout(1500); // let the final lookup for the new view land
    if (latest === null) console.error('沒有拿到團體戰資料（網站可能暫時無法使用）');
    else {
      const rows = show(latest, cur);
      if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ fetched_at: new Date().toISOString(), place: cur, raids: rows }, null, 1));
    }
    if (!WATCH) break;

    const t1 = Date.now();
    while (Date.now() - t1 < REFRESH_MS) await page.waitForTimeout(1000);
    const next = target();
    if (next.lat !== cur.lat || next.lng !== cur.lng) {
      console.log(`\n>>> 時段切換：${cur.name} → ${next.name}`);
      cur = next;
      await search(cur);
    } else {
      latest = null;
      await page.getByRole('button', { name: 'Refresh' }).click().catch(() => {});
    }
  }
  await browser.close();
})();
