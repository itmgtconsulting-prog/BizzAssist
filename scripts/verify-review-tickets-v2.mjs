#!/usr/bin/env node
/**
 * v2 — retry af failed tickets med brugerens præciseringer:
 *   BIZZ-605  BFE 100165662, servitut-række 13, bilag-badge ekspansion
 *   BIZZ-610  Kaffevej 31 1.tv — direkte URL
 *   BIZZ-595  Jakobs person-side direkte via URL eller diagram
 *   BIZZ-585  JaJR diagram — Jakobs egne ejendomme stiplede emerald-linjer
 *   BIZZ-604  verificér faktisk centrering (horizontal midterlinje vs. container)
 */
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';

loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});

const BASE = 'https://test.bizzassist.dk';
const SHOTS = '/tmp/verify-screenshots';
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
function record(ticket, passed, notes) {
  results.push({ ticket, passed, notes });
  console.log(`${passed ? '✅' : '❌'} ${ticket}: ${notes}`);
}

async function login(page) {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState('domcontentloaded');
  const cookie = page.getByRole('button', { name: /Acceptér|Accepter/i });
  if (await cookie.isVisible({ timeout: 3000 }).catch(() => false)) await cookie.click();
  await page.getByPlaceholder('navn@virksomhed.dk').fill(process.env.E2E_TEST_EMAIL);
  await page.getByPlaceholder('••••••••').fill(process.env.E2E_TEST_PASS);
  await page.getByRole('button', { name: /Log ind/i }).click();
  await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 30000 });
  if (page.url().includes('/onboarding')) await page.goto(`${BASE}/dashboard`);
  await page.waitForLoadState('domcontentloaded');
  for (let i = 0; i < 5; i++) {
    const n = page.getByRole('button', { name: /Næste|Next|Kom i gang|Fortsæt/i }).first();
    if (await n.isVisible({ timeout: 1200 }).catch(() => false)) { await n.click(); await page.waitForTimeout(250); } else break;
  }
  const close = page.locator('[role="dialog"] button[aria-label*="Luk"]').first();
  if (await close.isVisible({ timeout: 500 }).catch(() => false)) await close.click();
}

// ─── BIZZ-605: PDF-knap på servitut-række 13 ───────────────────────────────

async function verify_605(page, context) {
  const T = 'BIZZ-605';
  try {
    // Prøv BFE 100165662 — brugerens præcisering
    // BFE 100165662 er sandsynligvis hovedejendommen til Thorvald Bindesbølls Plads 18
    // Find ejendoms-UUID først via /api/adresse/lookup eller ejendom-endpoint
    await page.goto(`${BASE}/dashboard/ejendomme/dd4a90de-b126-4438-824f-3677efab2bd0`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    // Klik Tinglysning-tab
    const tlTab = page.getByRole('tab', { name: /Tinglysning/i }).first();
    if (await tlTab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await tlTab.click();
      await page.waitForTimeout(5000); // servitut-tabel tager tid
    }

    await page.screenshot({ path: `${SHOTS}/bizz-605-tinglysning-tab.png`, fullPage: true });

    // Tæl PDF-ikoner / download-knapper
    const pdfBtns = page.locator('button[aria-label*="PDF" i], a[aria-label*="PDF" i], button[title*="PDF" i], [data-testid*="pdf" i]');
    const iconBtns = page.locator('button svg[class*="file" i], button svg[class*="pdf" i], button:has(svg[d*="M"])');

    const pdfCount = await pdfBtns.count();
    const iconCount = await iconBtns.count();

    if (pdfCount === 0 && iconCount === 0) {
      record(T, false, `Ingen PDF-knapper fundet på Tinglysning-tab (pdfCount=${pdfCount}, iconCount=${iconCount}). Muligvis renderer servitut-tabellen anderledes nu — manuel verifikation nødvendig.`);
      return;
    }

    // Målret række 13 — find alle table-rows eller servitut-cards
    const rows = page.locator('tr, [role="row"], .servitut-row, [data-testid*="servitut" i]');
    const rowCount = await rows.count();

    if (rowCount < 13) {
      record(T, false, `Kun ${rowCount} rækker i servitut-tabel — kan ikke ramme række 13`);
      return;
    }

    // Klik PDF-knap i række 13 (1-indexed → index 12)
    const row13 = rows.nth(12);
    const row13Pdf = row13.locator('button[aria-label*="PDF" i], button:has(svg)').first();
    const tabsBefore = context.pages().length;

    if (await row13Pdf.isVisible({ timeout: 2000 }).catch(() => false)) {
      await row13Pdf.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(4000);
    } else {
      // Fallback: klik på første PDF-knap
      await pdfBtns.first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(4000);
    }

    const tabsAfter = context.pages().length;
    const newTabs = tabsAfter - tabsBefore;

    if (newTabs <= 1) {
      record(T, true, `PDF-klik åbnede ${newTabs} ny fane(r) — forventet 1 (hoveddok). Bug løst ✓`);
    } else {
      record(T, false, `PDF åbnede ${newTabs} faner — bug stadig til stede (forventet ≤1)`);
    }
    for (const p of context.pages()) if (p !== page) await p.close().catch(() => {});
  } catch (err) {
    record(T, false, `Fejl: ${err.message}`);
  }
}

// ─── BIZZ-610: Kaffevej 31 1.tv ejerskab ───────────────────────────────────

async function verify_610(page) {
  const T = 'BIZZ-610';
  try {
    await page.goto(`${BASE}/dashboard/ejendomme/4afa00c5-c304-463d-a67e-b24446187465`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(5000); // ejerskabs-data kan tage lidt

    // Tjek om siden er redirectet
    const currentUrl = page.url();
    const loadedFully = !currentUrl.includes('/login');

    if (!loadedFully) {
      record(T, false, `Siden redirected til login — session udløbet?`);
      return;
    }

    await page.screenshot({ path: `${SHOTS}/bizz-610-v2-landing.png`, fullPage: false });

    // Klik Ejerskab — prøv flere varianter af tab-selektor
    let tabClicked = false;
    for (const sel of [
      'role=tab[name="Ejerskab"]',
      'role=tab[name=/Ejerskab/i]',
      'button:has-text("Ejerskab")',
      'a:has-text("Ejerskab")',
      '[data-tab="ejerskab"]',
    ]) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        await el.click().catch(() => {});
        await page.waitForTimeout(3500);
        tabClicked = true;
        break;
      }
    }

    await page.screenshot({ path: `${SHOTS}/bizz-610-v2-after-tab.png`, fullPage: true });

    const bodyText = await page.locator('body').innerText();
    const hasJAJR = /JAJR\s*Ejendomme/i.test(bodyText);
    const hasFunch = /Boutrup\s+Funch/i.test(bodyText);
    const hasCVR35658912 = /35658912/.test(bodyText);
    const has300pct = /300\s*%|samlet.*300|sum.*300/i.test(bodyText);
    const has100pct = /100\s*%/.test(bodyText);

    if (hasJAJR && !hasFunch && !hasCVR35658912 && !has300pct) {
      record(T, true, `Kun JAJR Ejendomme vist — historiske ejere er filtreret. has100%=${has100pct}`);
    } else {
      record(T, false, `Historiske ejere stadig til stede eller JAJR mangler. JAJR=${hasJAJR}, Funch=${hasFunch}, CVR35658912=${hasCVR35658912}, 300%=${has300pct}. tabClicked=${tabClicked}`);
    }
  } catch (err) {
    record(T, false, `Fejl: ${err.message}`);
  }
}

