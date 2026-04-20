import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });
const BASE='https://test.bizzassist.dk';
const EMAIL = 'itmgtconsulting@gmail.com';
const PASS = process.env.ADMIN_PASS || process.env.E2E_TEST_PASS;
const browser = await chromium.launch({headless:true}); const ctx = await browser.newContext({ignoreHTTPSErrors:true});
const page = await ctx.newPage();
await page.goto(`${BASE}/login`);
const c = page.getByRole('button', { name: /Acceptér|Accepter/i });
if (await c.isVisible({timeout:3000}).catch(()=>false)) await c.click();
await page.getByPlaceholder('navn@virksomhed.dk').fill(EMAIL);
await page.getByPlaceholder('••••••••').fill(PASS);
await page.getByRole('button', { name: /Log ind/i }).click();
try { await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 20000 }); }
catch(e) { console.log('login failed:', page.url(), '— password may be wrong'); await browser.close(); process.exit(0); }
if (page.url().includes('/onboarding')) await page.goto(`${BASE}/dashboard`);
const r = await page.evaluate(async ()=>{
  const res = await fetch('/api/ai/chat?_cb='+Date.now(), {
    method: 'POST', credentials: 'include', cache: 'no-store',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Hej' }] }),
  });
  const body = await res.text();
  return { status: res.status, body: body.slice(0, 400) };
});
console.log('status:', r.status);
console.log('body:', r.body);
if (r.status === 402 && r.body.includes('trial_ai_blocked')) console.log('✅ P0 FIX VERIFIED');
else if (r.status === 200) console.log('❌ P0 REGRESSION');
else console.log('ℹ️  Unknown — manual review needed');
await browser.close();
