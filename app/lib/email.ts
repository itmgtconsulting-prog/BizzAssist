import { logger } from '@/app/lib/logger';
import { companyInfo } from '@/app/lib/companyInfo';
import { RESEND_ENDPOINT } from '@/app/lib/serviceEndpoints';

/**
 * Email helper — app/lib/email.ts
 *
 * Sends transactional emails via the Resend API.
 * Falls back silently (log-only) when RESEND_API_KEY is not configured.
 *
 * RESTRICTED — SERVER-SIDE ONLY. Never import in Client Components.
 *
 * @see /api/stripe/verify-session — sends payment confirmation after checkout
 */
const FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS || 'BizzAssist <noreply@bizzassist.dk>';

// ─── Payment confirmation ──────────────────────────────────────────────────

/** Parameters for the payment confirmation email */
export interface PaymentConfirmationParams {
  /** Recipient email address */
  to: string;
  /** Display name of the plan (localised) */
  planName: string;
  /** Monthly price in DKK */
  priceDkk: number;
  /** End of the current billing period (= next payment date) */
  periodEnd: Date;
  /** URL where the user can cancel their subscription */
  cancelUrl: string;
}

/**
 * Send a payment confirmation email after a successful Stripe subscription payment.
 * Silently skips if RESEND_API_KEY is not set (dev/staging environments).
 *
 * @param params - Email parameters including recipient, plan details, and cancel URL
 */
