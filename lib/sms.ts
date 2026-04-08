/**
 * SMS Alerts — app/lib/sms.ts
 *
 * Sends SMS notifications for critical production errors via Twilio.
 * Used as a secondary alert channel alongside email (Resend).
 *
 * Messages are capped at 160 characters to fit a single SMS segment.
 *
 * Required environment variables:
 *   - TWILIO_ACCOUNT_SID   — Twilio Account SID (starts with AC…)
 *   - TWILIO_AUTH_TOKEN    — Twilio Auth Token
 *   - TWILIO_FROM_NUMBER   — Twilio phone number in E.164 format, e.g. +4512345678
 *   - ALERT_PHONE_NUMBER   — Recipient phone number in E.164 format
 *
 * IMPORTANT: This module is SERVER-SIDE ONLY. Never import in Client Components.
 *
 * @module lib/sms
 */

/** Maximum SMS length for a single segment. */
const MAX_SMS_CHARS = 160;

/**
 * Send a critical-error SMS notification via Twilio.
 *
 * Silently skips sending if any required environment variable is missing —
 * logs a warning to the console but does not throw, so callers are never
 * blocked by a missing Twilio configuration.
 *
 * @param message - The SMS body. Truncated to 160 characters if longer.
 * @returns Resolves when the SMS has been sent (or gracefully skipped).
 */
export async function sendCriticalSms(message: string): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  const toNumber = process.env.ALERT_PHONE_NUMBER;

  if (!accountSid || !authToken || !fromNumber || !toNumber) {
    console.warn(
      '[sms] Twilio env vars ikke sat (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, ' +
        'TWILIO_FROM_NUMBER, ALERT_PHONE_NUMBER) — SMS-alert springes over'
    );
    return;
  }

  // Truncate to fit a single SMS segment
  const body = message.length > MAX_SMS_CHARS ? message.slice(0, MAX_SMS_CHARS) : message;

  try {
    const twilio = (await import('twilio')).default;
    const client = twilio(accountSid, authToken);

    await client.messages.create({
      body,
      from: fromNumber,
      to: toNumber,
    });

    console.log('[sms] Kritisk SMS-alert sendt til', toNumber);
  } catch (err) {
    // Non-fatal — email alert has already been sent
    console.error('[sms] Kunne ikke sende SMS-alert:', err);
  }
}
