#!/usr/bin/env node
/**
 * Verify BIZZ-516 — fusion/spaltning entries in history tab have
 * modpart enhedsNummer link + direction label.
 */
import { chromium } from 'playwright';
import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.local') });

const BASE = 'https://test.bizzassist.dk';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 2000 } });
const page = await ctx.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.getByPlaceholder('navn@virksomhed.dk').fill(process.env.E2E_TEST_EMAIL);
await page.getByPlaceholder('••••••••').fill(process.env.E2E_TEST_PASS);
await page.getByRole('button', { name: /Log ind/i }).click();
await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 30000 });

// Step 1: probe API (BIZZ-516 data)
const res = await page.evaluate(async () => {
  const r = await fetch('/api/cvr-public?vat=10403782');
  return r.ok ? await r.json() : null;
});
const fusions = res?.historik?.filter((h) => h.type === 'fusion') || [];
console.log(`\nFusion entries in historik: ${fusions.length}`);
for (const f of fusions) {
  console.log(
    `  fra=${f.fra} vaerdi="${f.vaerdi}" retning=${f.retning ?? 'null'} modpartEnhedsNummer=${f.modpartEnhedsNummer}`
  );
}
const spaltninger = res?.historik?.filter((h) => h.type === 'spaltning') || [];
console.log(`Spaltning entries: ${spaltninger.length}`);

// Step 2: navigate and screenshot the History tab for Vestas
console.log('\n→ Navigate to Vestas /dashboard/companies/10403782 Kronologi tab');
await page.goto(`${BASE}/dashboard/companies/10403782`, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(2500);
const kronTab = page.locator('button').filter({ hasText: /^Kronologi$|^History$/ }).first();
if (await kronTab.isVisible({ timeout: 3000 }).catch(() => false)) {
  await kronTab.click();
  await page.waitForTimeout(2500);
} else {
  console.log('  Kronologi tab not found via button locator');
}
const text = (await page.locator('main, body').first().innerText()).replace(/\s+/g, ' ');
const hasFusionLabel = /Fusion\s*\(optagende\)|Fusion\s*\(ophørt\)|\bFusion\b/i.test(text);
const hasModpartLink = /Se modpart|View counterparty/i.test(text);
const hasEnhedsNummer = /#4005877353|#\d{10}/.test(text);
console.log(`  Fusion label visible: ${hasFusionLabel ? '✅' : '❌'}`);
console.log(`  "Se modpart" link visible: ${hasModpartLink ? '✅' : '❌'}`);
console.log(`  enhedsNummer visible: ${hasEnhedsNummer ? '✅' : '❌'}`);
await page.screenshot({ path: '/tmp/bizz-verify/bizz516-vestas.png', fullPage: true });
console.log('Screenshot: /tmp/bizz-verify/bizz516-vestas.png');

await browser.close();
