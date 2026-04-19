/**
 * Unit tests for selectPrimaryOwner (BIZZ-460).
 *
 * Verifies the owner-selection heuristic used by /api/ejendomme-by-owner/enrich
 * to pick the "right" owner to show on each property card. Prior to BIZZ-460
 * we took ejere[0] blindly, which exposed a bug where Arnold Nielsens
 * Boulevard 62A (owned 100% by Arnbo 62 ApS) displayed "Kenny Dan Olsson"
 * (a personal beneficial owner node that happened to come first in the
 * EJF response).
 */

import { describe, it, expect } from 'vitest';
import {
  selectPrimaryOwner,
  type EjerCandidate,
} from '@/app/api/ejendomme-by-owner/enrich/selectPrimaryOwner';

describe('selectPrimaryOwner', () => {
  it('returns null for an empty list', () => {
    expect(selectPrimaryOwner([])).toBeNull();
  });

  it('returns null when no candidate has any identifier', () => {
    const ejere: EjerCandidate[] = [
      {
        cvr: null,
        personNavn: null,
        ejerandel_taeller: 1,
        ejerandel_naevner: 1,
        virkningFra: null,
      },
    ];
    expect(selectPrimaryOwner(ejere)).toBeNull();
  });

  it('picks the CVR-ejer with 100% over a person-beneficiary with null andel', () => {
    // BIZZ-460 reproduction case: Arnbo 62 ApS owns 1/1, Kenny Dan Olsson
    // appears as a person-beneficiary with no andel. Before the fix,
    // ejere[0] returned Kenny; selectPrimaryOwner must prefer Arnbo.
    const ejere: EjerCandidate[] = [
      {
        cvr: null,
        personNavn: 'Kenny Dan Olsson',
        ejerandel_taeller: null,
        ejerandel_naevner: null,
        virkningFra: '2020-05-01',
      },
      {
        cvr: '43924931',
        personNavn: null,
        ejerandel_taeller: 1,
        ejerandel_naevner: 1,
        virkningFra: '2020-05-01',
      },
    ];
    const picked = selectPrimaryOwner(ejere);
    expect(picked?.cvr).toBe('43924931');
  });

  it('prefers higher ejerandel ratio', () => {
    const ejere: EjerCandidate[] = [
      {
        cvr: '11111111',
        personNavn: null,
        ejerandel_taeller: 1,
        ejerandel_naevner: 3,
        virkningFra: '2020-01-01',
      },
      {
        cvr: '22222222',
        personNavn: null,
        ejerandel_taeller: 2,
        ejerandel_naevner: 3,
        virkningFra: '2020-01-01',
      },
    ];
    expect(selectPrimaryOwner(ejere)?.cvr).toBe('22222222');
  });

  it('on tie, prefers CVR-ejer over person-ejer', () => {
    const ejere: EjerCandidate[] = [
      {
        cvr: null,
        personNavn: 'A Person',
        ejerandel_taeller: 1,
        ejerandel_naevner: 2,
        virkningFra: '2020-01-01',
      },
      {
        cvr: '33333333',
        personNavn: null,
        ejerandel_taeller: 1,
        ejerandel_naevner: 2,
        virkningFra: '2020-01-01',
      },
    ];
    expect(selectPrimaryOwner(ejere)?.cvr).toBe('33333333');
  });

  it('on full tie, picks the most recent virkningFra', () => {
    const ejere: EjerCandidate[] = [
      {
        cvr: '11111111',
        personNavn: null,
        ejerandel_taeller: 1,
        ejerandel_naevner: 2,
        virkningFra: '2015-01-01',
      },
      {
        cvr: '22222222',
        personNavn: null,
        ejerandel_taeller: 1,
        ejerandel_naevner: 2,
        virkningFra: '2024-06-15',
      },
    ];
    expect(selectPrimaryOwner(ejere)?.cvr).toBe('22222222');
  });

  it('skips candidates without any identifier', () => {
    const ejere: EjerCandidate[] = [
      {
        cvr: null,
        personNavn: null,
        ejerandel_taeller: 1,
        ejerandel_naevner: 1,
        virkningFra: null,
      },
      {
        cvr: null,
        personNavn: 'Person Only',
        ejerandel_taeller: null,
        ejerandel_naevner: null,
        virkningFra: '2021-01-01',
      },
    ];
    expect(selectPrimaryOwner(ejere)?.personNavn).toBe('Person Only');
  });

  it('handles divisor=0 as invalid (ratio = -1), not infinity', () => {
    const ejere: EjerCandidate[] = [
      {
        cvr: '11111111',
        personNavn: null,
        ejerandel_taeller: 1,
        ejerandel_naevner: 0, // corrupt data — should sort last
        virkningFra: '2020-01-01',
      },
      {
        cvr: '22222222',
        personNavn: null,
        ejerandel_taeller: 1,
        ejerandel_naevner: 4,
        virkningFra: '2019-01-01',
      },
    ];
    expect(selectPrimaryOwner(ejere)?.cvr).toBe('22222222');
  });

  it('returns a single candidate unchanged even if identifiers are null except one', () => {
    const ejere: EjerCandidate[] = [
      {
        cvr: '99999999',
        personNavn: null,
        ejerandel_taeller: null,
        ejerandel_naevner: null,
        virkningFra: null,
      },
    ];
    expect(selectPrimaryOwner(ejere)?.cvr).toBe('99999999');
  });
});
