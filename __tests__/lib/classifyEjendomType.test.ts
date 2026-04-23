/**
 * Unit tests for classifyEjendomType + lookupVurForAddresses (BIZZ-794).
 *
 * Verifies:
 *   - DAR_Adresse (etage/dør) klassificeres altid som 'ejerlejlighed'
 *   - DAR_Husnummer + VUR-hit = 'bygning'
 *   - DAR_Husnummer uden VUR-hit = 'sfe'
 *   - vejnavn-type returnerer null (ikke en ejendom)
 *   - VUR-lookup fejl/timeout returnerer tom map (caller falder tilbage til null)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifyEjendomType, lookupVurForAddresses } from '@/app/lib/dar';

describe('classifyEjendomType', () => {
  it('vejnavn-type returnerer null for begge felter', () => {
    expect(classifyEjendomType('vejnavn', undefined)).toEqual({
      ejendomstype: null,
      harVurdering: null,
    });
    expect(classifyEjendomType('vejnavn', true)).toEqual({
      ejendomstype: null,
      harVurdering: null,
    });
  });

  it('adresse (etage/dør) klassificeres altid som ejerlejlighed', () => {
    expect(classifyEjendomType('adresse', undefined)).toEqual({
      ejendomstype: 'ejerlejlighed',
      harVurdering: true,
    });
    // Selv hvis VUR-lookup siger false (fx ES forkert formaterede hit),
    // stoler vi på DAR's klassifikation — adresse med etage/dør er pr.
    // definition en ejerlejlighed med egen vurdering.
    expect(classifyEjendomType('adresse', false)).toEqual({
      ejendomstype: 'ejerlejlighed',
      harVurdering: true,
    });
  });

  it('adgangsadresse med VUR-hit = bygning', () => {
    expect(classifyEjendomType('adgangsadresse', true)).toEqual({
      ejendomstype: 'bygning',
      harVurdering: true,
    });
  });

  it('adgangsadresse uden VUR-hit = sfe', () => {
    expect(classifyEjendomType('adgangsadresse', false)).toEqual({
      ejendomstype: 'sfe',
      harVurdering: false,
    });
  });

  it('adgangsadresse med undefined VUR-lookup = ukendt (null)', () => {
    expect(classifyEjendomType('adgangsadresse', undefined)).toEqual({
      ejendomstype: null,
      harVurdering: null,
    });
  });
});

describe('lookupVurForAddresses', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('tom liste returnerer tom map uden at fetche', async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch;
    const result = await lookupVurForAddresses([]);
    expect(result.size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('mapper ES-hits tilbage til input-adresser (case-insensitive prefix-match)', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        hits: {
          hits: [
            {
              _source: {
                address: 'Arnold Nielsens Boulevard 62A, 2650 Hvidovre',
                bfeNumbers: '2091165',
              },
            },
          ],
        },
      }),
    })) as unknown as typeof fetch;

    const result = await lookupVurForAddresses([
      'Arnold Nielsens Boulevard 62A',
      'Arnold Nielsens Boulevard 62D', // ingen VUR-hit
    ]);
    expect(result.get('arnold nielsens boulevard 62a')).toBe(true);
    expect(result.get('arnold nielsens boulevard 62d')).toBeUndefined();
  });

  it('dedupliker input-adresser', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ hits: { hits: [] } }),
    })) as unknown as typeof fetch;
    global.fetch = fetchMock;

    await lookupVurForAddresses(['Test 1', 'Test 1', 'Test 2']);
    // ES-query bør kun have 2 unique should-terms, men vi verificerer kun
    // at fetch kaldes én gang (batch).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ES-fejl returnerer tom map (silent fallback)', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const result = await lookupVurForAddresses(['Test 1']);
    expect(result.size).toBe(0);
  });

  it('netværks-timeout returnerer tom map', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('Timeout');
    }) as typeof fetch;
    const result = await lookupVurForAddresses(['Test 1']);
    expect(result.size).toBe(0);
  });
});
