import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});
const BASE = 'https://test.bizzassist.dk';
fs.mkdirSync('/tmp/verify-screenshots', { recursive: true });
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('input[type=email]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', process.env.E2E_TEST_PASS);
await Promise.all([page.waitForURL(/dashboard/, { timeout: 30000 }), page.click('button[type=submit]')]);
await page.waitForTimeout(2000);

// Jakob's person page → Ejendomme tab
await page.goto(`${BASE}/dashboard/owners/4000115446`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

// Click Ejendomme tab (scoped)
const ejTab = page.locator('button:has-text("Ejendomme")').filter({ has: page.locator('svg') }).first();
await ejTab.click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(6000);

// Extract bolig m² for each named ejendom
const data = await page.evaluate(() => {
  const addresses = ['Thorvald Bindesbølls Plads 18', 'Horsekildevej 26', 'J.C. Jacobsens Gade 11', 'Kildegårdsvej 18D', 'H C Møllersvej 21', 'Hovager 8'];
  const out = {};
  for (const addr of addresses) {
    // Find card containing the address
    const all = document.querySelectorAll('*');
    let card = null;
    for (const el of all) {
      if (el.textContent?.includes(addr) && el.textContent.length < 500) {
        // Try to find containing card
        let parent = el;
        while (parent && parent.offsetWidth < 200) parent = parent.parentElement;
        if (parent && parent.offsetWidth > 200) { card = parent; break; }
      }
    }
    if (!card) { out[addr] = 'card not found'; continue; }
    // Widen to card container
    for (let i = 0; i < 4; i++) {
      if (card.parentElement && card.parentElement.offsetWidth < 500) card = card.parentElement;
    }
    const text = card.textContent.replace(/\s+/g, ' ').slice(0, 400);
    // Extract Bolig: X m²
    const boligMatch = text.match(/Bolig:\s*(\d+)\s*m²/);
    const matrMatch = text.match(/Matr:\s*([\d.]+)\s*m²/);
    out[addr] = { bolig: boligMatch?.[1] ? parseInt(boligMatch[1], 10) : null, matr: matrMatch?.[1] || null, snippet: text.slice(0, 150) };
  }
  return out;
});

console.log(JSON.stringify(data, null, 2));
await page.screenshot({ path: '/tmp/verify-screenshots/691-lejligheder.png', fullPage: true });
await b.close();
