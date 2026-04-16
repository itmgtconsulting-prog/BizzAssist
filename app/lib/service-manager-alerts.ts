import { logger } from '@/app/lib/logger';

/**
 * Service Manager Critical Alerts — app/lib/service-manager-alerts.ts
 *
 * Sends immediate email notifications for critical production errors detected
 * by the Service Manager hourly scan. Does NOT wait for the daily report —
 * fires as soon as a critical issue is identified.
 *
 * Critical = build failures or 500-level errors on key application routes.
 *
 * IMPORTANT: This module is SERVER-SIDE ONLY. Never import in Client Components.
 *
 * @module lib/service-manager-alerts
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** Resend API endpoint */
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const FROM_ADDRESS = 'BizzAssist <noreply@bizzassist.dk>';
const TO_ADDRESS = 'support@pecuniait.com';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Parameters for a critical alert email.
 */
export interface CriticalAlertParams {
  /** Short description of the error (used in email subject) */
  description: string;
  /**
   * The affected route or file path, e.g. "/api/vurdering" or
   * "app/api/cron/service-scan/route.ts". May be undefined if not known.
   */
  affectedPath?: string;
  /** The UUID of the scan that detected this issue (for traceability) */
  scanId: string;
  /**
   * Issue type — drives the badge colour in the email.
   * Mirrors the ScanIssue type field.
   */
  issueType: 'build_error' | 'runtime_error' | 'type_error' | 'config_error';
  /** Additional context lines to include in the email body (optional) */
  context?: string;
  /** Timestamp of detection — defaults to `new Date()` if omitted */
  detectedAt?: Date;
}

// ─── HTML builder ─────────────────────────────────────────────────────────────

/**
 * Build the HTML body for a critical-error alert email.
 * Matches the BizzAssist design system (navy background, red accent).
 *
 * @param params - Alert parameters.
 * @returns HTML string ready to send via Resend.
 */
function buildCriticalAlertHtml(params: CriticalAlertParams): string {
  const { description, affectedPath, scanId, issueType, context, detectedAt = new Date() } = params;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bizzassist.dk';
  const adminUrl = `${appUrl}/dashboard/admin/service-manager`;

  const datetimeStr = detectedAt.toLocaleString('da-DK', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Copenhagen',
  });

  const typeLabel: Record<CriticalAlertParams['issueType'], string> = {
    build_error: 'Build-fejl',
    runtime_error: 'Runtime-fejl',
    type_error: 'Type-fejl',
    config_error: 'Konfigurationsfejl',
  };

  const affectedRow = affectedPath
    ? `
        <tr>
          <td style="padding: 10px 14px; color: #94a3b8; font-size: 13px; white-space: nowrap; border-bottom: 1px solid #0f172a;">Berørt sti</td>
          <td style="padding: 10px 14px; font-size: 13px; border-bottom: 1px solid #0f172a; font-family: 'Courier New', monospace; color: #e2e8f0;">${affectedPath}</td>
        </tr>`
    : '';

  const contextRow = context
    ? `
        <tr>
          <td style="padding: 10px 14px; color: #94a3b8; font-size: 13px; white-space: nowrap;">Kontekst</td>
          <td style="padding: 10px 14px; font-size: 12px; color: #94a3b8;">${context}</td>
        </tr>`
    : '';

  return `
<!DOCTYPE html>
<html lang="da">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 20px; background: #060d1a;">
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; background: #0f172a; color: #e2e8f0; padding: 36px; border-radius: 12px; border: 2px solid #ef4444;">

  <!-- Header -->
  <div style="margin-bottom: 28px; padding-bottom: 20px; border-bottom: 1px solid #1e293b;">
    <h1 style="color: #ffffff; font-size: 20px; margin: 0 0 4px 0; font-weight: 700;">BizzAssist</h1>
    <p style="color: #64748b; font-size: 12px; margin: 0 0 20px 0;">Service Manager Agent</p>

    <!-- Critical badge -->
    <div style="display: inline-flex; align-items: center; gap: 10px; background: #ef444420; border: 1px solid #ef4444; border-radius: 8px; padding: 10px 16px;">
      <span style="font-size: 20px;">🚨</span>
      <div>
        <div style="color: #ef4444; font-size: 16px; font-weight: 700;">KRITISK FEJL</div>
        <div style="color: #94a3b8; font-size: 11px; margin-top: 2px;">${typeLabel[issueType]}</div>
      </div>
    </div>
  </div>

  <!-- Error description -->
  <div style="margin-bottom: 24px; background: #1e293b; border-left: 4px solid #ef4444; border-radius: 0 8px 8px 0; padding: 16px 20px;">
    <p style="margin: 0; color: #e2e8f0; font-size: 15px; line-height: 1.6; font-weight: 500;">${description}</p>
    <p style="margin: 8px 0 0 0; color: #64748b; font-size: 12px;">${datetimeStr}</p>
  </div>

  <!-- Details table -->
  <div style="margin-bottom: 28px;">
    <h3 style="color: #94a3b8; font-size: 11px; margin: 0 0 10px 0; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;">Detaljer</h3>
    <div style="background: #1e293b; border-radius: 8px; overflow: hidden;">
      <table style="width: 100%; border-collapse: collapse;">
        <tbody>
          ${affectedRow}
          ${contextRow}
          <tr>
            <td style="padding: 10px 14px; color: #94a3b8; font-size: 13px; white-space: nowrap;">Scan-ID</td>
            <td style="padding: 10px 14px; font-size: 12px; color: #64748b; font-family: 'Courier New', monospace;">${scanId}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- Action required notice -->
  <div style="margin-bottom: 28px; background: #1c1000; border: 1px solid #f59e0b; border-radius: 8px; padding: 14px 18px;">
    <p style="margin: 0; color: #fbbf24; font-size: 13px; line-height: 1.6;">
      <strong>Handling krævet:</strong> Denne fejl er kategoriseret som kritisk og kræver øjeblikkelig opmærksomhed.
      Gennemse fix-forslagene i admin-panelet og godkend eller afvis dem.
    </p>
  </div>

  <!-- CTA -->
  <div style="text-align: center; margin-bottom: 28px;">
    <a href="${adminUrl}" style="display: inline-block; background: #dc2626; color: #ffffff; text-decoration: none; font-weight: 700; font-size: 14px; padding: 14px 32px; border-radius: 8px; letter-spacing: 0.02em;">
      Åbn Admin Panel
    </a>
  </div>

  <!-- Footer -->
  <hr style="border: none; border-top: 1px solid #1e293b; margin: 0 0 16px 0;" />
  <p style="color: #475569; font-size: 11px; margin: 0; line-height: 1.6;">
    BizzAssist &mdash; Pecunia IT ApS &mdash; S&oslash;byvej 11, 2650 Hvidovre &mdash; CVR 44718502<br/>
    Kritisk alert fra Service Manager Agent &mdash; m&aring; ikke videresendes
  </p>

</div>
</body>
</html>`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send an immediate critical-error alert email via Resend.
 *
 * Called from the hourly service-scan cron whenever a scan issue is classified
 * as critical (build failures, 500-level errors on key routes). Fires
 * immediately — does not wait for the daily digest report.
 *
 * Silently skips sending if RESEND_API_KEY is not configured (dev environment)
 * but always logs the attempt to the console.
 *
 * @param params - Details about the critical issue to report.
 * @returns Resolves when the email has been sent (or skipped).
 */
