#!/usr/bin/env node
/**
 * Retry BIZZ-629 med specifikke datterselskab-CVR'er der ejer ejendomme direkte.
 * JaJR Holding ApS ejer ikke ejendomme direkte — de ligger i datterselskaber.
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

// Datterselskaber der ejer de berørte ejendomme (fra tidligere ticket-beskrivelse)
const datterCvrs = [
  { cvr: '43924931', name: 'Arnbo 62 ApS',    expects: 'Arnold Nielsens Boulevard 62A + 62B' },
  { cvr: '44364484', name: 'ArnBo 64b ApS',   expects: 'Arnold Nielsens Boulevard 64B' },
  { cvr: '41370025', name: 'HP Properties ApS', expects: 'Høvedstensvej 33, 39, 43' },
];

for (const d of datterCvrs) {
  console.log(`═══ CVR ${d.cvr} — ${d.name} (${d.expects}) ═══`);
  const resp = await page.evaluate(async (cvr) => {
    const r = await fetch(`/api/ejendomme-by-owner?cvr=${cvr}&limit=20`, { credentials: 'include' });
    if (!r.ok) return { error: `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` };
    return await r.json();
  }, d.cvr);

  if (resp.error) {
    console.log(`  ❌ ${resp.error}\n`);
    continue;
  }

  const list = resp.ejendomme || [];
  console.log(`  ${list.length} ejendomme (totalBfe=${resp.totalBfe})`);

  for (const e of list) {
    const bfe = e.bfeNummer ?? e.bfe_nummer ?? e.bfe;
    const bolig = e.boligAreal ?? null;
    const erhv = e.erhvervsAreal ?? null;
    const matr = e.matrikelAreal ?? null;
    const adr = e.adresse || e.dawaAdresse || '?';

    const flag =
      (bolig == null || bolig === 0) && (erhv == null || erhv === 0)
        ? '⚠ BUG-KANDIDAT'
        : '✓';

    console.log(`    ${flag}  BFE ${bfe}  bolig=${bolig ?? 'null'}  erhv=${erhv ?? 'null'}  matr=${matr ?? 'null'}  ${(adr || '').toString().slice(0, 50)}`);
  }
  console.log();
}

await browser.close();
