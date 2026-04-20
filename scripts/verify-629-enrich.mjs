#!/usr/bin/env node
/**
 * BIZZ-629 retry — check enrich-endpoint returns real m² values.
 * Initial list endpoint returns null (expected — progressive enrich fills in).
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
console.log('Login OK\n');

const testBfes = [
  { bfe: 226630, name: 'Arnold Nielsens Boulevard 62A' },
  { bfe: 226629, name: 'Arnold Nielsens Boulevard 62B' },
  { bfe: 2091185, name: 'Arnold Nielsens Boulevard 64B' },
  { bfe: 2091179, name: 'Høvedstensvej 33' },
];

for (const t of testBfes) {
  console.log(`═══ BFE ${t.bfe} — ${t.name} ═══`);
  const resp = await page.evaluate(async (bfe) => {
    const r = await fetch(`/api/ejendomme-by-owner/enrich?bfe=${bfe}`, { credentials: 'include' });
    if (!r.ok) return { error: `HTTP ${r.status}`, body: (await r.text()).slice(0, 300) };
    return await r.json();
  }, t.bfe);

  if (resp.error) { console.log(`  ❌ ${resp.error}\n${resp.body || ''}\n`); continue; }
  console.log(`  boligAreal=${resp.boligAreal ?? 'null'}  erhvervsAreal=${resp.erhvervsAreal ?? 'null'}  matrikelAreal=${resp.matrikelAreal ?? 'null'}`);
  console.log(`  vurdering=${resp.ejendomsvurdering ?? 'null'}  grundVaerdi=${resp.grundVaerdi ?? 'null'}`);
  console.log();
}

// Also try enrich-batch
console.log('═══ Batch enrich (alle 4 BFE\'er) ═══');
const batch = await page.evaluate(async (bfes) => {
  const r = await fetch(`/api/ejendomme-by-owner/enrich-batch?bfes=${bfes.join(',')}`, { credentials: 'include' });
  if (!r.ok) return { error: `HTTP ${r.status}`, body: (await r.text()).slice(0, 300) };
  return await r.json();
}, testBfes.map(t => t.bfe));

if (batch.error) console.log(`❌ ${batch.error}\n${batch.body || ''}`);
else {
  const items = batch.enriched || batch.items || batch.results || [];
  for (const i of items) {
    console.log(`  BFE ${i.bfe ?? i.bfeNummer ?? '?'}  bolig=${i.boligAreal ?? 'null'}  erhv=${i.erhvervsAreal ?? 'null'}  matr=${i.matrikelAreal ?? 'null'}`);
  }
}

await browser.close();
