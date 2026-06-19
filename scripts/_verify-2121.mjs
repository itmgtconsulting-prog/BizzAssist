/**
 * Verifikation af BIZZ-2121 mod test.bizzassist.dk: genparse DBRAMANTE-
 * dokumenterne med den nye prompt, kør frisk analyse og assertér:
 *   1. ≥9 delpolicer parses (Driftstab/Netbank/Cyber/Kriminalitet medtages)
 *   2. Fareafværgelse kodes ikke som driftstab
 *   3. Ingen "Ingen cyber"-finding; ingen rød driftstabs-underforsikring
 *   4. Dækket-boksen aggregerer alle kundens policer (UI, ForsikringPageClient)
 * Screenshot af analyse-visningen. Engangs-script.
 */
import { chromium } from 'playwright';
import { config } from 'dotenv';
config({ path: '/root/BizzAssist/.env.local' });

const BASE = 'https://test.bizzassist.dk';
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();

await page.goto(`${BASE}/login`);
await page.fill('input[type="email"]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type="password"]', process.env.E2E_TEST_PASS);
await page.click('button[type="submit"]');
await page.waitForURL('**/dashboard**', { timeout: 25000 });
console.log('✓ logget ind');

let fail = 0;
const check = (ok, label) => {
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label}`);
  if (!ok) fail++;
};

// Dokument-scope
const docRes = await page.request.get(
  `${BASE}/api/forsikring/documents/for-customer?kunde_id=34601704`,
  { timeout: 30000 }
);
// Kun de 2 RIGTIGE DBRAMANTE-dokumenter — for-customer kan også returnere
// junction-linkede docs fra gamle test-analyser (fx syntetiske BIZZ-2097-docs)
const REAL_DOCS = ['Dbramante1928Aps.PDF', 'DBRAMANTE1928 ApS - produktansvar.pdf'];
const docs = ((await docRes.json()).documents ?? []).filter((d) =>
  REAL_DOCS.includes(d.original_name)
);
console.log('doc-scope:', docs.map((d) => `${d.original_name} [${d.parse_status}]`));
check(docs.length === 2, `dokument-scope fundet (${docs.length} docs)`);

// Genparse hvert dokument med den nye prompt (sekventielt — op til 300s pr. doc).
// Klient-socketen kan dø (ETIMEDOUT) før Vercel-funktionen er færdig — derfor
// catch + poll på dokumentets parse_status bagefter.
for (const d of docs) {
  const t0 = Date.now();
  let status = 'fejl';
  try {
    const pr = await page.request.post(`${BASE}/api/forsikring/parse`, {
      data: { document_id: d.id },
      timeout: 310000,
    });
    status = String(pr.status());
  } catch (e) {
    console.log(`  (parse-kald afbrudt for "${d.original_name}": ${e.message?.split('\n')[0]} — poller status)`);
  }
  // Poll parse_status indtil parsed/failed (max 6 min)
  let final = 'ukendt';
  for (let i = 0; i < 36; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    const sr = await page.request.get(
      `${BASE}/api/forsikring/documents/for-customer?kunde_id=34601704`,
      { timeout: 30000 }
    );
    const cur = ((await sr.json()).documents ?? []).find((x) => x.id === d.id);
    final = cur?.parse_status ?? 'ukendt';
    if (final === 'parsed' || final === 'failed') break;
  }
  check(final === 'parsed', `genparse "${d.original_name}" → ${final} (HTTP ${status}, ${Math.round((Date.now() - t0) / 1000)}s)`);
}

// Frisk analyse
const res = await page.request.post(`${BASE}/api/forsikring/analyser`, {
  data: {
    kunde_type: 'virksomhed',
    kunde_id: '34601704',
    kunde_navn: 'DBRAMANTE1928 ApS',
    document_ids: docs.map((d) => d.id),
  },
  timeout: 290000,
});
check(res.status() === 200, `analyse status 200 (fik ${res.status()})`);
const body = await res.json().catch(() => ({}));
console.log('analyse_id:', body.analyse_id);

const det = await page.request.get(`${BASE}/api/forsikring/analyser/${body.analyse_id}`, {
  timeout: 60000,
});
const detail = await det.json();
const pols = detail.policies ?? [];
const covs = detail.coverages ?? [];
const gaps = detail.gaps ?? [];
console.log(`policer: ${pols.length}, coverages: ${covs.length}, gaps: ${gaps.length}`);
for (const p of pols) console.log(`  · ${p.business_activity ?? '?'} | ${p.policy_number}`);

// Kriterium 1: alle 9 forsikringer fra oversigten + produktansvar = ≥9 policer
check(pols.length >= 9, `≥9 delpolicer parsed (fik ${pols.length})`);
const acts = pols.map((p) => (p.business_activity ?? '').toLowerCase()).join(' | ');
for (const need of ['driftstab', 'netbank', 'cyber', 'kriminalitet']) {
  check(acts.includes(need), `delpolice med "${need}" findes`);
}

// Kriterium 2: Fareafværgelse må ikke være driftstab
const fare = covs.filter((c) => /fareafvær/i.test(c.coverage_label ?? ''));
for (const c of fare) {
  check(c.coverage_code !== 'driftstab', `Fareafværgelse kodes ikke driftstab (fik ${c.coverage_code})`);
}
const ægteDriftstab = covs.find((c) => c.coverage_code === 'driftstab' && c.sum_dkk === 20459785);
check(!!ægteDriftstab, 'driftstab-dækning 20.459.785 findes');

// Kriterium 3: ingen falske findings
const ingenCyber = gaps.find((g) => /ingen cyber/i.test(`${g.title} ${g.description}`));
check(!ingenCyber, 'ingen "Ingen cyber-forsikring"-finding');
const rødDriftstab = gaps.find((g) =>
  /driftstabsdækning under/i.test(`${g.title} ${g.description}`)
);
check(!rødDriftstab, 'ingen rød driftstabs-underforsikrings-finding');

// Kriterium 4 (UI): Dækket-boksen aggregerer alle kundens policer
await page.goto(`${BASE}/dashboard/forsikring`, { waitUntil: 'domcontentloaded' });
await page.fill('input[placeholder*="Søg CVR"]', '34601704');
await page.waitForTimeout(3000);
await page.locator('div.absolute button').first().click();
await page.waitForTimeout(2000);
await page.keyboard.press('Escape'); // luk evt. doc-picker
// Klik nyeste historik-række
const histRow = page.locator('button', { hasText: 'gaps' }).first();
await histRow.click({ timeout: 15000 });
await page.waitForTimeout(8000);
// Ekspandér virksomheds-rækken så den grønne "Dækket"-boks renders
await page
  .locator('button[aria-label*="Udvid DBRAMANTE"], button[aria-label*="Udvid DBRA"]')
  .first()
  .click({ timeout: 15000 });
await page.waitForTimeout(2000);
const bodyText = await page.textContent('body');
const m = [...bodyText.matchAll(/Dækket \((\d+)\)/g)].map((x) => Number(x[1]));
console.log('Dækket-bokse:', m);
check(m.length > 0 && Math.max(...m) >= 20, `Dækket-boks aggregerer ≥20 dækninger (fik ${m.length ? Math.max(...m) : 0})`);
await page.screenshot({ path: '/tmp/bizz2121-final.png', fullPage: true });
console.log('screenshot: /tmp/bizz2121-final.png');

await browser.close();
console.log(fail === 0 ? '\nALLE CHECKS GRØNNE' : `\n${fail} CHECK(S) FEJLEDE`);
process.exit(fail === 0 ? 0 : 1);
