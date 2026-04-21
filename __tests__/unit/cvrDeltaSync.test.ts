/**
 * Unit-tests for BIZZ-651 CVR delta-sync pure helpers.
 */

import { describe, it, expect } from 'vitest';
import { computeCvrFromDate } from '@/app/api/cron/pull-cvr-aendringer/route';
import { mapVirksomhedToRow, type VrvirksomhedDoc } from '@/app/lib/cvrIngest';

describe('computeCvrFromDate — rolling window', () => {
  it('returns ISO timestamp N days before reference', () => {
    const now = new Date('2026-04-21T12:00:00Z');
    const from = computeCvrFromDate(now, 5);
    expect(from).toBe('2026-04-16T12:00:00.000Z');
  });

  it('handles 1-day window (yesterday)', () => {
    const now = new Date('2026-04-21T00:00:00Z');
    expect(computeCvrFromDate(now, 1)).toBe('2026-04-20T00:00:00.000Z');
  });

  it('handles month boundary', () => {
    const now = new Date('2026-05-02T00:00:00Z');
    expect(computeCvrFromDate(now, 5)).toBe('2026-04-27T00:00:00.000Z');
  });

  it('handles year boundary', () => {
    const now = new Date('2026-01-03T00:00:00Z');
    expect(computeCvrFromDate(now, 5)).toBe('2025-12-29T00:00:00.000Z');
  });
});

describe('mapVirksomhedToRow — ES → CvrRow mapping', () => {
  const baseDoc: VrvirksomhedDoc = {
    cvrNummer: 12345678,
    samtId: 42,
    sidstOpdateret: '2026-04-20T10:00:00.000+02:00',
    sidstIndlaest: '2026-04-21T02:30:00.000+02:00',
    livsforloeb: [{ periode: { gyldigFra: '2000-01-15', gyldigTil: null } }],
    virksomhedMetadata: {
      nyesteNavn: { navn: 'Test Firma ApS' },
      nyesteStatus: 'NORMAL',
      nyesteHovedbranche: { branchekode: 682040, branchetekst: 'Udlejning af erhvervsejendomme' },
      nyesteVirksomhedsform: { kortBeskrivelse: 'APS' },
      nyesteBeliggenhedsadresse: { vejnavn: 'Søbyvej', husnummerFra: 11, postnummer: 2650 },
      nyesteAarsbeskaeftigelse: { antalAnsatte: 5 },
      nyesteKvartalsbeskaeftigelse: [
        { kvartal: 1, antalAnsatte: 3 },
        { kvartal: 2, antalAnsatte: 4 },
      ],
    },
  };

  it('maps a complete record correctly', () => {
    const row = mapVirksomhedToRow(baseDoc);
    expect(row).not.toBeNull();
    expect(row!.cvr).toBe('12345678');
    expect(row!.samt_id).toBe(42);
    expect(row!.navn).toBe('Test Firma ApS');
    expect(row!.status).toBe('NORMAL');
    expect(row!.branche_kode).toBe('682040');
    expect(row!.branche_tekst).toBe('Udlejning af erhvervsejendomme');
    expect(row!.virksomhedsform).toBe('APS');
    expect(row!.stiftet).toBe('2000-01-15');
    expect(row!.ophoert).toBeNull();
    expect(row!.ansatte_aar).toBe(5);
    expect(row!.ansatte_kvartal_1).toBe(3);
    expect(row!.ansatte_kvartal_2).toBe(4);
    expect(row!.ansatte_kvartal_3).toBeNull();
    expect(row!.ansatte_kvartal_4).toBeNull();
  });

  it('returns null for missing cvrNummer', () => {
    expect(mapVirksomhedToRow({ ...baseDoc, cvrNummer: undefined })).toBeNull();
  });

  it('returns null for missing navn', () => {
    expect(
      mapVirksomhedToRow({
        ...baseDoc,
        virksomhedMetadata: { ...baseDoc.virksomhedMetadata, nyesteNavn: undefined },
      })
    ).toBeNull();
  });

  it('pads branchekode to 6 digits', () => {
    const row = mapVirksomhedToRow({
      ...baseDoc,
      virksomhedMetadata: {
        ...baseDoc.virksomhedMetadata,
        nyesteHovedbranche: { branchekode: 123 },
      },
    });
    expect(row!.branche_kode).toBe('000123');
  });

  it('extracts stiftet from first livsforloeb entry', () => {
    const row = mapVirksomhedToRow({
      ...baseDoc,
      livsforloeb: [{ periode: { gyldigFra: '1999-10-29T00:00:00+01:00' } }],
    });
    expect(row!.stiftet).toBe('1999-10-29');
  });

  it('extracts ophoert when latest livsforloeb has gyldigTil', () => {
    const row = mapVirksomhedToRow({
      ...baseDoc,
      livsforloeb: [
        { periode: { gyldigFra: '2000-01-01', gyldigTil: null } },
        { periode: { gyldigFra: '2010-01-01', gyldigTil: '2020-12-31' } },
      ],
    });
    expect(row!.ophoert).toBe('2020-12-31');
  });

  it('handles kvartalsbeskaeftigelse as single object (not array)', () => {
    const row = mapVirksomhedToRow({
      ...baseDoc,
      virksomhedMetadata: {
        ...baseDoc.virksomhedMetadata,
        nyesteKvartalsbeskaeftigelse: {
          kvartal: 3,
          antalAnsatte: 7,
        } as unknown as Array<{ kvartal?: number; antalAnsatte?: number | null }>,
      },
    });
    expect(row!.ansatte_kvartal_3).toBe(7);
  });

  it('handles missing branche gracefully', () => {
    const row = mapVirksomhedToRow({
      ...baseDoc,
      virksomhedMetadata: {
        ...baseDoc.virksomhedMetadata,
        nyesteHovedbranche: undefined,
      },
    });
    expect(row!.branche_kode).toBeNull();
    expect(row!.branche_tekst).toBeNull();
  });

  it('preserves adresse_json as-is for UI to render', () => {
    const row = mapVirksomhedToRow(baseDoc);
    expect(row!.adresse_json).toEqual({
      vejnavn: 'Søbyvej',
      husnummerFra: 11,
      postnummer: 2650,
    });
  });
});
