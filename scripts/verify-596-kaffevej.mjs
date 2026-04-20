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

// Test Kaffevej 31 1.tv — ejerlejlighed BFE 425479
// First without dawaId
console.log('=== enrich?bfe=425479 (no dawaId) ===');
let r = await page.evaluate(async()=>{
  const res = await fetch(`/api/ejendomme-by-owner/enrich?bfe=425479&_cb=${Date.now()}`, {credentials:'include',cache:'no-store'});
  return await res.json();
});
console.log('bolig:', r.boligAreal, 'erhv:', r.erhvervsAreal, 'matr:', r.matrikelAreal);

// Also try via listing to get dawaId
console.log('\n=== listing for CVR that owns Kaffevej 31 ===');
r = await page.evaluate(async()=>{
  const res = await fetch(`/api/ejendomme-by-owner?cvr=26316804&limit=30`, {credentials:'include'});
  if(!res.ok) return {error: res.status};
  const d = await res.json();
  const kaffe = (d.ejendomme||[]).find(e => String(e.bfeNummer ?? e.bfe_nummer ?? e.bfe) === '425479');
  return kaffe ? { bfe: kaffe.bfeNummer, dawaId: kaffe.dawaId, adresse: kaffe.adresse } : {notFound: true};
});
console.log(JSON.stringify(r));

// If we got dawaId, retry with it
if (r.dawaId) {
  console.log(`\n=== enrich?bfe=425479&dawaId=${r.dawaId} ===`);
  const r2 = await page.evaluate(async(dawaId)=>{
    const res = await fetch(`/api/ejendomme-by-owner/enrich?bfe=425479&dawaId=${dawaId}&_cb=${Date.now()}`, {credentials:'include',cache:'no-store'});
    return await res.json();
  }, r.dawaId);
  console.log('bolig:', r2.boligAreal, 'erhv:', r2.erhvervsAreal, 'matr:', r2.matrikelAreal);
}
await browser.close();
