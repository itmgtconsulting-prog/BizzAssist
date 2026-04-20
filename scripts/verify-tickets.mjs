#!/usr/bin/env node
/**
 * Verification runner: logs into test.bizzassist.dk, visits a property,
 * clicks through each tab, takes a screenshot + dumps visible text so we
 * can confirm the "In Review" tickets are shipped.
 *
 * Usage:  node scripts/verify-tickets.mjs "Vesterbrogade 1"
 */
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});

const BASE = process.env.E2E_BASE_URL || 'https://test.bizzassist.dk';
const EMAIL = process.env.E2E_TEST_EMAIL;
const PASS = process.env.E2E_TEST_PASS;
const TEST_ADDRESS = process.argv[2] || 'Vesterbrogade 1';

if (!EMAIL || !PASS) {
  console.error('Missing E2E_TEST_EMAIL / E2E_TEST_PASS in .env.local');
  process.exit(1);
}

const OUTDIR = '/tmp/bizz-verify';
fs.mkdirSync(OUTDIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 2200 } });
const page = await ctx.newPage();

page.on('console', (msg) => {
  if (msg.type() === 'error') console.log(`  [console.error] ${msg.text().slice(0, 200)}`);
});
page.on('pageerror', (err) => console.log(`  [pageerror] ${err.message.slice(0, 200)}`));

