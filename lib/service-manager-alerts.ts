import { companyInfo } from '@/app/lib/companyInfo';
import { RESEND_ENDPOINT } from '@/app/lib/serviceEndpoints';

/**
 * Service Manager — Critical Alert Helpers
 *
 * Utility functions for classifying issues as critical and sending
 * immediate, dedicated alert emails for high-severity scan findings.
 *
 * Used by the hourly cron scan (/api/cron/service-scan) to fire
 * targeted alerts before the general summary email.
 *
 * @module lib/service-manager-alerts
 */

import { sendCriticalSms } from '@/lib/sms';
import { logger } from '@/app/lib/logger';

const FROM_ADDRESS = `BizzAssist <${companyInfo.noreplyEmail}>`;
const TO_ADDRESS = companyInfo.supportEmail;

// ─── Critical issue classification ───────────────────────────────────────────

/**
 * Keywords in an issue message that indicate a critical (immediately
 * actionable) failure rather than a routine warning.
 */
const CRITICAL_KEYWORDS = [
  'cannot read properties',
  'typeerror',
  'referenceerror',
  'syntaxerror',
  'module not found',
  'build failed',
  'build error',
  'deployment failed',
  'database error',
  'supabase',
  'unhandled',
  'uncaught',
  '500',
  'internal server error',
  'econnrefused',
  'enotfound',
  'timeout',
  'out of memory',
];

/**
 * Issue types that are always considered critical regardless of message content.
 */
const ALWAYS_CRITICAL_TYPES = ['build_error'];

/**
 * Determine whether a scan issue warrants an immediate critical alert
 * (sent before the general summary email).
 *
 * @param type - The issue type string (e.g. 'build_error', 'runtime_error').
 * @param message - The human-readable error message.
 * @param context - Optional context string attached to the issue.
 * @returns true if the issue should trigger a critical alert.
 */
export function isCriticalIssue(type: string, message: string, context?: string): boolean {
  if (ALWAYS_CRITICAL_TYPES.includes(type)) return true;

  const haystack = `${message} ${context ?? ''}`.toLowerCase();
  return CRITICAL_KEYWORDS.some((kw) => haystack.includes(kw));
}

// ─── Critical alert email ─────────────────────────────────────────────────────

/**
 * Parameters for a critical alert email.
 */
export interface CriticalAlertParams {
  /** Human-readable description of the issue. */
  description: string;
  /** The path/function/entrypoint where the error occurred, if known. */
  affectedPath?: string;
  /** UUID of the scan record that detected this issue. */
  scanId: string;
  /** Issue type identifier. */
  issueType: string;
  /** Optional raw context string from the scan. */
  context?: string;
  /** Timestamp when the issue was detected. */
  detectedAt: Date;
}

/**
 * Build the HTML body for a critical alert email.
 *
 * @param params - Alert parameters.
 * @returns HTML string ready to send via Resend.
 */
