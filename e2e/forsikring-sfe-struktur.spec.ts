/**
 * BIZZ-2096 — E2E: SFE-struktur-arv af police-dækning i forsikringsanalysen.
 *
 * Scenario (BELVEDERE EJENDOMME A/S, CVR 24301117): policen 50143465 står på
 * SFE-adressen "Gefionsvej 47A, 3000 Helsingør" (SFE-BFE 5322356, matrikel
 * 65bp). Underliggende ejendomme på samme SFE (Fenrisvej 27A/27B,
 * Gefionsvej 49-57) skal arve dækningen i stedet for at stå UFORSIKRET, og
 * arven skal være transparent markeret via raw_data.daekket_via_sfe.
 *
 * Mønster: API-drevet analyse + detail-assert (jf. forsikring-belvedere-fix.spec.ts).
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH } from './helpers';

const BELVEDERE_CVR = '24301117';
const BELVEDERE_NAVN = 'BELVEDERE EJENDOMME A/S';
const SFE_ARV_SCORE = 75;

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping SFE-struktur verification');
  }
});

/** Aktiv-række fra analyse-detail API'et (subset) */
interface AktivRow {
  type: string;
  label: string;
  adresse: string | null;
  matched_policy_id: string | null;
  match_score: number | null;
  raw_data: {
    sfe_bfe?: number;
    sfe_niveau?: string;
    daekket_via_sfe?: { sfe_bfe: number; sfe_adresse: string };
  } | null;
}

test.describe('BIZZ-2096 SFE-struktur-arv', () => {
  test('analyse for Belvedere nedarver dækning fra SFE-police til underliggende ejendomme', async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const res = await page.request.post('/api/forsikring/analyser', {
      data: {
        kunde_type: 'virksomhed',
        kunde_id: BELVEDERE_CVR,
        kunde_navn: BELVEDERE_NAVN,
      },
      timeout: 120_000,
    });
    expect(res.status()).toBe(200);
    const analyse = (await res.json()) as { analyse_id?: string; insured_count?: number };
    expect(analyse.analyse_id).toBeTruthy();

    const detailRes = await page.request.get(`/api/forsikring/analyser/${analyse.analyse_id}`);
    expect(detailRes.status()).toBe(200);
    const detail = (await detailRes.json()) as { aktiver?: AktivRow[] };
    const ejendomme = (detail.aktiver ?? []).filter((a) => a.type === 'ejendom');
    expect(ejendomme.length).toBeGreaterThan(0);

    // 1. Strukturen er resolvet: mindst ét aktiv har SFE-annotering
    const medSfe = ejendomme.filter((a) => a.raw_data?.sfe_bfe != null);
    console.log(`[BIZZ-2096] ${medSfe.length}/${ejendomme.length} aktiver med sfe_bfe`);
    expect(medSfe.length).toBeGreaterThan(0);

    // 2. Mindst ét aktiv har arvet dækning via SFE-policen
    const arvede = ejendomme.filter((a) => a.raw_data?.daekket_via_sfe);
    console.log(
      `[BIZZ-2096] ${arvede.length} aktiver dækket via SFE:`,
      arvede.map((a) => `${a.label} ← ${a.raw_data?.daekket_via_sfe?.sfe_adresse}`)
    );
    expect(arvede.length).toBeGreaterThan(0);

    // 3. Arvede aktiver er forsikrede med arve-scoren og transparent kilde-adresse
    for (const a of arvede) {
      expect(a.matched_policy_id).toBeTruthy();
      expect(a.match_score).toBe(SFE_ARV_SCORE);
      expect(a.raw_data?.daekket_via_sfe?.sfe_adresse).toBeTruthy();
      expect(a.raw_data?.daekket_via_sfe?.sfe_bfe).toBeGreaterThan(0);
    }
  });
});
