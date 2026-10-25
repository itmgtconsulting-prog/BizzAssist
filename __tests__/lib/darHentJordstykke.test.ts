/**
 * Unit tests for darHentJordstykke — koordinat → BFE.
 *
 * Regression for adresse→BFE-fejlen: funktionen udledte matrikel/ejerlav men
 * returnerede ALDRIG et bfenummer, så AI-chattens dawa_adresse_detaljer aldrig
 * kunne kæde videre til ejerskab/vurdering/ejendomsadmin. Fixet selekterer
 * `samletFastEjendomLokalId` fra MAT og returnerer det som `bfenummer`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Minimal Response-stub. */
const makeRes = (body: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) }) as unknown as Response;

/** WFS-svar med ét jordstykke-feature (point-in-polygon falder tilbage til feats[0]). */
const wfsRes = () => makeRes({ features: [{ properties: { jordstykkeLokalId: 'js-1' } }] });

describe('darHentJordstykke — koordinat → BFE', () => {
  const origKey = process.env.DATAFORDELER_API_KEY;

  beforeEach(() => {
    process.env.DATAFORDELER_API_KEY = 'test-key';
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (origKey === undefined) delete process.env.DATAFORDELER_API_KEY;
    else process.env.DATAFORDELER_API_KEY = origKey;
  });

  it('returnerer bfenummer fra MAT samletFastEjendomLokalId', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(wfsRes())
      .mockResolvedValueOnce(
        makeRes({
          data: {
            MAT_Jordstykke: {
              nodes: [
                {
                  matrikelnummer: '13a',
                  registreretAreal: 450,
                  ejerlavLokalId: 'el-1',
                  kommuneLokalId: '0175',
                  samletFastEjendomLokalId: '7402488',
                },
              ],
            },
          },
        })
      )
      .mockResolvedValueOnce(
        makeRes({
          data: { MAT_Ejerlav: { nodes: [{ ejerlavskode: 12345, ejerlavsnavn: 'Rødovre' }] } },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const { darHentJordstykke } = await import('@/app/lib/dar');
    const r = await darHentJordstykke(12.464, 55.6894);

    expect(r).not.toBeNull();
    expect(r?.bfenummer).toBe(7402488);
    expect(r?.matrikelnr).toBe('13a');
    expect(r?.ejerlav.navn).toBe('Rødovre');
  });

  it('bfenummer er null når MAT mangler samletFastEjendomLokalId', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(wfsRes())
      .mockResolvedValueOnce(
        makeRes({
          data: { MAT_Jordstykke: { nodes: [{ matrikelnummer: '13a', registreretAreal: 450 }] } },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const { darHentJordstykke } = await import('@/app/lib/dar');
    const r = await darHentJordstykke(12.464, 55.6894);

    expect(r).not.toBeNull();
    expect(r?.bfenummer).toBeNull();
  });
});