export async function sendPaymentConfirmationEmail(
  params: PaymentConfirmationParams
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.warn('[email] RESEND_API_KEY not set, skipping payment confirmation email');
    return;
  }

  const { to, planName, priceDkk, periodEnd, cancelUrl } = params;

  const nextPaymentDa = periodEnd.toLocaleDateString('da-DK', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const nextPaymentEn = periodEnd.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  // Bilingual email — Danish primary, English secondary
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; background: #0f172a; color: #e2e8f0; padding: 40px; border-radius: 12px;">
      <h1 style="color: #ffffff; font-size: 24px; margin: 0 0 8px 0;">BizzAssist</h1>
      <p style="color: #64748b; font-size: 12px; margin: 0 0 24px 0;">Danmarks forretningsintelligens platform</p>

      <h2 style="color: #22c55e; font-size: 18px; margin: 0 0 16px 0;">&#10003; Betaling gennemf&oslash;rt / Payment confirmed</h2>

      <p style="margin: 0 0 4px 0; font-size: 14px;">Din betaling er registreret og dit abonnement er nu aktivt.</p>
      <p style="margin: 0 0 20px 0; font-size: 13px; color: #94a3b8;">Your payment has been received and your subscription is now active.</p>

      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <tr>
          <td style="padding: 10px 0; color: #94a3b8; font-size: 13px; border-bottom: 1px solid #1e293b;">Plan</td>
          <td style="padding: 10px 0; text-align: right; font-size: 13px; border-bottom: 1px solid #1e293b;">${planName}</td>
        </tr>
        <tr>
          <td style="padding: 10px 0; color: #94a3b8; font-size: 13px; border-bottom: 1px solid #1e293b;">Pris / Price</td>
          <td style="padding: 10px 0; text-align: right; font-size: 13px; border-bottom: 1px solid #1e293b;">${priceDkk} kr/md</td>
        </tr>
        <tr>
          <td style="padding: 10px 0; color: #94a3b8; font-size: 13px;">N&aelig;ste betaling / Next payment</td>
          <td style="padding: 10px 0; text-align: right; font-size: 13px;">${nextPaymentDa}<br/><span style="color: #64748b; font-size: 11px;">${nextPaymentEn}</span></td>
        </tr>
      </table>

      <p style="margin: 30px 0 12px 0; font-size: 13px; color: #94a3b8;">
        Hvis du &oslash;nsker at opsige dit abonnement kan du g&oslash;re det fra dine indstillinger:
      </p>
      <p style="margin: 0 0 12px 0; font-size: 12px; color: #64748b;">
        To cancel your subscription, visit your settings page:
      </p>
      <a href="${cancelUrl}" style="display: inline-block; background: #334155; color: #e2e8f0; padding: 10px 24px; border-radius: 8px; text-decoration: none; font-size: 13px; border: 1px solid #475569;">
        Administrer abonnement / Manage subscription
      </a>

      <hr style="border: none; border-top: 1px solid #1e293b; margin: 30px 0;" />
      <p style="color: #475569; font-size: 11px; margin: 0;">${companyInfo.legalLineHtml}</p>
    </div>
  `;

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to,
        subject: 'Betaling gennemfort — BizzAssist',
        html,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error('[email] Resend API error:', res.status, body);
    } else {
      logger.log('[email] Payment confirmation sent');
    }
  } catch (err) {
    logger.error('[email] Failed to send payment confirmation:', err);
  }
}

// ─── Subscription approval notification ───────────────────────────────────────

/** Parameters for the subscription approval email */
export interface SubscriptionApprovalParams {
  /** Recipient email address */
  to: string;
  /** Full name of the user, if available */
  fullName?: string;
  /** Display name of the approved plan */
  planName: string;
  /** Login URL to direct the user to */
  loginUrl?: string;
}

/**
 * Send a notification email to a user when their pending subscription/access
 * request has been approved by an administrator.
 * Silently skips if RESEND_API_KEY is not set (dev environments).
 *
 * @param params - Email parameters including recipient and plan details
 */
export async function sendApprovalEmail(params: SubscriptionApprovalParams): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.warn('[email] RESEND_API_KEY not set, skipping approval email');
    return;
  }

  const {
    to,
    fullName,
    planName,
    loginUrl = `${(process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk').replace(/\/$/, '')}/login`,
  } = params;

  const greeting = fullName ? `Hej ${fullName}` : 'Hej';

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; background: #0f172a; color: #e2e8f0; padding: 40px; border-radius: 12px;">
      <h1 style="color: #ffffff; font-size: 24px; margin: 0 0 8px 0;">BizzAssist</h1>
      <p style="color: #64748b; font-size: 12px; margin: 0 0 24px 0;">Danmarks forretningsintelligens platform</p>

      <h2 style="color: #22c55e; font-size: 18px; margin: 0 0 16px 0;">&#10003; Din adgang er godkendt!</h2>

      <p style="margin: 0 0 8px 0; font-size: 14px;">${greeting},</p>
      <p style="margin: 0 0 20px 0; font-size: 14px;">
        Din anmodning om adgang til BizzAssist er nu godkendt. Du kan logge ind og begynde at bruge platformen med det samme.
      </p>
      <p style="margin: 0 0 20px 0; font-size: 13px; color: #94a3b8;">
        Your request for access to BizzAssist has been approved. You can now log in and start using the platform.
      </p>

      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <tr>
          <td style="padding: 10px 0; color: #94a3b8; font-size: 13px; border-bottom: 1px solid #1e293b;">Plan</td>
          <td style="padding: 10px 0; text-align: right; font-size: 13px; border-bottom: 1px solid #1e293b;">${planName}</td>
        </tr>
        <tr>
          <td style="padding: 10px 0; color: #94a3b8; font-size: 13px;">Status</td>
          <td style="padding: 10px 0; text-align: right; font-size: 13px; color: #22c55e;">Aktiv / Active</td>
        </tr>
      </table>

      <a href="${loginUrl}" style="display: inline-block; background: #2563eb; color: #ffffff; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 600; margin-top: 8px;">
        Log ind p&aring; BizzAssist &rarr;
      </a>
      <p style="margin: 10px 0 0 0; font-size: 12px; color: #64748b;">
        Log in to BizzAssist &rarr; <a href="${loginUrl}" style="color: #3b82f6;">${loginUrl}</a>
      </p>

      <hr style="border: none; border-top: 1px solid #1e293b; margin: 30px 0;" />
      <p style="color: #475569; font-size: 11px; margin: 0;">${companyInfo.legalLineHtml}</p>
    </div>
  `;

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to,
        subject: 'Din adgang til BizzAssist er godkendt',
        html,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error('[email] Resend API error (approval):', res.status, body);
    } else {
      logger.log('[email] Approval notification sent');
    }
  } catch (err) {
    logger.error('[email] Failed to send approval email:', err);
  }
}

// ─── Recurring payment confirmation ──────────────────────────────────────────

/** Parameters for the recurring payment email */
export interface RecurringPaymentParams {
  /** Recipient email address */
  to: string;
  /** Display name of the plan */
  planName: string;
  /** Amount paid in DKK */
  priceDkk: number;
  /** End of the current billing period (= next payment date) */
  periodEnd: Date;
  /** URL where the user can manage/cancel their subscription */
  cancelUrl: string;
}

/**
 * Send a recurring payment confirmation email when Stripe successfully
 * charges a subscription renewal. Called from the webhook handler.
 *
 * @param params - Email parameters
 */
export async function sendRecurringPaymentEmail(params: RecurringPaymentParams): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.warn('[email] RESEND_API_KEY not set, skipping recurring payment email');
    return;
  }

  const { to, planName, priceDkk, periodEnd, cancelUrl } = params;

  const paymentDateDa = new Date().toLocaleDateString('da-DK', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const nextPaymentDa = periodEnd.toLocaleDateString('da-DK', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const nextPaymentEn = periodEnd.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; background: #0f172a; color: #e2e8f0; padding: 40px; border-radius: 12px;">
      <h1 style="color: #ffffff; font-size: 24px; margin: 0 0 8px 0;">BizzAssist</h1>
      <p style="color: #64748b; font-size: 12px; margin: 0 0 24px 0;">Danmarks forretningsintelligens platform</p>

      <h2 style="color: #22c55e; font-size: 18px; margin: 0 0 16px 0;">&#10003; Abonnement fornyet / Subscription renewed</h2>

      <p style="margin: 0 0 4px 0; font-size: 14px;">Dit abonnement er blevet fornyet og betaling er gennemf&oslash;rt.</p>
      <p style="margin: 0 0 20px 0; font-size: 13px; color: #94a3b8;">Your subscription has been renewed and payment was successful.</p>

      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <tr>
          <td style="padding: 10px 0; color: #94a3b8; font-size: 13px; border-bottom: 1px solid #1e293b;">Plan</td>
          <td style="padding: 10px 0; text-align: right; font-size: 13px; border-bottom: 1px solid #1e293b;">${planName}</td>
        </tr>
        <tr>
          <td style="padding: 10px 0; color: #94a3b8; font-size: 13px; border-bottom: 1px solid #1e293b;">Betalt / Paid</td>
          <td style="padding: 10px 0; text-align: right; font-size: 13px; border-bottom: 1px solid #1e293b;">${priceDkk} kr</td>
        </tr>
        <tr>
          <td style="padding: 10px 0; color: #94a3b8; font-size: 13px; border-bottom: 1px solid #1e293b;">Betalingsdato / Payment date</td>
          <td style="padding: 10px 0; text-align: right; font-size: 13px; border-bottom: 1px solid #1e293b;">${paymentDateDa}</td>
        </tr>
        <tr>
          <td style="padding: 10px 0; color: #94a3b8; font-size: 13px;">N&aelig;ste betaling / Next payment</td>
          <td style="padding: 10px 0; text-align: right; font-size: 13px;">${nextPaymentDa}<br/><span style="color: #64748b; font-size: 11px;">${nextPaymentEn}</span></td>
        </tr>
      </table>

      <p style="margin: 30px 0 12px 0; font-size: 13px; color: #94a3b8;">
        Du kan administrere dit abonnement fra dine indstillinger:
      </p>
      <p style="margin: 0 0 12px 0; font-size: 12px; color: #64748b;">
        You can manage your subscription from your settings:
      </p>
      <a href="${cancelUrl}" style="display: inline-block; background: #334155; color: #e2e8f0; padding: 10px 24px; border-radius: 8px; text-decoration: none; font-size: 13px; border: 1px solid #475569;">
        Administrer abonnement / Manage subscription
      </a>

      <hr style="border: none; border-top: 1px solid #1e293b; margin: 30px 0;" />
      <p style="color: #475569; font-size: 11px; margin: 0;">${companyInfo.legalLineHtml}</p>
    </div>
  `;

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to,
        subject: 'Abonnement fornyet — BizzAssist',
        html,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error('[email] Resend API error (recurring):', res.status, body);
    } else {
      logger.log('[email] Recurring payment confirmation sent');
    }
  } catch (err) {
    logger.error('[email] Failed to send recurring payment email:', err);
  }
}

