import { chromium, devices } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});
const BASE = 'https://test.bizzassist.dk';
const b = await chromium.launch({ headless: true });

// iPhone SE — smallest common viewport (375×667)
const iphoneSE = {
  ...devices['iPhone 13'],
  viewport: { width: 375, height: 667 },
};
const ctx = await b.newContext({ ...iphoneSE });
const page = await ctx.newPage();

const results = {};

// ── BIZZ-673: viewport maximumScale removed ─────────────────────────────
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
// Dismiss cookie banner if present
await page
  .locator('button', { hasText: /kun nødvendige|accepter/i })
  .first()
  .click({ timeout: 3000 })
  .catch(() => {});
await page.waitForTimeout(500);
const viewportMeta = await page.locator('meta[name="viewport"]').getAttribute('content');
results['BIZZ-673 viewport'] = viewportMeta;

// ── BIZZ-679: PWA start_url ──────────────────────────────────────────────
const manifest = await page.evaluate(async () => {
  const r = await fetch('/manifest.json');
  return r.json();
});
results['BIZZ-679 start_url'] = manifest.start_url;

// ── BIZZ-677 + BIZZ-678: Hero image + h1 ─────────────────────────────────
const heroH1 = await page
  .locator('h1')
  .first()
  .evaluate((el) => {
    const s = getComputedStyle(el);
    return { text: el.textContent.slice(0, 40), fontSize: s.fontSize, classes: el.className.slice(0, 150) };
  })
  .catch(() => null);
results['BIZZ-678 h1 fontSize'] = heroH1;

const heroImg = await page
  .locator('img[alt="BizzAssist Dashboard"]')
  .first()
  .evaluate((el) => ({
    sizes: el.getAttribute('sizes'),
    width: el.getAttribute('width'),
    height: el.getAttribute('height'),
    naturalW: el.naturalWidth,
  }))
  .catch(() => null);
results['BIZZ-677 hero img'] = heroImg;

// ── BIZZ-672: login input font-size ──────────────────────────────────────
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page
  .locator('button', { hasText: /kun nødvendige|accepter/i })
  .first()
  .click({ timeout: 3000 })
  .catch(() => {});
await page.waitForTimeout(500);
const emailInput = await page
  .locator('input[type=email]')
  .first()
  .evaluate((el) => {
    const s = getComputedStyle(el);
    return { fontSize: s.fontSize, classes: el.className.slice(0, 80) };
  })
  .catch(() => null);
results['BIZZ-672 email input'] = emailInput;

// ── BIZZ-674: search dropdown on iPhone SE ───────────────────────────────
await page.fill('input[type=email]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', process.env.E2E_TEST_PASS);
await Promise.all([
  page.waitForURL(/dashboard/, { timeout: 30000 }).catch(() => null),
  page.click('button[type=submit]'),
]);
await page.waitForTimeout(4000);

const searchInput = page.locator('input[placeholder*="Søg" i]').first();
const searchExists = await searchInput.count();
if (searchExists > 0) {
  await searchInput.focus();
  await searchInput.type('test');
  await page.waitForTimeout(1500);
  // Check any portal-rendered dropdown
  const dropdownBox = await page.evaluate(() => {
    const el = document.querySelector('[role="listbox"], [class*="dropdown"], [class*="portal"] > div');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, right: r.right, vpW: window.innerWidth };
  });
  results['BIZZ-674 dropdown'] = dropdownBox;
}

await page.screenshot({ path: '/tmp/verify-mobile-home.png', fullPage: false });
await b.close();

console.log(JSON.stringify(results, null, 2));
