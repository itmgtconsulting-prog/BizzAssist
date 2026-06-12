/**
 * E2E regression tests for fælles BFE→adresse-resolver (BIZZ-2093).
 *
 * Fixture: BELVEDERE EJENDOMME A/S (CVR 24301117) — SFE-gruppen i Helsingør
 * Markjorder hvor den korrupte cache-backfill (BIZZ-2092) gav alle BFE'er
 * gruppens hovedadresse ("Gefionsvej 47A" ×4). Ground truth verificeret mod
 * DAWA jordstykker pr. BFE 2026-06-12 — matrikulære adresser ændrer sig ikke:
 *   5322351 → Fenrisvej 19      (bebygget)
 *   5322352 → Fenrisvej 15      (bebygget)
 *   5322356 → Fenrisvej 27A     (bebygget)
 *   5322350 → 65bi Helsingør Markjorder (ubebygget grund — matrikelbetegnelse)
 *   5322372 → 65ce Helsingør Markjorder (ubebygget grund — matrikelbetegnelse)
 *
 * De tre flader der skal vise samme adresse pr. BFE:
 *   1. /api/bfe-addresses (diagram-berigelse)
 *   2. /api/ejendomme-by-owner (Ejendomme-tab)
 *   3. forsikrings-gab via walkKoncern — bruger samme lib (app/lib/bfeAdresse);
 *      label-logikken er dækket af __tests__/unit/bfeAdresse.test.ts, og
 *      flade 1 kaldes desuden af forsikring/analyser til police-matching.
 *
 * Requires E2E_TEST_EMAIL / E2E_TEST_PASS env vars + datasæt fra test-miljøet.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH } from './helpers';

const CVR = '24301117';
const BFES = [5322350, 5322351, 5322352, 5322356, 5322372];

/** Forventet adresse pr. BFE (DAWA jordstykke-ground-truth). */
const EXPECTED: Record<number, string> = {
  5322350: '65bi Helsingør Markjorder',
  5322351: 'Fenrisvej 19',
  5322352: 'Fenrisvej 15',
  5322356: 'Fenrisvej 27A',
  5322372: '65ce Helsingør Markjorder',
};

interface AdresseRow {
  adresse: string | null;
  postnr: string | null;
}

interface EjendomSummary {
  bfeNummer: number;
  adresse: string | null;
}

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping bfe-adresse parity tests');
  }
});

test.describe('BFE→adresse paritet på tværs af flader (BIZZ-2093)', () => {
  test('bfe-addresses giver unik pr-BFE-adresse — ingen gruppe-duplikater', async ({ request }) => {
    const res = await request.get(`/api/bfe-addresses?bfes=${BFES.join(',')}`, {
      timeout: 120_000,
    });
    expect(res.status()).toBe(200);
    const data = (await res.json()) as Record<string, AdresseRow>;

    for (const [bfe, exp] of Object.entries(EXPECTED)) {
      expect(data[bfe]?.adresse, `BFE ${bfe}`).toBe(exp);
    }
    // Regression BIZZ-2092: ingen to BFE'er må dele adresse
    const adresser = BFES.map((b) => data[String(b)]?.adresse).filter(Boolean);
    expect(new Set(adresser).size).toBe(adresser.length);
    expect(adresser).not.toContain('Gefionsvej 47A');
  });

  test('ejendomme-by-owner viser samme adresser som bfe-addresses', async ({ request }) => {
    const [addrRes, ejdRes] = await Promise.all([
      request.get(`/api/bfe-addresses?bfes=${BFES.join(',')}`, { timeout: 120_000 }),
      request.get(`/api/ejendomme-by-owner?cvr=${CVR}&limit=50`, { timeout: 120_000 }),
    ]);
    expect(addrRes.status()).toBe(200);
    expect(ejdRes.status()).toBe(200);
    const addrData = (await addrRes.json()) as Record<string, AdresseRow>;
    const { ejendomme } = (await ejdRes.json()) as { ejendomme: EjendomSummary[] };

    for (const bfe of BFES) {
      const fraTab = ejendomme.find((e) => e.bfeNummer === bfe);
      expect(fraTab, `BFE ${bfe} mangler i ejendomme-by-owner`).toBeTruthy();
      // Kernekravet i BIZZ-2093: samme BFE → samme adresse-label på begge flader
      expect(fraTab!.adresse, `BFE ${bfe} adresse-paritet`).toBe(
        addrData[String(bfe)]?.adresse ?? null
      );
    }
    // Ejendomme-tab må heller ikke vise gruppens hovedadresse flere gange
    const gefionsvej = ejendomme.filter((e) => e.adresse === 'Gefionsvej 47A');
    expect(gefionsvej.length).toBeLessThanOrEqual(1);
  });
});
