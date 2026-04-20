#!/usr/bin/env node
/**
 * Browser-verifikation af batch 2 In Review tickets (2026-04-20):
 *   BIZZ-630  Kort-søg lander i DK (ikke Afrika)
 *   BIZZ-603  /dashboard/pvoplys har loading.tsx
 *   BIZZ-628  "Ejer:"-linje fjernet fra person-Ejendomme-kort
 *   BIZZ-631  Filter-knapper fjernet fra person-Ejendomme-tab
 *   BIZZ-596  Person-Ejendomme-layout alignet med virksomhed
 *   BIZZ-621  Cron Status Dashboard eksisterer
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
    if (await n.isVisible({ timeout: 1000 }).catch(() => false)) { await n.click(); await page.waitForTimeout(250); } else break;
  }
}

const results = [];
function record(ticket, passed, notes) { results.push({ ticket, passed, notes }); console.log(`${passed ? '✅' : '❌'} ${ticket}: ${notes}`); }

// ─── BIZZ-630: Kort-søg ─────────────────────────────────────────────────────
async function verify_630(page) {
  const T = 'BIZZ-630';
  try {
    await page.goto(`${BASE}/dashboard/kort`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(4000);

    // Find søgefelt på kort-siden
    const search = page.locator('input[placeholder*="adresse" i], input[type="search"]').first();
    await search.waitFor({ state: 'visible', timeout: 10000 });
    await search.fill('Søbyvej 11');
    await page.waitForTimeout(2000);

    // Klik første forslag
    const forslag = page.locator('[role="option"], li[data-testid*="suggest"], button:has-text("Søbyvej")').first();
    if (await forslag.isVisible({ timeout: 3000 }).catch(() => false)) {
      await forslag.click();
      await page.waitForTimeout(3000);
    } else {
      await search.press('Enter');
      await page.waitForTimeout(3000);
    }

    await page.screenshot({ path: `${SHOTS}/bizz-630-kort-soegning.png`, fullPage: false });

    // Tjek at kortet er zoomet ind på DK (zoom > 10) og ikke står på verdensbillede
    const mapState = await page.evaluate(() => {
      const w = window;
      // mapbox lagrer typisk map-ref på globalen under udvikling — men i produktion ikke
      // Fall back: tjek om søgt-markør er synlig og om et zoom-tal vises
      const zoomBadge = document.querySelector('[data-testid="zoom-badge"], .zoom-badge');
      return { zoomText: zoomBadge?.textContent || null };
    });

    // Alternativ: tjek om der er en toast/besked om "adresse ikke fundet"
    const bodyText = await page.locator('body').innerText();
    const hasToast = /ikke\s+fundet|kunne\s+ikke\s+finde|invalid\s+koordinat/i.test(bodyText);

    // Hvis pin-marker er synlig, tjek om dens position er inden for DK
    // Canvas-based mapbox svært — bedste er om zoom-niveau er 10+ eller en toast
    const zoomIsCloseUp = mapState.zoomText && parseFloat(mapState.zoomText.replace(/[^\d.]/g, '')) >= 10;

    if (zoomIsCloseUp) {
      record(T, true, `Kortet zoomet til DK (zoom=${mapState.zoomText}) — pin lander ikke i Afrika ✓`);
    } else if (hasToast) {
      record(T, true, `Toast vist: "adresse ikke fundet" — kortet flytter sig ikke. DK-bbox-validering virker ✓`);
    } else {
      record(T, false, `Uklar tilstand — zoomText=${mapState.zoomText}, hasToast=${hasToast}. Manuel screenshot-review nødvendig.`);
    }
  } catch (err) { record(T, false, `Fejl: ${err.message}`); }
}

// ─── BIZZ-603: /dashboard/pvoplys loading.tsx ───────────────────────────────
async function verify_603(page) {
  const T = 'BIZZ-603';
  try {
    // Kør CPU-throttle for at tvinge skeleton til at være synlig
    const client = await page.context().newCDPSession(page);
    await client.send('Emulation.setCPUThrottlingRate', { rate: 6 });

    const nav = page.goto(`${BASE}/dashboard/pvoplys`, { waitUntil: 'commit' });
    await page.waitForTimeout(300);

    // Tjek om der er skeleton-elementer synlige
    const skeletonCount = await page.locator('[class*="skeleton" i], [class*="animate-pulse" i], [data-testid*="skeleton" i]').count();

    await page.screenshot({ path: `${SHOTS}/bizz-603-pvoplys-loading.png` });
    await nav.catch(() => {}); // complete navigation
    await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });

    if (skeletonCount > 0) {
      record(T, true, `Loading skeleton vises (${skeletonCount} skeleton-elementer under navigation) ✓`);
    } else {
      // Fallback: tjek at filen eksisterer i source (allerede verificeret code-level)
      record(T, false, `Ingen skeleton-elementer synlige — manual verifikation anbefalet. CPU-throttle måske ikke aggressiv nok.`);
    }
  } catch (err) { record(T, false, `Fejl: ${err.message}`); }
}

// ─── BIZZ-628, 631, 596: Person → Ejendomme-tab ────────────────────────────
async function verify_628_631_596(page) {
  // Brug Jakob (4000115446) som test-case
  try {
    await page.goto(`${BASE}/dashboard/owners/4000115446`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    const ejTab = page.getByRole('tab', { name: /^Ejendomme/i }).first();
    if (await ejTab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await ejTab.click();
      await page.waitForTimeout(5000);
    }

    await page.screenshot({ path: `${SHOTS}/bizz-628-631-596-person-ejendomme.png`, fullPage: true });

    const bodyText = await page.locator('body').innerText();

    // BIZZ-631: filter-knapper "Alle / Ejendomme / Ejendomshandler"
    const hasFilterAlle = /\b(Alle|All)\b.*\b(Ejendomme|Ejendomshandler|Properties)\b/.test(bodyText);
    const has3FilterBtns = await page.locator('button:has-text("Ejendomshandler"), button:has-text("Ejendomme") + button:has-text("Ejendomshandler")').count();
    if (has3FilterBtns === 0 && !/Ejendomshandler/i.test(bodyText)) {
      record('BIZZ-631', true, `Filter-knap "Ejendomshandler" ikke længere synlig ✓`);
    } else {
      record('BIZZ-631', false, `Filter-knap "Ejendomshandler" stadig synlig (matches=${has3FilterBtns})`);
    }

    // BIZZ-628: "Ejer: [virksomhed]" linje i hvert kort
    const ejerLineCount = (bodyText.match(/^Ejer:\s/gm) || []).length + (bodyText.match(/\n\s*Ejer:\s/g) || []).length;
    if (ejerLineCount === 0) {
      record('BIZZ-628', true, `"Ejer:"-linje ikke længere synlig i ejendoms-kort ✓`);
    } else {
      record('BIZZ-628', false, `"Ejer:"-linje stadig synlig (${ejerLineCount} forekomster)`);
    }

    // BIZZ-596: alignment med virksomhed — check om Ejendomme-tabben IKKE viser "Kommer snart"
    const hasPlaceholder = /Kommer\s+snart/i.test(bodyText);
    // Check for existence of ejendoms-kort
    const ejendomsCards = await page.locator('[data-testid*="ejendom" i], a[href*="/dashboard/ejendomme/"]').count();
    if (!hasPlaceholder && ejendomsCards >= 5) {
      record('BIZZ-596', true, `Person-Ejendomme alignet med virksomhed: ${ejendomsCards} ejendomskort vist, ingen placeholder ✓`);
    } else if (hasPlaceholder) {
      record('BIZZ-596', false, `"Kommer snart"-placeholder stadig synlig — alignment ikke gennemført`);
    } else {
      record('BIZZ-596', false, `Kun ${ejendomsCards} ejendomskort synlige (forventet ≥ flere)`);
    }
  } catch (err) {
    record('BIZZ-628', false, `Fejl: ${err.message}`);
    record('BIZZ-631', false, `Fejl: ${err.message}`);
    record('BIZZ-596', false, `Fejl: ${err.message}`);
  }
}

// ─── BIZZ-621: Cron Status Dashboard ────────────────────────────────────────
async function verify_621(page) {
  const T = 'BIZZ-621';
  try {
    // Prøv forventet URL først
    for (const p of ['/dashboard/admin/cron-status', '/dashboard/admin/service-management?tab=crons', '/dashboard/admin/crons']) {
      const r = await page.goto(`${BASE}${p}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      const status = r?.status() ?? 0;
      const url = page.url();
      if (status === 200 && !url.includes('/404') && !url.endsWith('/dashboard')) {
        // Check if Cron-relateret indhold findes
        const bodyText = await page.locator('body').innerText();
        if (/cron|heartbeat|last.run|sidste.k\u00f8rsel/i.test(bodyText)) {
          await page.screenshot({ path: `${SHOTS}/bizz-621-cron-dashboard.png`, fullPage: true });
          record(T, true, `Cron Status Dashboard tilgængelig på ${p} ✓`);
          return;
        }
      }
    }
    // Fallback: tjek service-management-page for Crons-tab
    await page.goto(`${BASE}/dashboard/admin/service-management`);
    await page.waitForTimeout(2500);
    const cronTab = page.getByRole('tab', { name: /Cron|Heartbeats/i }).first();
    if (await cronTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await cronTab.click();
      await page.waitForTimeout(2000);
      record(T, true, `Cron-tab på /dashboard/admin/service-management ✓`);
    } else {
      record(T, false, `Ingen cron-dashboard / cron-tab fundet under admin-siderne`);
    }
  } catch (err) { record(T, false, `Fejl: ${err.message}`); }
}

// ─── Run ────────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true });
const page = await context.newPage();

await login(page);
console.log('Login OK\n');

await verify_630(page);
await verify_603(page);
await verify_628_631_596(page);
await verify_621(page);

await browser.close();

console.log(`\n═══ BATCH 2 ═══`);
const passed = results.filter(r => r.passed);
console.log(`✅ Passed: ${passed.length}/${results.length}`);
fs.writeFileSync(`${SHOTS}/results-batch2.json`, JSON.stringify(results, null, 2));
