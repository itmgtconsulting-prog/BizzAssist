/**
 * Unit tests for app/lib/email.ts — transactional email via Resend API.
 *
 * Covers:
 *   - sendPaymentConfirmationEmail: skips when RESEND_API_KEY absent
 *   - sendPaymentConfirmationEmail: POSTs to Resend with correct headers + body
 *   - sendPaymentConfirmationEmail: handles non-ok Resend response gracefully
 *   - sendPaymentConfirmationEmail: handles network error gracefully
 *   - sendApprovalEmail: skips when RESEND_API_KEY absent
 *   - sendApprovalEmail: POSTs to Resend with correct subject
 *   - sendRecurringPaymentEmail: skips when RESEND_API_KEY absent
 *   - sendRecurringPaymentEmail: POSTs with correct plan/price details
 *
 * Global fetch is replaced with a vi.fn() mock — no real HTTP calls are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  sendPaymentConfirmationEmail,
  sendApprovalEmail,
  sendRecurringPaymentEmail,
} from '@/app/lib/email';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal mock Response-like object. */
function makeFetchResponse(ok: boolean, text = '') {
  return {
    ok,
    status: ok ? 200 : 422,
    text: vi.fn().mockResolvedValue(text),
    json: vi.fn().mockResolvedValue({}),
  } as unknown as Response;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  // Default: Resend returns 200 OK
  global.fetch = vi.fn().mockResolvedValue(makeFetchResponse(true));
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.EMAIL_FROM_ADDRESS = 'BizzAssist <noreply@bizzassist.dk>';
});

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.RESEND_API_KEY;
});

// ─── sendPaymentConfirmationEmail ─────────────────────────────────────────────

describe('sendPaymentConfirmationEmail', () => {
  const params = {
    to: 'customer@example.com',
    planName: 'Professionel / Professional',
    priceDkk: 799,
    periodEnd: new Date('2026-05-01T12:00:00Z'),
    cancelUrl: 'https://bizzassist.dk/dashboard/settings?tab=abonnement',
  };

  it('does not call fetch when RESEND_API_KEY is absent', async () => {
    delete process.env.RESEND_API_KEY;

    await sendPaymentConfirmationEmail(params);

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('POSTs to the Resend API endpoint', async () => {
    await sendPaymentConfirmationEmail(params);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
  });

  it('includes Authorization header with Bearer token', async () => {
    await sendPaymentConfirmationEmail(params);

    const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect((options.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer test-resend-key'
    );
  });

  it('sends correct recipient, subject, and plan info in the body', async () => {
    await sendPaymentConfirmationEmail(params);

    const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(options.body as string) as {
      to: string;
      subject: string;
      html: string;
      from: string;
    };

    expect(body.to).toBe('customer@example.com');
    expect(body.subject).toContain('BizzAssist');
    // Plan name should appear in the HTML
    expect(body.html).toContain('Professionel / Professional');
    // Price should appear in the HTML
    expect(body.html).toContain('799');
  });

  it('handles a non-ok Resend response without throwing', async () => {
    global.fetch = vi.fn().mockResolvedValue(makeFetchResponse(false, 'Bad request'));

    await expect(sendPaymentConfirmationEmail(params)).resolves.not.toThrow();
  });

  it('handles a network error without throwing', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    await expect(sendPaymentConfirmationEmail(params)).resolves.not.toThrow();
  });
});

// ─── sendApprovalEmail ────────────────────────────────────────────────────────

describe('sendApprovalEmail', () => {
  const params = {
    to: 'newuser@example.com',
    fullName: 'Jakob Rasmussen',
    planName: 'Demo',
    loginUrl: 'https://bizzassist.dk/login',
  };

  it('does not call fetch when RESEND_API_KEY is absent', async () => {
    delete process.env.RESEND_API_KEY;

    await sendApprovalEmail(params);

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('POSTs to the Resend API endpoint', async () => {
    await sendApprovalEmail(params);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
  });

  it('sends the correct recipient and approval subject', async () => {
    await sendApprovalEmail(params);

    const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(options.body as string) as {
      to: string;
      subject: string;
      html: string;
    };

    expect(body.to).toBe('newuser@example.com');
    expect(body.subject).toContain('godkendt');
    // User's name should appear in the greeting
    expect(body.html).toContain('Jakob Rasmussen');
    // Plan name should appear
    expect(body.html).toContain('Demo');
  });

  it('uses a default greeting when fullName is omitted', async () => {
    await sendApprovalEmail({ to: 'x@y.com', planName: 'Basis' });

    const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(options.body as string) as { html: string };
    expect(body.html).toContain('Hej,');
  });

  it('handles a non-ok Resend response without throwing', async () => {
    global.fetch = vi.fn().mockResolvedValue(makeFetchResponse(false, 'Unprocessable'));

    await expect(sendApprovalEmail(params)).resolves.not.toThrow();
  });

  it('handles a network error without throwing', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    await expect(sendApprovalEmail(params)).resolves.not.toThrow();
  });
});

// ─── sendRecurringPaymentEmail ────────────────────────────────────────────────

describe('sendRecurringPaymentEmail', () => {
  const params = {
    to: 'renew@example.com',
    planName: 'Professionel',
    priceDkk: 799,
    periodEnd: new Date('2026-06-01T00:00:00Z'),
    cancelUrl: 'https://bizzassist.dk/dashboard/settings',
  };

  it('does not call fetch when RESEND_API_KEY is absent', async () => {
    delete process.env.RESEND_API_KEY;

    await sendRecurringPaymentEmail(params);

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('POSTs to the Resend API endpoint', async () => {
    await sendRecurringPaymentEmail(params);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
  });

  it('sends correct plan name and price in body', async () => {
    await sendRecurringPaymentEmail(params);

    const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(options.body as string) as {
      to: string;
      subject: string;
      html: string;
    };

    expect(body.to).toBe('renew@example.com');
    expect(body.subject).toContain('fornyet');
    expect(body.html).toContain('Professionel');
    expect(body.html).toContain('799');
  });

  it('handles a network error without throwing', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('timeout'));

    await expect(sendRecurringPaymentEmail(params)).resolves.not.toThrow();
  });
});
