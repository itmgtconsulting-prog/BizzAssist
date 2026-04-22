#!/usr/bin/env node
/**
 * Playwright-verifikation af BIZZ-694 (hovedejendom lejlighedsliste) +
 * BIZZ-695 (fuld ejendomsmodel: søgning + hovedejendom + navigation).
 *
 * Tjekker:
 *   - Liste vises (felter udfyldt)
 *   - Data GIVER MENING: BFE er realistisk, adresser er ikke corrupte,
 *     CVR er 8-cifret, ejer-navn ligner et firmanavn, areal er > 0
 *   - Klik navigerer korrekt til lejlighedens detalje-side
 *   - Søgning returnerer forventede resultater for "Arnold Nielsens Boulevard 62"
 */
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const BASE = 'https://test.bizzassist.dk';
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.fill('input[type=email]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', process.env.E2E_TEST_PASS);
await page.click('button[type=submit]');
try {
  await page.waitForURL(/dashboard/, { timeout: 45000 });
} catch (e) {
  console.log('Login wait-url timeout, URL:', page.url());
  await page.screenshot({ path: '/tmp/verify-screenshots/login-debug.png' });
  // Check if we're actually already on dashboard
  if (!/dashboard/.test(page.url())) {
    await page.waitForTimeout(5000);
    if (!/dashboard/.test(page.url())) throw e;
  }
}
await page.waitForTimeout(2000);

const results = {
  '694': { checks: [], screenshots: [] },
  '695': { checks: [], screenshots: [] },
};
const push = (id, ok, name, detail) => results[id].checks.push({ ok, name, detail });

fs.mkdirSync('/tmp/verify-screenshots', { recursive: true });

