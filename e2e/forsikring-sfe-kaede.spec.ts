/**
 * E2E regression tests for forsikringsanalysens SFE-kæde (BIZZ-2118).
 *
 * Fixture: BELVEDERE EJENDOMME A/S (CVR 24301117) i test-miljøet. Policen
 * "Gefionsvej 47A, 3000 Helsingør" (Alm. Brand) er tegnet på SFE-adressen for
 * en stor del af porteføljen (ejerlav 2000652, Helsingør Markjorder):
 *  - Fenrisvej 27A/27B ligger på SAMME SFE (5322356, matr. 65bp) → direkte arv
 *  - Fenrisvej 15/19/23/25 + 65bi/65ce er SØSTER-SFE'er i samme ejerlav med
 *    samme ejer → arver via SFE-kæden (BIZZ-2094-logikken)
 *
 * Dækker de to fejl fra ticketen:
 *  A. Policen på SFE-adressen må IKKE flages "uden for porteføljen"
 *     (selvmodsigende når samme police bruges til SFE-arv)
 *  B. Søster-SFE'erne må ikke stå UFORSIKRET når kæden dækker dem
 *
 * Requires E2E_TEST_EMAIL / E2E_TEST_PASS env vars + BELVEDERE-dokumenterne i
 * test-miljøets tenant. Kører en frisk analyse via API (uden persist-sideløb
 * for preflight-delen).
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH } from './helpers';

const KUNDE = {
  kunde_type: 'virksomhed',
  kunde_id: '24301117',
  kunde_navn: 'BELVEDERE EJENDOMME A/S',
};

/** Delmængde af analyse-svarets mismatch-shape */
interface Mismatch {
  policy_id: string;
  property_address: string | null;
}

/** Delmængde af aktiv-shape fra analyse-detail API'et */
interface AktivRow {
  label: string;
  adresse: string | null;
  matched_policy_id: string | null;
  match_score: number | null;
}

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping forsikring SFE-kæde tests');
  }
});

test.describe('Forsikringsanalyse SFE-kæde (BIZZ-2118)', () => {
  test('preflight flager ikke SFE-police (Gefionsvej 47A) som uden for porteføljen', async ({
    request,
  }) => {
    test.setTimeout(180_000);
    const res = await request.post('/api/forsikring/analyser', {
      data: { ...KUNDE, preflight: true },
      timeout: 150_000,
    });
    expect(res.status()).toBe(200);
    const { mismatches } = (await res.json()) as { mismatches: Mismatch[] };
    const gefionsvej = mismatches.filter((m) => /gefionsvej\s*47/i.test(m.property_address ?? ''));
    expect(gefionsvej, 'SFE-policen på Gefionsvej 47A må ikke flages').toHaveLength(0);
  });

  test("frisk analyse: søster-SFE'er arver dækning via SFE-kæden og mismatch-banner udelades", async ({
    request,
  }) => {
    test.setTimeout(300_000);
    const res = await request.post('/api/forsikring/analyser', {
      data: KUNDE,
      timeout: 280_000,
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      analyse_id: string;
      address_mismatches?: Mismatch[];
    };

    // A) Ingen "uden for porteføljen"-advarsel for SFE-policen
    const gefionsvej = (body.address_mismatches ?? []).filter((m) =>
      /gefionsvej\s*47/i.test(m.property_address ?? '')
    );
    expect(gefionsvej, 'SFE-policen på Gefionsvej 47A må ikke flages').toHaveLength(0);

    // B) Søster-SFE'erne er ikke længere UFORSIKRET
    const detail = await request.get(`/api/forsikring/analyser/${body.analyse_id}`, {
      timeout: 60_000,
    });
    expect(detail.status()).toBe(200);
    const { aktiver } = (await detail.json()) as { aktiver: AktivRow[] };

    const fenrisvej15 = aktiver.find((a) => /fenrisvej\s*15/i.test(a.adresse ?? a.label));
    expect(fenrisvej15, 'Fenrisvej 15 mangler i aktivlisten').toBeTruthy();
    expect(fenrisvej15!.matched_policy_id, 'Fenrisvej 15 må ikke stå UFORSIKRET').not.toBeNull();
    // Kæde-arv skal kunne skelnes fra direkte match (score < 80)
    expect(fenrisvej15!.match_score).toBeLessThan(80);
  });
});