function buildCriticalAlertHtml(params: CriticalAlertParams): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bizzassist.dk';
  const adminUrl = `${appUrl}/dashboard/admin/service-manager`;

  const datetimeStr = params.detectedAt.toLocaleString('da-DK', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Copenhagen',
  });

  const typeLabel =
    params.issueType === 'build_error'
      ? 'Build-fejl'
      : params.issueType === 'runtime_error'
        ? 'Runtime-fejl'
        : params.issueType === 'config_error'
          ? 'Konfigurationsfejl'
          : 'Type-fejl';

  return `
<!DOCTYPE html>
<html lang="da">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 20px; background: #060d1a;">
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; background: #0f172a; color: #e2e8f0; padding: 36px; border-radius: 12px; border: 1px solid #1e293b;">

  <!-- Header -->
  <div style="margin-bottom: 28px; padding-bottom: 20px; border-bottom: 1px solid #1e293b;">
    <h1 style="color: #ffffff; font-size: 20px; margin: 0 0 4px 0; font-weight: 700;">BizzAssist</h1>
    <p style="color: #64748b; font-size: 12px; margin: 0 0 16px 0;">Service Manager — Kritisk Alert</p>
    <div style="display: flex; align-items: center; gap: 10px;">
      <div style="width: 10px; height: 10px; border-radius: 50%; background: #ef4444; flex-shrink: 0;"></div>
      <h2 style="color: #ef4444; font-size: 18px; margin: 0; font-weight: 600;">Kritisk fejl registreret</h2>
    </div>
    <p style="color: #94a3b8; font-size: 13px; margin: 8px 0 0 0;">${datetimeStr}</p>
  </div>

  <!-- Issue details -->
  <div style="margin-bottom: 24px; background: #1e293b; border-radius: 8px; padding: 16px;">
    <div style="margin-bottom: 12px;">
      <span style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; background: #ef444422; color: #ef4444; text-transform: uppercase; letter-spacing: 0.05em;">${typeLabel}</span>
    </div>
    <p style="color: #e2e8f0; font-size: 14px; margin: 0 0 10px 0; line-height: 1.6;">${params.description}</p>
    ${params.affectedPath ? `<p style="color: #94a3b8; font-size: 12px; margin: 0 0 6px 0;">Funktion/sti: <code style="background: #0f172a; padding: 2px 6px; border-radius: 3px;">${params.affectedPath}</code></p>` : ''}
    ${params.context ? `<p style="color: #64748b; font-size: 11px; margin: 0;">${params.context}</p>` : ''}
  </div>

  <!-- Scan reference -->
  <div style="margin-bottom: 28px;">
    <p style="color: #64748b; font-size: 11px; margin: 0;">Scan-ID: ${params.scanId}</p>
  </div>

  <!-- CTA -->
  <div style="text-align: center; margin-bottom: 28px;">
    <a href="${adminUrl}" style="display: inline-block; background: #2563eb; color: #ffffff; text-decoration: none; font-weight: 600; font-size: 14px; padding: 12px 28px; border-radius: 8px;">
      Åbn Admin Panel
    </a>
  </div>

  <!-- Footer -->
  <hr style="border: none; border-top: 1px solid #1e293b; margin: 0 0 16px 0;" />
  <p style="color: #475569; font-size: 11px; margin: 0; line-height: 1.6;">
    ${companyInfo.legalLineHtml}<br/>
    Automatisk kritisk alert fra Service Manager Agent &mdash; m&aring; ikke videresendes
  </p>

</div>
</body>
</html>`;
}

/**
 * Send a dedicated critical alert email via Resend for a single high-severity issue.
 * Silently skips if RESEND_API_KEY is not configured (dev environment).
 *
 * @param params - Critical alert parameters.
 */
export async function sendCriticalAlert(params: CriticalAlertParams): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.log('[service-manager-alerts] RESEND_API_KEY ikke sat — kritisk alert springes over');
    return;
  }

  const subject = `[KRITISK] BizzAssist — ${params.issueType === 'build_error' ? 'Build fejlede' : 'Kritisk runtime-fejl'}`;
  const html = buildCriticalAlertHtml(params);

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: TO_ADDRESS,
        subject,
        html,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error('[service-manager-alerts] Resend API fejl:', res.status, body);
    } else {
      logger.log('[service-manager-alerts] Kritisk alert sendt til', TO_ADDRESS);
    }
  } catch (err) {
    logger.error('[service-manager-alerts] Kunne ikke sende kritisk alert:', err);
  }

  // Also send SMS — secondary alert channel
  const typeShort =
    params.issueType === 'build_error'
      ? 'build-fejl'
      : params.issueType === 'runtime_error'
        ? 'runtime-fejl'
        : params.issueType === 'config_error'
          ? 'konfigurationsfejl'
          : 'type-fejl';
  const smsMsg = `\uD83D\uDEA8 BizzAssist: ${typeShort} \u2014 ${params.description.slice(0, 80)}. Check admin panel.`;
  await sendCriticalSms(smsMsg);
}
