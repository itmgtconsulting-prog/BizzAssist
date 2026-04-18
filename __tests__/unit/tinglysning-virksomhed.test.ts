/**
 * Unit tests for parseVirksomhedSoegResultat (BIZZ-521).
 *
 * Guards the XML-shaped JSON response parser for e-TL's soegvirksomhed
 * endpoint. The shape comes from http_api_beskrivelse_v1.12 §4.7.4.
 *
 * What matters here:
 *   - BFE-nummer is extracted as number (route/links depend on it)
 *   - Multiple dokumenter per ejendom → multiple rows (each row links to one doc)
 *   - AdkomstType only populated for rolle=ejer (kreditor has no adkomst)
 *   - Missing/partial sections never throw, just return fewer fields
 */

import { describe, it, expect } from 'vitest';
import { parseVirksomhedSoegResultat } from '@/app/api/tinglysning/virksomhed/route';

describe('parseVirksomhedSoegResultat', () => {
  it('extracts a single ejer-row with adkomstType and dokumentId', () => {
    const raw = {
      VirksomhedSoegResultat: {
        VirksomhedSoegningInformationSamling: [
          {
            EjendomIdentifikator: {
              BestemtFastEjendomNummer: 6020169,
              Matrikel: [
                {
                  CadastralDistrictName: 'Vigerslev, København',
                  CadastralDistrictIdentifier: 2000180,
                  Matrikelnummer: 3178,
                },
              ],
            },
            RolleTypeIdentifikator: 'ejer',
            DokumentRettighedSamling: [
              {
                DokumentRevisionIdentifikator: { DokumentIdentifikator: 'doc-uuid-1' },
                DokumentAlias: { AktHistoriskIdentifikator: '19921016-900131-01' },
                AdkomstType: 'skoede',
              },
            ],
          },
        ],
      },
    };

    const rows = parseVirksomhedSoegResultat(raw);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      bfe: 6020169,
      matrikel: 'Vigerslev, København, 3178',
      rolle: 'ejer',
      dokumentId: 'doc-uuid-1',
      dokumentAlias: '19921016-900131-01',
      adkomstType: 'skoede',
    });
  });

  it('splits one ejendom with multiple dokumenter into multiple rows', () => {
    const raw = {
      VirksomhedSoegResultat: {
        VirksomhedSoegningInformationSamling: [
          {
            EjendomIdentifikator: {
              BestemtFastEjendomNummer: 42,
              Matrikel: [{ CadastralDistrictName: 'Lyngby', Matrikelnummer: '1a' }],
            },
            RolleTypeIdentifikator: 'ejer',
            DokumentRettighedSamling: [
              {
                DokumentRevisionIdentifikator: { DokumentIdentifikator: 'a' },
                DokumentAlias: { AktHistoriskIdentifikator: '2020-1' },
                AdkomstType: 'skoede',
              },
              {
                DokumentRevisionIdentifikator: { DokumentIdentifikator: 'b' },
                DokumentAlias: { AktHistoriskIdentifikator: '2020-2' },
                AdkomstType: 'arv',
              },
            ],
          },
        ],
      },
    };

    const rows = parseVirksomhedSoegResultat(raw);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.dokumentId)).toEqual(['a', 'b']);
    expect(rows.map((r) => r.adkomstType)).toEqual(['skoede', 'arv']);
    // Same BFE for both rows
    expect(new Set(rows.map((r) => r.bfe))).toEqual(new Set([42]));
  });

  it('leaves adkomstType=null for kreditor rows even if AdkomstType is present', () => {
    const raw = {
      VirksomhedSoegResultat: {
        VirksomhedSoegningInformationSamling: [
          {
            EjendomIdentifikator: {
              BestemtFastEjendomNummer: 100,
              Matrikel: [{ CadastralDistrictName: 'Test', Matrikelnummer: '5b' }],
            },
            RolleTypeIdentifikator: 'kreditor',
            DokumentRettighedSamling: [
              {
                DokumentRevisionIdentifikator: { DokumentIdentifikator: 'pant-1' },
                DokumentAlias: { AktHistoriskIdentifikator: '2024-5' },
                AdkomstType: 'skoede', // should be ignored for kreditor
              },
            ],
          },
        ],
      },
    };

    const rows = parseVirksomhedSoegResultat(raw);

    expect(rows).toHaveLength(1);
    expect(rows[0].rolle).toBe('kreditor');
    expect(rows[0].adkomstType).toBeNull();
  });

  it('creates a row even when DokumentRettighedSamling is empty', () => {
    const raw = {
      VirksomhedSoegResultat: {
        VirksomhedSoegningInformationSamling: [
          {
            EjendomIdentifikator: {
              BestemtFastEjendomNummer: 7,
              Matrikel: [{ CadastralDistrictName: 'X', Matrikelnummer: '1' }],
            },
            RolleTypeIdentifikator: 'ejer',
            DokumentRettighedSamling: [],
          },
        ],
      },
    };

    const rows = parseVirksomhedSoegResultat(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0].dokumentId).toBeNull();
    expect(rows[0].dokumentAlias).toBeNull();
    expect(rows[0].adkomstType).toBeNull();
  });

  it('skips entries without a valid BFE number (no link target = no row)', () => {
    const raw = {
      VirksomhedSoegResultat: {
        VirksomhedSoegningInformationSamling: [
          {
            EjendomIdentifikator: {
              // BFE missing entirely
              Matrikel: [{ CadastralDistrictName: 'Foo', Matrikelnummer: '1' }],
            },
            RolleTypeIdentifikator: 'ejer',
            DokumentRettighedSamling: [
              { DokumentRevisionIdentifikator: { DokumentIdentifikator: 'x' } },
            ],
          },
          {
            EjendomIdentifikator: {
              BestemtFastEjendomNummer: 'not-a-number',
              Matrikel: [],
            },
            RolleTypeIdentifikator: 'ejer',
          },
        ],
      },
    };

    const rows = parseVirksomhedSoegResultat(raw);
    expect(rows).toHaveLength(0);
  });

  it('returns empty array for completely unexpected shapes (never throws)', () => {
    expect(parseVirksomhedSoegResultat(null)).toEqual([]);
    expect(parseVirksomhedSoegResultat({})).toEqual([]);
    expect(parseVirksomhedSoegResultat({ VirksomhedSoegResultat: {} })).toEqual([]);
    expect(parseVirksomhedSoegResultat('garbage')).toEqual([]);
  });

  it('coerces BFE-nummer from string to number (some e-TL environments return strings)', () => {
    const raw = {
      VirksomhedSoegResultat: {
        VirksomhedSoegningInformationSamling: [
          {
            EjendomIdentifikator: {
              BestemtFastEjendomNummer: '6020169',
              Matrikel: [{ CadastralDistrictName: 'Vigerslev', Matrikelnummer: '3178' }],
            },
            RolleTypeIdentifikator: 'ejer',
            DokumentRettighedSamling: [
              {
                DokumentRevisionIdentifikator: { DokumentIdentifikator: 'x' },
                DokumentAlias: { AktHistoriskIdentifikator: '2020-1' },
                AdkomstType: 'skoede',
              },
            ],
          },
        ],
      },
    };

    const rows = parseVirksomhedSoegResultat(raw);
    expect(rows[0].bfe).toBe(6020169);
    expect(typeof rows[0].bfe).toBe('number');
  });

  it('joins multiple matrikler with " | " (defensive — rare case)', () => {
    const raw = {
      VirksomhedSoegResultat: {
        VirksomhedSoegningInformationSamling: [
          {
            EjendomIdentifikator: {
              BestemtFastEjendomNummer: 99,
              Matrikel: [
                { CadastralDistrictName: 'By1', Matrikelnummer: '1' },
                { CadastralDistrictName: 'By2', Matrikelnummer: '2' },
              ],
            },
            RolleTypeIdentifikator: 'ejer',
            DokumentRettighedSamling: [
              {
                DokumentRevisionIdentifikator: { DokumentIdentifikator: 'z' },
                DokumentAlias: { AktHistoriskIdentifikator: '2020-9' },
                AdkomstType: 'skoede',
              },
            ],
          },
        ],
      },
    };

    const rows = parseVirksomhedSoegResultat(raw);
    expect(rows[0].matrikel).toBe('By1, 1 | By2, 2');
  });
});
