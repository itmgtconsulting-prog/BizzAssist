import { describe, it, expect } from 'vitest';
import {
  parseHusnr,
  formatEnhedsadresse,
  parseRawKvhxRows,
  buildSelectedAddresses,
} from '@/app/lib/daekningsanalyse/rawKvhx';

describe('parseHusnr — DAWA_KVHX (fast bredde)', () => {
  it('udleder husnr uden etage/dør', () => {
    expect(parseHusnr('01470220_128_______', '')).toEqual({ husnr: '128', etage: '', dor: '' });
  });
  it('udleder husnr + st + dør', () => {
    expect(parseHusnr('01470220_128_st___1', '')).toEqual({ husnr: '128', etage: 'st', dor: '1' });
  });
  it('udleder etage + dør-bogstaver (tv)', () => {
    expect(parseHusnr('01470220_126__4__tv', '')).toEqual({ husnr: '126', etage: '4', dor: 'tv' });
  });
  it('bevarer husnr-bogstav (114A)', () => {
    expect(parseHusnr('01470220114A_______', '')).toEqual({ husnr: '114A', etage: '', dor: '' });
  });
  it('håndterer kælder (kl)', () => {
    expect(parseHusnr('01470220_126_kl____', '')).toEqual({ husnr: '126', etage: 'kl', dor: '' });
  });
});

describe('parseHusnr — sub_address_kvhx_id fallback (blank DAWA_KVHX)', () => {
  it('udleder husnr fra kvhx-id', () => {
    expect(parseHusnr('', '147022010604TV')).toEqual({ husnr: '106', etage: '4', dor: 'tv' });
  });
  it('husnr + ST + TH', () => {
    expect(parseHusnr('', '1470220106STTH')).toEqual({ husnr: '106', etage: 'st', dor: 'th' });
  });
  it('husnr-bogstav + etage (114A ST)', () => {
    expect(parseHusnr('', '1470220114AST')).toEqual({ husnr: '114A', etage: 'st', dor: '' });
  });
  it('foretrækker DAWA_KVHX når begge findes', () => {
    expect(parseHusnr('01470220_128_st___1', '147022012899XX')).toEqual({
      husnr: '128',
      etage: 'st',
      dor: '1',
    });
  });
  it('returnerer null når ingen nøgle kan udledes', () => {
    expect(parseHusnr('', '')).toBeNull();
    expect(parseHusnr('kort', 'xx')).toBeNull();
  });
});

describe('formatEnhedsadresse', () => {
  it('husnr + etage + dør + by', () => {
    expect(formatEnhedsadresse('Falkoner Alle', '128', 'st', '1', 2000, 'Frederiksberg')).toBe(
      'Falkoner Alle 128, st. 1, 2000 Frederiksberg'
    );
  });
  it('kun husnr (rækkehus)', () => {
    expect(formatEnhedsadresse('Belsager', '3', '', '', 2670, 'Greve')).toBe(
      'Belsager 3, 2670 Greve'
    );
  });
  it('etage uden dør', () => {
    expect(formatEnhedsadresse('Falkoner Alle', '1', '5', '', 2000, 'Frederiksberg')).toBe(
      'Falkoner Alle 1, 5., 2000 Frederiksberg'
    );
  });
});

const RAW_HEADER = [
  'sub_address_kvhx_id',
  'address_street_name',
  'address_postcode',
  'DAWA_KVHX',
  'HomeInternet_base',
];
const RAW_ROWS = [
  RAW_HEADER,
  ['1470220128ST0001', 'Falkoner Alle', 2000, '01470220_128_st___1', 1], // kunde
  ['147022012805', 'Falkoner Alle', 2000, '01470220_128__5____', 1], // kunde
  ['1470220130', 'Falkoner Alle', 2000, '01470220_130_______', 0], // IKKE kunde
  ['2538375003', 'Søagerparken', 2670, '02538375___3_______', 2], // kunde, andet postnr
  ['147022010604TV', 'Falkoner Alle', 2000, '', 1], // kunde via kvhx-fallback (blank DAWA)
];

describe('parseRawKvhxRows', () => {
  it('returnerer null for ikke-rå-format', () => {
    expect(parseRawKvhxRows([['Adresse'], ['Falkoner Alle 1, 2000 Frederiksberg']])).toBeNull();
  });

  it('parser rå-format og filtrerer til HomeInternet-kunder', () => {
    const ds = parseRawKvhxRows(RAW_ROWS)!;
    expect(ds).not.toBeNull();
    expect(ds.hasHomeInternetColumn).toBe(true);
    expect(ds.totalRows).toBe(5);
    expect(ds.customerRows).toBe(4); // 130 (home=0) frafiltreret
    expect(ds.postnumre).toEqual([2000, 2670]);
    expect(ds.streetsByPostnr[2000]).toEqual(['Falkoner Alle']);
    expect(ds.streetsByPostnr[2670]).toEqual(['Søagerparken']);
  });

  it('bevarer HomeInternet-antal pr. record', () => {
    const ds = parseRawKvhxRows(RAW_ROWS)!;
    const soag = ds.records.find((r) => r.street === 'Søagerparken')!;
    expect(soag.homeInternet).toBe(2);
    expect(soag.husnr).toBe('3');
  });

  it('uden HomeInternet-kolonne beholdes alle rækker som kunder', () => {
    const noHome = [
      ['sub_address_kvhx_id', 'address_street_name', 'address_postcode', 'DAWA_KVHX'],
      ['1470220130', 'Falkoner Alle', 2000, '01470220_130_______'],
    ];
    const ds = parseRawKvhxRows(noHome)!;
    expect(ds.hasHomeInternetColumn).toBe(false);
    expect(ds.customerRows).toBe(1);
  });
});

describe('buildSelectedAddresses', () => {
  it('bygger unikke adresser for valgt postnr (alle gader)', () => {
    const ds = parseRawKvhxRows(RAW_ROWS)!;
    const addrs = buildSelectedAddresses(ds, 2000, 'Frederiksberg');
    expect(addrs).toContain('Falkoner Alle 128, st. 1, 2000 Frederiksberg');
    expect(addrs).toContain('Falkoner Alle 128, 5., 2000 Frederiksberg');
    expect(addrs).toContain('Falkoner Alle 106, 4. tv, 2000 Frederiksberg');
    // ingen 2670-adresser i 2000-udvalget
    expect(addrs.every((a) => a.includes('2000'))).toBe(true);
  });

  it('filtrerer på valgt gade når angivet', () => {
    const ds = parseRawKvhxRows(RAW_ROWS)!;
    const addrs = buildSelectedAddresses(ds, 2670, 'Greve', 'Søagerparken');
    expect(addrs).toEqual(['Søagerparken 3, 2670 Greve']);
  });
});
