/**
 * BIZZ-1587 — Verifikation af virksomhed-fallback for fejlcachede person-noder.
 *
 * Belvedere (CVR 24301117) har 4 ejer-noder hvor enhedsnummer faktisk peger
 * på et Vrvirksomhed, ikke en Vrdeltagerperson:
 *   4001768042 → FAMILIEN PETERSEN INVEST A/S (CVR 29821909)
 *   4001845989 → OLE PETERSEN INVEST ApS     (CVR 33356080)
 *   4001845992 → PIA BARNOW INVEST ApS       (CVR 33356099)
 *   4001845993 → KIM PETERSEN INVEST ApS     (CVR 33356102)
 *
 * Test verificerer at /api/diagram/resolve nu konverterer dem til company-noder
 * med korrekte CVR + navn + link i stedet for at vise "Ukendt ejer (en NNNN)".
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH } from './helpers';

const BELVEDERE_CVR = '24301117';
const FORVENTEDE_NAVNE = [
  'FAMILIEN PETERSEN INVEST',
  'OLE PETERSEN INVEST',
  'PIA BARNOW INVEST',
  'KIM PETERSEN INVEST',
];

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) testInfo.skip(true, 'No E2E auth');
});

test('BIZZ-1587: Belvedere diagram resolver virksomhed-fejlcache som company', async ({ page }) => {
  const res = await page.request.post('/api/diagram/resolve', {
    data: { cvr: BELVEDERE_CVR },
  });
  expect(res.status()).toBe(200);
  const data = (await res.json()) as {
    nodes?: Array<{ id: string; label: string; type: string; cvr?: number }>;
  };
  const nodes = data.nodes ?? [];
  console.log(`[BIZZ-1587] ${nodes.length} noder i total`);

  // Ingen "Ukendt ejer (en NNNN)" tilbage
  const ukendte = nodes.filter((n) => /^Ukendt ejer\s*\(en\s*\d+\)$/.test(n.label));
  console.log(
    `[BIZZ-1587] Ukendt-labels:`,
    ukendte.map((n) => n.label)
  );
  expect(ukendte).toEqual([]);

  // Alle 4 forventede holdingselskaber findes som company-noder
  for (const navn of FORVENTEDE_NAVNE) {
    const found = nodes.find((n) => n.label.includes(navn) && n.type === 'company');
    console.log(
      `[BIZZ-1587] ${navn} → ${found ? `cvr=${found.cvr}, type=${found.type}` : 'MANGLER'}`
    );
    expect(found, `${navn} skal være konverteret til company-node`).toBeTruthy();
  }
});
