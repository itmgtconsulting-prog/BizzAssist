#!/usr/bin/env node
/**
 * Playwright-verifikation af BIZZ-725, BIZZ-728, BIZZ-729.
 * Tjekker at UI rendrer som beskrevet + at content giver mening.
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
try { await page.waitForURL(/dashboard/, { timeout: 45000 }); }
catch { await page.waitForTimeout(5000); }
await page.waitForTimeout(2500);

const results = { 725: [], 728: [], 729: [] };
const add = (id, ok, name, detail = '') => results[id].push({ ok, name, detail });
fs.mkdirSync('/tmp/verify-screenshots', { recursive: true });

// ── BIZZ-725: Udfaset banner på 62C ────────────────────────────────
console.log('\n── BIZZ-725: Udfaset banner på 62C ──');
await page.goto(`${BASE}/dashboard/ejendomme/3b362995-27a0-4c12-ad73-8ead0c978ad2`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
const ss725 = '/tmp/verify-screenshots/725-62C-banner.png';
await page.screenshot({ path: ss725, fullPage: false });
const body725 = await page.evaluate(() => document.body.innerText);

const hasUdfasetBanner = /udfaset ejendom/i.test(body725);
const hasHistoricalNote = /(historisk|zone|registrering)/i.test(body725);
const hasFindButton = /find andre ejendomme|matriklen|hovedejendom/i.test(body725);

add(725, hasUdfasetBanner, 'Banner med "Udfaset ejendom"-overskrift synlig', hasUdfasetBanner ? 'OK' : 'mangler');
add(725, hasHistoricalNote, 'Banner forklarer hvorfor (historisk/zone/registrering)', hasHistoricalNote ? 'OK' : 'mangler');
add(725, hasFindButton, 'Knap til at finde andre ejendomme/hovedejendom', hasFindButton ? 'OK' : 'mangler');

// Check that we're on the right page (62C)
const is62C = /62C|Arnold Nielsens Boulevard 62C/.test(body725);
add(725, is62C, 'Side loader korrekt 62C', is62C ? 'OK' : 'forkert side');

// ── BIZZ-728: Gå til hovedejendom-knap på 62B, 1. ──────────────────
console.log('\n── BIZZ-728: Gå til hovedejendom-knap på 62B, 1. ──');
await page.goto(`${BASE}/dashboard/ejendomme/222d784c-2363-46ef-9ff8-40632bb04d6e`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
const ss728 = '/tmp/verify-screenshots/728-62B-1sal-hovedejendom-btn.png';
await page.screenshot({ path: ss728, fullPage: false });
const body728 = await page.evaluate(() => document.body.innerText);

const hasHovedBtn = /gå til hovedejendom|hovedejendom/i.test(body728);
add(728, hasHovedBtn, 'Knap/link "Gå til hovedejendom" synlig på 62B, 1.', hasHovedBtn ? 'OK' : 'mangler');

// Check page is for 62B, 1.
const is62B1 = /62B.*1\.|Arnold Nielsens Boulevard 62B, 1/i.test(body728);
add(728, is62B1, 'Side loader korrekt 62B, 1.', is62B1 ? 'OK' : 'forkert side');

// Try clicking + verify navigation
try {
  const btn = page.locator('a, button').filter({ hasText: /gå til hovedejendom/i }).first();
  if (await btn.count()) {
    const before = page.url();
    await btn.click();
    await page.waitForTimeout(3000);
    const after = page.url();
    const navigated = before !== after && /\/dashboard\/ejendomme\//.test(after);
    add(728, navigated, 'Klik på "Gå til hovedejendom" navigerer til anden ejendomsside', navigated ? `${before.slice(-25)} → ${after.slice(-25)}` : 'ingen navigation');
    // Check destination is hovedejendom (has Ejerlejligheder badge or similar)
    if (navigated) {
      const destBody = await page.evaluate(() => document.body.innerText);
      const isHovedejendom = /hovedejendom/i.test(destBody);
      add(728, isHovedejendom, 'Destinationssiden er en hovedejendom (badge/indikator)', isHovedejendom ? 'OK' : 'måske ikke');
    }
  } else {
    add(728, false, 'Kan ikke finde klikbar knap', 'locator tomt');
  }
} catch (e) {
  add(728, false, 'Klik-test fejlede', e.message.slice(0, 100));
}

// ── BIZZ-729: Loading-pill på Diagram-tab for JaJR Holding ─────────
console.log('\n── BIZZ-729: Loading-pill på Diagram-tab ──');
await page.goto(`${BASE}/dashboard/companies/41092807`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

// Klik Diagram-tab OG straks capture body (loading-pill skal være synlig mens ejendomme fetches)
const diagramBtn = page.locator('button, [role=tab]').filter({ hasText: /^Diagram$/i }).first();
if (await diagramBtn.count()) {
  await diagramBtn.click();
  // Capture over 3 sekunder for at se om pillen dukker op
  const sightings = [];
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(500);
    const body = await page.evaluate(() => document.body.innerText);
    const hasPill = /(henter ejendomme|henter|indlæser).*\d+.*\d+/i.test(body) || /henter ejendomme/i.test(body);
    sightings.push({ t: i * 500, hasPill });
  }
  const everSeen = sightings.some(s => s.hasPill);
  add(729, everSeen, 'Loading-pill "Henter ejendomme..." vises efter Diagram-tab-klik', everSeen ? `sightings: ${sightings.filter(s => s.hasPill).map(s => s.t + 'ms').join(', ')}` : 'aldrig set');

  // Tag screenshot ved 1s (hvor pillen skulle være aktiv)
  await page.goto(`${BASE}/dashboard/companies/41092807`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const d2 = page.locator('button, [role=tab]').filter({ hasText: /^Diagram$/i }).first();
  await d2.click();
  await page.waitForTimeout(800);
  const ss729 = '/tmp/verify-screenshots/729-diagram-loading.png';
  await page.screenshot({ path: ss729, fullPage: false });
} else {
  add(729, false, 'Diagram-tab ikke fundet', 'locator tomt');
}

// ── ARIA + accessibility check på BIZZ-729 ───────────────────────
const ariaLive = await page.evaluate(() => {
  const el = document.querySelector('[aria-live="polite"], [aria-live="assertive"]');
  return el ? { exists: true, text: el.textContent?.slice(0, 100) } : { exists: false };
});
add(729, ariaLive.exists, 'Loading-pill har aria-live for skærmlæsere', ariaLive.exists ? `text: "${ariaLive.text}"` : 'mangler');

// ── Summary ────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(70));
for (const id of ['725', '728', '729']) {
  const pass = results[id].filter(c => c.ok).length;
  console.log(`\nBIZZ-${id}: ${pass}/${results[id].length} passed`);
  for (const c of results[id]) {
    console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}`);
    if (c.detail) console.log(`      ${c.detail}`);
  }
}
fs.writeFileSync('/tmp/verify-screenshots/725-728-729-results.json', JSON.stringify(results, null, 2));
await b.close();
