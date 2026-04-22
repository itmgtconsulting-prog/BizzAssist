import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext();
const page = await ctx.newPage();
await page.goto('https://test.bizzassist.dk/login', { waitUntil: 'domcontentloaded' });
await page.fill('input[type=email]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', process.env.E2E_TEST_PASS);
await Promise.all([page.waitForURL(/dashboard/, { timeout: 30000 }), page.click('button[type=submit]')]);
await page.waitForTimeout(2000);
const r = await page.evaluate(async () => {
  const s = await fetch('/api/cvr-search?q=JAJR+Ejendomme').then(r => r.json()).catch(e => ({err: e.message}));
  const a = await fetch('/api/cvr-search?q=ArnBo').then(r => r.json()).catch(e => ({err: e.message}));
  return { jajr: s, arnbo: a };
});
console.log('JAJR:', JSON.stringify(r.jajr).slice(0, 800));
console.log('\nARNBO:', JSON.stringify(r.arnbo).slice(0, 800));
// Now probe /api/tinglysning/virksomhed with the correct CVR
if (Array.isArray(r.jajr?.results)) {
  for (const v of r.jajr.results.slice(0, 3)) {
    if (!v.cvr) continue;
    const rr = await page.evaluate(async (cvr) => {
      const res = await fetch(`/api/tinglysning/virksomhed?cvr=${cvr}`);
      return { status: res.status, body: await res.json().catch(() => null) };
    }, v.cvr);
    const n = rr.body?.ejer?.length || 0;
    console.log(`\nCVR ${v.cvr} (${v.navn}) → /tinglysning/virksomhed: ${n} ejer-rækker`);
    if (n > 0) {
      const bfes = new Set(rr.body.ejer.map((x) => x.bfe));
      console.log(`  BFEs: ${[...bfes].slice(0, 10).join(', ')}`);
      const relevant = rr.body.ejer.filter((x) => [2091166, 425479, 2091185, 2024847, 100065801].includes(x.bfe));
      if (relevant.length) {
        console.log(`  RELEVANT to BIZZ-685/693:`);
        for (const rel of relevant) {
          console.log(`    BFE ${rel.bfe} adkomst=${rel.adkomstType} dok=${rel.dokumentId?.slice(0, 10)} alias=${rel.dokumentAlias}`);
        }
      }
    }
  }
}
await b.close();
