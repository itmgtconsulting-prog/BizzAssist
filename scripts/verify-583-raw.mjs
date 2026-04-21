import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });
const BASE='https://bizzassist.dk';
async function login(page){ await page.goto(`${BASE}/login`); await page.waitForLoadState('domcontentloaded');
  const c = page.getByRole('button', { name: /Accept/i }); if (await c.isVisible({timeout:3000}).catch(()=>false)) await c.click();
  await page.getByPlaceholder('navn@virksomhed.dk').fill(process.env.E2E_TEST_EMAIL);
  await page.getByPlaceholder('••••••••').fill(process.env.E2E_TEST_PASS);
  await page.getByRole('button', { name: /Log ind/i }).click();
  await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 20000 });
  if (page.url().includes('/onboarding')) await page.goto(`${BASE}/dashboard`);
}
const browser = await chromium.launch({headless:true}); const ctx = await browser.newContext({ignoreHTTPSErrors:true});
const page = await ctx.newPage(); await login(page);
for (const bfe of [100165718, 425479, 226629]) {
  const r = await page.evaluate(async(b)=>{
    const res = await fetch(`/api/ejendomsadmin?bfeNummer=${b}`, {credentials:'include'});
    return { status: res.status, body: (await res.text()).slice(0, 300) };
  }, bfe);
  console.log(`BFE ${bfe}: HTTP ${r.status}`);
  console.log('  body:', r.body);
}
await browser.close();