try {
  console.log(`\n→ Login ${BASE}/login`);
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  const cookie = page.getByRole('button', { name: /Acceptér|Accepter/i });
  if (await cookie.isVisible({ timeout: 2000 }).catch(() => false)) await cookie.click();
  await page.getByPlaceholder('navn@virksomhed.dk').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASS);
  await page.getByRole('button', { name: /Log ind/i }).click();
  await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 30000 });
  if (page.url().includes('/onboarding')) await page.goto(`${BASE}/dashboard`);
  await page.waitForLoadState('domcontentloaded');
  for (let i = 0; i < 6; i++) {
    const next = page.getByRole('button', { name: /Næste|Kom i gang|Fortsæt|Luk|Close/i }).first();
    if (await next.isVisible({ timeout: 1000 }).catch(() => false)) {
      await next.click().catch(() => {});
      await page.waitForTimeout(300);
    } else break;
  }

  console.log(`\n→ Search "${TEST_ADDRESS}"`);
  await page.goto(`${BASE}/dashboard/ejendomme`, { waitUntil: 'domcontentloaded' });
  const search = page.getByPlaceholder(/adresse.*vejnavn|vejnavn.*postnummer|postnummer/i).first();
  await search.waitFor({ timeout: 15000 });
  await search.fill(TEST_ADDRESS);
  await page.waitForTimeout(1500);
  const firstHit = page
    .locator('button')
    .filter({ hasText: new RegExp(TEST_ADDRESS.split(' ')[0], 'i') })
    .first();
  await firstHit.waitFor({ timeout: 12000 });
  await firstHit.click();
  await page.waitForURL(/\/dashboard\/ejendomme\//, { timeout: 20000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2500);
  console.log(`  URL: ${page.url()}`);

  const tabs = ['Oversigt', 'BBR', 'Ejerskab', 'Økonomi', 'SKAT', 'Tinglysning'];
  const dump = {};

  for (const t of tabs) {
    const tab = page.getByRole('tab', { name: new RegExp(`^${t}$`, 'i') }).first();
    const altTab = page.getByRole('button', { name: new RegExp(`^${t}$`, 'i') }).first();
    if (await tab.isVisible({ timeout: 1500 }).catch(() => false)) {
      await tab.click();
    } else if (await altTab.isVisible({ timeout: 1500 }).catch(() => false)) {
      await altTab.click();
    } else {
      console.log(`  Tab "${t}" not found`);
      continue;
    }
    // Wait for loading spinners/"Henter..." placeholders to disappear
    await page.waitForTimeout(1500);
    for (let i = 0; i < 8; i++) {
      const loading = await page.locator('text=/Henter|Indlæser|Loading/i').count();
      if (loading === 0) break;
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(1500);

    // On BBR tab, click each bygning row to expand (reveals Opgange/Etager detaljer — BIZZ-486)
    if (t === 'BBR') {
      const bygBtns = page.locator('button').filter({
        hasText:
          /Etagebolig|Parcelhus|Beboelse|Kontor|Butik|Erhverv|Produktion|Rækkehus|Dobbelthus/i,
      });
      const count = await bygBtns.count();
      for (let i = 0; i < Math.min(count, 3); i++) {
        await bygBtns
          .nth(i)
          .click()
          .catch(() => {});
        await page.waitForTimeout(700);
      }
    }
    // On Oversigt tab, click the matrikel detail row if present (reveals arealtype — BIZZ-499)
    if (t === 'Oversigt') {
      const matBtn = page
        .locator('button, summary')
        .filter({ hasText: /Matrikelnr|Jordstykke|Matr\./i })
        .first();
      if (await matBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await matBtn.click().catch(() => {});
        await page.waitForTimeout(700);
      }
    }

    const text = (await page.locator('main, [role="main"], body').first().innerText()).replace(
      /\s+/g,
      ' '
    );
    const filename = `${OUTDIR}/${t.toLowerCase().replace(/ø/g, 'oe').replace(/å/g, 'aa')}.txt`;
    fs.writeFileSync(filename, text);
    await page.screenshot({
      path: `${OUTDIR}/${t.toLowerCase().replace(/ø/g, 'oe').replace(/å/g, 'aa')}.png`,
      fullPage: true,
    });
    dump[t] = text;
    console.log(`  ${t} — ${text.length} chars dumped to ${filename}`);
  }

  const allText = Object.values(dump).join('\n');

  // Verification matrix
  const checks = [
    // ── UI/ejendom ────────
    [
      'BIZZ-550',
      /ejerlejlighed|parcelhus|etagebolig|kontor|erhvervsejendom|række|landbrug|beboelse|handel|industri|fritidsbolig/i,
      'property-type badge',
    ],
    ['BIZZ-551', /\d+\.\s*(tv|th|mf)\b|\d\.\s*sal|etage\s*\d|dør\s+\d/i, 'etage+dør i header'],
    // ── MAT ────────
    ['BIZZ-497', /ejerlav/i, 'ejerlav vist (kode+navn)'],
    ['BIZZ-499', /arealtype/i, 'arealtype vist'],
    // ── BBR ────────
    ['BIZZ-486', /opgang|etage\b.*\d|etageoversigt|bygnings.?layout/i, 'opgang/etage i BBR'],
    ['BIZZ-487', /kælder|tagetage|kælderareal|tagetageareal/i, 'kælder/tagetage i BBR'],
    [
      'BIZZ-488',
      /ombygning|bevaringsværdig|revisionsdato/i,
      'ombygning/bevaringsværdighed/revisionsdato',
    ],
    // ── Økonomi ────────
    ['BIZZ-492', /grundværdispecifikation|grundværdi.*specifik/i, 'grundværdispecifikation'],
    ['BIZZ-493', /ejerboligfordeling|boligfordeling/i, 'ejerboligfordeling'],
    ['BIZZ-494', /fradragforforbedring|fradrag.*forbedring/i, 'fradrag for forbedring'],
    ['BIZZ-495', /bebyggelsesprocent|afgiftspligtig/i, 'bebyggelsesprocent/afgiftspligtig'],
    // ── SKAT ────────
    ['BIZZ-491', /\bfritagelse\b|skattefritagelse/i, 'skattefritagelse-detaljer'],
    // ── Tinglysning ────────
    ['BIZZ-548', /servitut|byrde|ingen servitutter|kunne ikke hente/i, 'servitut empty/data state'],
  ];

  console.log(`\n=== Results for "${TEST_ADDRESS}" ===`);
  const pass = [];
  const fail = [];
  for (const [id, re, label] of checks) {
    const ok = re.test(allText);
    console.log(`${ok ? '✅' : '❌'}  ${id}  ${label}`);
    (ok ? pass : fail).push(id);
  }
  console.log(`\nPASS (${pass.length}): ${pass.join(', ')}`);
  console.log(`FAIL (${fail.length}): ${fail.join(', ')}`);
} catch (err) {
  console.error('ERR', err.message);
  await page.screenshot({ path: `${OUTDIR}/error.png`, fullPage: true });
} finally {
  await browser.close();
}
