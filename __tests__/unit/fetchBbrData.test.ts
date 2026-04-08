/**
 * Unit tests for app/lib/fetchBbrData.ts
 *
 * Covers:
 *  - UUID_RE constant
 *  - normaliseBygning — raw→live transformation
 *  - normaliseEnhed — raw→live transformation including UUID etage filtering
 *  - fetchBbrForAddress — orchestration function with mocked fetch
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

/**
 * dfProxy helpers are server-only and would fail in jsdom.
 * Return pass-through stubs so we can test everything else.
 */
vi.mock('@/app/lib/dfProxy', () => ({
  proxyUrl: (url: string) => url,
  proxyHeaders: () => ({}),
  proxyTimeout: () => 10_000,
}));

/**
 * BBR kode-lookup functions are exercised indirectly through normaliseBygning /
 * normaliseEnhed. We keep them real so the human-readable strings are verified.
 * No mock needed here — they are pure functions with no side-effects.
 */

// ── Imports (after mocks are registered) ─────────────────────────────────────

import {
  UUID_RE,
  normaliseBygning,
  normaliseEnhed,
  fetchBbrForAddress,
  type RawBBRBygning,
} from '@/app/lib/fetchBbrData';

// ─────────────────────────────────────────────────────────────────────────────
// UUID_RE
// ─────────────────────────────────────────────────────────────────────────────

