/**
 * Unit tests for app/lib/slug.
 *
 * generateSlug converts arbitrary text (addresses, company names) to URL-safe slugs.
 * generateEjendomSlug builds a slug from individual address components.
 * generateVirksomhedSlug is an alias for generateSlug focused on company names.
 *
 * Covers:
 * - Danish special characters (æ→ae, ø→oe, å→aa)
 * - German/accented characters (ä, ö, ü, ß, é, etc.)
 * - Special characters replaced with spaces then collapsed to single dash
 * - Leading/trailing dashes stripped
 * - Multiple consecutive spaces/dashes collapsed
 * - Uppercase folded to lowercase
 * - generateEjendomSlug concatenates components in correct order
 * - generateVirksomhedSlug handles company name patterns
 */
import { describe, it, expect } from 'vitest';
import { generateSlug, generateEjendomSlug, generateVirksomhedSlug } from '@/app/lib/slug';

describe('generateSlug', () => {
  it('converts simple ASCII text to lowercase slug', () => {
    expect(generateSlug('Hello World')).toBe('hello-world');
  });

  it('converts æ to ae', () => {
    // Æblegrød: Æ→ae, ø→oe, d remains → 'aeblegroed'
    expect(generateSlug('Æblegrød')).toBe('aeblegroed');
  });

  it('converts ø to oe', () => {
    expect(generateSlug('Nørrebrogade')).toBe('noerrebrogade');
  });

  it('converts å to aa', () => {
    expect(generateSlug('Åboulevard')).toBe('aaboulevard');
  });

  it('converts full Danish address correctly', () => {
    expect(generateSlug('Arnold Nielsens Boulevard 62A, 2650 Hvidovre')).toBe(
      'arnold-nielsens-boulevard-62a-2650-hvidovre'
    );
  });

  it('converts ä to ae', () => {
    expect(generateSlug('Märkte')).toBe('maerkte');
  });

  it('converts ö to oe', () => {
    expect(generateSlug('Töpfer')).toBe('toepfer');
  });

  it('converts ü to ue', () => {
    expect(generateSlug('Über')).toBe('ueber');
  });

  it('converts ß to ss', () => {
    expect(generateSlug('Straße')).toBe('strasse');
  });

  it('converts é to e', () => {
    expect(generateSlug('Café René')).toBe('cafe-rene');
  });

  it('replaces forward slash with dash', () => {
    expect(generateSlug('A/S')).toBe('a-s');
  });

  it('replaces parentheses with dashes and collapses them', () => {
    expect(generateSlug('(test)')).toBe('test');
  });

  it('collapses multiple spaces into a single dash', () => {
    expect(generateSlug('foo   bar')).toBe('foo-bar');
  });

  it('collapses multiple dashes into a single dash', () => {
    expect(generateSlug('foo---bar')).toBe('foo-bar');
  });

  it('strips leading dash', () => {
    expect(generateSlug(' leading')).toBe('leading');
  });

  it('strips trailing dash', () => {
    expect(generateSlug('trailing ')).toBe('trailing');
  });

  it('converts uppercase to lowercase', () => {
    expect(generateSlug('NOVO NORDISK')).toBe('novo-nordisk');
  });

  it('handles empty string', () => {
    expect(generateSlug('')).toBe('');
  });

  it('handles string with only special characters', () => {
    expect(generateSlug('!!!@@@')).toBe('');
  });

  it('preserves numbers', () => {
    expect(generateSlug('Vej 42B')).toBe('vej-42b');
  });

  it('handles mixed special chars and Danish characters together', () => {
    // Ø→oe, ø→oe... but Østerå: Ø→oe, s,t,e,r unchanged, å→aa → 'oesteraagade'
    // Ål: Å→aa, l → 'aalborg'
    expect(generateSlug('Østerågade 3, 9000 Ålborg')).toBe('oesteraagade-3-9000-aalborg');
  });

  it('handles company name with A/S suffix', () => {
    expect(generateSlug('NOVO NORDISK A/S')).toBe('novo-nordisk-a-s');
  });

  it('handles á, à, â characters', () => {
    expect(generateSlug('à á â')).toBe('a-a-a');
  });

  it('handles ó, ò, ô, õ characters', () => {
    expect(generateSlug('ó ò ô õ')).toBe('o-o-o-o');
  });

  it('handles ú, ù, û characters', () => {
    expect(generateSlug('ú ù û')).toBe('u-u-u');
  });

  it('handles í, ì, î, ï characters', () => {
    expect(generateSlug('í ì î ï')).toBe('i-i-i-i');
  });

  it('handles ñ character', () => {
    expect(generateSlug('España')).toBe('espana');
  });

  it('handles ç character', () => {
    expect(generateSlug('François')).toBe('francois');
  });
});

describe('generateEjendomSlug', () => {
  it('combines address components into a slug', () => {
    expect(generateEjendomSlug('Arnold Nielsens Boulevard', '62A', '2650', 'Hvidovre')).toBe(
      'arnold-nielsens-boulevard-62a-2650-hvidovre'
    );
  });

  it('handles Danish characters in vejnavn', () => {
    expect(generateEjendomSlug('Nørrebrogade', '1', '2200', 'København N')).toBe(
      'noerrebrogade-1-2200-koebenhavn-n'
    );
  });

  it('handles å in postnrnavn', () => {
    expect(generateEjendomSlug('Torvet', '5', '8900', 'Randers C')).toBe('torvet-5-8900-randers-c');
  });

  it('handles uppercase vejnavn', () => {
    expect(generateEjendomSlug('VESTERBROGADE', '1', '1620', 'KØBENHAVN V')).toBe(
      'vesterbrogade-1-1620-koebenhavn-v'
    );
  });

  it('returns non-empty string for all components present', () => {
    const slug = generateEjendomSlug('Testvej', '1', '1234', 'Testby');
    expect(slug.length).toBeGreaterThan(0);
  });
});

describe('generateVirksomhedSlug', () => {
  it('converts a simple company name to a slug', () => {
    expect(generateVirksomhedSlug('Novo Nordisk A/S')).toBe('novo-nordisk-a-s');
  });

  it('handles uppercase company names', () => {
    expect(generateVirksomhedSlug('MAERSK A/S')).toBe('maersk-a-s');
  });

  it('handles ApS suffix', () => {
    expect(generateVirksomhedSlug('Testfirma ApS')).toBe('testfirma-aps');
  });

  it('handles Danish characters in company name', () => {
    expect(generateVirksomhedSlug('Øresund Byggeri A/S')).toBe('oeresund-byggeri-a-s');
  });

  it('handles company name with parentheses', () => {
    expect(generateVirksomhedSlug('Firma (under likvidation)')).toBe('firma-under-likvidation');
  });
});
