import { describe, it, expect } from 'vitest';
import {
  streetKey,
  longestStreetWord,
  foreningHusnumre,
  buildForeningIndex,
  matchForening,
  parseLabelLine,
} from '@/app/lib/daekningsanalyse/ejerforeningMatch';

describe('streetKey — accent/mellemrum-uafhængig', () => {
  it('giver samme nøgle for varianter', () => {
    expect(streetKey('Falkoner Alle')).toBe('falkoneralle');
    expect(streetKey('Falkoner Allé')).toBe('falkoneralle');
    expect(streetKey('Falkoneralle')).toBe('falkoneralle');
  });
  it('bevarer å/ø/æ', () => {
    expect(streetKey('Søagerparken')).toBe('søagerparken');
    expect(streetKey('Højager')).toBe('højager');
  });
});

describe('longestStreetWord', () => {
  it('vælger det mest distinktive ord', () => {
    expect(longestStreetWord('Falkoner Alle')).toBe('falkoner');
    expect(longestStreetWord('Kong Georgs Vej')).toBe('georgs');
    expect(longestStreetWord('Belsager')).toBe('belsager');
  });
});

describe('foreningHusnumre — udled husnr fra forenings-navn', () => {
  it('enkelt husnr', () => {
    expect(foreningHusnumre('E/F Falkoner Alle 54', 'Falkoner Alle')).toEqual(['54']);
    expect(foreningHusnumre('Ejerforeningen Falkoner Alle 75', 'Falkoner Alle')).toEqual(['75']);
  });
  it('navn uden mellemrum + accent', () => {
    expect(foreningHusnumre('Falkoneralle 53', 'Falkoner Alle')).toEqual(['53']);
    expect(foreningHusnumre('E/F Falkoner Allé 126 (2745)', 'Falkoner Alle')).toEqual(['126']);
  });
  it('interval ekspanderes paritets-bevidst (samme vejside)', () => {
    expect(foreningHusnumre('A/B Falkoner Alle 65-67', 'Falkoner Alle')).toEqual(['65', '67']);
    expect(foreningHusnumre('Andelsboligforeningen Falkoner Allé 57-61', 'Falkoner Alle')).toEqual([
      '57',
      '59',
      '61',
    ]);
  });
  it('husnr-bogstav-interval (58 A-D) → kun tallet', () => {
    expect(foreningHusnumre('Andelsboligforeningen Falkoner Alle 58 A-D', 'Falkoner Alle')).toEqual(
      ['58']
    );
  });
  it('ignorerer husnr fra ANDEN gade i navnet', () => {
    expect(foreningHusnumre('E/F Falkoner Alle 33-Rolfsvej 1', 'Falkoner Alle')).toEqual(['33']);
  });
  it('tom når gaden ikke er i navnet', () => {
    expect(foreningHusnumre('E/F Bredgade 12', 'Falkoner Alle')).toEqual([]);
  });
});

describe('buildForeningIndex + matchForening', () => {
  const cands = [
    { navn: 'Andelsboligforeningen Falkoner Alle 58 A-D', cvr: '111' },
    { navn: 'A/B Falkoner Alle 65-67', cvr: '222' },
    { navn: 'E/F Falkoner Alle 33-Rolfsvej 1', cvr: '333' },
  ];
  const idx = buildForeningIndex(cands, ['Falkoner Alle']);

  it('matcher matrikel-husnr til rette forening', () => {
    expect(matchForening('Falkoner Alle', ['58A', '58B'], idx)?.cvr).toBe('111');
    expect(matchForening('Falkoner Alle', ['67'], idx)?.cvr).toBe('222');
    expect(matchForening('Falkoner Allé', ['33'], idx)?.cvr).toBe('333'); // accent-variant vej
  });
  it('ingen match for husnr uden forening (fx lige side når kun ulige findes)', () => {
    expect(matchForening('Falkoner Alle', ['66'], idx)).toBeNull(); // 65-67 → kun 65,67
    expect(matchForening('Falkoner Alle', ['100'], idx)).toBeNull();
  });
});

describe('parseLabelLine', () => {
  it('vej + husnumre', () => {
    expect(parseLabelLine('Falkoner Alle 42, 44')).toEqual({
      vej: 'Falkoner Alle',
      husnumre: ['42', '44'],
    });
  });
  it('husnr med bogstav', () => {
    expect(parseLabelLine('Falkoner Alle 26A, 26B')).toEqual({
      vej: 'Falkoner Alle',
      husnumre: ['26', '26'],
    });
  });
  it('null uden husnr', () => {
    expect(parseLabelLine('Ukendt')).toBeNull();
  });
});