export async function sendCriticalAlert(params: CriticalAlertParams): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;

  const detectedAt = params.detectedAt ?? new Date();

  // Always log so errors are visible in Vercel function logs
  logger.error(
    `[service-manager-alerts] KRITISK FEJL: ${params.issueType} — ${params.description}` +
      (params.affectedPath ? ` (${params.affectedPath})` : '') +
      ` @ ${detectedAt.toISOString()}`
  );

  if (!apiKey) {
    logger.warn('[service-manager-alerts] RESEND_API_KEY ikke sat — kritisk alert springes over');
    return;
  }

  const subject = `\uD83D\uDEA8 BizzAssist KRITISK FEJL \u2014 ${params.description}`;
  const html = buildCriticalAlertHtml({ ...params, detectedAt });

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
}

/**
 * Determine whether a scan issue qualifies as "critical" for immediate alerting.
 *
 * Criteria:
 * - Any build_error (the app may be undeployable)
 * - Runtime errors with a 500-level status code context
 * - Runtime errors on key application routes (API endpoints, auth, payments)
 *
 * @param issueType - The type field from the ScanIssue.
 * @param message - The human-readable error message.
 * @param context - Optional context string from the ScanIssue.
 * @returns true if the issue should trigger an immediate critical alert.
 */
export function isCriticalIssue(issueType: string, message: string, context?: string): boolean {
  // All build errors are critical — a failed build means the app is broken
  if (issueType === 'build_error') return true;

  // 500-level status codes in runtime errors
  const combined = `${message} ${context ?? ''}`.toLowerCase();
  if (/\b5[0-9]{2}\b/.test(combined)) return true;

  // Key routes whose failure significantly impacts users or revenue
  const CRITICAL_ROUTE_PATTERNS: RegExp[] = [
    /\/api\/auth/i,
    /\/api\/stripe/i,
    /\/api\/webhook/i,
    /\/api\/ai\/chat/i,
    /\/api\/vurdering/i,
    /\/api\/cron\//i,
    /\/dashboard\/admin/i,
  ];

  if (CRITICAL_ROUTE_PATTERNS.some((pattern) => pattern.test(combined))) return true;

  // BIZZ-304: Certificate expiry is critical — service outage imminent
  if (issueType === 'certificate_expiry') return true;

  return false;
}
