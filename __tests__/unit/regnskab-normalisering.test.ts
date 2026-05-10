/**
 * BIZZ-1134: Tests for cross-year T DKK normalisation.
 *
 * Validates that normaliserAlleAar() handles mixed XBRL formats
 * consistently — years in full DKK get divided by 1.000 regardless
 * of whether their max is above or below the 10M per-year threshold.
 */

import { describe, it, expect } from 'vitest';
import type {
  RegnskabsAar,
  Resultatopgoerelse,
  Balance,
  Noegletal,
  Pengestroemme,
} from '@/app/api/regnskab/xbrl/route';
import { normaliserAlleAar } from '@/app/api/regnskab/xbrl/route';

/** Hjælpefunktion: opret et minimalt RegnskabsAar med valgfrie monetære værdier */
function lagAar(
  aar: number,
  overrides: {
    omsaetning?: number | null;
    aktiverIAlt?: number | null;
    aaretsResultat?: number | null;
    egenkapital?: number | null;
    nettoGaeld?: number | null;
  } = {}
): RegnskabsAar {
  const resultat: Resultatopgoerelse = {
    omsaetning: overrides.omsaetning ?? null,
    bruttofortjeneste: null,
    personaleomkostninger: null,
    afskrivninger: null,
    resultatFoerSkat: null,
    skatAfAaretsResultat: null,
    aaretsResultat: overrides.aaretsResultat ?? null,
    finansielleIndtaegter: null,
    finansielleOmkostninger: null,
    eksterneOmkostninger: null,
    driftsomkostninger: null,
  };
  const balance: Balance = {
    aktiverIAlt: overrides.aktiverIAlt ?? null,
    anlaegsaktiverIAlt: null,
    omsaetningsaktiverIAlt: null,
    egenkapital: overrides.egenkapital ?? null,
    gaeldsforpligtelserIAlt: null,
    kortfristetGaeld: null,
    langfristetGaeld: null,
    selskabskapital: null,
    overfoertResultat: null,
    likvideBeholdninger: null,
    vaerdipapirer: null,
    grundeOgBygninger: null,
    materielleAnlaeg: null,
    investeringsejendomme: null,
  };
  const noegletal: Noegletal = {
    afkastningsgrad: null,
    soliditetsgrad: null,
    egenkapitalensForrentning: null,
    overskudsgrad: null,
    bruttomargin: null,
    ebitMargin: null,
    roic: null,
    likviditetsgrad: null,
    aktivernesOmsaetningshastighed: null,
    omsaetningPrAnsat: null,
    resultatPrAnsat: null,
    finansielGearing: null,
    nettoGaeld: overrides.nettoGaeld ?? null,
    antalAnsatte: null,
  };
  return {
    aar,
    periodeStart: `${aar}-01-01`,
    periodeSlut: `${aar}-12-31`,
    resultat,
    balance,
    noegletal,
    pengestroemme: null,
    revisor: null,
    noter: null,
  };
}

