#!/usr/bin/env node
/**
 * V2: brug DAWA-UUID i URL (ikke BFE), verificér UI-rendering af
 * lejlighedsliste + data-kvalitet.
 */
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const BASE = 'https://test.bizzassist.dk';
const DAWA_62A = '0a3f507c-b62a-32b8-e044-0003ba298018'; // adgangsadresse 62A (hovedejendom)

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
} catch {
  console.log('login timeout URL:', page.url());
  await page.waitForTimeout(5000);
}
await page.waitForTimeout(2500);

const checks = { '694': [], '695': [] };
const add = (id, ok, name, detail) => checks[id].push({ ok, name, detail });

fs.mkdirSync('/tmp/verify-screenshots', { recursive: true });

// ── TEST 1: Find 62B DAWA-UUID via søgning ──
console.log('\n── Finder DAWA-UUIDs via search ──');
const search = await page.evaluate(async (q) => {
  const r = await fetch('/api/search?q=' + encodeURIComponent(q)).then(r => r.json());
  return Array.isArray(r) ? r : (r.results ?? []);
}, 'Arnold Nielsens Boulevard 62');

const hovedejendomme = search.filter(s => s.type === 'address' && /62[AB]/i.test(s.title) && !s.meta?.etage);
const lejligheder = search.filter(s => s.type === 'address' && /62[AB]/i.test(s.title) && s.meta?.etage);
console.log('Hovedejendomme fundet:', hovedejendomme.map(h => h.title));
console.log('Lejligheder fundet:', lejligheder.map(l => `${l.title} (etage=${l.meta?.etage || '-'}, dør=${l.meta?.['dør'] || '-'})`));

// BIZZ-695 acceptance: søgning skal returnere 62A + 62B + lejligheder
const has62A = hovedejendomme.some(h => /62A/i.test(h.title));
const has62B = hovedejendomme.some(h => /62B/i.test(h.title));
const has62Alejl = lejligheder.some(l => /62A/i.test(l.title));
const has62Blejl = lejligheder.some(l => /62B/i.test(l.title));
add('695', has62A, 'Søgning indeholder 62A hovedejendom', has62A ? 'OK' : 'mangler');
add('695', has62B, 'Søgning indeholder 62B hovedejendom', has62B ? 'OK' : 'mangler');
add('695', has62Alejl, 'Søgning indeholder 62A lejligheder (med etage)', has62Alejl ? `${lejligheder.filter(l => /62A/i.test(l.title)).length} lejligheder` : 'mangler');
add('695', has62Blejl, 'Søgning indeholder 62B lejligheder (med etage)', has62Blejl ? `${lejligheder.filter(l => /62B/i.test(l.title)).length} lejligheder` : 'mangler');

const dawa62B = hovedejendomme.find(h => /62B/i.test(h.title))?.id;

// ── TEST 2: Åbn 62A hovedejendom og tjek Ejerskab-tab ──
console.log('\n── 62A hovedejendom Ejerskab-tab ──');
await page.goto(`${BASE}/dashboard/ejendomme/${DAWA_62A}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3500);

// Luk cookie-banner hvis den blokkerer
try {
  const cookieBtn = page.locator('button').filter({ hasText: /Kun n.dvendige|Accept/ }).first();
  if (await cookieBtn.count()) { await cookieBtn.click(); await page.waitForTimeout(500); }
} catch {}

// Klik Ejerskab-tab
const ejerskabBtn = page.locator('button,[role=tab]').filter({ hasText: /^Ejerskab$/i }).first();
const tabCount = await ejerskabBtn.count();
if (tabCount) {
  await ejerskabBtn.click();
  await page.waitForTimeout(3000);
}

const ss62A = '/tmp/verify-screenshots/694-62A-v2.png';
await page.screenshot({ path: ss62A, fullPage: true });
console.log('Screenshot:', ss62A);

// Tjek hvilken tab vi er på (URL + overskrift)
const currentUrl = page.url();
add('694', /ejendomme\/0a3f507c/.test(currentUrl), 'Landede korrekt på 62A ejendomside via DAWA-UUID', currentUrl.slice(-80));

// Hent hele body-teksten
const bodyText = await page.evaluate(() => document.body.innerText);
const hasEjerskabOverskrift = /Ejerskab|Ejerforhold|Ejerstruktur/i.test(bodyText);
add('694', hasEjerskabOverskrift, 'Ejerskab-sektion er synlig', hasEjerskabOverskrift ? 'OK' : 'mangler');

// Tjek for lejligheds-rækker (62A st., 62A 1.sal, 62B st., 62B 1.sal)
const lejlMatches = {
  '62A st': /62A[\s,]*,?\s*st\./i.test(bodyText),
  '62A 1.': /62A[\s,]*,?\s*1\./i.test(bodyText),
  '62B st': /62B[\s,]*,?\s*st\./i.test(bodyText),
  '62B 1.': /62B[\s,]*,?\s*1\./i.test(bodyText),
};
const lejlFundet = Object.values(lejlMatches).filter(Boolean).length;
add('694', lejlFundet >= 2, 'UI viser ≥ 2 lejligheder med etage-info', `Fundet: ${Object.entries(lejlMatches).filter(([,v]) => v).map(([k]) => k).join(', ')}`);

// Tjek ejer "Arnbo 62 ApS" vises i UI
const hasEjerNavnUI = /Arnbo\s*62\s*ApS/i.test(bodyText);
add('694', hasEjerNavnUI, 'Ejer "Arnbo 62 ApS" vises i UI', hasEjerNavnUI ? 'OK' : 'mangler i DOM-tekst');

// Tjek placeholder-skrald
const hasSkrald = /undefined|NaN|\[object Object\]/.test(bodyText);
add('694', !hasSkrald, 'Ingen undefined/NaN/[object Object] i UI', hasSkrald ? 'fundet' : 'clean');

// Klik navigation på første lejlighed
let navOk = false;
try {
  const lejlLink = page.locator('a, button, [role=link]').filter({ hasText: /62[AB][\s,]*,?\s*(st\.|1\.)/i }).first();
  if (await lejlLink.count()) {
    const before = page.url();
    await lejlLink.click();
    await page.waitForTimeout(2500);
    const after = page.url();
    navOk = before !== after && /\/dashboard\/ejendomme\//.test(after);
    add('694', navOk, 'Klik på lejlighed navigerer til detaljeside', `${before.slice(-40)} → ${after.slice(-40)}`);
    await page.goto(`${BASE}/dashboard/ejendomme/${DAWA_62A}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
  } else {
    add('694', false, 'Klik-test: ingen lejligheds-link fundet', 'lokator tomt');
  }
} catch (e) {
  add('694', false, 'Klik-navigation fejlede', e.message.slice(0, 120));
}

