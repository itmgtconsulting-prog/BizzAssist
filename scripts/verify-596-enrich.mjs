import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: '/root/BizzAssist/.env.local' });
const BASE = 'https://test.bizzassist.dk';
async function login(page) {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState('domcontentloaded');
  const c = page.getByRole('button', { name: /Acceptér|Accepter/i });
  if (await c.isVisible({ timeout: 2000 }).catch(() => false)) await c.click();
  await page.getByPlaceholder('navn@virksomhed.dk').fill(process.env.E2E_TEST_EMAIL);
  await page.getByPlaceholder('••••••••').fill(process.env.E2E_TEST_PASS);
  await page.getByRole('button', { name: /Log ind/i }).click();
  await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 30000 });
  if (page.url().includes('/onboarding')) await page.goto(`${BASE}/dashboard`);
}
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
await login(page);
// Test Kaffevej 31 ejerlejlighed + Søbyvej 11 (bolig)
for (const bfe of [425479, 2081243]) {
  const resp = await page.evaluate(async (b) => {
    const r = await fetch(`/api/ejendomme-by-owner/enrich?bfe=${b}&_cb=${Date.now()}`, { credentials:'include', cache:'no-store' });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return await r.json();
  }, bfe);
  console.log(`BFE ${bfe}: bolig=${resp.boligAreal ?? 'null'}  erhv=${resp.erhvervsAreal ?? 'null'}  matr=${resp.matrikelAreal ?? 'null'}`);
}
await browser.close();