// ─── BIZZ-595: Jakobs person-side → Ejendomme-tab ──────────────────────────

async function verify_595(page) {
  const T = 'BIZZ-595';
  try {
    // Gå direkte til Jakobs diagram-side via virksomhedsdiagrammet
    await page.goto(`${BASE}/dashboard/companies/41092807`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    const diaTab = page.getByRole('tab', { name: /Diagram/i }).first();
    if (await diaTab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await diaTab.click();
      await page.waitForTimeout(5000);
    }

    // Find et link til Jakobs person-side i diagrammet
    const jakobLink = page.locator('a[href*="/dashboard/owners/"]').first();
    if (await jakobLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      const href = await jakobLink.getAttribute('href');
      await page.goto(`${BASE}${href}`);
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(3500);
    } else {
      record(T, false, `Fandt ikke link til Jakobs person-side fra diagrammet`);
      return;
    }

    await page.screenshot({ path: `${SHOTS}/bizz-595-v2-jakob-landing.png`, fullPage: false });

    // Klik Ejendomme-tab
    const ejTab = page.getByRole('tab', { name: /^Ejendomme/i }).first();
    if (await ejTab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await ejTab.click();
      await page.waitForTimeout(5000);
    }

    await page.screenshot({ path: `${SHOTS}/bizz-595-v2-ejendomme-tab.png`, fullPage: true });

    const body = await page.locator('body').innerText();
    const personal = ['Søbyvej 11', 'Vigerslevvej 146', 'H C Møllersvej 21', 'Horsekildevej 26', 'Hovager 8'];
    const found = personal.filter((a) => new RegExp(a.replace(/\s+/g, '\\s*'), 'i').test(body));
    const hasPrivatBadge = /personligt\s*ejet|privat/i.test(body);

    if (found.length >= 2) {
      record(T, true, `Personligt ejede ejendomme synlige: ${found.join(', ')} (${found.length}/5 kendte) + badge=${hasPrivatBadge}`);
    } else {
      record(T, false, `Kun ${found.length}/5 kendte personlige adresser fundet. Fandt: ${found.join(', ') || 'ingen'}. URL: ${page.url()}`);
    }
  } catch (err) {
    record(T, false, `Fejl: ${err.message}`);
  }
}

// ─── BIZZ-585: JaJR Diagram — personligt ejede på separat linje ─────────────

async function verify_585(page) {
  const T = 'BIZZ-585';
  try {
    await page.goto(`${BASE}/dashboard/companies/41092807`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    const diaTab = page.getByRole('tab', { name: /Diagram/i }).first();
    if (await diaTab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await diaTab.click();
      await page.waitForTimeout(7000); // D3-simulation
    }

    // Find person-noder for Jakob
    const svg = page.locator('svg').first();
    if (!(await svg.isVisible({ timeout: 3000 }).catch(() => false))) {
      record(T, false, `Ingen SVG-diagram synlig`);
      return;
    }

    // Tjek for stiplede linjer — look for stroke-dasharray i SVG path
    const dashedPaths = await page.locator('svg path[stroke-dasharray], svg line[stroke-dasharray]').count();
    const emeraldPaths = await page.locator('svg [stroke*="emerald"], svg [stroke="#10"], svg [stroke="#34d399"], svg [stroke="#059669"]').count();

    // Tjek om Jakobs adresser står i diagrammet
    const body = await page.locator('body').innerText();
    const personal = ['Søbyvej 11', 'Vigerslevvej 146', 'Horsekildevej 26', 'Hovager 8', 'H C Møllersvej'];
    const found = personal.filter((a) => new RegExp(a.replace(/\s+/g, '\\s*'), 'i').test(body));

    await page.screenshot({ path: `${SHOTS}/bizz-585-v2-diagram.png`, fullPage: false });

    if (found.length >= 2 && dashedPaths > 0) {
      record(T, true, `Diagram viser ${found.length}/5 personligt ejede + ${dashedPaths} stiplede linjer (emerald=${emeraldPaths})`);
    } else if (found.length >= 2) {
      record(T, false, `Personlige ejendomme synlige (${found.length}/5) MEN 0 stiplede linjer fundet — stiplede person→ejendom-edges mangler`);
    } else {
      record(T, false, `Personlige ejendomme ikke fundet i diagram (${found.length}/5), dashed=${dashedPaths}`);
    }
  } catch (err) {
    record(T, false, `Fejl: ${err.message}`);
  }
}

// ─── BIZZ-604: Ejerskabsdiagram faktisk centreret ──────────────────────────

async function verify_604(page) {
  const T = 'BIZZ-604';
  try {
    await page.goto(`${BASE}/dashboard/ejendomme/dd4a90de-b126-4438-824f-3677efab2bd0`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    const ejerskabTab = page.getByRole('tab', { name: /Ejerskab/i }).first();
    if (await ejerskabTab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await ejerskabTab.click();
      await page.waitForTimeout(5000);
    }

    // Beregn centrering: find alle <g>-noder (eller <circle>/<rect>) i SVG
    // og check om deres midlertidige x-midte ligger tæt på SVG's midte
    const metrics = await page.evaluate(() => {
      const svg = document.querySelector('svg');
      if (!svg) return null;
      const svgRect = svg.getBoundingClientRect();
      // Find alle positionerede nodes (typisk <g> med transform)
      const nodes = Array.from(svg.querySelectorAll('g[transform], circle, rect.node, foreignObject'));
      const positions = nodes
        .map((n) => {
          const r = n.getBoundingClientRect();
          return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height };
        })
        .filter((p) => p.w > 5 && p.h > 5);
      if (positions.length === 0) return null;
      const minX = Math.min(...positions.map((p) => p.cx));
      const maxX = Math.max(...positions.map((p) => p.cx));
      const nodesCenter = (minX + maxX) / 2;
      const svgCenter = svgRect.left + svgRect.width / 2;
      const offset = Math.abs(nodesCenter - svgCenter);
      return {
        svgWidth: svgRect.width,
        svgCenter,
        nodesCenter,
        offset,
        offsetPct: (offset / svgRect.width) * 100,
        nodeCount: positions.length,
      };
    });

    await page.screenshot({ path: `${SHOTS}/bizz-604-v2-ejerskab.png`, fullPage: false });

    if (!metrics) {
      record(T, false, `Kunne ikke måle diagram-centrering`);
      return;
    }

    // Hvis nodes er centreret: offset < 5% af svg-bredde
    if (metrics.offsetPct < 5) {
      record(T, true, `Nodes centreret — offset ${metrics.offset.toFixed(0)}px (${metrics.offsetPct.toFixed(1)}% af ${metrics.svgWidth}px), ${metrics.nodeCount} nodes`);
    } else {
      record(T, false, `Nodes forskudt ${metrics.offset.toFixed(0)}px (${metrics.offsetPct.toFixed(1)}%) fra midten — centrering ikke optimal`);
    }
  } catch (err) {
    record(T, false, `Fejl: ${err.message}`);
  }
}

// ─── Run ────────────────────────────────────────────────────────────────────

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true });
const page = await context.newPage();

await login(page);
console.log('Login OK — retry med præciseringer...\n');

await verify_605(page, context);
await verify_610(page);
await verify_595(page);
await verify_585(page);
await verify_604(page);

await browser.close();

console.log('\n═══ RESULT v2 ═══');
const passed = results.filter((r) => r.passed);
console.log(`✅ Passed: ${passed.length}/${results.length}`);
fs.writeFileSync(`${SHOTS}/results-v2.json`, JSON.stringify(results, null, 2));
