import { chromium } from 'playwright';
import { config } from 'dotenv';
config({ path: '/root/BizzAssist/.env.local' });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
const page = await ctx.newPage();

await page.goto('https://test.bizzassist.dk/login');
await page.fill('input[type="email"]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type="password"]', process.env.E2E_TEST_PASS);
await page.click('button[type="submit"]');
await page.waitForURL('**/dashboard**', { timeout: 25000 });

await page.goto('https://test.bizzassist.dk/dashboard/analyse/virksomhedshandler', {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
await page.waitForSelector('table', { timeout: 30000 });
await page.waitForTimeout(4000);

// ── BIZZ-1963: prove the live radar (route + rebuilt MV) returns the seller's exit
// and the buyer's entry for HUPFELD EJENDOMSADMINISTRATION (CVR 30809289) on the
// 2025-09-01 ownership transfer — NOT two simultaneous "→100%" rows. ──
const found = await page.evaluate(async () => {
  const CVR = '30809289';
  const acc = [];
  // 2025-09-01 has ~1289 candidate rows; DEAS (entry) and HUP (exit) share that
  // date but land on different pages, so accumulate across ALL pages.
  for (let offset = 0; offset < 4000; offset += 200) {
    const res = await fetch(
      `/api/virksomhedshandler/kandidater?from_date=2025-09-01&to_date=2025-09-01&limit=200&offset=${offset}`
    );
    const data = await res.json();
    for (const k of data.kandidater || []) {
      if (k.virksomhed_cvr === CVR) {
        acc.push({
          navn: k.virksomhed_navn,
          deltager: k.deltager_navn,
          signal: k.signal_type,
          fra: k.prev_ejerandel_pct,
          til: k.current_ejerandel_pct,
          aendringsdato: (k.aendringsdato || '').slice(0, 10),
        });
      }
    }
    if ((data.kandidater || []).length < 200) break; // exhausted
  }
  return acc;
});
console.log('HUPFELD (CVR 30809289) rows on 2025-09-01:\n', JSON.stringify(found, null, 1));

const deas = found.find((r) => r.deltager === 'DEAS A/S');
const hup = found.find((r) => r.deltager === 'HUP ApS');
const ok =
  deas && deas.signal === 'entry' && Number(deas.til) === 100 &&
  hup && hup.signal === 'exit' && Number(hup.til) === 100;
console.log('ASSERT DEAS=entry→100 & HUP=exit(100→0):', ok ? 'PASS' : 'FAIL');

await page.screenshot({ path: '/root/BizzAssist/scripts/verify-1963-radar.png', fullPage: false });
console.log('screenshot: scripts/verify-1963-radar.png');

await browser.close();
if (!ok) process.exit(1);
