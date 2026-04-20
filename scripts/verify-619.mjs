#!/usr/bin/env node
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
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
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true });
const page = await context.newPage();
await login(page);

await page.goto(`${BASE}/dashboard/owners/4000115446`);
await page.waitForLoadState('domcontentloaded');

// Vent for "Indlæser persondata" at forsvinde
for (let i = 0; i < 30; i++) {
  const skel = await page.getByText(/Indlæser\s+persondata/i).isVisible({ timeout: 500 }).catch(() => false);
  if (!skel) break;
  await page.waitForTimeout(500);
}
await page.waitForTimeout(2000);

// Klik Diagram-tab
const diaTab = page.getByRole('tab', { name: /Diagram|Relationsdiagram/i }).first();
await diaTab.click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(8000); // D3-simulation

await page.screenshot({ path: `${SHOTS}/bizz-619-standard.png`, fullPage: false });

// Tjek for Jakobs personligt ejede ejendomme
const stats = await page.evaluate(() => {
  const all = Array.from(document.querySelectorAll('svg text, svg foreignObject *, svg g'));
  const texts = [];
  for (const el of all) {
    const t = (el.textContent || '').trim();
    if (t && t.length > 2 && t.length < 150) texts.push(t);
  }
  const personalAddrs = ['Søbyvej 11', 'Vigerslevvej 146', 'H C Møllersvej 21', 'H.C. Møllersvej', 'Horsekildevej 26', 'Hovager 8', 'Thorvald Bindesbølls', 'Kildegårdsvej 18D', 'J.C. Jacobsens Gade 11'];
  const foundAddrs = personalAddrs.filter(a => texts.some(t => t.includes(a.split(' ')[0])));
  const companies = ['JaJR Holding', 'Crossboksen', 'DJKL Holding', 'FJKL Holding', 'SJKL Holding', 'Pharma IT', 'ProductLife', 'Neo Biopharm', 'Pharma Lab', 'Arnbo 62'];
  const foundCompanies = companies.filter(c => texts.some(t => t.includes(c.split(' ')[0])));
  return { total: texts.length, foundAddrs: foundAddrs.length, addrSamples: foundAddrs, foundCompanies: foundCompanies.length, companySamples: foundCompanies };
});
console.log('Standard view:', stats);

// Klik Udvid
const udvid = page.locator('button:has-text("Udvid")').first();
let udvidClicked = false;
if (await udvid.isVisible({ timeout: 3000 }).catch(() => false)) {
  await udvid.click();
  await page.waitForTimeout(7000);
  udvidClicked = true;
}

await page.screenshot({ path: `${SHOTS}/bizz-619-udvid.png`, fullPage: false });

const stats2 = await page.evaluate(() => {
  const all = Array.from(document.querySelectorAll('svg text, svg foreignObject *'));
  const texts = [];
  for (const el of all) {
    const t = (el.textContent || '').trim();
    if (t && t.length > 2 && t.length < 150) texts.push(t);
  }
  const personalAddrs = ['Søbyvej 11', 'Vigerslevvej 146', 'H C Møllersvej', 'Horsekildevej 26', 'Hovager 8', 'Thorvald Bindesbølls', 'Kildegårdsvej', 'J.C. Jacobsens Gade'];
  const foundAddrs = personalAddrs.filter(a => texts.some(t => t.includes(a.split(' ')[0])));
  return { total: texts.length, foundAddrs: foundAddrs.length, addrSamples: foundAddrs };
});
console.log('Udvid view:', stats2);

const passedStandard = stats.foundAddrs >= 3; // mindst 3 af 5 personligt ejede skal være der
const passedUdvid = stats2.foundAddrs >= 5; // udvid skal vise flere

console.log(`\nResult: standard=${passedStandard ? 'PASS' : 'FAIL'} (${stats.foundAddrs}/5+), udvid=${passedUdvid ? 'PASS' : 'FAIL'} (${stats2.foundAddrs}/8+), udvidClicked=${udvidClicked}`);
await browser.close();
