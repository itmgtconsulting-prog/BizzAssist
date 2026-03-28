/**
 * Unit tests for BBR API route helper functions.
 *
 * Dækker:
 * - normaliseBygning: korrekt mapping af rå BBR-data til klientformat
 * - normaliseEnhed: UUID-filtrering af etage-felt, areal og anvendelse
 * - UUID_RE: korrekt detektion af UUID-strenge
 * - BBR kodeopslagsfunktioner: tagmateriale, ydervæg, varme, anvendelse m.fl.
 * - WFS bygningIds-deduplicering: sammenlægning af enheds- og bygnings-UUID'er
 */

import { describe, it, expect } from 'vitest';
import type { RawBBRBygning } from '@/app/api/ejendom/[id]/route';
import { normaliseBygning, normaliseEnhed, UUID_RE } from '@/app/api/ejendom/[id]/route';
import {
  tagMaterialeTekst,
  ydervaegMaterialeTekst,
  varmeInstallationTekst,
  opvarmningsmiddelTekst,
  vandforsyningTekst,
  afloebsforholdTekst,
  bygAnvendelseTekst,
  enhedAnvendelseTekst,
} from '@/app/lib/bbrKoder';

// ─── UUID_RE ────────────────────────────────────────────────────────────────

describe('UUID_RE', () => {
  it('matcher gyldige UUIDs', () => {
    expect(UUID_RE.test('fbc6fab9-d041-4eb0-96ee-d88e4f5d25af')).toBe(true);
    expect(UUID_RE.test('64fe1896-699c-4558-92e3-20155693f9e6')).toBe(true);
    expect(UUID_RE.test('00000000-0000-0000-0000-000000000000')).toBe(true);
  });

  it('matcher ikke ikke-UUID strenge', () => {
    expect(UUID_RE.test('st')).toBe(false);
    expect(UUID_RE.test('1')).toBe(false);
    expect(UUID_RE.test('kld')).toBe(false);
    expect(UUID_RE.test('')).toBe(false);
    expect(UUID_RE.test('1. sal')).toBe(false);
  });
});

// ─── normaliseBygning ────────────────────────────────────────────────────────

describe('normaliseBygning', () => {
  const rawFull: RawBBRBygning = {
    id_lokalId: 'abc-123',
    byg026Opfoerelsesaar: 1985,
    byg027OmTilbygningsaar: 2010,
    byg038SamletBygningsareal: 500,
    byg039BygningensSamledeBoligAreal: 400,
    byg040BygningensSamledeErhvervsAreal: 100,
    byg041BebyggetAreal: 250,
    byg024AntalLejlighederMedKoekken: 3,
    byg025AntalLejlighederUdenKoekken: 1,
    byg054AntalEtager: 2,
    byg033Tagdaekningsmateriale: '1', // Betontagsten
    byg032YdervaeggensMateriale: '1', // Mursten
    byg056Varmeinstallation: '1', // Fjernvarme
    byg057Opvarmningsmiddel: '6', // Fjernvarme/blokvarme
    byg030Vandforsyning: '1', // Alment vandforsyningsanlæg
    byg031Afloebsforhold: '1', // Afløb til kloaknet
    byg021BygningensAnvendelse: '120', // Fritliggende enfamilieshus
    byg070Fredning: 'F',
    status: '3',
  };

  it('mapper alle felter korrekt', () => {
    const result = normaliseBygning(rawFull);
    expect(result.id).toBe('abc-123');
    expect(result.opfoerelsesaar).toBe(1985);
    expect(result.ombygningsaar).toBe(2010);
    expect(result.samletBygningsareal).toBe(500);
    expect(result.samletBoligareal).toBe(400);
    expect(result.samletErhvervsareal).toBe(100);
    expect(result.bebyggetAreal).toBe(250);
    expect(result.antalBoligenheder).toBe(4); // 3 + 1
    expect(result.antalEtager).toBe(2);
    expect(result.status).toBe('Bygning opført');
    expect(result.fredning).toBe('F');
  });

  it('returnerer null for manglende numeriske felter', () => {
    const raw: RawBBRBygning = { id_lokalId: 'x' };
    const result = normaliseBygning(raw);
    expect(result.opfoerelsesaar).toBeNull();
    expect(result.samletBygningsareal).toBeNull();
    expect(result.antalBoligenheder).toBeNull();
    expect(result.antalEtager).toBeNull();
  });

  it('returnerer "–" for ukendte koder', () => {
    const raw: RawBBRBygning = { id_lokalId: 'x' };
    const result = normaliseBygning(raw);
    expect(result.tagmateriale).toBe('–');
    expect(result.ydervaeg).toBe('–');
    expect(result.varmeinstallation).toBe('–');
  });

  it('summerer boligenheder korrekt (med og uden køkken)', () => {
    const raw: RawBBRBygning = {
      id_lokalId: 'x',
      byg024AntalLejlighederMedKoekken: 5,
      byg025AntalLejlighederUdenKoekken: 0,
    };
    expect(normaliseBygning(raw).antalBoligenheder).toBe(5);
  });

  it('returnerer null for antalBoligenheder når begge er 0', () => {
    const raw: RawBBRBygning = {
      id_lokalId: 'x',
      byg024AntalLejlighederMedKoekken: 0,
      byg025AntalLejlighederUdenKoekken: 0,
    };
    expect(normaliseBygning(raw).antalBoligenheder).toBeNull();
  });
});