// ══ TEST 1: 62A (BFE 226630) hovedejendom Ejerskab-tab ═══════════════
console.log('\n── TEST 1: Hovedejendom 62A (BFE 226630) Ejerskab-tab ──');
await page.goto(`${BASE}/dashboard/ejendomme/226630`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

// Find Ejerskab-tab og klik
const ejerskabBtn = page.locator('button,[role=tab]').filter({ hasText: /^Ejerskab$/ }).first();
if (await ejerskabBtn.count()) {
  await ejerskabBtn.click();
  await page.waitForTimeout(2000);
}

const ss1 = '/tmp/verify-screenshots/694-62A-ejerskab.png';
await page.screenshot({ path: ss1, fullPage: true });
results['694'].screenshots.push(ss1);

// Fang alt tekst-indhold på siden
const pageTxt = (await page.content()) + '\n' + (await page.evaluate(() => document.body.innerText));

// Check: "opdelt i ejerlejligheder" besked står stadig, men der skal være en liste under
const hasOpdeltMsg = /opdelt i ejerlejligheder/i.test(pageTxt);
push('694', hasOpdeltMsg, 'Hovedejendom-besked ("opdelt i ejerlejligheder") vises', hasOpdeltMsg ? 'OK' : 'mangler');

// Check: Lejlighedsliste vises — kig efter "62A 1." og "62A st." (eller varianter)
const has62A1 = /62A[\s,]*1\.?\s*(sal|tv|th|mf|$)/i.test(pageTxt) || /Arnold Nielsens[^,]*62A[^,]*1/i.test(pageTxt);
const has62Ast = /62A[\s,]*st\.?(\s|,|$)/i.test(pageTxt) || /Arnold Nielsens[^,]*62A[^,]*st\./i.test(pageTxt);
push('694', has62A1 || has62Ast, 'Lejlighedsliste indeholder 62A lejligheder (1.sal og/eller st.)',
  `62A 1.sal: ${has62A1}, 62A st.: ${has62Ast}`);

// Check: Ejer "Arnbo 62 ApS" er vist (per commit a7413f1)
const hasEjerNavn = /Arnbo\s*62/i.test(pageTxt);
push('694', hasEjerNavn, 'Ejer-navn "Arnbo 62 ApS" vises på lejligheder', hasEjerNavn ? 'OK' : 'mangler');

// Check: CVR 43924931 vises (8 cifre, valid format)
const cvrMatch = pageTxt.match(/CVR[:\s]*(\d{8})/);
const cvrOk = cvrMatch && cvrMatch[1].length === 8;
push('694', cvrOk, 'CVR vises og er 8-cifret', cvrMatch ? `CVR: ${cvrMatch[1]}` : 'mangler');

// Check: Inget placeholder-skrald (— eller null eller undefined ligger)
const hasUglyPlaceholders = /undefined|\[object Object\]|NaN/.test(pageTxt);
push('694', !hasUglyPlaceholders, 'Ingen rå placeholder-skrald i UI', hasUglyPlaceholders ? 'FUND: undefined/null/NaN' : 'OK');

// Check: Navigation — klik på 62A 1.sal hvis det findes
let navigationWorks = false;
try {
  const lejlighedLink = page.locator('a,button').filter({ hasText: /62A[\s,]*1\./i }).first();
  if (await lejlighedLink.count()) {
    const hrefBefore = page.url();
    await lejlighedLink.click();
    await page.waitForTimeout(1500);
    const hrefAfter = page.url();
    navigationWorks = hrefAfter !== hrefBefore && /\/dashboard\/ejendomme\//.test(hrefAfter);
    push('694', navigationWorks, 'Klik på lejlighed navigerer til detalje-side',
      navigationWorks ? `${hrefBefore.slice(-30)} → ${hrefAfter.slice(-30)}` : 'ingen navigation');
    // Gå tilbage
    await page.goto(`${BASE}/dashboard/ejendomme/226630`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
  } else {
    push('694', false, 'Klik-test: fandt ikke lejligheds-link', 'Ingen clickable element matchede');
  }
} catch (e) {
  push('694', false, 'Navigation test fejlede', e.message.slice(0, 200));
}

// ══ TEST 2: 62B (BFE 226629) hovedejendom ═══════════════
console.log('\n── TEST 2: Hovedejendom 62B (BFE 226629) Ejerskab-tab ──');
await page.goto(`${BASE}/dashboard/ejendomme/226629`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
const ejerBtn2 = page.locator('button,[role=tab]').filter({ hasText: /^Ejerskab$/ }).first();
if (await ejerBtn2.count()) { await ejerBtn2.click(); await page.waitForTimeout(2000); }
const ss2 = '/tmp/verify-screenshots/695-62B-ejerskab.png';
await page.screenshot({ path: ss2, fullPage: true });
results['695'].screenshots.push(ss2);

const pageTxt2 = (await page.content()) + '\n' + (await page.evaluate(() => document.body.innerText));
const has62B1 = /62B[\s,]*1\.?\s*(sal|tv|th|mf|$)/i.test(pageTxt2) || /Arnold Nielsens[^,]*62B[^,]*1/i.test(pageTxt2);
const has62Bst = /62B[\s,]*st\.?(\s|,|$)/i.test(pageTxt2) || /Arnold Nielsens[^,]*62B[^,]*st\./i.test(pageTxt2);
push('695', has62B1 || has62Bst, 'Hovedejendom 62B viser 62B lejligheder',
  `62B 1.sal: ${has62B1}, 62B st.: ${has62Bst}`);

// ══ TEST 3: API check — /api/ejerlejligheder via page.evaluate ══════
console.log('\n── TEST 3: /api/ejerlejligheder data-kvalitet ──');
// Check search API actual shape by trying known fields
const searchProbe = await page.evaluate(async () => {
  const r = await fetch('/api/search?q=' + encodeURIComponent('Arnold Nielsens Boulevard 62')).then(r => r.json()).catch(e => ({ err: e.message }));
  return { keys: Object.keys(r || {}), firstItem: Array.isArray(r) ? r[0] : (r?.results?.[0] ?? r?.adresser?.[0] ?? null), isArray: Array.isArray(r) };
});
console.log('Search API probe:', JSON.stringify(searchProbe).slice(0, 500));

const api = await page.evaluate(async () => {
  // Matrikel for Arnold Nielsens Blvd 62: ejerlavKode=12851, matrikelnr=21by
  const r1 = await fetch('/api/ejerlejligheder?ejerlavKode=12851&matrikelnr=21by&moderBfe=226630').then(r => r.json()).catch(e => ({ err: e.message }));
  const r2 = await fetch('/api/ejerlejligheder?ejerlavKode=12851&matrikelnr=21by&moderBfe=226629').then(r => r.json()).catch(e => ({ err: e.message }));
  return { for_62A: r1, for_62B: r2 };
});
console.log('API 62A:', JSON.stringify(api.for_62A).slice(0, 500));
console.log('API 62B:', JSON.stringify(api.for_62B).slice(0, 500));

const lejl62A = api.for_62A?.lejligheder || [];
const lejl62B = api.for_62B?.lejligheder || [];
push('694', lejl62A.length >= 2, `/api/ejerlejligheder for 62A returnerer ≥ 2 lejligheder`, `faktisk: ${lejl62A.length}`);
push('695', lejl62B.length >= 2, `/api/ejerlejligheder for 62B returnerer ≥ 2 lejligheder`, `faktisk: ${lejl62B.length}`);

// Data-kvalitet check på 62A lejligheder
if (lejl62A.length > 0) {
  const first = lejl62A[0];
  const fieldCheck = {
    adresse: !!first.adresse && first.adresse.length > 5,
    bfe: first.bfe && Number.isFinite(Number(first.bfe)) && String(first.bfe).length >= 5,
    ejer: !!first.ejer && !/undefined|null|NaN/i.test(String(first.ejer)),
    areal: first.areal != null ? Number(first.areal) > 0 : null, // Kan være null iflg. ticket
  };
  console.log('62A første lejlighed fields:', JSON.stringify(first).slice(0, 400));
  push('694', fieldCheck.adresse, 'Lejlighed.adresse er udfyldt og ser meningsfuld ud', `"${first.adresse}"`);
  push('694', fieldCheck.bfe, 'Lejlighed.bfe er et gyldigt BFE-nummer', `BFE: ${first.bfe}`);
  push('694', fieldCheck.ejer, 'Lejlighed.ejer er udfyldt', `ejer: "${JSON.stringify(first.ejer).slice(0, 80)}"`);
  if (fieldCheck.areal !== null) {
    push('694', fieldCheck.areal, 'Lejlighed.areal er > 0', `areal: ${first.areal}`);
  }
}

// ══ TEST 4: Søgning på "Arnold Nielsens Boulevard 62" ══════════════════
console.log('\n── TEST 4: Søgning på "Arnold Nielsens Boulevard 62" ──');
await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const searchApi = await page.evaluate(async () => {
  const r = await fetch('/api/search?q=' + encodeURIComponent('Arnold Nielsens Boulevard 62')).then(r => r.json()).catch(e => ({ err: e.message }));
  return r;
});
console.log('Search API response keys:', Object.keys(searchApi || {}));
const ejdResults = searchApi?.ejendomme || searchApi?.results?.filter(r => r.type === 'ejendom') || searchApi?.adresser || [];
console.log(`Search returnerer ${Array.isArray(ejdResults) ? ejdResults.length : 0} ejendomme-resultater`);

if (Array.isArray(ejdResults) && ejdResults.length) {
  const firstFew = ejdResults.slice(0, 10).map(r => r.adresse || r.title || r.label || JSON.stringify(r).slice(0, 80));
  console.log('First 10:', firstFew);
  const has62A = firstFew.some(s => /62A/i.test(s));
  const has62B = firstFew.some(s => /62B/i.test(s));
  const hasLejligheder = firstFew.some(s => /\b1\.\s*(sal|tv|th)|st\./i.test(s));
  push('695', has62A && has62B, 'Søgning returnerer både 62A og 62B', `62A: ${has62A}, 62B: ${has62B}`);
  push('695', hasLejligheder, 'Søgning indeholder også lejlighedsadresser (1.sal/st.)', hasLejligheder ? 'OK' : 'kun adgangsadresser — ikke complete');
}

// ══ Summary ══════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(70));
for (const id of ['694', '695']) {
  const pass = results[id].checks.filter(c => c.ok).length;
  const total = results[id].checks.length;
  console.log(`\nBIZZ-${id}: ${pass}/${total} checks passed`);
  for (const c of results[id].checks) {
    console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}`);
    if (c.detail) console.log(`      ${c.detail}`);
  }
}

fs.writeFileSync('/tmp/verify-screenshots/694-695-results.json', JSON.stringify(results, null, 2));
console.log('\n📄 JSON: /tmp/verify-screenshots/694-695-results.json');

await b.close();
