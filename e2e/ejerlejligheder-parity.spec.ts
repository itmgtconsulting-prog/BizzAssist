/**
 * E2E regression tests for /api/ejerlejligheder Resights-paritet (BIZZ-2061).
 *
 * Fixture: Hammerholmen 44-48, 2650 Hvidovre — SFE BFE 2160256, matrikel
 * 21851/43cr med 17 erhvervs-ejerlejligheder (BFE 221037-221053). Ground
 * truth er verificeret mod Resights og tinglysningens adkomstdata 2026-06-10.
 * Værdierne er historiske registerdata (tinglyste handler + Matriklens
 * arealer) og ændrer sig ikke over tid — sikre som faste fixtures.
 *
 * Dækker de tre regressioner fundet under BIZZ-2061:
 *  1. SFE-lækage: SFE'ens egen cache-række (BFE 2160256) må ikke optræde
 *     som "Ukendt"-enhed i listen
 *  2. Areal/handel-berigelse: tinglyst areal fra MAT_Ejerlejlighed (v2) og
 *     seneste handel fra ejerskifte_historik (koebsaftale_dato + i_alt)
 *  3. moderBfe-selvrække: når klienten sender en leaf-enheds BFE som
 *     moderBfe (fx 221045), skal enhedens egen række bevares — ellers
 *     fejler BFE-match i strukturtræet og en søster-enheds data vises
 *
 * Requires E2E_TEST_EMAIL / E2E_TEST_PASS env vars + datasæt fra
 * test-miljøet (bfe_adresse_cache, ejf_ejerskab, ejerskifte_historik).
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH } from './helpers';

const API = '/api/ejerlejligheder?ejerlavKode=21851&matrikelnr=43cr';
const SFE_BFE = 2160256;

/** Forventet ground truth pr. BFE (tinglyst areal m², seneste handel). */
const EXPECTED: Record<number, { areal: number; pris: number | null; dato: string | null }> = {
  221037: { areal: 1013, pris: 784128, dato: '1988-01-17' },
  221041: { areal: 1146, pris: 12000000, dato: '2019-11-24' },
  221045: { areal: 3336, pris: 2225000, dato: '2001-12-31' },
  221046: { areal: 244, pris: 188872, dato: '1988-01-17' },
};

/** Minimal shape af API-svarets enheder (delmængde af Ejerlejlighed). */
interface Unit {
  bfe: number;
  adresse: string;
  ejer: string | null;
  areal: number | null;
  koebspris: number | null;
  koebsdato: string | null;
  beskrivelse: string | null;
}

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping ejerlejligheder parity tests');
  }
});

test.describe('Ejerlejligheder API — Resights-paritet (BIZZ-2061)', () => {
  test('returnerer alle 17 enheder uden SFE-lækage eller Ukendt-ejere', async ({ request }) => {
    const res = await request.get(API, { timeout: 120_000 });
    expect(res.status()).toBe(200);
    const { lejligheder } = (await res.json()) as { lejligheder: Unit[] };

    expect(lejligheder).toHaveLength(17);
    // SFE'ens egen række må aldrig lække ind i enhedslisten
    expect(lejligheder.some((l) => l.bfe === SFE_BFE)).toBe(false);
    // Alle enheder skal have en resolvet ejer (ingen "Ukendt")
    expect(lejligheder.filter((l) => l.ejer === 'Ukendt')).toHaveLength(0);
    // Tinglyst areal fra MAT_Ejerlejlighed skal være sat på alle enheder
    expect(lejligheder.filter((l) => l.areal == null)).toHaveLength(0);
  });

  test('areal, købspris og købsdato matcher tinglyste registerdata', async ({ request }) => {
    const res = await request.get(API, { timeout: 120_000 });
    expect(res.status()).toBe(200);
    const { lejligheder } = (await res.json()) as { lejligheder: Unit[] };

    for (const [bfeStr, exp] of Object.entries(EXPECTED)) {
      const unit = lejligheder.find((l) => l.bfe === Number(bfeStr));
      expect(unit, `BFE ${bfeStr} mangler i svaret`).toBeTruthy();
      expect(unit!.areal, `BFE ${bfeStr} areal`).toBe(exp.areal);
      expect(unit!.koebspris, `BFE ${bfeStr} købspris`).toBe(exp.pris);
      expect(unit!.koebsdato, `BFE ${bfeStr} købsdato`).toBe(exp.dato);
    }
    // Ejerlejlighedsnummer fra Matriklen vises i beskrivelsen
    const nr1 = lejligheder.find((l) => l.bfe === 221037);
    expect(nr1?.beskrivelse).toBe('Ejerlejlighed nr. 1');
  });

  test('moderBfe på en leaf-enhed fjerner ikke enhedens egen række', async ({ request }) => {
    // BIZZ-2061 (bf773fa4): klienten sender bbrData.ejerlejlighedBfe som
    // moderBfe — på adgangsadresse-niveau kan det være en ægte leaf-enhed.
    // Uden selvrækken fejler BFE-match i UI'et og søster-data vises.
    const res = await request.get(`${API}&moderBfe=221045`, { timeout: 120_000 });
    expect(res.status()).toBe(200);
    const { lejligheder } = (await res.json()) as { lejligheder: Unit[] };

    expect(lejligheder).toHaveLength(17);
    const self = lejligheder.find((l) => l.bfe === 221045);
    expect(self, 'BFE 221045 (moderBfe-selvrække) mangler').toBeTruthy();
    expect(self!.areal).toBe(3336);
    expect(self!.koebspris).toBe(2225000);
  });

  test('moderBfe på SFE-niveau filtrerer fortsat SFE-rækken fra', async ({ request }) => {
    const res = await request.get(`${API}&moderBfe=${SFE_BFE}`, { timeout: 120_000 });
    expect(res.status()).toBe(200);
    const { lejligheder } = (await res.json()) as { lejligheder: Unit[] };

    expect(lejligheder).toHaveLength(17);
    expect(lejligheder.some((l) => l.bfe === SFE_BFE)).toBe(false);
  });
});

test.describe('Ejerskab-tab strukturtræ — enheds-data (BIZZ-2061)', () => {
  test('strukturtræet viser individuelle areal/pris/dato pr. enhed', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`/dashboard/ejendomme/${SFE_BFE}`);
    await page.waitForLoadState('domcontentloaded');

    // Vent til adgangs-gate er passeret og skift til Ejerskab-tabben
    await expect(page.locator('body')).not.toContainText(/Kontrollerer adgang/i, {
      timeout: 45_000,
    });
    await page.getByText('Ejerskab', { exact: true }).first().click({ timeout: 15_000 });

    // Strukturtræet beriges asynkront — vent på en kendt enheds-værdi
    const body = page.locator('body');
    await expect(body).toContainText('784.128', { timeout: 60_000 });

    // 221045 skal vise SINE data (3336 m² / 2.225.000) — ikke søster-enhedens
    await expect(body).toContainText('3336 m²');
    await expect(body).toContainText('2.225.000');
    // Korrigeret handel fra adkomstdata (ikke ejendomshandel-tabellens 973.000)
    await expect(body).not.toContainText('973.000');
    // Ingen "Ukendt"-ejere i træet
    await expect(body).not.toContainText('Ukendt ejer');
  });
});
