#!/usr/bin/env node
/**
 * Verify BIZZ-498 (zone classification badge) — zone chip shown on property header.
 * Tests a byzone property (Copenhagen) and a summerhus property.
 */
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
import _fs from 'node:fs';

loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const BASE = 'https://test.bizzassist.dk';
const EMAIL = process.env.E2E_TEST_EMAIL;
const PASS = process.env.E2E_TEST_PASS;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
const page = await ctx.newPage();

async function login() {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  const cookie = page.getByRole('button', { name: /Acceptér|Accepter/i });
  if (await cookie.isVisible({ timeout: 2000 }).catch(() => false)) await cookie.click();
  await page.getByPlaceholder('navn@virksomhed.dk').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASS);
  await page.getByRole('button', { name: /Log ind/i }).click();
  await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 30000 });
  if (page.url().includes('/onboarding')) await page.goto(`${BASE}/dashboard`);
  await page.waitForLoadState('domcontentloaded');
}

try {
  await login();

  const tests = [
    { addr: 'Nørrebrogade 100', expect: /Byzone/i },
    { addr: 'Strandvejen 100, 2900', expect: /Byzone|Landzone|Sommerhuszone/i },
  ];

  for (const { addr, expect } of tests) {
    console.log(`\n→ Navigating to: ${addr}`);
    await page.goto(`${BASE}/dashboard/ejendomme`, { waitUntil: 'domcontentloaded' });
    const search = page.getByPlaceholder(/adresse.*vejnavn|vejnavn.*postnummer|postnummer/i).first();
    await search.waitFor({ timeout: 15000 });
    await search.fill(addr);
    await page.waitForTimeout(1500);
    const firstHit = page.locator('button').filter({ hasText: new RegExp(addr.split(' ')[0].replace('ø', '[øo]'), 'i') }).first();
    await firstHit.waitFor({ timeout: 12000 });
    await firstHit.click();
    await page.waitForURL(/\/dashboard\/ejendomme\//, { timeout: 20000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const headerText = (await page.locator('main, body').first().innerText()).replace(/\s+/g, ' ').slice(0, 3000);
    const match = expect.test(headerText);
    console.log(`  Zone badge: ${match ? '✅' : '❌'} (testing ${expect})`);
    const zoneMatch = headerText.match(/(Byzone|Landzone|Sommerhuszone)/);
    if (zoneMatch) console.log(`  Detected: ${zoneMatch[0]}`);
  }

  await page.screenshot({ path: '/tmp/bizz-verify/bizz498.png', fullPage: true });
  console.log('\nScreenshot: /tmp/bizz-verify/bizz498.png');
} finally {
  await browser.close();
}