describe('normaliserAlleAar', () => {
  it('returnerer tomt array for tomt input', () => {
    expect(normaliserAlleAar([])).toEqual([]);
  });

  it('normaliserer et enkelt år i fuld DKK (max > 10M)', () => {
    const years = [lagAar(2023, { omsaetning: 50_000_000, aktiverIAlt: 30_000_000 })];
    const result = normaliserAlleAar(years);
    expect(result[0].resultat.omsaetning).toBe(50_000);
    expect(result[0].balance.aktiverIAlt).toBe(30_000);
  });

  it('beholder et enkelt år der allerede er T DKK (max < 10M)', () => {
    const years = [lagAar(2023, { omsaetning: 5_000, aktiverIAlt: 3_000 })];
    const result = normaliserAlleAar(years);
    expect(result[0].resultat.omsaetning).toBe(5_000);
    expect(result[0].balance.aktiverIAlt).toBe(3_000);
  });

  it('BIZZ-1134: normaliserer blandet format korrekt (CACAO-case)', () => {
    // 2020-2022: fuld DKK (omsætning ~2M DKK = 2.000.000), under 10M-tærsklen
    // 2023: T DKK (omsætning ~2.000 T DKK)
    // Uden cross-year logik ville 2020-2022 IKKE blive normaliseret
    const years = [
      lagAar(2023, { omsaetning: 2_100, aktiverIAlt: 1_500 }),
      lagAar(2022, { omsaetning: 2_100_000, aktiverIAlt: 1_500_000 }),
      lagAar(2021, { omsaetning: 1_900_000, aktiverIAlt: 1_400_000 }),
      lagAar(2020, { omsaetning: 1_800_000, aktiverIAlt: 1_300_000 }),
    ];

    const result = normaliserAlleAar(years);

    // Alle år skal nu være i T DKK (~2.000 range)
    expect(result[0].resultat.omsaetning).toBe(2_100); // 2023 uændret
    expect(result[1].resultat.omsaetning).toBe(2_100); // 2022 divideret
    expect(result[2].resultat.omsaetning).toBe(1_900); // 2021 divideret
    expect(result[3].resultat.omsaetning).toBe(1_800); // 2020 divideret

    // Balance-felter skal også normaliseres
    expect(result[1].balance.aktiverIAlt).toBe(1_500);
    expect(result[2].balance.aktiverIAlt).toBe(1_400);
    expect(result[3].balance.aktiverIAlt).toBe(1_300);
  });

  it('beholder allerede konsistente T DKK-regnskaber uændrede', () => {
    const years = [
      lagAar(2023, { omsaetning: 5_000, aktiverIAlt: 3_000 }),
      lagAar(2022, { omsaetning: 4_500, aktiverIAlt: 2_800 }),
      lagAar(2021, { omsaetning: 4_000, aktiverIAlt: 2_500 }),
    ];

    const result = normaliserAlleAar(years);

    // Ratio = 5000/4000 = 1.25 — IKKE formatskift → uændrede
    expect(result[0].resultat.omsaetning).toBe(5_000);
    expect(result[1].resultat.omsaetning).toBe(4_500);
    expect(result[2].resultat.omsaetning).toBe(4_000);
  });

  it('normaliserer rent fuld DKK (alle år > 10M) konsistent', () => {
    const years = [
      lagAar(2023, { omsaetning: 50_000_000 }),
      lagAar(2022, { omsaetning: 45_000_000 }),
    ];

    const result = normaliserAlleAar(years);

    // Begge er i fuld DKK men ratio = 50M/45M = 1.11 — IKKE formatskift
    // Standard per-år heuristik fanger dem (> 10M)
    expect(result[0].resultat.omsaetning).toBe(50_000);
    expect(result[1].resultat.omsaetning).toBe(45_000);
  });

  it('håndterer år med alle null-værdier (ingen data)', () => {
    const years = [
      lagAar(2023, { omsaetning: 2_000 }),
      lagAar(2022, {}), // ingen monetære felter
    ];

    const result = normaliserAlleAar(years);

    expect(result[0].resultat.omsaetning).toBe(2_000);
    expect(result[1].resultat.omsaetning).toBeNull();
  });

  it('normaliserer nettoGaeld i nøgletal korrekt ved formatskift', () => {
    const years = [
      lagAar(2023, { omsaetning: 3_000, nettoGaeld: 1_000 }),
      lagAar(2022, { omsaetning: 3_000_000, nettoGaeld: 1_000_000 }),
    ];

    const result = normaliserAlleAar(years);

    expect(result[0].noegletal.nettoGaeld).toBe(1_000);
    expect(result[1].noegletal.nettoGaeld).toBe(1_000);
  });

  it('håndterer pengestrømme ved formatskift', () => {
    const pengestroemme: Pengestroemme = {
      fraDrift: 500_000,
      fraInvestering: -200_000,
      fraFinansiering: -100_000,
      aaretsForskydning: 200_000,
      likviderPrimo: 300_000,
      likviderUltimo: 500_000,
    };

    const yearFuldDkk = {
      ...lagAar(2022, { omsaetning: 3_000_000 }),
      pengestroemme,
    };
    const yearTDkk = lagAar(2023, { omsaetning: 3_000 });

    const result = normaliserAlleAar([yearTDkk, yearFuldDkk]);

    // 2022 skal divideres — pengestrømme med
    expect(result[1].pengestroemme?.fraDrift).toBe(500);
    expect(result[1].pengestroemme?.fraInvestering).toBe(-200);
    // 2023 uændret
    expect(result[0].resultat.omsaetning).toBe(3_000);
  });

  it('grænseværdi: ratio = 199 er IKKE formatskift', () => {
    // 199x forskel → under 200-grænsen → behandles som naturlig vækst
    const years = [lagAar(2023, { omsaetning: 199_000 }), lagAar(2022, { omsaetning: 1_000 })];

    const result = normaliserAlleAar(years);

    // Ingen formatskift-detektion, per-år heuristik (begge < 10M)
    expect(result[0].resultat.omsaetning).toBe(199_000);
    expect(result[1].resultat.omsaetning).toBe(1_000);
  });

  it('grænseværdi: ratio = 200 ER formatskift', () => {
    const years = [lagAar(2023, { omsaetning: 200_000 }), lagAar(2022, { omsaetning: 1_000 })];

    const result = normaliserAlleAar(years);

    // Formatskift detekteret → 2023 (stor) divideres, 2022 (lille) uændret
    expect(result[0].resultat.omsaetning).toBe(200);
    expect(result[1].resultat.omsaetning).toBe(1_000);
  });

  it('grænseværdi: ratio > 5000 er IKKE formatskift (outlier)', () => {
    // 50000x forskel → over 5000-grænsen → ikke DKK/TDKK-skift
    const years = [lagAar(2023, { omsaetning: 50_000_000 }), lagAar(2022, { omsaetning: 1_000 })];

    const result = normaliserAlleAar(years);

    // Per-år heuristik: 2023 > 10M → normaliseres alene
    expect(result[0].resultat.omsaetning).toBe(50_000);
    expect(result[1].resultat.omsaetning).toBe(1_000);
  });
});