// ── TEST 3: 62B hovedejendom ──
if (dawa62B) {
  console.log(`\n── 62B hovedejendom Ejerskab-tab (DAWA ${dawa62B.slice(0, 8)}...) ──`);
  await page.goto(`${BASE}/dashboard/ejendomme/${dawa62B}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3500);
  const ejerBtn62B = page.locator('button,[role=tab]').filter({ hasText: /^Ejerskab$/i }).first();
  if (await ejerBtn62B.count()) { await ejerBtn62B.click(); await page.waitForTimeout(3000); }
  const ss62B = '/tmp/verify-screenshots/695-62B-v2.png';
  await page.screenshot({ path: ss62B, fullPage: true });
  const body62B = await page.evaluate(() => document.body.innerText);
  const b1 = /62B[\s,]*,?\s*1\./i.test(body62B);
  const bst = /62B[\s,]*,?\s*st\./i.test(body62B);
  add('695', b1 || bst, 'Hovedejendom 62B Ejerskab-tab viser 62B-lejligheder', `62B 1.: ${b1}, 62B st.: ${bst}`);
}

// ── TEST 4: Data-kvalitets check på API-niveau ──
const api = await page.evaluate(async () => {
  const r1 = await fetch('/api/ejerlejligheder?ejerlavKode=12851&matrikelnr=21by&moderBfe=226630').then(r => r.json());
  return r1;
});
const lejl = api?.lejligheder || [];
add('694', lejl.length >= 2, `/api/ejerlejligheder returnerer ≥ 2 rækker`, `count=${lejl.length}`);

if (lejl.length) {
  // Analyser hver række for data-kvalitet
  const qualityReport = lejl.map((l, i) => ({
    idx: i,
    adresse_ok: !!l.adresse && l.adresse.length > 10,
    etage_ok: !!l.etage,
    bfe_ok: l.bfe && Number.isFinite(Number(l.bfe)) && Number(l.bfe) > 100, // BFE=0 er dårlig
    ejer_ok: !!l.ejer && !/^(ukendt|null|undefined)/i.test(l.ejer) && l.ejer.length > 3,
    dawaId_ok: !!l.dawaId && /^[0-9a-f-]{36}$/i.test(l.dawaId),
    areal: l.areal, // må være null
  }));
  console.log('Data-kvalitet pr. lejlighed:');
  for (const q of qualityReport) {
    console.log(`  [${q.idx}] adresse=${q.adresse_ok} etage=${q.etage_ok} bfe=${q.bfe_ok} ejer=${q.ejer_ok} dawaId=${q.dawaId_ok}`);
  }
  const allBfeOk = qualityReport.every(q => q.bfe_ok);
  const allEjerOk = qualityReport.every(q => q.ejer_ok);
  const allDawaOk = qualityReport.every(q => q.dawaId_ok);
  const allAdresseOk = qualityReport.every(q => q.adresse_ok);

  add('694', allAdresseOk, 'ALLE lejligheder har gyldig adresse', allAdresseOk ? 'OK' : 'mindst én mangler');
  add('694', allEjerOk, 'ALLE lejligheder har udfyldt ejer', allEjerOk ? 'OK' : 'mindst én mangler eller er "ukendt"');
  add('694', allDawaOk, 'ALLE lejligheder har gyldigt dawaId for navigation', allDawaOk ? 'OK' : 'mindst én mangler');
  add('694', allBfeOk, 'ALLE lejligheder har gyldigt BFE-nummer > 100', allBfeOk ? 'OK' : `BFEs: ${qualityReport.map(q => lejl[q.idx].bfe).join(',')} — bfe=0 er stub`);
}

// ── Summary ──
console.log('\n' + '═'.repeat(70));
for (const id of ['694', '695']) {
  const pass = checks[id].filter(c => c.ok).length;
  console.log(`\nBIZZ-${id}: ${pass}/${checks[id].length} passed`);
  for (const c of checks[id]) {
    console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}`);
    if (c.detail) console.log(`      ${c.detail}`);
  }
}

fs.writeFileSync('/tmp/verify-screenshots/694-695-v2-results.json', JSON.stringify({ checks, api_62A: api }, null, 2));
await b.close();
