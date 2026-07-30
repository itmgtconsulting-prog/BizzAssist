/**
 * Component tests for LinkedInPosts (BIZZ-2184).
 *
 * Verifies that:
 * - isValidLinkedInEmbed only accepts https://www.linkedin.com/embed/ URLs
 * - Section is hidden when the API returns no posts
 * - A post with a valid embed_url renders an iframe ONLY after cookie consent
 * - Without consent, a post falls back to the first-party card (no iframe loaded)
 * - With consent but an INVALID embed_url, it still falls back to the card
 *   (security: no arbitrary iframe source is rendered)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import LinkedInPosts, { isValidLinkedInEmbed } from '@/app/components/LinkedInPosts';
import { LanguageProvider } from '@/app/context/LanguageContext';
import { CONSENT_COOKIE_NAME } from '@/app/lib/cookieConsent';

/** Clear document.cookie by expiring every cookie */
function clearCookies(): void {
  document.cookie.split(';').forEach((c) => {
    const name = c.trim().split('=')[0];
    if (name) document.cookie = `${name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  });
}

const POST = {
  id: '1',
  post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:123',
  image_url: 'https://example.com/shot.png',
  embed_url: 'https://www.linkedin.com/embed/feed/update/urn:li:share:123',
  excerpt_da: 'Et dansk uddrag',
  excerpt_en: 'An english excerpt',
  published_at: '2026-06-01',
};

/** Mock the public API to return the given posts */
function mockFetch(posts: unknown[]) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ posts }),
  }) as unknown as typeof fetch;
}

/** Render the component inside LanguageProvider and let effects settle */
async function renderPosts() {
  await act(async () => {
    render(
      <LanguageProvider>
        <LinkedInPosts />
      </LanguageProvider>
    );
  });
}

describe('isValidLinkedInEmbed', () => {
  it('accepts a valid LinkedIn embed URL', () => {
    expect(isValidLinkedInEmbed('https://www.linkedin.com/embed/feed/update/urn:li:share:1')).toBe(
      true
    );
  });

  it('rejects null and non-LinkedIn / non-embed URLs', () => {
    expect(isValidLinkedInEmbed(null)).toBe(false);
    expect(isValidLinkedInEmbed('https://evil.example.com/embed/x')).toBe(false);
    expect(isValidLinkedInEmbed('https://www.linkedin.com/feed/update/x')).toBe(false);
    expect(isValidLinkedInEmbed('http://www.linkedin.com/embed/x')).toBe(false);
  });
});

describe('LinkedInPosts', () => {
  beforeEach(() => {
    clearCookies();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when there are no posts', async () => {
    mockFetch([]);
    const { container } = render(
      <LanguageProvider>
        <LinkedInPosts />
      </LanguageProvider>
    );
    await act(async () => {});
    expect(container.querySelector('section')).toBeNull();
  });

  it('renders an iframe for a valid embed_url AFTER consent is accepted', async () => {
    document.cookie = `${CONSENT_COOKIE_NAME}=accepted; Path=/`;
    mockFetch([POST]);
    await renderPosts();
    const iframe = document.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('src')).toBe(POST.embed_url);
    // No fallback card link when embedding
    expect(screen.queryByRole('link', { name: /læs på linkedin/i })).not.toBeInTheDocument();
  });

  it('falls back to the card (no iframe) when consent is declined', async () => {
    document.cookie = `${CONSENT_COOKIE_NAME}=declined; Path=/`;
    mockFetch([POST]);
    await renderPosts();
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByText('Et dansk uddrag')).toBeInTheDocument();
  });

  it('falls back to the card when embed_url is invalid even WITH consent', async () => {
    document.cookie = `${CONSENT_COOKIE_NAME}=accepted; Path=/`;
    mockFetch([{ ...POST, embed_url: 'https://evil.example.com/embed/x' }]);
    await renderPosts();
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByText('Et dansk uddrag')).toBeInTheDocument();
  });
});
