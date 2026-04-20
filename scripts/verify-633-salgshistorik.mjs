import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });
const BASE='https://test.bizzassist.dk';
async function login(page){ await page.goto(`${BASE}/login`); await page.waitForLoadState('domcontentloaded');
  const c = page.getByRole('button', { name: /Acceptér|Accepter/i }); if (await c.isVisible({timeout:3000}).catch(()=>false)) await c.click();
  await page.getByPlaceholder('navn@virksomhed.dk').fill(process.env.E2E_TEST_EMAIL);
  await page.getByPlaceholder('••••••••').fill(process.env.E2E_TEST_PASS);
  await page.getByRole('button', { name: /Log ind/i }).click();
  await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 30000 });
  if (page.url().includes('/onboarding')) await page.goto(`${BASE}/dashboard`);
}
const browser = await chromium.launch({headless:true}); const ctx = await browser.newContext({ignoreHTTPSErrors:true});
const page = await ctx.newPage(); await login(page);
const bfes = [425479, 226629, 100165718];
for (const b of bfes){
  const r = await page.evaluate(async(b)=>{
    const r=await fetch(`/api/salgshistorik?bfeNummer=${b}&_cb=${Date.now()}`,{credentials:'include',cache:'no-store'});
    if(!r.ok) return {error:`HTTP ${r.status}`};
    const d=await r.json();
    return {count: d.handler?.length ?? 0, fejl: d.fejl, first: d.handler?.[0]?.overtagelsesdato, last: d.handler?.[d.handler.length-1]?.overtagelsesdato};
  }, b);
  console.log(`BFE ${b}:`, JSON.stringify(r));
}
await browser.close();
