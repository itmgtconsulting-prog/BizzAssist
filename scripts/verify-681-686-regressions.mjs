import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});
const BASE = 'https://test.bizzassist.dk';
fs.mkdirSync('/tmp/verify-screenshots', { recursive: true });
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('PE: ' + e.message.slice(0, 120)));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !t.includes('vercel.live') && !t.includes('Mapbox') && !t.includes('401'))
    errors.push('E: ' + t.slice(0, 120));
});
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('input[type=email]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', process.env.E2E_TEST_PASS);
await Promise.all([page.waitForURL(/dashboard/, { timeout: 30000 }), page.click('button[type=submit]')]);
await page.waitForTimeout(2000);

async function clickTab(name) {
  const el = page.getByText(new RegExp(`^${name}$`, 'i')).first();
  const n = await el.count();
  if (!n) return false;
  await el.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(2500);
  return true;
}

const result = {};

// ── BIZZ-683 + 684 + 682: JAJR Ejendomme ApS (CVR 26316804) ──────────────
await page.goto(`${BASE}/dashboard/companies/26316804`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
const companyH1 = await page.locator('h1').first().textContent().catch(() => '');
result['683_diagram'] = {};
if (await clickTab('Diagram')) {
  const diagramText = await page.locator('svg, [class*="diagram"]').first().evaluate(el => el?.textContent?.slice(0, 200) || '').catch(() => '');
  const hasJAJR = diagramText.includes('JAJR') || (await page.getByText(/JAJR Ejendomme/i).count()) > 0;
  await page.screenshot({ path: '/tmp/verify-screenshots/683-diagram.png', fullPage: false });
  result['683_diagram'] = { hasJAJR, sampleText: diagramText.slice(0, 100) };
}

result['684_virksomheder'] = {};
if (await clickTab('Virksomheder')) {
  await page.waitForTimeout(2000);
  // Count rows with company names
  const companyCount = await page.getByText(/JaJR Holding|Ejendomme|ApS|A\/S/).count();
  await page.screenshot({ path: '/tmp/verify-screenshots/684-virksomheder.png', fullPage: false });
  result['684_virksomheder'] = { companyTextCount: companyCount };
}

result['682_personer'] = {};
if (await clickTab('Personer')) {
  await page.waitForTimeout(2000);
  const peopleCount = await page.getByText(/Jakob|Rasmussen|Direktør|Ejer|bestyrelse/i).count();
  await page.screenshot({ path: '/tmp/verify-screenshots/682-personer.png', fullPage: false });
  result['682_personer'] = { personCount: peopleCount };
}

if (await clickTab('Kronologi')) {
  await page.waitForTimeout(2000);
  const historyItems = await page.locator('article, [class*="timeline"], [class*="event"]').count();
  await page.screenshot({ path: '/tmp/verify-screenshots/682-kronologi.png', fullPage: false });
  result['682_kronologi'] = { items: historyItems };
}

// ── BIZZ-681: Ejendomme-tab → overflow modal ─────────────────────────────
if (await clickTab('Ejendomme')) {
  await page.waitForTimeout(3000);
  const ejendommeListed = await page.getByText(/Kaffevej|Arnold Nielsens|Høvedstens/i).count();
  // Try to click "Vis alle" or similar modal opener
  const modalBtn = page.getByText(/Vis alle|Se alle|Flere/i).first();
  if ((await modalBtn.count()) > 0) {
    await modalBtn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  // Check if BFE-only (e.g. "BFE 2091185") visible instead of adresse
  const hasBfeOnly = await page.locator('text=/^BFE \\d{5,}$/').count();
  const hasAddress = await page.getByText(/Kaffevej|Arnold Nielsens|Høvedstens|\\d{4} \\w+/).count();
  await page.screenshot({ path: '/tmp/verify-screenshots/681-ejendomme.png', fullPage: false });
  result['681_ejendomme'] = { ejendommeListed, hasBfeOnly, hasAddress };
}

// ── BIZZ-686: Jakob Juul Rasmussen personside ────────────────────────────
// Need enhedsNummer — use search
await page.goto(`${BASE}/dashboard/owners/4000115446`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
await page.screenshot({ path: '/tmp/verify-screenshots/686-person.png', fullPage: false });
const personH1 = await page.locator('h1').first().textContent().catch(() => '');
result['686_person_h1'] = personH1?.trim();
if (await clickTab('Ejendomme')) {
  await page.waitForTimeout(3000);
  const personalProps = await page.getByText(/Søbyvej|Vigerslev|Hovager|Astridsvej/i).count();
  await page.screenshot({ path: '/tmp/verify-screenshots/686-ejendomme.png', fullPage: false });
  result['686_ejendomme'] = { personalAddresses: personalProps };
}
if (await clickTab('Diagram')) {
  await page.waitForTimeout(3000);
  const diagramPropCount = await page.locator('[class*="node"], circle, rect').count();
  await page.screenshot({ path: '/tmp/verify-screenshots/686-diagram.png', fullPage: false });
  result['686_diagram'] = { nodes: diagramPropCount };
}

// ── BIZZ-685: Salgshistorik — Kaffevej 31, 1.tv BFE 425479 ───────────────
await page.goto(`${BASE}/dashboard/ejendomme/425479`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
const notFound = (await page.getByText(/ikke fundet/i).count()) > 0;
if (!notFound) {
  if (await clickTab('Økonomi')) {
    await page.waitForTimeout(3000);
    const salgshistRows = await page.locator('text=/Købt|Salg|DKK/i').count();
    await page.screenshot({ path: '/tmp/verify-screenshots/685-oekonomi.png', fullPage: false });
    result['685_oekonomi'] = { rows: salgshistRows };
  }
}
result['685_exists'] = !notFound;

console.log(JSON.stringify(result, null, 2));
console.log('errors:', errors.length);
if (errors.length) errors.slice(0, 5).forEach(e => console.log(' ', e));
await b.close();
