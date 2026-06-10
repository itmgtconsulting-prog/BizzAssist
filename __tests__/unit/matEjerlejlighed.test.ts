/**
 * BIZZ-2061: fetchMatEjerlejlighederByBfe unit tests.
 *
 * Mocker global fetch — verificerer batch-query-bygning (kun positive
 * heltal interpoleres), parsing af MAT_Ejerlejlighed-noder, frasortering
 * af ikke-gældende noder samt fejl-tolerance (tomt Map ved fejl).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchMatEjerlejlighederByBfe } from '@/app/lib/matEjerlejlighed';

const fetchMock = vi.fn();

/** Bygger et gyldigt GraphQL-svar med de givne noder. */
function gqlResponse(nodes: unknown[]): Response {
  return new Response(JSON.stringify({ data: { MAT_Ejerlejlighed: { nodes } } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('DATAFORDELER_API_KEY', 'test-key');
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('fetchMatEjerlejlighederByBfe', () => {
  it('parser gældende noder til Map med areal + ejerlejlighedsnummer', async () => {
    fetchMock.mockResolvedValueOnce(
      gqlResponse([
        { BFEnummer: 221037, ejerlejlighedsnummer: '1', samletAreal: 1013, status: 'Gældende' },
        { BFEnummer: 221046, ejerlejlighedsnummer: '2', samletAreal: 244, status: 'Gældende' },
        // Historisk node skal ignoreres
        { BFEnummer: 221046, ejerlejlighedsnummer: '2', samletAreal: 999, status: 'Historisk' },
      ])
    );
    const map = await fetchMatEjerlejlighederByBfe([221037, 221046]);
    expect(map.get(221037)).toEqual({ areal: 1013, ejerlejlighedsnummer: '1' });
    expect(map.get(221046)).toEqual({ areal: 244, ejerlejlighedsnummer: '2' });
    expect(map.size).toBe(2);
  });

  it('interpolerer kun positive heltal i query (injection-guard)', async () => {
    fetchMock.mockResolvedValueOnce(gqlResponse([]));
    await fetchMatEjerlejlighederByBfe([221037, -1, 0, NaN, 2.5, 221037]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { query: string };
    expect(body.query).toContain('in: [221037]');
    expect(body.query).not.toContain('NaN');
    expect(body.query).not.toContain('2.5');
  });

  it('returnerer tomt Map ved HTTP-fejl, GraphQL-errors og tom input', async () => {
    fetchMock.mockResolvedValueOnce(new Response('oops', { status: 500 }));
    expect((await fetchMatEjerlejlighederByBfe([221037])).size).toBe(0);

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ message: 'bad' }] }), { status: 200 })
    );
    expect((await fetchMatEjerlejlighederByBfe([221037])).size).toBe(0);

    expect((await fetchMatEjerlejlighederByBfe([])).size).toBe(0);
  });

  it('returnerer tomt Map uden API-nøgle og ved netværksfejl', async () => {
    vi.stubEnv('DATAFORDELER_API_KEY', '');
    expect((await fetchMatEjerlejlighederByBfe([221037])).size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv('DATAFORDELER_API_KEY', 'test-key');
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    expect((await fetchMatEjerlejlighederByBfe([221037])).size).toBe(0);
  });

  it('normaliserer areal ≤ 0 og manglende felter til null', async () => {
    fetchMock.mockResolvedValueOnce(
      gqlResponse([
        { BFEnummer: 1, ejerlejlighedsnummer: null, samletAreal: 0, status: 'Gældende' },
        { BFEnummer: 2, status: 'Gældende' },
      ])
    );
    const map = await fetchMatEjerlejlighederByBfe([1, 2]);
    expect(map.get(1)).toEqual({ areal: null, ejerlejlighedsnummer: null });
    expect(map.get(2)).toEqual({ areal: null, ejerlejlighedsnummer: null });
  });
});