// ─── normaliseEnhed ──────────────────────────────────────────────────────────

describe('normaliseEnhed', () => {
  it('filtrerer UUID-etage fra og returnerer null', () => {
    const raw = {
      id_lokalId: 'enhed-1',
      etage: 'fbc6fab9-d041-4eb0-96ee-d88e4f5d25af', // UUID — skal nulles
      enh026EnhedensSamledeAreal: 75,
    };
    const result = normaliseEnhed(raw as Parameters<typeof normaliseEnhed>[0]);
    expect(result.etage).toBeNull();
  });

  it('beholder læsbar etage-tekst', () => {
    const raw = {
      id_lokalId: 'enhed-2',
      etage: 'st', // Stueplan — ikke UUID
      enh026EnhedensSamledeAreal: 60,
    };
    const result = normaliseEnhed(raw as Parameters<typeof normaliseEnhed>[0]);
    expect(result.etage).toBe('st');
  });

  it('mapper areal og vaerelser korrekt', () => {
    const raw = {
      id_lokalId: 'enhed-3',
      enh026EnhedensSamledeAreal: 120,
      enh027ArealTilBeboelse: 100,
      enh028ArealTilErhverv: 20,
      enh031AntalVaerelser: 4,
    };
    const result = normaliseEnhed(raw as Parameters<typeof normaliseEnhed>[0]);
    expect(result.areal).toBe(120);
    expect(result.arealBolig).toBe(100);
    expect(result.arealErhverv).toBe(20);
    expect(result.vaerelser).toBe(4);
  });

  it('returnerer null for manglende felter', () => {
    const raw = { id_lokalId: 'enhed-4' };
    const result = normaliseEnhed(raw as Parameters<typeof normaliseEnhed>[0]);
    expect(result.etage).toBeNull();
    expect(result.areal).toBeNull();
    expect(result.vaerelser).toBeNull();
  });
});

// ─── BBR kodeopslagsfunktioner ───────────────────────────────────────────────

describe('tagMaterialeTekst', () => {
  it('oversætter kendte koder', () => {
    expect(tagMaterialeTekst(1)).toBe('Betontagsten');
    expect(tagMaterialeTekst(2)).toBe('Tegltagsten');
  });
  it('returnerer "–" for null/undefined', () => {
    expect(tagMaterialeTekst(null)).toBe('–');
    expect(tagMaterialeTekst(undefined)).toBe('–');
  });
  it('returnerer "Ukendt (X)" for ukendte koder', () => {
    expect(tagMaterialeTekst(9999)).toMatch(/Ukendt/);
  });
});

