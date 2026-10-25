/**
 * Unit tests for IndexNow-indsendelse (submitToIndexNow).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const makeRes = (status: number): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(''),
  }) as unknown as Response;

describe('submitToIndexNow', () => {
  const origKey = process.env.INDEXNOW_KEY;

  beforeEach(() => {
    process.env.INDEXNOW_KEY = 'test-key-123';
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (origKey === undefined) delete process.env.INDEXNOW_KEY;
    else process.env.INDEXNOW_KEY = origKey;
  });

  it('springer over og returnerer ok=false uden nøgle', async () => {
    delete process.env.INDEXNOW_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { submitToIndexNow } = await import('@/app/lib/indexnow');
    const r = await submitToIndexNow(
      ['https://bizzassist.dk/virksomhed/a/1'],
      'https://bizzassist.dk'
    );
    expect(r.ok).toBe(false);
    expect(r.submitted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tom URL-liste → ok=true, ingen kald', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { submitToIndexNow } = await import('@/app/lib/indexnow');
    const r = await submitToIndexNow([], 'https://bizzassist.dk');
    expect(r.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sender korrekt payload og accepterer 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeRes(200));
    vi.stubGlobal('fetch', fetchMock);
    const { submitToIndexNow } = await import('@/app/lib/indexnow');
    const r = await submitToIndexNow(
      ['https://bizzassist.dk/virksomhed/a/1', 'https://bizzassist.dk/ejendom/b/2'],
      'https://bizzassist.dk/'
    );
    expect(r.ok).toBe(true);
    expect(r.submitted).toBe(2);
    expect(r.batches).toBe(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.host).toBe('bizzassist.dk');
    expect(body.key).toBe('test-key-123');
    expect(body.keyLocation).toBe('https://bizzassist.dk/api/indexnow/key');
    expect(body.urlList).toHaveLength(2);
  });

  it('accepterer 202 (validering pending)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeRes(202)));
    const { submitToIndexNow } = await import('@/app/lib/indexnow');
    const r = await submitToIndexNow(
      ['https://bizzassist.dk/virksomhed/a/1'],
      'https://bizzassist.dk'
    );
    expect(r.ok).toBe(true);
  });

  it('markerer ok=false ved fejl-status (fx 403)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeRes(403)));
    const { submitToIndexNow } = await import('@/app/lib/indexnow');
    const r = await submitToIndexNow(
      ['https://bizzassist.dk/virksomhed/a/1'],
      'https://bizzassist.dk'
    );
    expect(r.ok).toBe(false);
    expect(r.statuses).toEqual([403]);
  });

  it('chunker >10.000 URLs i flere batches', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeRes(200));
    vi.stubGlobal('fetch', fetchMock);
    const { submitToIndexNow } = await import('@/app/lib/indexnow');
    const urls = Array.from(
      { length: 10_001 },
      (_, i) => `https://bizzassist.dk/virksomhed/x/${i}`
    );
    const r = await submitToIndexNow(urls, 'https://bizzassist.dk');
    expect(r.batches).toBe(2);
    expect(r.submitted).toBe(10_001);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
