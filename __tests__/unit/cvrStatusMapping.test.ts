/**
 * Unit-tests for cvrStatusMapping — afkodning af CVR's rå status-blob til de
 * 5 visuelle M&A-radar-kategorier (BIZZ-1962).
 *
 * Test-data er hentet fra de faktiske distinct-værdier i cvr_virksomhed.status
 * (test-DB), så mappingen valideres mod virkeligheden, ikke antagelser.
 */

import { describe, it, expect } from 'vitest';
import {
  deriveCvrStatusKode,
  mapCvrStatus,
  CVR_STATUS_INFO,
  CVR_STATUS_KODER,
} from '@/app/lib/cvrStatusMapping';

/** Byg en rå status-JSON-streng som CVR-cachen gemmer den. */
function status(statustekst: string | null, kreditoplysningtekst: string | null): string {
  return JSON.stringify({
    statuskode: 3,
    statustekst,
    kreditoplysningkode: 3,
    kreditoplysningtekst,
    periode: { gyldigFra: '2024-01-01', gyldigTil: '2024-02-01' },
    sidstOpdateret: '2024-03-01T10:00:00.000+01:00',
  });
}

describe('deriveCvrStatusKode', () => {
  it('NULL/undefined/tom → aktiv (ingen insolvenshændelse)', () => {
    expect(deriveCvrStatusKode(null)).toBe('aktiv');
    expect(deriveCvrStatusKode(undefined)).toBe('aktiv');
    expect(deriveCvrStatusKode('')).toBe('aktiv');
  });

  it('ikke-JSON tekst → aktiv (defensiv, kaster ikke)', () => {
    expect(deriveCvrStatusKode('NORMAL')).toBe('aktiv');
    expect(deriveCvrStatusKode('   ')).toBe('aktiv');
  });

  it('ugyldig JSON → aktiv (parse-fejl fanges)', () => {
    expect(deriveCvrStatusKode('{ ikke gyldig json')).toBe('aktiv');
  });

  it('"Regnskab og boafslutning" / Konkurs → oploest_konkurs (bo afsluttet)', () => {
    expect(deriveCvrStatusKode(status('Regnskab og boafslutning', 'Konkurs'))).toBe(
      'oploest_konkurs'
    );
  });

  it('"Dekret" / Konkurs → under_konkurs (igangværende konkurs)', () => {
    expect(deriveCvrStatusKode(status('Dekret', 'Konkurs'))).toBe('under_konkurs');
  });

  it('"Indkaldelse til fordringsprøvelse" / Konkurs → under_konkurs', () => {
    expect(deriveCvrStatusKode(status('Indkaldelse til fordringsprøvelse', 'Konkurs'))).toBe(
      'under_konkurs'
    );
  });

  it('"Ophævelse af dekret" → aktiv (dekret hævet, selskab fortsætter)', () => {
    expect(deriveCvrStatusKode(status('Ophævelse af dekret', 'Konkurs'))).toBe('aktiv');
    expect(deriveCvrStatusKode(status('Ophævelse af dekret', 'Tvangsakkord'))).toBe('aktiv');
  });

  it('Tvangsakkord-faser → under_konkurs (distressed/igangværende)', () => {
    expect(deriveCvrStatusKode(status('Stadfæstelse', 'Tvangsakkord'))).toBe('under_konkurs');
    expect(deriveCvrStatusKode(status('Åbning af forhandling', 'Tvangsakkord'))).toBe(
      'under_konkurs'
    );
  });

  it('både statustekst og kreditoplysningtekst null → aktiv', () => {
    expect(deriveCvrStatusKode(status(null, null))).toBe('aktiv');
  });

  // BIZZ-1974: ophoert-dato er det autoritative ophørs-signal når status-blobben
  // er NULL (gælder ~2.1M selskaber i cachen).
  it('NULL status men ophoert-dato sat → ophoert', () => {
    expect(deriveCvrStatusKode(null, '2017-12-12')).toBe('ophoert');
    expect(deriveCvrStatusKode(null, '2026-03-13')).toBe('ophoert');
  });

  it('ophoert-dato i fremtiden ignoreres → aktiv', () => {
    expect(deriveCvrStatusKode(null, '2999-01-01')).toBe('aktiv');
  });

  it('tom/null ophoert → aktiv', () => {
    expect(deriveCvrStatusKode(null, null)).toBe('aktiv');
    expect(deriveCvrStatusKode(null, '')).toBe('aktiv');
  });

  it('insolvens-blob vinder over ophoert (mere specifik)', () => {
    expect(deriveCvrStatusKode(status('Regnskab og boafslutning', 'Konkurs'), '2020-01-01')).toBe(
      'oploest_konkurs'
    );
    expect(deriveCvrStatusKode(status('Dekret', 'Konkurs'), '2020-01-01')).toBe('under_konkurs');
  });

  it('"Ophævelse af dekret" + ophoert-dato → ophoert (blob neutral, dato afgør)', () => {
    expect(deriveCvrStatusKode(status('Ophævelse af dekret', 'Konkurs'), '2020-01-01')).toBe(
      'ophoert'
    );
  });
});

describe('mapCvrStatus', () => {
  it('returnerer fuld CvrStatusInfo med farve + label', () => {
    const info = mapCvrStatus(status('Regnskab og boafslutning', 'Konkurs'));
    expect(info.kode).toBe('oploest_konkurs');
    expect(info.label).toBe('Opløst efter konkurs');
    expect(info.badgeClass).toContain('red');
    expect(info.dotClass).toContain('red');
  });

  it('aktiv har grøn (emerald) farve', () => {
    const info = mapCvrStatus(null);
    expect(info.kode).toBe('aktiv');
    expect(info.dotClass).toContain('emerald');
  });
});

describe('CVR_STATUS-registry', () => {
  it('CVR_STATUS_KODER dækker præcis alle 6 kategorier i registry', () => {
    expect(CVR_STATUS_KODER).toHaveLength(6);
    for (const kode of CVR_STATUS_KODER) {
      expect(CVR_STATUS_INFO[kode]).toBeDefined();
      expect(CVR_STATUS_INFO[kode].kode).toBe(kode);
    }
  });
});
