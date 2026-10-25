/**
 * Unit tests for erhvervslejemål-normalisering & sanitisering (BIZZ-2306).
 *
 * Fokus: `buildObservation` er privatlivs-grænsen fra ADR 0013 — den SKAL
 * udlede aggregat-felter korrekt OG garantere at rå adresse/kilde/PII aldrig
 * forlader funktionen.
 */

import { describe, it, expect } from 'vitest';
import {
  arealBucket,
  normalizeErhvervstype,
  dedupHash,
  buildObservation,
  type RawListing,
} from '@/app/lib/lejemaal/normalize';

describe('arealBucket', () => {
  it('placerer areal i korrekt bucket', () => {
    expect(arealBucket(50)).toBe('0-99');
    expect(arealBucket(99)).toBe('0-99');
    expect(arealBucket(100)).toBe('100-249');
    expect(arealBucket(249)).toBe('100-249');
    expect(arealBucket(250)).toBe('250-499');
    expect(arealBucket(500)).toBe('500-999');
    expect(arealBucket(1000)).toBe('1000+');
    expect(arealBucket(25000)).toBe('1000+');
  });

  it('returnerer "ukendt" ved ugyldigt areal', () => {
    expect(arealBucket(0)).toBe('ukendt');
    expect(arealBucket(-10)).toBe('ukendt');
    expect(arealBucket(NaN)).toBe('ukendt');
    expect(arealBucket(Infinity)).toBe('ukendt'); // ikke-finit → ugyldigt
  });
});

describe('normalizeErhvervstype', () => {
  it('mapper nøgleord til kanonisk type', () => {
    expect(normalizeErhvervstype('Kontorlokale')).toBe('kontor');
    expect(normalizeErhvervstype('Butik / detail')).toBe('butik');
    expect(normalizeErhvervstype('Lager og logistik')).toBe('lager');
    expect(normalizeErhvervstype('Produktion/industri')).toBe('produktion');
    expect(normalizeErhvervstype('Restaurant')).toBe('restaurant');
    expect(normalizeErhvervstype('Tandklinik')).toBe('klinik');
    expect(normalizeErhvervstype('Showroom')).toBe('showroom');
  });

  it('falder tilbage til "andet" for ukendt/tom', () => {
    expect(normalizeErhvervstype('noget helt andet')).toBe('andet');
    expect(normalizeErhvervstype('')).toBe('andet');
    // @ts-expect-error — test af defensiv håndtering af ikke-streng
    expect(normalizeErhvervstype(null)).toBe('andet');
  });
});

describe('dedupHash', () => {
  it('er stabil og uafhængig af whitespace/case', () => {
    const a = dedupHash(['Dansborg Allé 9', 'kontor', '100-249']);
    const b = dedupHash(['  dansborg allé 9 ', 'KONTOR', '100-249']);
    expect(a).toBe(b);
  });

  it('giver forskellig hash for forskellige input', () => {
    expect(dedupHash(['A', 'kontor'])).not.toBe(dedupHash(['B', 'kontor']));
  });

  it('producerer en 64-tegns hex SHA-256', () => {
    expect(dedupHash(['x'])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('buildObservation (privatlivs-grænse)', () => {
  const raw: RawListing = {
    adresse: 'Hemmelighedsvej 7, 2650 Hvidovre',
    postnr: 2650,
    kommune: 'Hvidovre',
    erhvervstypeRaw: 'Kontorlokale til leje',
    arealM2: 200,
    aarligLejeKr: 240000,
    seenDate: '2026-10-25',
  };

  it('udleder kr/m²/år, bucket og type korrekt', () => {
    const obs = buildObservation(raw);
    expect(obs).not.toBeNull();
    expect(obs!.leje_kr_m2_aar).toBe(1200); // 240000 / 200
    expect(obs!.areal_bucket).toBe('100-249');
    expect(obs!.erhvervstype).toBe('kontor');
    expect(obs!.postnr).toBe(2650);
    expect(obs!.first_seen).toBe('2026-10-25');
    expect(obs!.last_seen).toBe('2026-10-25');
    expect(obs!.dedup_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('LÆKKER ALDRIG rå adresse/kilde ud af funktionen', () => {
    const obs = buildObservation(raw);
    const keys = Object.keys(obs!);
    // Hele privatlivs-kontrakten: kun de hvidlistede aggregat-felter må findes.
    expect(keys.sort()).toEqual(
      [
        'areal_bucket',
        'dedup_hash',
        'erhvervstype',
        'first_seen',
        'kommune',
        'last_seen',
        'leje_kr_m2_aar',
        'postnr',
      ].sort()
    );
    // Adressens vejnavn må ikke optræde nogen steder i det serialiserede output.
    expect(JSON.stringify(obs)).not.toContain('Hemmelighedsvej');
  });

  it('returnerer null ved ugyldigt areal eller leje', () => {
    expect(buildObservation({ ...raw, arealM2: 0 })).toBeNull();
    expect(buildObservation({ ...raw, aarligLejeKr: 0 })).toBeNull();
    expect(buildObservation({ ...raw, arealM2: NaN })).toBeNull();
  });
});
