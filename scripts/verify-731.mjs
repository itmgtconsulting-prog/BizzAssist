#!/usr/bin/env node
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
try { await page.waitForURL(/dashboard/, { timeout: 45000 }); } catch { await page.waitForTimeout(5000); }
await page.waitForTimeout(2500);

// Test via API først — mest deterministisk
console.log('\n── API probe /api/ejendomme-by-owner for owner 4000115446 ──');
// Probe flere endpoints + params indtil vi finder en der returnerer noget
const api = await page.evaluate(async () => {
  const tries = [
    '/api/ejendomme-by-owner?enhedsNummer=4000115446',
    '/api/ejendomme-by-owner?owner=4000115446',
    '/api/ejendomme-by-owner/enrich?enhedsNummer=4000115446',
    '/api/person-properties?enhedsNummer=4000115446',
    '/api/person/4000115446/ejendomme',
  ];
  const out = {};
  for (const u of tries) {
    try {
      const r = await fetch(u);
      const json = r.ok ? await r.json().catch(() => null) : null;
      const keys = json ? Object.keys(json).slice(0, 10) : [];
      out[u] = { status: r.status, keys, preview: JSON.stringify(json).slice(0, 300) };
    } catch (e) { out[u] = { err: e.message }; }
  }
  return out;
});
console.log('\nEndpoint probe:');
for (const [u, r] of Object.entries(api)) {
  console.log(`  ${u} → ${r.status} keys=[${r.keys?.join(',')}]`);
  if (r.preview) console.log(`     ${r.preview}`);
}

if (api.err) {
  console.log('API fejl:', api.err);
  await b.close();
  process.exit(1);
}

const ejdm = api.ejendomme || api.personligeEjendomme || api.results || (Array.isArray(api) ? api : []);
console.log(`Fandt ${Array.isArray(ejdm) ? ejdm.length : 0} ejendomme i response`);

// Find de 4 BFEer
const expected = [
  { bfe: 100165718, adresse: 'Thorvald Bindesbølls Plads 18, 3. th', expected_bolig_m2: 82 }, // fra Jakob's kommentar
  { bfe: 173448, adresse: 'Horsekildevej 26, 2. tv' },
  { bfe: 100435372, adresse: 'J.C. Jacobsens Gade 11, 5. th' },
  { bfe: 167448, adresse: 'Vigerslevvej 146, 1. th' },
];

// Check rå API data først
console.log('\n── Rå API data pr. BFE ──');
const arr = Array.isArray(ejdm) ? ejdm : (ejdm.personligeEjendomme || ejdm.ejendomme || []);
const checks = [];

for (const exp of expected) {
  const found = arr.find(e =>
    e.bfe === exp.bfe || e.bfeNummer === exp.bfe || Number(e.bfe) === exp.bfe || Number(e.bfeNummer) === exp.bfe
  );
  if (!found) {
    checks.push({ ok: false, bfe: exp.bfe, name: `BFE ${exp.bfe} findes i API response`, detail: 'mangler' });
    continue;
  }
  // Forsøg at læse bolig-m²
  const bolig = found.boligAreal ?? found.bolig ?? found.bbr?.bolig ?? found.arealBolig ?? null;
  console.log(`  BFE ${exp.bfe}: bolig=${bolig}, felter=${Object.keys(found).slice(0, 10).join(',')}`);
  checks.push({
    ok: bolig !== null && bolig > 0,
    bfe: exp.bfe,
    name: `BFE ${exp.bfe} (${exp.adresse}) har bolig-m² > 0`,
    detail: `bolig=${bolig} m²${exp.expected_bolig_m2 ? ` (forventet ~${exp.expected_bolig_m2})` : ''}`,
  });
}

// Direkte BBR-probe på hver af de 4 BFEer — det er den mest direkte test af fix'et
console.log('\n── Direkte BBR-probe pr. BFE ──');
for (const exp of expected) {
  const r = await page.evaluate(async (bfe) => {
    const res = await fetch(`/api/bbr?bfe=${bfe}`).then(r => r.json()).catch(e => ({ err: e.message }));
    return res;
  }, exp.bfe);
  const bolig = r?.boligAreal ?? r?.bolig ?? r?.arealBolig ?? r?.samletAreal ?? null;
  const boligErhverv = r?.erhvervsAreal ?? r?.erhverv ?? null;
  console.log(`  BFE ${exp.bfe} (${exp.adresse})`);
  console.log(`    response keys: ${Object.keys(r).slice(0, 12).join(',')}`);
  console.log(`    bolig=${bolig}, erhverv=${boligErhverv}`);
  checks.push({
    ok: bolig !== null && bolig > 0,
    bfe: exp.bfe,
    name: `/api/bbr?bfe=${exp.bfe}: boligAreal > 0 (fix verificeret direkte)`,
    detail: `bolig=${bolig} m²${exp.expected_bolig_m2 ? ` (Jakob angav ~${exp.expected_bolig_m2})` : ''}`,
  });
}

// Alternativ: UI-verification ved at navigere til ejendomsiden for BFE 100165718
console.log('\n── UI verification på ejendomsside for BFE 100165718 ──');
// Løs først DAWA-UUID for ejendommen via /api/search eller gå direkte med BFE
// Prøv først BFE-URL fallback
await page.goto(`${BASE}/dashboard/owners/4000115446`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

// Klik Ejendomme-tab
const ejdmBtn = page.locator('button,[role=tab]').filter({ hasText: /^Ejendomme$/i }).first();
if (await ejdmBtn.count()) { await ejdmBtn.click(); await page.waitForTimeout(3000); }

fs.mkdirSync('/tmp/verify-screenshots', { recursive: true });
const ss = '/tmp/verify-screenshots/731-person-ejendomme.png';
await page.screenshot({ path: ss, fullPage: true });

const bodyTxt = await page.evaluate(() => document.body.innerText);

// Tjek hver forventet adresse for "0 m²" (skal IKKE findes)
for (const exp of expected) {
  // Find den tekst der matcher adressen og check omliggende tekst for bolig
  const adresseFragment = exp.adresse.split(',')[0]; // "Thorvald Bindesbølls Plads 18"
  const re = new RegExp(adresseFragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]{0,300}?bolig\\s*[:\\s]*([\\d]+)', 'i');
  const m = bodyTxt.match(re);
  const boligUi = m ? Number(m[1]) : null;
  checks.push({
    ok: boligUi !== null && boligUi > 0,
    bfe: exp.bfe,
    name: `UI viser korrekt bolig-m² for ${exp.adresse}`,
    detail: m ? `"Bolig: ${boligUi} m²"` : 'ingen match i DOM',
  });
}

// Check at det IKKE står "Bolig: 0 m²" på siden (regression-guard)
const hasZero = /(bolig|bbr)[:\s]*0\s*m²/i.test(bodyTxt);
checks.push({ ok: !hasZero, bfe: '-', name: 'Ingen "Bolig: 0 m²" tekst i UI (regression-guard)', detail: hasZero ? 'FUND: "0 m²" synlig' : 'clean' });

// Summary
console.log('\n' + '═'.repeat(70));
const pass = checks.filter(c => c.ok).length;
console.log(`BIZZ-731: ${pass}/${checks.length} passed`);
for (const c of checks) {
  console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}`);
  if (c.detail) console.log(`      ${c.detail}`);
}
fs.writeFileSync('/tmp/verify-screenshots/731-results.json', JSON.stringify({ checks, raw_api: arr.filter(e => expected.some(x => x.bfe === e.bfe || x.bfe === e.bfeNummer)) }, null, 2));
await b.close();
