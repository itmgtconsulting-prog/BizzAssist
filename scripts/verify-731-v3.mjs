#!/usr/bin/env node
/**
 * Direkte verifikation: for hver af de 4 problem-BFEer, find ejendommens
 * DAWA-UUID via søgning, åbn ejendomssiden, og check om BBR-tab'en viser
 * et bolig-areal > 0.
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
try { await page.waitForURL(/dashboard/, { timeout: 45000 }); } catch { await page.waitForTimeout(5000); }
await page.waitForTimeout(2500);

const expected = [
  { bfe: 100165718, adresse: 'Thorvald Bindesbølls Plads 18, 3. th', expected: 82 },
  { bfe: 173448, adresse: 'Horsekildevej 26, 2. tv' },
  { bfe: 100435372, adresse: 'J.C. Jacobsens Gade 11, 5. th' },
  { bfe: 167448, adresse: 'Vigerslevvej 146, 1. th' },
];

const checks = [];
fs.mkdirSync('/tmp/verify-screenshots', { recursive: true });

for (const e of expected) {
  console.log(`\n── BFE ${e.bfe} (${e.adresse}) ──`);

  // Søg efter ejendommen via /api/search
  const search = await page.evaluate(async (q) => {
    const r = await fetch('/api/search?q=' + encodeURIComponent(q)).then(r => r.json()).catch(err => ({ err: err.message }));
    return Array.isArray(r) ? r : (r.results ?? []);
  }, e.adresse.split(',')[0]);

  // Find adresse med matchende etage/dør
  const lejl = Array.isArray(search) ? search.find(s => s.type === 'address' && s.meta?.etage && new RegExp(e.adresse.split(',')[0], 'i').test(s.title || '')) : null;
  if (!lejl) {
    console.log(`  Ingen match i search`);
    checks.push({ bfe: e.bfe, ok: false, name: `Fandt ${e.adresse} via search`, detail: 'ingen match' });
    continue;
  }

  console.log(`  Match: ${lejl.title} (dawaId=${lejl.id?.slice(0, 8)}...)`);

  // Gå til ejendomssiden
  await page.goto(`${BASE}/dashboard/ejendomme/${lejl.id}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  // BBR-tab
  const bbrBtn = page.locator('main button, main [role=tab], main a').filter({ hasText: /^BBR$/ }).first();
  if (await bbrBtn.count()) {
    await bbrBtn.click();
    await page.waitForTimeout(2500);
  }

  const ss = `/tmp/verify-screenshots/731-v3-${e.bfe}-bbr.png`;
  await page.screenshot({ path: ss, fullPage: false });

  // Læs bolig-felter
  const body = await page.evaluate(() => document.body.innerText);
  const boligMatch = body.match(/bolig[^:\n]*[:\s]+(\d[\d.]*)\s*m²/i);
  const samletMatch = body.match(/samlet[^:\n]*[:\s]+(\d[\d.]*)\s*m²/i);
  const erhvervsMatch = body.match(/erhverv[^:\n]*[:\s]+(\d[\d.]*)\s*m²/i);

  const boligVal = boligMatch ? Number(boligMatch[1].replace(/\./g, '')) : null;
  console.log(`  bolig-match: ${boligMatch?.[0] || 'ingen'}`);
  console.log(`  samlet-match: ${samletMatch?.[0] || 'ingen'}`);
  console.log(`  erhverv-match: ${erhvervsMatch?.[0] || 'ingen'}`);

  checks.push({
    bfe: e.bfe,
    ok: boligVal !== null && boligVal > 0,
    name: `BFE ${e.bfe} (${e.adresse}) viser bolig-m² > 0 på BBR-tab`,
    detail: boligMatch ? `"${boligMatch[0]}"${e.expected ? ` (forventet ~${e.expected})` : ''}` : 'intet bolig-felt fundet',
  });
}

// Summary
console.log('\n' + '═'.repeat(70));
const pass = checks.filter(c => c.ok).length;
console.log(`BIZZ-731: ${pass}/${checks.length} passed`);
for (const c of checks) {
  console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}`);
  if (c.detail) console.log(`      ${c.detail}`);
}
fs.writeFileSync('/tmp/verify-screenshots/731-v3-results.json', JSON.stringify(checks, null, 2));
await b.close();
