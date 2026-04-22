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
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('input[type=email]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', process.env.E2E_TEST_PASS);
await Promise.all([page.waitForURL(/dashboard/, { timeout: 30000 }), page.click('button[type=submit]')]);
await page.waitForTimeout(2000);

const out = {};

async function timedFetch(path) {
  return page.evaluate(async (p) => {
    const t0 = performance.now();
    const r = await fetch(p);
    const ms = Math.round(performance.now() - t0);
    const txt = await r.text();
    let body = null;
    try {
      body = JSON.parse(txt);
    } catch {}
    return { status: r.status, ms, bytes: txt.length, body };
  }, path);
}

// ── /api/cvr/[cvr] ─────────────────────────────────────────────────────
const cvrR = await timedFetch('/api/cvr/26316804');
out['cvr_single'] = { status: cvrR.status, ms: cvrR.ms, hasName: !!cvrR.body?.name, name: cvrR.body?.name };

// ── /api/cvr-public?vat= (cache-first existing) ─────────────────────────
const cvrPub = await timedFetch('/api/cvr-public?vat=26316804');
out['cvr_public'] = { status: cvrPub.status, ms: cvrPub.ms, name: cvrPub.body?.name };

// ── /api/ejendomme-by-owner?cvr= ─────────────────────────────────────────
const ejOwn = await timedFetch('/api/ejendomme-by-owner?cvr=26316804');
out['ejendomme_by_owner'] = {
  status: ejOwn.status,
  ms: ejOwn.ms,
  count: (ejOwn.body?.ejendomme || ejOwn.body?.bfes || []).length,
};

// ── /api/ejerskab?bfe= ───────────────────────────────────────────────────
// Use a known BFE from our ejf_ejerskab table
const ejer = await timedFetch('/api/ejerskab?bfeNummer=425479');
out['ejerskab'] = {
  status: ejer.status,
  ms: ejer.ms,
  count: (ejer.body?.ejere || ejer.body?.ejerskaber || []).length,
  ejere_sample: (ejer.body?.ejere || []).slice(0, 2),
};

// Second call to measure cache-hit speed
const ejer2 = await timedFetch('/api/ejerskab?bfeNummer=425479');
out['ejerskab_2nd'] = { ms: ejer2.ms };
const cvr2 = await timedFetch('/api/cvr/26316804');
out['cvr_single_2nd'] = { ms: cvr2.ms };

// ── Visual: company page rendering ───────────────────────────────────────
await page.goto(`${BASE}/dashboard/companies/26316804`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(5000);
const companyH1 = await page.locator('h1').first().textContent().catch(() => null);
const hasInfo = await page.getByText(/Stiftet|CVR/i).first().count();
await page.screenshot({ path: '/tmp/verify-screenshots/680-company.png', fullPage: false });
out['company_page'] = { h1: companyH1?.trim(), hasInfo, screenshot: '680-company.png' };

// ── Visual: property page ──────────────────────────────────────────────
await page.goto(`${BASE}/dashboard/ejendomme/425479`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(5000);
await page.screenshot({ path: '/tmp/verify-screenshots/680-property.png', fullPage: false });
const notFound = (await page.getByText(/Ejendom ikke fundet|ikke fundet/i).count()) > 0;
out['property_page'] = { notFound, screenshot: '680-property.png' };

console.log(JSON.stringify(out, null, 2));
await b.close();
