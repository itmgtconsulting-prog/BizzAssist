#!/usr/bin/env node
/**
 * Test salgshistorik på flere BFE'er for at se om fejlen er generel eller
 * ejendomsspecifik.
 */
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });
const BASE = 'https://test.bizzassist.dk';

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
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
await login(page);

const testBfes = [
  { bfe: 425479, name: 'Kaffevej 31 1.tv (ejerlejlighed, 2 handler forventet)' },
  { bfe: 226629, name: 'Arnold Nielsens Boulevard 62B (købt 2023 for 7,5 mio)' },
  { bfe: 100165718, name: 'Thorvald Bindesbølls Plads 18 (købt 2019)' },
];

for (const t of testBfes) {
  console.log(`\n═══ BFE ${t.bfe} — ${t.name} ═══`);
  const resp = await page.evaluate(async (bfe) => {
    const r = await fetch(`/api/salgshistorik?bfeNummer=${bfe}`, { credentials: 'include' });
    return { status: r.status, body: await r.json().catch(() => r.text()) };
  }, t.bfe);

  console.log(`  HTTP ${resp.status}`);
  const b = resp.body;
  if (typeof b === 'string') { console.log(`  Response: ${b.slice(0, 200)}`); continue; }

  const handler = b.handler || [];
  console.log(`  handler.length: ${handler.length}`);
  console.log(`  fejl: ${b.fejl || 'ingen'}`);
  console.log(`  manglerAdgang: ${b.manglerAdgang}, manglerNoegle: ${b.manglerNoegle}`);

  for (const h of handler.slice(0, 5)) {
    const dato = h.handelsDato || h.overtagelsesDato || h.dato;
    const pris = h.kontantKoebesum || h.koebesum || h.pris;
    console.log(`    ${dato || '?'}  ${pris || '?'} DKK  type=${h.handelType || h.type || '?'}`);
  }
}

await browser.close();
