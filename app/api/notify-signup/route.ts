/**
 * Signup notification API — POST /api/notify-signup
 *
 * Sends an email to support@pecuniait.com when a new user signs up.
 * Includes: user name, email, requested plan, status, and environment.
 *
 * Called from the signup server action after user creation.
 * Uses Resend API for email delivery.
 *
 * @module api/notify-signup
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { logger } from '@/app/lib/logger';
import { parseBody } from '@/app/lib/validate';

/** Zod schema for POST /api/notify-signup request body */
const notifySignupSchema = z
  .object({
    email: z.string().min(1),
    fullName: z.string().optional(),
    planId: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

const NOTIFY_EMAIL = process.env.SUPPORT_NOTIFICATION_EMAIL || 'support@pecuniait.com';
const RESEND_API_KEY = process.env.RESEND_API_KEY;

/**
 * Determine the current environment name from the app URL.
 *
 * @returns Environment string, e.g. 'test.bizzassist.dk', 'localhost:3000', 'bizzassist.dk'
 */
function getEnvironment(): string {
  const url = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL || '';
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    return parsed.host; // e.g. 'test.bizzassist.dk' or 'localhost:3000'
  } catch {
    return url || 'unknown';
  }
}

/**
 * POST /api/notify-signup — send signup notification email.
 *
 * Body: { fullName, email, planId, status }
 *
 * Sends a structured email to the support address with all details
 * about the new user registration.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    if (!RESEND_API_KEY) {
      logger.warn('[notify-signup] RESEND_API_KEY not configured, skipping notification');
      return NextResponse.json({ ok: true, skipped: true });
    }

    const parsed = await parseBody(req, notifySignupSchema);
    if (!parsed.success) return parsed.response;
    const { email, planId, status } = parsed.data;

    const environment = getEnvironment();
    const statusLabel =
      status === 'pending'
        ? 'Afventer godkendelse'
        : status === 'active'
          ? 'Aktiv'
          : (status ?? 'Ukendt');
    const planLabel =
      planId === 'demo'
        ? 'Demo'
        : planId === 'basis'
          ? 'Basis'
          : planId === 'professionel'
            ? 'Professionel'
            : planId === 'enterprise'
              ? 'Enterprise'
              : (planId ?? 'Ikke valgt');

    // BIZZ-220: Subject must not contain raw PII (email/name) — email subjects
    // are often cached and indexed by mail clients and providers unencrypted.
    // Full details remain in the email body which is encrypted in transit.
    const subject = `[BizzAssist] Ny tilmelding — ${planLabel} · ${environment}`;

    // Mask email for body: show first char + *** + @domain (e.g. j***@gmail.com).
    // Full email stays available to admins via the admin panel.
    const maskedEmail = (() => {
      const at = email.indexOf('@');
      if (at <= 0) return '***';
      return `${email[0]}***${email.slice(at)}`;
    })();

    const htmlBody = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #0f172a; padding: 24px 32px; border-radius: 12px 12px 0 0;">
          <h1 style="color: #ffffff; font-size: 20px; margin: 0;">
            <span style="color: #60a5fa;">Bizz</span>Assist — Ny brugerregistrering
          </h1>
        </div>
        <div style="background: #1e293b; padding: 24px 32px; border-radius: 0 0 12px 12px; border: 1px solid #334155; border-top: none;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #94a3b8; font-size: 14px;">E-mail:</td>
              <td style="padding: 8px 0; color: #ffffff; font-size: 14px; font-weight: 600;">${maskedEmail}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #94a3b8; font-size: 14px;">Ansøgt plan:</td>
              <td style="padding: 8px 0; color: #60a5fa; font-size: 14px; font-weight: 600;">${planLabel}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #94a3b8; font-size: 14px;">Status:</td>
              <td style="padding: 8px 0; font-size: 14px; font-weight: 600;">
                <span style="color: ${status === 'pending' ? '#fbbf24' : '#34d399'};">${statusLabel}</span>
              </td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #94a3b8; font-size: 14px;">Miljø:</td>
              <td style="padding: 8px 0; color: #c084fc; font-size: 14px; font-weight: 600;">${environment}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #94a3b8; font-size: 14px;">Tidspunkt:</td>
              <td style="padding: 8px 0; color: #94a3b8; font-size: 14px;">${new Date().toLocaleString('da-DK', { timeZone: 'Europe/Copenhagen' })}</td>
            </tr>
          </table>
          ${
            status === 'pending'
              ? `
          <div style="margin-top: 20px; padding: 12px 16px; background: #fbbf2410; border: 1px solid #fbbf2430; border-radius: 8px;">
            <p style="color: #fbbf24; font-size: 13px; margin: 0;">
              ⏳ Denne bruger afventer admin-godkendelse. Log ind på admin-panelet for at godkende eller afvise.
            </p>
          </div>
          `
              : ''
          }
        </div>
        <p style="color: #475569; font-size: 11px; text-align: center; margin-top: 16px;">
          Denne notifikation er sendt automatisk fra BizzAssist (${environment})
        </p>
      </div>
    `;

    // Send email via Resend API
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'BizzAssist <noreply@bizzassist.dk>',
        to: [NOTIFY_EMAIL],
        subject,
        html: htmlBody,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const errBody = await res.text();
      logger.error('[notify-signup] Resend error:', res.status, errBody);
      // Don't fail the signup — notification is best-effort
      return NextResponse.json({ ok: true, emailSent: false, reason: errBody });
    }

    const data = await res.json();
    logger.log('[notify-signup] Email sent:', data.id);
    return NextResponse.json({ ok: true, emailSent: true, id: data.id });
  } catch (err) {
    logger.error('[notify-signup] Unexpected error:', err);
    // Don't fail the signup — notification is best-effort
    return NextResponse.json({ ok: true, emailSent: false });
  }
}
