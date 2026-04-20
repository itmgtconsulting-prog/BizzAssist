#!/usr/bin/env node
/**
 * Verificér BIZZ-629 (m² regression) + BIZZ-633 (salgshistorik) via direkte
 * API-kald fra authenticated browser-context (page.evaluate + fetch).
 *
 *   BIZZ-629: kald /api/ejendomme-by-owner?cvrs=41092807 og tjek om
 *             boligAreal/erhvervsAreal er non-null for de berørte BFE'er.
 *
 *   BIZZ-633: kald /api/salgshistorik?bfe=425479 (Kaffevej 31 1.tv) og
 *             tæl antal handler returneret. Tjek også historik-spor.
 */
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';

loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });
const BASE = 'https://test.bizzassist.dk';
const SHOTS = '/tmp/verify-screenshots';

async function login(page) {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState('domcontentloaded');
  const c = page.getByRole('button', { name: /Acceptér|Accepter/i });
  if (await c.isVisible({ timeout: 3000 }).catch(() => false)) await c.click();
  await page.getByPlaceholder('navn@virksomhed.dk').fill(process.env.E2E_TEST_EMAIL);
  await page.getByPlaceholder('••••••••').fill(process.env.E2E_TEST_PASS);
  await page.getByRole('button', { name: /Log ind/i }).click();
  await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 30000 });
  if (page.url().includes('/onboarding')) await page.goto(`${BASE}/dashboard`);
  await page.waitForLoadState('domcontentloaded');
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
const page = await context.newPage();
await login(page);
console.log('Login OK\n');

// ─── BIZZ-629: /api/ejendomme-by-owner ──────────────────────────────────────

console.log('═══ BIZZ-629: /api/ejendomme-by-owner for CVR 41092807 ═══');
const resp629 = await page.evaluate(async () => {
  const r = await fetch('/api/ejendomme-by-owner?cvr=41092807', { credentials: 'include' });
  if (!r.ok) return { error: `HTTP ${r.status}`, body: await r.text().catch(() => '') };
  return await r.json().catch((e) => ({ error: `JSON parse: ${e.message}` }));
});

if (resp629.error) {
  console.log(`  ❌ API-fejl: ${resp629.error}`);
} else {
  // Struktur: { ejendomme: [...] } eller { bfeList: [...] }
  const list = resp629.ejendomme || resp629.data || resp629.bfeList || resp629.properties || [];
  console.log(`  API returnerede ${list.length} ejendomme`);

  // Find de berørte BFE'er fra ticket-description
  const targetBfes = [226629, 226630, 2091185, 2091179, 2091191, 2091198];
  const found = list.filter((e) => targetBfes.includes(e.bfeNummer || e.bfe_nummer || e.bfe));

  console.log(`  Af de 6 kendte BFE'er fandt vi ${found.length}:\n`);

  let allZero = true;
  let anyNonZero = false;
  for (const e of list.slice(0, 15)) {
    const bfe = e.bfeNummer || e.bfe_nummer || e.bfe || '?';
    const bolig = e.boligAreal ?? e.boligareal ?? null;
    const erhv = e.erhvervsAreal ?? e.erhvAreal ?? e.erhvervsareal ?? null;
    const matr = e.matrikelAreal ?? e.matrAreal ?? e.matrikelareal ?? null;
    const adr = e.adresse || e.address || e.dawaAdresse || '?';

    const isZeroOrNull = (v) => v == null || v === 0;
    const nonZero = !isZeroOrNull(bolig) || !isZeroOrNull(erhv);
    if (nonZero) { anyNonZero = true; allZero = false; }

    console.log(`    BFE ${bfe}:  bolig=${bolig ?? 'null'} erhv=${erhv ?? 'null'} matr=${matr ?? 'null'}  — ${(adr || '').toString().slice(0, 40)}`);
  }
  console.log(`\n  Sammenfatning: anyNonZero=${anyNonZero}, allZero=${allZero}`);
  fs.writeFileSync(`${SHOTS}/bizz-629-api-response.json`, JSON.stringify(resp629, null, 2).slice(0, 50000));
  console.log(`  Full API response gemt i: /tmp/verify-screenshots/bizz-629-api-response.json (første 50 KB)`);
}

// ─── BIZZ-633: /api/salgshistorik?bfe=425479 ────────────────────────────────

console.log('\n═══ BIZZ-633: /api/salgshistorik for BFE 425479 (Kaffevej 31 1.tv) ═══');
const resp633 = await page.evaluate(async () => {
  const r = await fetch('/api/salgshistorik?bfeNummer=425479', { credentials: 'include' });
  if (!r.ok) return { error: `HTTP ${r.status}`, body: await r.text().catch(() => '') };
  return await r.json().catch((e) => ({ error: `JSON parse: ${e.message}` }));
});

if (resp633.error) {
  console.log(`  ❌ API-fejl: ${resp633.error}`);
} else {
  const handler = resp633.handler || resp633.handelsListe || resp633.handlerList || resp633.data || [];
  const antal = Array.isArray(handler) ? handler.length : 0;
  console.log(`  API returnerede ${antal} handler for BFE 425479`);

  if (Array.isArray(handler)) {
    for (const h of handler.slice(0, 10)) {
      const dato = h.handelsDato || h.dato || h.overtagelsesDato || h.date || h.tinglysningsDato;
      const pris = h.kontantKoebesum || h.koebesum || h.pris || h.price;
      const koeber = h.koeber || h.erhverver || h.buyer;
      const saelger = h.saelger || h.afgiver || h.seller;
      const type = h.handelType || h.type || h.dokumenttype;
      console.log(`    ${dato || '?'}  ${pris || '?'} DKK  type=${type || '?'}  koeber=${JSON.stringify(koeber).slice(0, 60)}`);
    }
  }

  fs.writeFileSync(`${SHOTS}/bizz-633-api-response.json`, JSON.stringify(resp633, null, 2).slice(0, 50000));
  console.log(`  Full response gemt i: /tmp/verify-screenshots/bizz-633-api-response.json`);
}

await browser.close();
