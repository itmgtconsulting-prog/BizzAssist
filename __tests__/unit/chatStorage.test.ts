/**
 * Unit-tests for chatStorage — AI-chat conversation persistence.
 *
 * Dækker generateId, deriveTitle, og load/save-flow mod mocket localStorage.
 *
 * BIZZ-599: Lib-tests for kritiske untested-filer.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  generateId,
  deriveTitle,
  loadConversations,
  saveConversations,
  STORAGE_KEY,
} from '@/app/lib/chatStorage';

function setupLocalStorageMock(): Record<string, string> {
  const store: Record<string, string> = {};
  const mockStorage: Storage = {
    get length() {
      return Object.keys(store).length;
    },
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      Object.keys(store).forEach((k) => delete store[k]);
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
  // vitest jsdom miljø understøtter global window — override
  (globalThis as unknown as { window: Window }).window = {
    localStorage: mockStorage,
  } as Window;
  (globalThis as unknown as { localStorage: Storage }).localStorage = mockStorage;
  return store;
}

describe('generateId', () => {
  it('returnerer unik streng', () => {
    const a = generateId();
    const b = generateId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^\d+-[a-z0-9]+$/);
  });

  it('starter med timestamp-prefix', () => {
    const before = Date.now();
    const id = generateId();
    const parts = id.split('-');
    const ts = parseInt(parts[0], 10);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThan(Date.now() + 1000);
  });
});

describe('deriveTitle', () => {
  it('returnerer short message uændret', () => {
    expect(deriveTitle('Hej')).toBe('Hej');
  });

  it('trimmer whitespace', () => {
    expect(deriveTitle('   hello   ')).toBe('hello');
  });

  it('fjerner newlines og erstatter med mellemrum', () => {
    expect(deriveTitle('line 1\nline 2\nline 3')).toBe('line 1 line 2 line 3');
  });

  it('trunkerer beskeder over 40 tegn med ellipsis', () => {
    const long = 'a'.repeat(50);
    const result = deriveTitle(long);
    expect(result).toHaveLength(41); // 40 + 1 ellipsis
    expect(result.endsWith('\u2026')).toBe(true);
  });

  it('beholder præcis 40 tegn uden ellipsis', () => {
    const exact = 'b'.repeat(40);
    expect(deriveTitle(exact)).toBe(exact);
  });
});

describe('loadConversations / saveConversations', () => {
  beforeEach(() => {
    setupLocalStorageMock();
  });

  it('returnerer tom array når localStorage er tom', () => {
    expect(loadConversations()).toEqual([]);
  });

  it('roundtrip: save → load returnerer samme data', () => {
    const convos = [
      {
        id: '123',
        title: 'Test',
        messages: [{ role: 'user' as const, content: 'hi' }],
        createdAt: '2026-04-20T10:00:00Z',
      },
    ];
    saveConversations(convos);
    expect(loadConversations()).toEqual(convos);
  });

  it('returnerer tom array ved korrupt JSON', () => {
    (globalThis as unknown as { localStorage: Storage }).localStorage.setItem(
      STORAGE_KEY,
      '{not valid json'
    );
    expect(loadConversations()).toEqual([]);
  });

  it('saveConversations er no-op under SSR (window === undefined)', () => {
    // Midlertidig fjern window — simulér SSR-path
    const g = globalThis as unknown as { window: Window | undefined };
    const originalWindow = g.window;
    g.window = undefined;
    expect(() =>
      saveConversations([{ id: 'x', title: 't', messages: [], createdAt: 'now' }])
    ).not.toThrow();
    g.window = originalWindow;
  });

  it('bruger den rigtige STORAGE_KEY', () => {
    expect(STORAGE_KEY).toBe('ba-chat-history');
  });

  it('håndterer quota-exceeded gracefully uden at kaste', () => {
    const throwingStorage: Storage = {
      length: 0,
      getItem: () => null,
      setItem: () => {
        throw new DOMException('QuotaExceededError');
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
    };
    (globalThis as unknown as { window: Window }).window = {
      localStorage: throwingStorage,
    } as Window;
    (globalThis as unknown as { localStorage: Storage }).localStorage = throwingStorage;
    expect(() =>
      saveConversations([{ id: '1', title: 'X', messages: [], createdAt: '2026-01-01' }])
    ).not.toThrow();
  });
});

describe('vi.clearAllMocks integration', () => {
  it('tester er isoleret (ingen cross-test state)', () => {
    setupLocalStorageMock();
    const before = loadConversations();
    expect(before).toEqual([]);
    vi.clearAllMocks(); // ikke nødvendig her, men bekræfter at vitest-runner er i orden
  });
});
