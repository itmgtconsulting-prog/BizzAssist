/**
 * Unit tests for ejendomsstruktur/ejerlejligheder fallback-logik.
 *
 * Verificerer at Constantin Hansens Gade 35 (BFE 427376) viser
 * ejendomsstruktur korrekt via DAWA jordstykke-fallback når BBR
 * returnerer 404 og matrikel API er tom.
 *
 * Testcases:
 * - DAWA jordstykke bruges som tertiær kilde for ejerlavKode+matrikelnr
 * - Ejerlejligheder returneres korrekt for matrikel 1218g
 * - BFE-placeholder adresser springes over i cache-lookup
 */

import { describe, it, expect } from 'vitest';

// ─── Test data: Constantin Hansens Gade 35, matrikel 1218g ─────────────────

/** Simulerer BBR, matrikel og DAWA data-kilder for ejerlejligheder-fetch */
interface DataSources {
  bbrEjerlejlighedBfe: number | null;
  bbrEjerlavKode: string | null;
  bbrMatrikelnr: string | null;
  matrikelEjerlavskode: string | null;
  matrikelMatrikelnummer: string | null;
  matrikelOpdelt: boolean;
  dawaEjerlavKode: number | null;
  dawaMatrikelnr: string | null;
  dawaEtage: string | null;
}

/**
 * Spejler logikken i EjendomDetaljeClient.tsx useEffect for lejligheder-fetch.
 * Returnerer { shouldFetch, ejerlavKode, matrikelnr } baseret på datakilderne.
 */
function shouldFetchLejligheder(sources: DataSources): {
  shouldFetch: boolean;
  ejerlavKode: string | null;
  matrikelnr: string | null;
} {
  const erModer = !sources.dawaEtage && !!sources.bbrEjerlejlighedBfe;
  const erChild = !!sources.dawaEtage && !!sources.bbrEjerlejlighedBfe;
  const matOpdelt = sources.matrikelOpdelt;

  const hasEjerlavMatr =
    (!!sources.bbrEjerlavKode && !!sources.bbrMatrikelnr) ||
    (!!sources.matrikelEjerlavskode && !!sources.matrikelMatrikelnummer) ||
    (!!sources.dawaEjerlavKode && !!sources.dawaMatrikelnr);

  const erParentSfe = !sources.dawaEtage && hasEjerlavMatr && !sources.bbrEjerlejlighedBfe;
  const erChildUdenBfe = !!sources.dawaEtage && hasEjerlavMatr && !sources.bbrEjerlejlighedBfe;

  if (!erModer && !erChild && !matOpdelt && !erParentSfe && !erChildUdenBfe) {
    return { shouldFetch: false, ejerlavKode: null, matrikelnr: null };
  }

  const ejerlavKode =
    sources.bbrEjerlavKode ??
    sources.matrikelEjerlavskode ??
    (sources.dawaEjerlavKode ? String(sources.dawaEjerlavKode) : null);
  const matrikelnr =
    sources.bbrMatrikelnr ?? sources.matrikelMatrikelnummer ?? sources.dawaMatrikelnr;

  if (!ejerlavKode || !matrikelnr) {
    return { shouldFetch: false, ejerlavKode: null, matrikelnr: null };
  }

  return { shouldFetch: true, ejerlavKode, matrikelnr };
}

/**
 * Spejler BFE-placeholder filter i bfe_adresse_cache lookups.
 * Returnerer true hvis adressen er en reel adresse (ikke placeholder).
 */
function isRealAddress(adresse: string | null): boolean {
  if (!adresse) return false;
  return !/^BFE \d+$/.test(adresse);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('ejendom jordstykke-fallback: Constantin Hansens Gade 35', () => {
  it('henter lejligheder via DAWA jordstykke når BBR og matrikel er tomme', () => {
    // Constantin Hansens Gade 35 (BFE 427376):
    // BBR returnerer 404, matrikel API returnerer tom
    // Men DAWA jordstykke har ejerlav 2000174 + matrikel 1218g
    const result = shouldFetchLejligheder({
      bbrEjerlejlighedBfe: null,
      bbrEjerlavKode: null,
      bbrMatrikelnr: null,
      matrikelEjerlavskode: null,
      matrikelMatrikelnummer: null,
      matrikelOpdelt: false,
      dawaEjerlavKode: 2000174,
      dawaMatrikelnr: '1218g',
      dawaEtage: null, // hovedejendom (ingen etage)
    });

    expect(result.shouldFetch).toBe(true);
    expect(result.ejerlavKode).toBe('2000174');
    expect(result.matrikelnr).toBe('1218g');
  });

  it('returnerer shouldFetch=false når ALLE kilder er tomme', () => {
    const result = shouldFetchLejligheder({
      bbrEjerlejlighedBfe: null,
      bbrEjerlavKode: null,
      bbrMatrikelnr: null,
      matrikelEjerlavskode: null,
      matrikelMatrikelnummer: null,
      matrikelOpdelt: false,
      dawaEjerlavKode: null,
      dawaMatrikelnr: null,
      dawaEtage: null,
    });

    expect(result.shouldFetch).toBe(false);
  });

  it('foretrækker BBR over DAWA jordstykke', () => {
    const result = shouldFetchLejligheder({
      bbrEjerlejlighedBfe: 427376,
      bbrEjerlavKode: '2000174',
      bbrMatrikelnr: '1218g',
      matrikelEjerlavskode: null,
      matrikelMatrikelnummer: null,
      matrikelOpdelt: false,
      dawaEjerlavKode: 9999999, // Skulle ignoreres
      dawaMatrikelnr: 'WRONG',
      dawaEtage: null,
    });

    expect(result.shouldFetch).toBe(true);
    expect(result.ejerlavKode).toBe('2000174');
    expect(result.matrikelnr).toBe('1218g');
  });

  it('bruger DAWA fallback for child-ejerlejlighed uden BFE', () => {
    // Lejlighed med etage men uden ejerlejlighedBfe (VP kan ikke resolve)
    const result = shouldFetchLejligheder({
      bbrEjerlejlighedBfe: null,
      bbrEjerlavKode: null,
      bbrMatrikelnr: null,
      matrikelEjerlavskode: null,
      matrikelMatrikelnummer: null,
      matrikelOpdelt: false,
      dawaEjerlavKode: 2000174,
      dawaMatrikelnr: '1218g',
      dawaEtage: '2', // ejerlejlighed med etage
    });

    expect(result.shouldFetch).toBe(true);
  });
});

describe('BFE-placeholder filter', () => {
  it('afviser "BFE 12345" som placeholder', () => {
    expect(isRealAddress('BFE 12345')).toBe(false);
    expect(isRealAddress('BFE 427376')).toBe(false);
    expect(isRealAddress('BFE 100074364')).toBe(false);
  });

  it('accepterer rigtige adresser', () => {
    expect(isRealAddress('Constantin Hansens Gade 35')).toBe(true);
    expect(isRealAddress('Vigerslevvej 146')).toBe(true);
    expect(isRealAddress('Rahbeks Allé 13')).toBe(true);
  });

  it('afviser null/tom', () => {
    expect(isRealAddress(null)).toBe(false);
    expect(isRealAddress('')).toBe(false);
  });

  it('accepterer adresser der indeholder BFE men ikke er placeholders', () => {
    // "BFE 427376, Rahbeks Allé 13" er ikke et placeholder-mønster
    expect(isRealAddress('BFE 427376, Rahbeks Allé 13')).toBe(true);
  });
});