// ─── Welcome email (BIZZ-272) ──────────────────────────────────────────────

/**
 * Send a welcome email to a new user after signup and onboarding.
 * Silently skips if RESEND_API_KEY is not set.
 *
 * @param to - New user's email address
 * @param fullName - User's display name (optional)
 */
export async function sendWelcomeEmail(to: string, fullName?: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk';
  const greeting = fullName ? `Hej ${fullName}` : 'Hej';

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; background: #0f172a; color: #e2e8f0; padding: 40px; border-radius: 12px;">
      <h1 style="color: #ffffff; font-size: 24px; margin: 0 0 8px 0;">BizzAssist</h1>
      <p style="color: #64748b; font-size: 12px; margin: 0 0 24px 0;">Danmarks forretningsintelligens platform</p>

      <h2 style="color: #3b82f6; font-size: 18px; margin: 0 0 16px 0;">Velkommen til BizzAssist!</h2>

      <p style="margin: 0 0 8px 0; font-size: 14px;">${greeting},</p>
      <p style="margin: 0 0 16px 0; font-size: 14px;">
        Din konto er oprettet og du kan nu s&oslash;ge i virksomheder, ejendomme og personer i hele Danmark.
      </p>
      <p style="margin: 0 0 24px 0; font-size: 13px; color: #94a3b8;">
        Your account has been created. You can now search companies, properties and people across Denmark.
      </p>

      <p style="margin: 0 0 8px 0; font-size: 13px; color: #94a3b8;">Kom godt i gang:</p>
      <ul style="margin: 0 0 24px 0; padding-left: 20px; font-size: 13px; color: #cbd5e1;">
        <li style="margin-bottom: 6px;">S&oslash;g efter en virksomhed eller ejendom</li>
        <li style="margin-bottom: 6px;">Brug AI-assistenten til at analysere data</li>
        <li style="margin-bottom: 6px;">F&oslash;lg ejendomme og virksomheder for at f&aring; opdateringer</li>
      </ul>

      <a href="${appUrl}/dashboard" style="display: inline-block; background: #2563eb; color: #ffffff; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 600;">
        G&aring; til dit dashboard &rarr;
      </a>

      <hr style="border: none; border-top: 1px solid #1e293b; margin: 30px 0;" />
      <p style="color: #475569; font-size: 11px; margin: 0;">${companyInfo.legalLineHtml}</p>
    </div>
  `;

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_ADDRESS, to, subject: 'Velkommen til BizzAssist', html }),
    });
    if (!res.ok) logger.error('[email] Welcome email error:', res.status);
    else logger.log('[email] Welcome email sent');
  } catch (err) {
    logger.error('[email] Failed to send welcome email:', err);
  }
}

// ─── Account deletion confirmation (BIZZ-272) ─────────────────────────────

/**
 * Send a confirmation email after account deletion (GDPR Art. 17).
 * Silently skips if RESEND_API_KEY is not set.
 *
 * @param to - Deleted user's email address
 */
export async function sendAccountDeletionEmail(to: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; background: #0f172a; color: #e2e8f0; padding: 40px; border-radius: 12px;">
      <h1 style="color: #ffffff; font-size: 24px; margin: 0 0 8px 0;">BizzAssist</h1>
      <p style="color: #64748b; font-size: 12px; margin: 0 0 24px 0;">Danmarks forretningsintelligens platform</p>

      <h2 style="color: #ef4444; font-size: 18px; margin: 0 0 16px 0;">Konto slettet / Account deleted</h2>

      <p style="margin: 0 0 16px 0; font-size: 14px;">
        Din BizzAssist-konto og alle tilknyttede data er blevet permanent slettet som anmodet.
      </p>
      <p style="margin: 0 0 24px 0; font-size: 13px; color: #94a3b8;">
        Your BizzAssist account and all associated data have been permanently deleted as requested.
      </p>

      <p style="margin: 0 0 8px 0; font-size: 13px; color: #94a3b8;">Hvad er slettet:</p>
      <ul style="margin: 0 0 24px 0; padding-left: 20px; font-size: 13px; color: #cbd5e1;">
        <li style="margin-bottom: 4px;">Profil og kontodata</li>
        <li style="margin-bottom: 4px;">Gemte s&oslash;gninger og fulgte enheder</li>
        <li style="margin-bottom: 4px;">AI-samtaler og uploadede dokumenter</li>
        <li style="margin-bottom: 4px;">Notifikationer og aktivitetslog</li>
      </ul>

      <p style="margin: 0 0 8px 0; font-size: 13px; color: #64748b;">
        Denne besked er den sidste du modtager fra os. Du er altid velkommen til at oprette en ny konto.
      </p>

      <hr style="border: none; border-top: 1px solid #1e293b; margin: 30px 0;" />
      <p style="color: #475569; font-size: 11px; margin: 0;">${companyInfo.legalLineHtml}</p>
    </div>
  `;

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to,
        subject: 'Din konto er slettet — BizzAssist',
        html,
      }),
    });
    if (!res.ok) logger.error('[email] Deletion confirmation error:', res.status);
    else logger.log('[email] Deletion confirmation sent');
  } catch (err) {
    logger.error('[email] Failed to send deletion email:', err);
  }
}