describe('UUID_RE', () => {
  it('matches a valid lower-case UUID', () => {
    expect(UUID_RE.test('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('matches a valid upper-case UUID', () => {
    expect(UUID_RE.test('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
  });

  it('matches a mixed-case UUID', () => {
    expect(UUID_RE.test('550e8400-E29B-41d4-A716-446655440000')).toBe(true);
  });

  it('does not match a string that is too short', () => {
    expect(UUID_RE.test('550e8400-e29b-41d4-a716-44665544000')).toBe(false);
  });

  it('does not match a string with wrong separator placement', () => {
    expect(UUID_RE.test('550e8400e29b-41d4-a716-446655440000')).toBe(false);
  });

  it('does not match an empty string', () => {
    expect(UUID_RE.test('')).toBe(false);
  });

  it('does not match a plain text string', () => {
    expect(UUID_RE.test('not-a-uuid')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// normaliseBygning
// ─────────────────────────────────────────────────────────────────────────────

describe('normaliseBygning', () => {
  /** Minimal valid raw bygning — only id_lokalId populated */
  const minimal: RawBBRBygning = {
    id_lokalId: 'abc123',
  };

  it('maps id_lokalId to id', () => {
    const result = normaliseBygning(minimal);
    expect(result.id).toBe('abc123');
  });

  it('returns empty string for id when id_lokalId is missing', () => {
    const result = normaliseBygning({});
    expect(result.id).toBe('');
  });

  it('maps opfoerelsesaar correctly', () => {
    const result = normaliseBygning({ ...minimal, byg026Opfoerelsesaar: 1985 });
    expect(result.opfoerelsesaar).toBe(1985);
  });

  it('returns null for opfoerelsesaar when missing', () => {
    const result = normaliseBygning(minimal);
    expect(result.opfoerelsesaar).toBeNull();
  });

  it('maps ombygningsaar correctly', () => {
    const result = normaliseBygning({ ...minimal, byg027OmTilbygningsaar: 2005 });
    expect(result.ombygningsaar).toBe(2005);
  });

  it('maps bebyggetAreal correctly', () => {
    const result = normaliseBygning({ ...minimal, byg041BebyggetAreal: 120 });
    expect(result.bebyggetAreal).toBe(120);
  });

  it('maps samletBygningsareal correctly', () => {
    const result = normaliseBygning({ ...minimal, byg038SamletBygningsareal: 200 });
    expect(result.samletBygningsareal).toBe(200);
  });

  it('maps samletBoligareal correctly', () => {
    const result = normaliseBygning({ ...minimal, byg039BygningensSamledeBoligAreal: 175 });
    expect(result.samletBoligareal).toBe(175);
  });

  it('maps samletErhvervsareal correctly', () => {
    const result = normaliseBygning({ ...minimal, byg040BygningensSamledeErhvervsAreal: 50 });
    expect(result.samletErhvervsareal).toBe(50);
  });

  it('sums antalBoligenheder from med+uden køkken', () => {
    const result = normaliseBygning({
      ...minimal,
      byg024AntalLejlighederMedKoekken: 3,
      byg025AntalLejlighederUdenKoekken: 2,
    });
    expect(result.antalBoligenheder).toBe(5);
  });

  it('returns null for antalBoligenheder when both fields are 0', () => {
    const result = normaliseBygning({
      ...minimal,
      byg024AntalLejlighederMedKoekken: 0,
      byg025AntalLejlighederUdenKoekken: 0,
    });
    // 0 + 0 = 0, the || null coercion makes this null
    expect(result.antalBoligenheder).toBeNull();
  });

  it('returns null for antalBoligenheder when both fields are absent', () => {
    const result = normaliseBygning(minimal);
    expect(result.antalBoligenheder).toBeNull();
  });

  it('maps antalEtager correctly', () => {
    const result = normaliseBygning({ ...minimal, byg054AntalEtager: 4 });
    expect(result.antalEtager).toBe(4);
  });

  it('always sets kaelder and tagetage to null', () => {
    const result = normaliseBygning(minimal);
    expect(result.kaelder).toBeNull();
    expect(result.tagetage).toBeNull();
  });

  it('always sets tagkonstruktion to "–"', () => {
    const result = normaliseBygning(minimal);
    expect(result.tagkonstruktion).toBe('–');
  });

  it('resolves tagmateriale text from code', () => {
    // byg033Tagdaekningsmateriale "2" → "Tegltagsten"
    const result = normaliseBygning({ ...minimal, byg033Tagdaekningsmateriale: '2' });
    expect(result.tagmateriale).toBe('Tegltagsten');
  });

  it('resolves ydervaeg text from code', () => {
    // byg032YdervaeggensMateriale "1" → "Mursten"
    const result = normaliseBygning({ ...minimal, byg032YdervaeggensMateriale: '1' });
    expect(result.ydervaeg).toBe('Mursten');
  });

  it('resolves varmeinstallation text from code', () => {
    // byg056Varmeinstallation "1" → "Fjernvarme / blokvarme"
    const result = normaliseBygning({ ...minimal, byg056Varmeinstallation: '1' });
    expect(result.varmeinstallation).toBe('Fjernvarme / blokvarme');
  });

  it('resolves opvarmningsform text from code', () => {
    // byg057Opvarmningsmiddel "3" → "El"
    const result = normaliseBygning({ ...minimal, byg057Opvarmningsmiddel: '3' });
    expect(result.opvarmningsform).toBe('El');
  });

  it('resolves vandforsyning text from code', () => {
    // byg030Vandforsyning "1" → "Alment vandforsyningsanlæg"
    const result = normaliseBygning({ ...minimal, byg030Vandforsyning: '1' });
    expect(result.vandforsyning).toBe('Alment vandforsyningsanlæg');
  });

  it('resolves afloeb text from code', () => {
    // byg031Afloebsforhold "1" → "Afløb til kloaksystem"
    const result = normaliseBygning({ ...minimal, byg031Afloebsforhold: '1' });
    expect(result.afloeb).toBe('Afløb til kloaksystem');
  });

  it('resolves anvendelse text from code 120', () => {
    const result = normaliseBygning({ ...minimal, byg021BygningensAnvendelse: '120' });
    expect(result.anvendelse).toBe('Fritliggende enfamilieshus');
    expect(result.anvendelseskode).toBe(120);
  });

  it('returns null for anvendelseskode when field is missing', () => {
    const result = normaliseBygning(minimal);
    expect(result.anvendelseskode).toBeNull();
  });

  it('always sets energimaerke to null', () => {
    const result = normaliseBygning(minimal);
    expect(result.energimaerke).toBeNull();
  });

  it('maps fredning correctly', () => {
    const result = normaliseBygning({ ...minimal, byg070Fredning: 'F' });
    expect(result.fredning).toBe('F');
  });

  it('returns null for fredning when absent', () => {
    const result = normaliseBygning(minimal);
    expect(result.fredning).toBeNull();
  });

  it('resolves supplerendeVarme text from code "2"', () => {
    // "2" → "Brændeovn / pejs"
    const result = normaliseBygning({ ...minimal, byg058SupplerendeVarme: '2' });
    expect(result.supplerendeVarme).toBe('Brændeovn / pejs');
  });

  it('returns null for supplerendeVarme when absent', () => {
    const result = normaliseBygning(minimal);
    expect(result.supplerendeVarme).toBeNull();
  });

  it('maps bevaringsvaerdighed correctly', () => {
    const result = normaliseBygning({ ...minimal, byg071BevaringsvaerdighedReference: 'SAVE-4' });
    expect(result.bevaringsvaerdighed).toBe('SAVE-4');
  });

  it('returns null for bevaringsvaerdighed when absent', () => {
    const result = normaliseBygning(minimal);
    expect(result.bevaringsvaerdighed).toBeNull();
  });

  it('resolves status from numeric string', () => {
    // status "6" should map via bygStatusTekst — check it returns a non-empty string
    const result = normaliseBygning({ ...minimal, status: '6' });
    expect(typeof result.status).toBe('string');
    expect((result.status ?? '').length).toBeGreaterThan(0);
  });

  it('returns null for status when absent', () => {
    const result = normaliseBygning(minimal);
    expect(result.status).toBeNull();
  });

  it('always sets bygningsnr to null (filled later from WFS)', () => {
    const result = normaliseBygning(minimal);
    expect(result.bygningsnr).toBeNull();
  });

  it('maps revisionsdato correctly', () => {
    const result = normaliseBygning({ ...minimal, byg094Revisionsdato: '2024-01-15' });
    expect(result.revisionsdato).toBe('2024-01-15');
  });

  it('returns null for revisionsdato when absent', () => {
    const result = normaliseBygning(minimal);
    expect(result.revisionsdato).toBeNull();
  });

  it('maps ejerforholdskode correctly', () => {
    const result = normaliseBygning({ ...minimal, byg066Ejerforhold: '50' });
    expect(result.ejerforholdskode).toBe('50');
  });

  it('returns null for ejerforholdskode when absent', () => {
    const result = normaliseBygning(minimal);
    expect(result.ejerforholdskode).toBeNull();
  });

  it('handles a fully populated raw record without throwing', () => {
    const full: RawBBRBygning = {
      id_lokalId: 'full-id',
      byg026Opfoerelsesaar: 1960,
      byg027OmTilbygningsaar: 2000,
      byg038SamletBygningsareal: 300,
      byg039BygningensSamledeBoligAreal: 250,
      byg040BygningensSamledeErhvervsAreal: 50,
      byg041BebyggetAreal: 180,
      byg024AntalLejlighederMedKoekken: 6,
      byg025AntalLejlighederUdenKoekken: 1,
      byg054AntalEtager: 3,
      byg033Tagdaekningsmateriale: '1',
      byg032YdervaeggensMateriale: '1',
      byg056Varmeinstallation: '1',
      byg057Opvarmningsmiddel: '2',
      byg058SupplerendeVarme: '1',
      byg030Vandforsyning: '1',
      byg031Afloebsforhold: '1',
      byg021BygningensAnvendelse: '140',
      byg066Ejerforhold: '10',
      byg070Fredning: 'F',
      byg071BevaringsvaerdighedReference: 'SAVE-3',
      byg094Revisionsdato: '2025-06-01',
      status: '6',
      husnummer: 'husnr-uuid',
    };
    expect(() => normaliseBygning(full)).not.toThrow();
    const result = normaliseBygning(full);
    expect(result.id).toBe('full-id');
    expect(result.antalBoligenheder).toBe(7);
    expect(result.antalEtager).toBe(3);
    expect(result.ejerforholdskode).toBe('10');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// normaliseEnhed
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal raw enhed record type (not exported — defined inline for tests) */
interface RawEnhedMinimal {
  id_lokalId?: string;
  adresseIdentificerer?: string;
  enh020EnhedensAnvendelse?: string;
  enh023Boligtype?: string;
  enh026EnhedensSamledeAreal?: number;
  enh027ArealTilBeboelse?: number;
  enh028ArealTilErhverv?: number;
  enh031AntalVaerelser?: number;
  enh035Energiforsyning?: string;
  enh051Varmeinstallation?: string;
  enh052Opvarmningsmiddel?: string;
  bygning?: string;
  etage?: string;
  status?: string;
}

describe('normaliseEnhed', () => {
  const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

  it('maps id_lokalId to id', () => {
    const result = normaliseEnhed({ id_lokalId: 'enhed-1' });
    expect(result.id).toBe('enhed-1');
  });

  it('returns empty string for id when id_lokalId is missing', () => {
    const result = normaliseEnhed({});
    expect(result.id).toBe('');
  });

  it('sets bygningId to UUID when bygning field is a valid UUID', () => {
    const result = normaliseEnhed({ bygning: VALID_UUID });
    expect(result.bygningId).toBe(VALID_UUID);
  });

  it('returns null for bygningId when bygning is a non-UUID string', () => {
    // Non-UUID values are filtered out (they are reference strings, not UUIDs in bygning field)
    // The logic: (raw.bygning && !UUID_RE.test(raw.bygning) ? null : raw.bygning) ?? null
    // When bygning is NOT a UUID → returns null
    const result = normaliseEnhed({ bygning: 'not-a-uuid' });
    expect(result.bygningId).toBeNull();
  });

  it('returns null for bygningId when absent', () => {
    const result = normaliseEnhed({});
    expect(result.bygningId).toBeNull();
  });

  it('returns null for etage when etage is a UUID (reference field, not floor number)', () => {
    const result = normaliseEnhed({ etage: VALID_UUID });
    expect(result.etage).toBeNull();
  });

  it('returns etage value when it is a non-UUID string', () => {
    const result = normaliseEnhed({ etage: '2' });
    expect(result.etage).toBe('2');
  });

  it('returns null for etage when absent', () => {
    const result = normaliseEnhed({});
    expect(result.etage).toBeNull();
  });

  it('always sets doer to null (filled from DAWA later)', () => {
    const result = normaliseEnhed({});
    expect(result.doer).toBeNull();
  });

  it('always sets adressebetegnelse to null (filled from DAWA later)', () => {
    const result = normaliseEnhed({});
    expect(result.adressebetegnelse).toBeNull();
  });

  it('maps areal correctly', () => {
    const result = normaliseEnhed({ enh026EnhedensSamledeAreal: 85 });
    expect(result.areal).toBe(85);
  });

  it('returns null for areal when absent', () => {
    const result = normaliseEnhed({});
    expect(result.areal).toBeNull();
  });

  it('maps arealBolig correctly', () => {
    const result = normaliseEnhed({ enh027ArealTilBeboelse: 70 });
    expect(result.arealBolig).toBe(70);
  });

  it('maps arealErhverv correctly', () => {
    const result = normaliseEnhed({ enh028ArealTilErhverv: 15 });
    expect(result.arealErhverv).toBe(15);
  });

  it('maps vaerelser correctly', () => {
    const result = normaliseEnhed({ enh031AntalVaerelser: 3 });
    expect(result.vaerelser).toBe(3);
  });

  it('returns null for vaerelser when absent', () => {
    const result = normaliseEnhed({});
    expect(result.vaerelser).toBeNull();
  });

  it('resolves anvendelse text from code', () => {
    // enh020EnhedensAnvendelse "1" → should produce a string from enhedAnvendelseTekst
    const result = normaliseEnhed({ enh020EnhedensAnvendelse: '1' });
    expect(typeof result.anvendelse).toBe('string');
    expect(result.anvendelse.length).toBeGreaterThan(0);
  });

  it('resolves boligtype text from code', () => {
    const result = normaliseEnhed({ enh023Boligtype: '1' });
    expect(typeof result.boligtype).toBe('string');
    expect(result.boligtype!.length).toBeGreaterThan(0);
  });

  it('returns null for boligtype when absent', () => {
    const result = normaliseEnhed({});
    expect(result.boligtype).toBeNull();
  });

  it('resolves energiforsyning text from code', () => {
    const result = normaliseEnhed({ enh035Energiforsyning: '1' });
    expect(typeof result.energiforsyning).toBe('string');
    expect(result.energiforsyning!.length).toBeGreaterThan(0);
  });

  it('returns null for energiforsyning when absent', () => {
    const result = normaliseEnhed({});
    expect(result.energiforsyning).toBeNull();
  });

  it('maps status correctly', () => {
    const result = normaliseEnhed({ status: 'aktiv' });
    expect(result.status).toBe('aktiv');
  });

  it('returns null for status when absent', () => {
    const result = normaliseEnhed({});
    expect(result.status).toBeNull();
  });

  it('always sets energimaerke to null', () => {
    const result = normaliseEnhed({});
    expect(result.energimaerke).toBeNull();
  });

  it('resolves varmeinstallation text from code', () => {
    // enh051Varmeinstallation "4" → "Varmepumpe"
    const result = normaliseEnhed({ enh051Varmeinstallation: '4' });
    expect(result.varmeinstallation).toBe('Varmepumpe');
  });

  it('handles empty enhed without throwing', () => {
    expect(() => normaliseEnhed({})).not.toThrow();
  });

  it('handles a fully populated enhed record', () => {
    const full: RawEnhedMinimal = {
      id_lokalId: 'enhed-full',
      adresseIdentificerer: VALID_UUID,
      enh020EnhedensAnvendelse: '1',
      enh023Boligtype: '1',
      enh026EnhedensSamledeAreal: 90,
      enh027ArealTilBeboelse: 80,
      enh028ArealTilErhverv: 10,
      enh031AntalVaerelser: 4,
      enh035Energiforsyning: '1',
      enh051Varmeinstallation: '1',
      bygning: VALID_UUID,
      etage: 'st',
      status: '6',
    };
    const result = normaliseEnhed(full);
    expect(result.id).toBe('enhed-full');
    expect(result.areal).toBe(90);
    expect(result.bygningId).toBe(VALID_UUID);
    expect(result.etage).toBe('st');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fetchBbrForAddress — mocked fetch, response-parsing logic
// ─────────────────────────────────────────────────────────────────────────────

describe('fetchBbrForAddress', () => {
  const DAWA_ID = 'b84b7e12-b8a1-4601-87d5-000000000001';

  /** Helper: creates a Response-like object for vi.stubGlobal('fetch') */
  function makeResponse(data: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
      headers: { entries: () => [] as unknown as IterableIterator<[string, string]> },
    } as unknown as Response;
  }

  beforeEach(() => {
    // Reset env so the API key is absent by default — simplest, exercised below
    delete process.env.DATAFORDELER_API_KEY;
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DATAFORDELER_API_KEY;
  });

  it('returns bbrFejl when DATAFORDELER_API_KEY is not set', async () => {
    // DAWA adgangsadresse fetch succeeds, jordstykke fetch succeeds, GQL returns empty
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          // adgangsadresse
          jordstykke: { ejerlav: { kode: 123 }, matrikelnr: '1a' },
          adressebetegnelse: 'Testvej 1, 2400 København NV',
          kommune: { kode: '0101' },
        })
      )
      .mockResolvedValueOnce(makeResponse({ bfenummer: 9999 })) // jordstykker
      .mockResolvedValueOnce(
        makeResponse({
          // vurderingsportalen ES
          hits: { hits: [] },
        })
      )
      .mockResolvedValueOnce(
        makeResponse({
          // BBR GraphQL bygninger
          data: { BBR_Bygning: { nodes: [] } },
        })
      )
      .mockResolvedValueOnce(
        makeResponse({
          // BBR GraphQL enheder
          data: { BBR_Enhed: { nodes: [] } },
        })
      );

    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchBbrForAddress(DAWA_ID);

    expect(result.bbrFejl).toBeTruthy();
    expect(result.bbrFejl).toContain('API');
  });

  it('returns null bbrFejl when API key is set and data is returned', async () => {
    process.env.DATAFORDELER_API_KEY = 'test-key-123';

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          // adgangsadresse
          jordstykke: { ejerlav: { kode: 456 }, matrikelnr: '2b' },
          adressebetegnelse: 'Nørrebrogade 10, 2200 København N',
          kommune: { kode: '0101' },
        })
      )
      .mockResolvedValueOnce(makeResponse({ bfenummer: 12345 })) // jordstykker
      .mockResolvedValueOnce(
        makeResponse({
          // vurderingsportalen
          hits: { hits: [] },
        })
      )
      .mockResolvedValueOnce(
        makeResponse({
          // BBR GraphQL bygninger
          data: {
            BBR_Bygning: {
              nodes: [
                {
                  id_lokalId: 'byg-1',
                  byg026Opfoerelsesaar: 1950,
                  byg021BygningensAnvendelse: '140',
                  status: '6',
                },
              ],
            },
          },
        })
      )
      .mockResolvedValueOnce(
        makeResponse({
          // BBR GraphQL enheder
          data: {
            BBR_Enhed: {
              nodes: [
                {
                  id_lokalId: 'enh-1',
                  enh026EnhedensSamledeAreal: 80,
                },
              ],
            },
          },
        })
      )
      // WFS bygningspunkter (since api key is set and bygningIds might not be empty)
      .mockResolvedValueOnce(makeResponse({ features: [] }));

    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchBbrForAddress(DAWA_ID);

    expect(result.bbrFejl).toBeNull();
  });

  it('sets ejendomsrelationer with bfeNummer when jordstykke lookup succeeds', async () => {
    process.env.DATAFORDELER_API_KEY = 'test-key-456';

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          // adgangsadresse
          jordstykke: { ejerlav: { kode: 789 }, matrikelnr: '3c' },
          adressebetegnelse: 'Østerbrogade 5, 2100 København Ø',
          kommune: { kode: '0101' },
        })
      )
      .mockResolvedValueOnce(makeResponse({ bfenummer: 77777 })) // jordstykker
      .mockResolvedValueOnce(makeResponse({ hits: { hits: [] } })) // vurderingsportalen
      .mockResolvedValueOnce(makeResponse({ data: { BBR_Bygning: { nodes: [] } } })) // bygninger GQL
      .mockResolvedValueOnce(makeResponse({ data: { BBR_Enhed: { nodes: [] } } })) // enheder GQL
      .mockResolvedValueOnce(makeResponse({ features: [] })); // WFS

    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchBbrForAddress(DAWA_ID);

    expect(result.ejendomsrelationer).not.toBeNull();
    expect(result.ejendomsrelationer![0].bfeNummer).toBe(77777);
  });

  it('returns null ejendomsrelationer when adgangsadresse fetch fails', async () => {
    process.env.DATAFORDELER_API_KEY = 'test-key-789';

    const mockFetch = vi
      .fn()
      // Step 1a: adgangsadresse fails
      .mockResolvedValueOnce(makeResponse({}, 404))
      // Step 1b: adresser fetch also fails
      .mockResolvedValueOnce(makeResponse({}, 404))
      // BBR GQL bygninger
      .mockResolvedValueOnce(makeResponse({ data: { BBR_Bygning: { nodes: [] } } }))
      // BBR GQL enheder
      .mockResolvedValueOnce(makeResponse({ data: { BBR_Enhed: { nodes: [] } } }));

    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchBbrForAddress(DAWA_ID);

    expect(result.ejendomsrelationer).toBeNull();
    expect(result.ejerlejlighedBfe).toBeNull();
    expect(result.moderBfe).toBeNull();
  });

  it('deduplicates BBR bygninger with the same id_lokalId', async () => {
    process.env.DATAFORDELER_API_KEY = 'test-key-dedup';

    const sharedBygId = 'byg-dedup-uuid-0000-000000000001';

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          // adgangsadresse
          jordstykke: { ejerlav: { kode: 111 }, matrikelnr: '1d' },
          adressebetegnelse: 'Test 1, 1000 Kbh',
          kommune: { kode: '0101' },
        })
      )
      .mockResolvedValueOnce(makeResponse({ bfenummer: 11111 })) // jordstykker
      .mockResolvedValueOnce(makeResponse({ hits: { hits: [] } })) // vurderingsportalen
      .mockResolvedValueOnce(
        makeResponse({
          // BBR GraphQL bygninger — two identical id_lokalId
          data: {
            BBR_Bygning: {
              nodes: [
                { id_lokalId: sharedBygId, byg026Opfoerelsesaar: 1970 },
                { id_lokalId: sharedBygId, byg026Opfoerelsesaar: 1975 }, // duplicate
              ],
            },
          },
        })
      )
      .mockResolvedValueOnce(makeResponse({ data: { BBR_Enhed: { nodes: [] } } })) // enheder GQL
      .mockResolvedValueOnce(makeResponse({ features: [] })); // WFS

    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchBbrForAddress(DAWA_ID);

    // Should deduplicate to 1 bygning
    expect(result.bbr).not.toBeNull();
    expect(result.bbr!.length).toBe(1);
    expect(result.bbr![0].opfoerelsesaar).toBe(1970); // first occurrence kept
  });

  it('returns bygningPunkter as null when no API key is set', async () => {
    // No DATAFORDELER_API_KEY set — fetchBygningPunkter returns null immediately
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          // adgangsadresse
          jordstykke: { ejerlav: { kode: 222 }, matrikelnr: '2e' },
          adressebetegnelse: 'Søgade 2, 8000 Aarhus',
          kommune: { kode: '0751' },
        })
      )
      .mockResolvedValueOnce(makeResponse({ bfenummer: 22222 })) // jordstykker
      .mockResolvedValueOnce(makeResponse({ hits: { hits: [] } })) // vurderingsportalen
      .mockResolvedValueOnce(makeResponse({ data: { BBR_Bygning: { nodes: [] } } })) // bygninger GQL
      .mockResolvedValueOnce(makeResponse({ data: { BBR_Enhed: { nodes: [] } } })); // enheder GQL

    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchBbrForAddress(DAWA_ID);

    expect(result.bygningPunkter).toBeNull();
  });

  it('normalises returned bygninger into LiveBBRBygning shape', async () => {
    process.env.DATAFORDELER_API_KEY = 'normalise-test';

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          // adgangsadresse
          jordstykke: { ejerlav: { kode: 333 }, matrikelnr: '3f' },
          adressebetegnelse: 'Havnegade 3, 5000 Odense',
          kommune: { kode: '0461' },
        })
      )
      .mockResolvedValueOnce(makeResponse({ bfenummer: 33333 })) // jordstykker
      .mockResolvedValueOnce(makeResponse({ hits: { hits: [] } })) // vurderingsportalen
      .mockResolvedValueOnce(
        makeResponse({
          // BBR GraphQL bygninger
          data: {
            BBR_Bygning: {
              nodes: [
                {
                  id_lokalId: 'byg-shape',
                  byg026Opfoerelsesaar: 2000,
                  byg038SamletBygningsareal: 150,
                  byg021BygningensAnvendelse: '120',
                  byg066Ejerforhold: '10',
                  status: '6',
                },
              ],
            },
          },
        })
      )
      .mockResolvedValueOnce(makeResponse({ data: { BBR_Enhed: { nodes: [] } } })) // enheder GQL
      .mockResolvedValueOnce(makeResponse({ features: [] })); // WFS

    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchBbrForAddress(DAWA_ID);

    expect(result.bbr).not.toBeNull();
    const byg = result.bbr![0];
    expect(byg.id).toBe('byg-shape');
    expect(byg.opfoerelsesaar).toBe(2000);
    expect(byg.samletBygningsareal).toBe(150);
    expect(byg.anvendelse).toBe('Fritliggende enfamilieshus');
    expect(byg.ejerforholdskode).toBe('10');
  });

  it('handles fetch throwing an error gracefully', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    vi.stubGlobal('fetch', mockFetch);

    // Should not throw — catches internally and returns fallback
    const result = await fetchBbrForAddress(DAWA_ID);

    expect(result).toBeDefined();
    expect(result.bbr).toBeNull();
    expect(result.ejendomsrelationer).toBeNull();
  });
});
