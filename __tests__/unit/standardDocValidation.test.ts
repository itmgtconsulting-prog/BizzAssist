/**
 * BIZZ-2105: Tests for afvisningslogikken ved upload af standard betingelser.
 *
 * Reglerne er fail-closed: kan AI-valideringen ikke gennemføres (null),
 * afvises uploaden. Persondata og ikke-standard-dokumenter afvises også.
 */
import { describe, it, expect } from 'vitest';
import { vurderStandardDocAfvisning } from '@/app/lib/forsikring/standardDocValidation';

describe('vurderStandardDocAfvisning (BIZZ-2105)', () => {
  it('afviser fail-closed når vurderingen er null (AI-gate lukket / kald fejlede)', () => {
    const res = vurderStandardDocAfvisning(null);
    expect(res.afvist).toBe(true);
    expect(res.aarsag).toMatch(/kunne ikke valideres/i);
  });

  it('afviser dokumenter med persondata (GDPR)', () => {
    const res = vurderStandardDocAfvisning({
      er_standard_betingelser: true,
      indeholder_persondata: true,
      begrundelse: 'Indeholder CPR-nummer på side 2',
    });
    expect(res.afvist).toBe(true);
    expect(res.aarsag).toMatch(/persondata/i);
    expect(res.aarsag).toContain('Indeholder CPR-nummer på side 2');
  });

  it('persondata-afvisning har forrang over standard-vurderingen', () => {
    const res = vurderStandardDocAfvisning({
      er_standard_betingelser: false,
      indeholder_persondata: true,
    });
    expect(res.afvist).toBe(true);
    expect(res.aarsag).toMatch(/persondata/i);
  });

  it('afviser dokumenter der ikke er standard-betingelser (police/faktura)', () => {
    const res = vurderStandardDocAfvisning({
      er_standard_betingelser: false,
      indeholder_persondata: false,
      begrundelse: 'Individuel police med policenummer',
    });
    expect(res.afvist).toBe(true);
    expect(res.aarsag).toMatch(/ikke ud til at være generelle standard-betingelser/i);
    expect(res.aarsag).toContain('Individuel police med policenummer');
  });

  it('accepterer ægte standard-betingelser uden persondata', () => {
    const res = vurderStandardDocAfvisning({
      er_standard_betingelser: true,
      indeholder_persondata: false,
      begrundelse: 'Generelle vilkår for erhvervsforsikring',
    });
    expect(res).toEqual({ afvist: false, aarsag: null });
  });

  it('accepterer når flagene mangler men vurderingen findes (kun eksplicit true/false afviser)', () => {
    // AI'en svarede men udelod felterne — vi afviser kun på eksplicitte signaler,
    // da selve valideringen ER gennemført (ikke fail-closed-tilfældet).
    const res = vurderStandardDocAfvisning({ begrundelse: 'Uklart dokument' });
    expect(res.afvist).toBe(false);
  });
});