describe('ydervaegMaterialeTekst', () => {
  it('oversætter kendte koder', () => {
    expect(ydervaegMaterialeTekst(1)).toBeTruthy();
    expect(typeof ydervaegMaterialeTekst(1)).toBe('string');
  });
  it('returnerer "–" for null', () => {
    expect(ydervaegMaterialeTekst(null)).toBe('–');
  });
});

describe('bygAnvendelseTekst', () => {
  it('oversætter erhvervskoder', () => {
    const tekst = bygAnvendelseTekst(320); // Kontor
    expect(tekst).toBeTruthy();
    expect(tekst).not.toBe('–');
  });
  it('returnerer "–" for manglende kode', () => {
    expect(bygAnvendelseTekst(undefined)).toBe('–');
  });
});

describe('enhedAnvendelseTekst', () => {
  it('oversætter kendte koder', () => {
    expect(enhedAnvendelseTekst(1)).toBeTruthy();
  });
  it('returnerer "–" for null', () => {
    expect(enhedAnvendelseTekst(null)).toBe('–');
  });
});

describe('varmeInstallationTekst + opvarmningsform', () => {
  it('oversætter kode 1', () => {
    expect(varmeInstallationTekst(1)).toBeTruthy();
    expect(opvarmningsmiddelTekst(1)).toBeTruthy();
  });
});

describe('vandforsyningTekst + afloebsforholdTekst', () => {
  it('oversætter kode 1', () => {
    expect(vandforsyningTekst(1)).toBeTruthy();
    expect(afloebsforholdTekst(1)).toBeTruthy();
  });
  it('returnerer "–" for null', () => {
    expect(vandforsyningTekst(null)).toBe('–');
    expect(afloebsforholdTekst(null)).toBe('–');
  });
});

// ─── WFS bygningIds deduplicering ────────────────────────────────────────────

describe('WFS bygningIds deduplicering', () => {
  /** Simulerer logikken fra route-handleren */
  function buildBygningIds(
    rawEnheder: Array<{ bygning?: string }>,
    rawBygninger: Array<{ id_lokalId?: string }>
  ): string[] {
    const fraEnheder = rawEnheder
      .map((e) => e.bygning)
      .filter((b): b is string => typeof b === 'string' && b.length > 0);
    const fraBygninger = rawBygninger
      .map((b) => b.id_lokalId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return [...new Set([...fraEnheder, ...fraBygninger])];
  }

  it('bruger enheds-bygning-UUID som primær kilde', () => {
    const ids = buildBygningIds([{ bygning: 'uuid-a' }, { bygning: 'uuid-a' }], []);
    expect(ids).toEqual(['uuid-a']); // deduplikeret
  });

  it('falder tilbage på bygnings-id_lokalId når enheder er tomme', () => {
    const ids = buildBygningIds([], [{ id_lokalId: 'uuid-b' }]);
    expect(ids).toEqual(['uuid-b']);
  });

  it('kombinerer og deduplikerer fra begge kilder', () => {
    const ids = buildBygningIds(
      [{ bygning: 'uuid-a' }, { bygning: 'uuid-b' }],
      [{ id_lokalId: 'uuid-b' }, { id_lokalId: 'uuid-c' }]
    );
    expect(ids).toHaveLength(3);
    expect(ids).toContain('uuid-a');
    expect(ids).toContain('uuid-b');
    expect(ids).toContain('uuid-c');
  });

  it('returnerer tomt array når ingen data', () => {
    expect(buildBygningIds([], [])).toEqual([]);
  });

  it('filtrerer tomme strenge fra', () => {
    const ids = buildBygningIds([{ bygning: '' }], [{ id_lokalId: '' }]);
    expect(ids).toEqual([]);
  });
});
