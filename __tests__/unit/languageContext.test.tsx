/**
 * Unit tests for LanguageContext.
 *
 * Tests:
 * - LanguageProvider renders its children
 * - useLanguage returns 'da' by default (no localStorage value)
 * - useLanguage reads initial language from localStorage
 * - setLang changes the active language
 * - setLang persists the choice to localStorage
 * - Invalid localStorage value falls back to 'da'
 * - useLanguage outside provider returns context default ('da')
 * - Server-side language preference (from /api/preferences) updates state
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import React from 'react';
import { LanguageProvider, useLanguage } from '@/app/context/LanguageContext';

// ── Mock fetch so /api/preferences never hits the network ─────────────────────
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Default: API returns 401 / non-ok so the provider keeps localStorage value
function mockPreferencesNotAuthenticated() {
  mockFetch.mockResolvedValue({ ok: false, json: () => Promise.resolve(null) });
}

function mockPreferencesReturns(lang: string) {
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ language: lang }),
  });
}

// ── Small consumer component ───────────────────────────────────────────────────
function LangDisplay() {
  const { lang } = useLanguage();
  return <div data-testid="lang">{lang}</div>;
}

function LangToggle() {
  const { lang, setLang } = useLanguage();
  return (
    <div>
      <span data-testid="lang">{lang}</span>
      <button onClick={() => setLang(lang === 'da' ? 'en' : 'da')}>toggle</button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

describe('LanguageProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockPreferencesNotAuthenticated();
  });

  it('renders its children', () => {
    render(
      <LanguageProvider>
        <span data-testid="child">hello</span>
      </LanguageProvider>
    );
    expect(screen.getByTestId('child')).toBeDefined();
  });

  it('renders multiple children', () => {
    render(
      <LanguageProvider>
        <span data-testid="a">A</span>
        <span data-testid="b">B</span>
      </LanguageProvider>
    );
    expect(screen.getByTestId('a')).toBeDefined();
    expect(screen.getByTestId('b')).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('useLanguage — default language', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockPreferencesNotAuthenticated();
  });

  it('returns "da" when localStorage is empty', () => {
    render(
      <LanguageProvider>
        <LangDisplay />
      </LanguageProvider>
    );
    expect(screen.getByTestId('lang').textContent).toBe('da');
  });

  it('reads "en" from localStorage on first render', () => {
    localStorage.setItem('ba-lang', 'en');
    render(
      <LanguageProvider>
        <LangDisplay />
      </LanguageProvider>
    );
    expect(screen.getByTestId('lang').textContent).toBe('en');
  });

  it('reads "da" from localStorage on first render', () => {
    localStorage.setItem('ba-lang', 'da');
    render(
      <LanguageProvider>
        <LangDisplay />
      </LanguageProvider>
    );
    expect(screen.getByTestId('lang').textContent).toBe('da');
  });

  it('falls back to "da" for an invalid localStorage value', () => {
    localStorage.setItem('ba-lang', 'fr'); // not a valid Language
    render(
      <LanguageProvider>
        <LangDisplay />
      </LanguageProvider>
    );
    expect(screen.getByTestId('lang').textContent).toBe('da');
  });

  it('falls back to "da" for an empty localStorage value', () => {
    localStorage.setItem('ba-lang', '');
    render(
      <LanguageProvider>
        <LangDisplay />
      </LanguageProvider>
    );
    expect(screen.getByTestId('lang').textContent).toBe('da');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('useLanguage — language toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockPreferencesNotAuthenticated();
  });

  it('toggles from da to en when button is clicked', async () => {
    render(
      <LanguageProvider>
        <LangToggle />
      </LanguageProvider>
    );

    expect(screen.getByTestId('lang').textContent).toBe('da');

    await act(async () => {
      screen.getByRole('button').click();
    });

    expect(screen.getByTestId('lang').textContent).toBe('en');
  });

  it('toggles back from en to da', async () => {
    localStorage.setItem('ba-lang', 'en');
    render(
      <LanguageProvider>
        <LangToggle />
      </LanguageProvider>
    );

    expect(screen.getByTestId('lang').textContent).toBe('en');

    await act(async () => {
      screen.getByRole('button').click();
    });

    expect(screen.getByTestId('lang').textContent).toBe('da');
  });

  it('toggles da→en→da across two clicks', async () => {
    render(
      <LanguageProvider>
        <LangToggle />
      </LanguageProvider>
    );

    await act(async () => {
      screen.getByRole('button').click();
    });
    expect(screen.getByTestId('lang').textContent).toBe('en');

    await act(async () => {
      screen.getByRole('button').click();
    });
    expect(screen.getByTestId('lang').textContent).toBe('da');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('useLanguage — localStorage persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockPreferencesNotAuthenticated();
  });

  it('writes the new language to localStorage after toggle', async () => {
    render(
      <LanguageProvider>
        <LangToggle />
      </LanguageProvider>
    );

    await act(async () => {
      screen.getByRole('button').click();
    });

    expect(localStorage.getItem('ba-lang')).toBe('en');
  });

  it('writes "da" to localStorage when toggling back', async () => {
    localStorage.setItem('ba-lang', 'en');
    render(
      <LanguageProvider>
        <LangToggle />
      </LanguageProvider>
    );

    await act(async () => {
      screen.getByRole('button').click();
    });

    expect(localStorage.getItem('ba-lang')).toBe('da');
  });

  it('fires a PUT to /api/preferences with the new language on toggle', async () => {
    // Reset to only match the PUT call
    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === 'PUT') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
      // GET for preferences
      return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
    });

    render(
      <LanguageProvider>
        <LangToggle />
      </LanguageProvider>
    );

    await act(async () => {
      screen.getByRole('button').click();
    });

    const putCall = mockFetch.mock.calls.find(
      ([, opts]) => (opts as RequestInit)?.method === 'PUT'
    );
    expect(putCall).toBeDefined();
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body.language).toBe('en');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('useLanguage — server preference sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('updates language to "en" when server returns "en" and local is "da"', async () => {
    // localStorage has 'da', server says 'en'
    localStorage.setItem('ba-lang', 'da');
    mockPreferencesReturns('en');

    render(
      <LanguageProvider>
        <LangDisplay />
      </LanguageProvider>
    );

    // Initially 'da' from localStorage
    expect(screen.getByTestId('lang').textContent).toBe('da');

    // After async fetch resolves the state should update to 'en'
    await waitFor(() => {
      expect(screen.getByTestId('lang').textContent).toBe('en');
    });
  });

  it('updates localStorage to server value after successful sync', async () => {
    localStorage.setItem('ba-lang', 'da');
    mockPreferencesReturns('en');

    render(
      <LanguageProvider>
        <LangDisplay />
      </LanguageProvider>
    );

    await waitFor(() => {
      expect(localStorage.getItem('ba-lang')).toBe('en');
    });
  });

  it('keeps "da" when server returns the same language', async () => {
    localStorage.setItem('ba-lang', 'da');
    mockPreferencesReturns('da');

    render(
      <LanguageProvider>
        <LangDisplay />
      </LanguageProvider>
    );

    // Wait for the fetch to resolve
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId('lang').textContent).toBe('da');
  });

  it('ignores an invalid server language value', async () => {
    localStorage.setItem('ba-lang', 'da');
    mockPreferencesReturns('fr'); // invalid

    render(
      <LanguageProvider>
        <LangDisplay />
      </LanguageProvider>
    );

    await act(async () => {
      await Promise.resolve();
    });

    // Should remain 'da' — 'fr' is not a valid Language
    expect(screen.getByTestId('lang').textContent).toBe('da');
  });

  it('keeps localStorage value when server returns non-ok response', async () => {
    localStorage.setItem('ba-lang', 'en');
    mockPreferencesNotAuthenticated();

    render(
      <LanguageProvider>
        <LangDisplay />
      </LanguageProvider>
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId('lang').textContent).toBe('en');
  });

  it('keeps localStorage value when fetch throws', async () => {
    localStorage.setItem('ba-lang', 'en');
    mockFetch.mockRejectedValue(new Error('Network error'));

    render(
      <LanguageProvider>
        <LangDisplay />
      </LanguageProvider>
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId('lang').textContent).toBe('en');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('useLanguage — outside provider', () => {
  it('returns default context values ("da") when used outside provider', () => {
    function Bare() {
      const { lang } = useLanguage();
      return <span data-testid="bare">{lang}</span>;
    }
    render(<Bare />);
    expect(screen.getByTestId('bare').textContent).toBe('da');
  });
});