// ─── Payment failure notification (BIZZ-540) ───────────────────────────────

/** Parameters for the payment-failed notification email */
export interface PaymentFailedParams {
  /** Recipient email address */
  to: string;
  /** Display name of the plan whose invoice failed */
  planName: string;
  /** Amount Stripe tried and failed to charge, in DKK */
  amountDueDkk: number;
  /** Optional decline reason from Stripe (e.g. "Your card was declined") */
  failureReason?: string | null;
  /** Date of Stripe's next automatic retry, when known */
  nextRetryAt?: Date | null;
  /** URL where the user can update their payment method (our settings page) */
  updateUrl: string;
  /** Which attempt this was (Stripe invoice.attempt_count) */
  attemptCount?: number | null;
}

/**
 * Send a payment-failure notification email when Stripe's invoice.payment_failed
 * webhook fires. Users need to know their recurring charge failed so they can
 * update their card before access is cut off.
 *
 * BIZZ-540: Called from app/api/stripe/webhook/route.ts handlePaymentFailed().
 *
 * Retention: Transactional email — no persistent storage beyond Resend delivery logs.
 * No PII (email address) is logged on our side — only user_id via audit_log.
 *
 * @param params - Email parameters (recipient, plan, amount, retry info, update link)
 */
export async function sendPaymentFailedEmail(params: PaymentFailedParams): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.warn('[email] RESEND_API_KEY not set, skipping payment-failed email');
    return;
  }

  const { to, planName, amountDueDkk, failureReason, nextRetryAt, updateUrl, attemptCount } =
    params;

  const nextRetryDa = nextRetryAt
    ? nextRetryAt.toLocaleDateString('da-DK', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;
  const nextRetryEn = nextRetryAt
    ? nextRetryAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;

  // Escape failure reason to avoid HTML injection from Stripe decline messages
  const reasonDa = failureReason
    ? String(failureReason).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`)
    : null;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; background: #0f172a; color: #e2e8f0; padding: 40px; border-radius: 12px;">
      <h1 style="color: #ffffff; font-size: 24px; margin: 0 0 8px 0;">BizzAssist</h1>
      <p style="color: #64748b; font-size: 12px; margin: 0 0 24px 0;">Danmarks forretningsintelligens platform</p>

      <h2 style="color: #f87171; font-size: 18px; margin: 0 0 16px 0;">&#9888; Betaling mislykkedes / Payment failed</h2>

      <p style="margin: 0 0 4px 0; font-size: 14px;">Vi kunne ikke tr&aelig;kke betalingen for dit abonnement.</p>
      <p style="margin: 0 0 20px 0; font-size: 13px; color: #94a3b8;">We were unable to charge your subscription.</p>

      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <tr>
          <td style="padding: 10px 0; color: #94a3b8; font-size: 13px; border-bottom: 1px solid #1e293b;">Plan</td>
          <td style="padding: 10px 0; text-align: right; font-size: 13px; border-bottom: 1px solid #1e293b;">${planName}</td>
        </tr>
        <tr>
          <td style="padding: 10px 0; color: #94a3b8; font-size: 13px; border-bottom: 1px solid #1e293b;">Bel&oslash;b / Amount</td>
          <td style="padding: 10px 0; text-align: right; font-size: 13px; border-bottom: 1px solid #1e293b;">${amountDueDkk} kr</td>
        </tr>
        ${
          reasonDa
            ? `<tr>
          <td style="padding: 10px 0; color: #94a3b8; font-size: 13px; border-bottom: 1px solid #1e293b;">&Aring;rsag / Reason</td>
          <td style="padding: 10px 0; text-align: right; font-size: 13px; border-bottom: 1px solid #1e293b;">${reasonDa}</td>
        </tr>`
            : ''
        }
        ${
          attemptCount
            ? `<tr>
          <td style="padding: 10px 0; color: #94a3b8; font-size: 13px; border-bottom: 1px solid #1e293b;">Fors&oslash;g / Attempt</td>
          <td style="padding: 10px 0; text-align: right; font-size: 13px; border-bottom: 1px solid #1e293b;">${attemptCount}</td>
        </tr>`
            : ''
        }
        ${
          nextRetryDa
            ? `<tr>
          <td style="padding: 10px 0; color: #94a3b8; font-size: 13px;">N&aelig;ste fors&oslash;g / Next retry</td>
          <td style="padding: 10px 0; text-align: right; font-size: 13px;">${nextRetryDa}<br/><span style="color: #64748b; font-size: 11px;">${nextRetryEn}</span></td>
        </tr>`
            : ''
        }
      </table>

      <p style="margin: 30px 0 12px 0; font-size: 14px; color: #e2e8f0;">
        Opdat&eacute;r din betalingsmetode for at undg&aring; afbrydelse af adgangen.
      </p>
      <p style="margin: 0 0 20px 0; font-size: 12px; color: #94a3b8;">
        Please update your payment method to avoid losing access.
      </p>
      <a href="${updateUrl}" style="display: inline-block; background: #dc2626; color: #ffffff; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 600;">
        Opdat&eacute;r betalingsmetode / Update payment method
      </a>

      <p style="margin: 30px 0 0 0; font-size: 12px; color: #64748b;">
        Hvis du mener der er sket en fejl, kontakt os p&aring; ${companyInfo.supportEmail ?? 'support@bizzassist.dk'}.
      </p>

      <hr style="border: none; border-top: 1px solid #1e293b; margin: 30px 0;" />
      <p style="color: #475569; font-size: 11px; margin: 0;">${companyInfo.legalLineHtml}</p>
    </div>
  `;

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to,
        subject:
          'Betaling mislykkedes — handling p&aring;kr&aelig;vet / Payment failed — action required',
        html,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error('[email] Resend API error (payment-failed):', res.status, body);
    } else {
      logger.log('[email] Payment-failed notification sent');
    }
  } catch (err) {
    logger.error('[email] Failed to send payment-failed email:', err);
  }
}
