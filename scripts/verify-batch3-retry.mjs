#!/usr/bin/env node
/**
 * Retry for 626/627/629/633 — skeletons forsinkede første run.
 * Vent explicit på at "Henter..." er væk før assertions.
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
  for (let i = 0; i < 5; i++) {
    const n = page.getByRole('button', { name: /Næste|Next|Kom i gang|Fortsæt/i }).first();
    if (await n.isVisible({ timeout: 1000 }).catch(() => false)) { await n.click(); await page.waitForTimeout(250); } else break;
  }
}

async function waitForDataLoaded(page, maxWaitMs = 30000) {
  const start = Date.now();
  const loadingTexts = [/Henter\s+virksomhedsdata/i, /Henter\s+persondata/i, /Henter\s+ejendom/i, /Indlæser/i, /Henter\s+data/i];
  while (Date.now() - start < maxWaitMs) {
    let anyVisible = false;
    for (const re of loadingTexts) {
      if (await page.getByText(re).first().isVisible({ timeout: 300 }).catch(() => false)) { anyVisible = true; break; }
    }
    if (!anyVisible) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

const results = [];
function record(t, p, n) { results.push({ t, p, n }); console.log(`${p ? '✅' : '❌'} ${t}: ${n}`); }

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true });
const page = await context.newPage();
await login(page);
console.log('Login OK\n');

// ─── 629 + 626 — JaJR Ejendomme tab ─────────────────────────────────────────
console.log('--- BIZZ-629 + 626 (JaJR Ejendomme-tab) ---');
await page.goto(`${BASE}/dashboard/companies/41092807`);
await page.waitForLoadState('domcontentloaded');
await waitForDataLoaded(page);
await page.waitForTimeout(2000);

const ejTab = page.getByRole('tab', { name: /^Ejendomme/i }).first();
await ejTab.click({ timeout: 5000 }).catch(() => {});
await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
await waitForDataLoaded(page, 20000);
await page.waitForTimeout(4000);

await page.screenshot({ path: `${SHOTS}/bizz-629-626-retry.png`, fullPage: true });

const body = await page.locator('body').innerText();
console.log(`  body.length: ${body.length} chars`);

// BIZZ-629
const erhvMatches = body.match(/Erhv[:\s]*[0-9.,]+\s*m²/gi) || [];
const nonZeroErhv = erhvMatches.filter(m => !/[:\s]0\s*m²/.test(m));
const matrMatches = body.match(/Matr[:\s]*[0-9.,]+\s*m²/gi) || [];
const nonZeroMatr = matrMatches.filter(m => !/[:\s]0\s*m²/.test(m));
record('BIZZ-629',
  nonZeroErhv.length > 0 && nonZeroMatr.length > 0,
  `Erhv m² non-zero: ${nonZeroErhv.length}/${erhvMatches.length}. Matr m² non-zero: ${nonZeroMatr.length}/${matrMatches.length}. Samples Erhv: ${nonZeroErhv.slice(0,3).join(' | ')}`
);

// BIZZ-626
const testAddrs = ['Arnold Nielsens Boulevard 62A', 'Arnold Nielsens Boulevard 62B', 'Høvedstensvej 33', 'Høvedstensvej 39'];
const foundAddrs = testAddrs.filter(a => body.includes(a));
const hasDawaMangler = /DAWA[-\s]?id\s+mangler/i.test(body);
const hasVurdering = /Vurd[:\s]|Vurdering[:\s]|mio\s+DKK\s*\(20\d\d\)/i.test(body);
record('BIZZ-626',
  foundAddrs.length >= 3 && !hasDawaMangler && hasVurdering,
  `Adresser som titel: ${foundAddrs.length}/4. DAWA-mangler-tekst: ${hasDawaMangler}. Vurderings-felt: ${hasVurdering}`
);

// ─── 627 — Diagram node-tekster ────────────────────────────────────────────
console.log('\n--- BIZZ-627 (Diagram ejendomsnoder) ---');
const diaTab = page.getByRole('tab', { name: /Diagram/i }).first();
await diaTab.click();
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await waitForDataLoaded(page, 15000);
await page.waitForTimeout(6000);

// Klik Udvid for at få Jakobs ejendomme frem
const udvidBtn = page.locator('button:has-text("Udvid")').first();
if (await udvidBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
  await udvidBtn.click();
  await page.waitForTimeout(5000);
}

await page.screenshot({ path: `${SHOTS}/bizz-627-retry.png`, fullPage: false });

const svgStats = await page.evaluate(() => {
  const nodes = Array.from(document.querySelectorAll('svg text, svg foreignObject, svg foreignObject *'));
  const out = [];
  for (const el of nodes) {
    const t = (el.textContent || '').trim();
    if (t && t.length > 3 && t.length < 100) out.push(t);
  }
  return {
    total: out.length,
    bfeAsTitle: out.filter(t => /^BFE\s*[\d.,]+$/i.test(t)).length,
    addressAsTitle: out.filter(t => /^(Arnold|Høvedstensvej|Thorvald|Kaffevej|Søbyvej|Vigerslevvej|Horsekildevej|Hovager)\s/i.test(t)).length,
    postnrSamples: out.filter(t => /^\d{4}\s+\w/i.test(t)).slice(0, 3),
    addrSamples: out.filter(t => /^(Arnold|Høvedstensvej|Thorvald|Kaffevej|Søbyvej|Vigerslevvej|Horsekildevej|Hovager)/i.test(t)).slice(0, 3),
    bfeSamples: out.filter(t => /^BFE\s*[\d.,]+$/i.test(t)).slice(0, 3),
  };
});
record('BIZZ-627',
  svgStats.bfeAsTitle === 0 && svgStats.addressAsTitle > 0,
  `Total tekster: ${svgStats.total}. BFE som titel: ${svgStats.bfeAsTitle} (${svgStats.bfeSamples.join(' | ')}). Adresser: ${svgStats.addressAsTitle} (${svgStats.addrSamples.join(' | ')}). Postnrs: ${svgStats.postnrSamples.join(' | ')}`
);

// ─── 633 — Salgshistorik på Kaffevej 31 ────────────────────────────────────
console.log('\n--- BIZZ-633 (Kaffevej 31 Salgshistorik) ---');
await page.goto(`${BASE}/dashboard/ejendomme/4afa00c5-c304-463d-a67e-b24446187465`);
await page.waitForLoadState('domcontentloaded');
await waitForDataLoaded(page, 20000);
await page.waitForTimeout(3000);

const oekTab = page.getByRole('tab', { name: /Økonomi/i }).first();
await oekTab.click({ timeout: 5000 }).catch(() => {});
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(5000);

await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(4000);

await page.screenshot({ path: `${SHOTS}/bizz-633-retry.png`, fullPage: true });

const body2 = await page.locator('body').innerText();
const salgsMatch = body2.match(/Salgshistorik[\s\S]{0,3000}/i);
const section = salgsMatch?.[0] || '';
const datoer = section.match(/(?:\d{1,2}\.\s+(?:jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec)\.?\s+\d{4})|(?:\d{4}-\d{2}-\d{2})/gi) || [];
const yearMentions = section.match(/\b(2019|2020|2021|2022|2023)\b/g) || [];
const hasJAJR = /JAJR/i.test(section);
record('BIZZ-633',
  datoer.length >= 2 || yearMentions.length >= 2,
  `Salgshistorik: section-length=${section.length}, datoer=${datoer.length}, år-mentions=${yearMentions.length}, hasJAJR=${hasJAJR}. Samples: ${datoer.slice(0, 5).join(' | ')}`
);

await browser.close();

console.log('\n═══ BATCH 3 RETRY ═══');
const passed = results.filter(r => r.p);
console.log(`✅ Passed: ${passed.length}/${results.length}`);
fs.writeFileSync(`${SHOTS}/results-batch3-retry.json`, JSON.stringify(results, null, 2));
