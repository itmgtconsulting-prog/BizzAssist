import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });
const BASE = 'https://test.bizzassist.dk';
fs.mkdirSync('/tmp/verify-screenshots', { recursive: true });
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('input[type=email]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', process.env.E2E_TEST_PASS);
await Promise.all([page.waitForURL(/dashboard/, { timeout: 30000 }), page.click('button[type=submit]')]);
await page.waitForTimeout(2000);

// ── BIZZ-692: Ejerskab tab shows selskabsnavn ────────────────────────────
console.log('=== BIZZ-692: Ejerskab tab selskabsnavn ===');
await page.goto(`${BASE}/dashboard/ejendomme/0a3f507c-ce08-32b8-e044-0003ba298018`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
const ejTab = page.locator('button:has-text("Ejerskab")').filter({ has: page.locator('svg') }).first();
await ejTab.click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(4000);
await page.screenshot({ path: '/tmp/verify-screenshots/692-ejerskab.png', fullPage: false });

const hasJAJR = await page.getByText(/JAJR Ejendomme ApS/).count();
const hasOnlyCvrPrefix = await page.locator('text=/^CVR \\d{8}/').count();
const h1Text = await page.locator('h2, h3, [class*="font-bold"]').allTextContents().catch(() => []);
console.log('hasJAJR-text:', hasJAJR, '| CVR-only entries:', hasOnlyCvrPrefix);

// ── BIZZ-680: DB-first sitemap ───────────────────────────────────────────
console.log('\n=== BIZZ-680: DB-first sitemap ===');
// Check sitemap/0.xml for both ejendom + virksomhed URLs
const sitemap = await page.evaluate(async () => {
  const r = await fetch('https://bizzassist.dk/sitemap/0.xml?_=' + Date.now());
  const txt = await r.text();
  const ejendomCount = (txt.match(/\/ejendom\//g) || []).length;
  const virksomhedCount = (txt.match(/\/virksomhed\//g) || []).length;
  return { ejendomCount, virksomhedCount, total: ejendomCount + virksomhedCount, sample: txt.slice(0, 300) };
});
console.log('sitemap:', sitemap);

// Verify sub-regression checks: diagram + virksomheder + personer tabs on company
console.log('\n=== BIZZ-680 regression check: company tabs ===');
await page.goto(`${BASE}/dashboard/companies/26316804`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
const diagramTab = page.locator('button:has-text("Diagram")').filter({ has: page.locator('svg') }).first();
await diagramTab.click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(3000);
const jajrInDiagram = await page.getByText(/JAJR Ejendomme/).count();
await page.screenshot({ path: '/tmp/verify-screenshots/680-diagram.png', fullPage: false });
console.log('JAJR in diagram:', jajrInDiagram);

await b.close();
