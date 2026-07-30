import { describe, it, expect } from 'vitest';
import { erOpdeltSfePlaceholder, type EjfEjerRow } from '@/app/lib/ejerskab/opdeltPlaceholder';

/** Hjælper: byg en ejf_ejerskab-lignende række. */
function row(p: Partial<EjfEjerRow>): EjfEjerRow {
  return {
    ejer_navn: null,
    ejer_cvr: null,
    ejerandel_taeller: 1,
    ejerandel_naevner: 1,
    ...p,
  };
}

describe('erOpdeltSfePlaceholder (BIZZ-2193)', () => {
  it('genkender den ENESTE "Ukendt" 1/1-placeholder uden CVR', () => {
    expect(erOpdeltSfePlaceholder([row({ ejer_navn: 'Ukendt' })])).toBe(true);
  });

  it('genkender fuld andel udtrykt som andet end 1/1 (fx 2/2)', () => {
    expect(
      erOpdeltSfePlaceholder([
        row({ ejer_navn: 'Ukendt', ejerandel_taeller: 2, ejerandel_naevner: 2 }),
      ])
    ).toBe(true);
  });

  it('konverterer IKKE en "Ukendt" med brøk-andel (delvist-ukendt medejerskab)', () => {
    expect(
      erOpdeltSfePlaceholder([
        row({ ejer_navn: 'Ukendt', ejerandel_taeller: 1, ejerandel_naevner: 2 }),
      ])
    ).toBe(false);
  });

  it('konverterer IKKE når "Ukendt" optræder sammen med en reel ejer', () => {
    expect(
      erOpdeltSfePlaceholder([
        row({ ejer_navn: 'Ukendt', ejerandel_taeller: 1, ejerandel_naevner: 2 }),
        row({
          ejer_navn: 'CVR 12345678',
          ejer_cvr: '12345678',
          ejerandel_taeller: 1,
          ejerandel_naevner: 2,
        }),
      ])
    ).toBe(false);
  });

  it('konverterer IKKE en reel navngiven ejer', () => {
    expect(erOpdeltSfePlaceholder([row({ ejer_navn: 'Jens Hansen' })])).toBe(false);
  });

  it('konverterer IKKE en "Ukendt" der har et CVR (selskab uden cachet navn)', () => {
    expect(erOpdeltSfePlaceholder([row({ ejer_navn: 'Ukendt', ejer_cvr: '12345678' })])).toBe(
      false
    );
  });

  it('returnerer false for tom liste', () => {
    expect(erOpdeltSfePlaceholder([])).toBe(false);
  });

  it('returnerer false når andel mangler', () => {
    expect(
      erOpdeltSfePlaceholder([
        row({ ejer_navn: 'Ukendt', ejerandel_taeller: null, ejerandel_naevner: null }),
      ])
    ).toBe(false);
  });
});
