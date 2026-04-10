/**
 * Gmail send endpoint — BIZZ-47
 *
 * POST /api/integrations/gmail/send
 * Sends an email via Gmail API using the user's stored OAuth token.
 *
 * Body: { to: string, subject: string, body: string, isHtml?: boolean }
 *
 * Rate limiting: 60 req/min per IP (general rateLimit)
 * Token refresh: automatically refreshes expired access tokens
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient, tenantDb } from '@/lib/supabase/admin';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';

/** Request body for sending a Gmail message */
interface SendEmailBody {
  to: string;
  subject: string;
  body: string;
  isHtml?: boolean;
}

/** Gmail API token response (for refresh) */
interface RefreshedToken {
  access_token: string;
  expires_in: number;
}

/** Gmail API send response */
interface GmailSendResponse {
  id: string;
}

/**
 * Refreshes an expired Gmail access token using the stored refresh token.
 *
 * @param refreshToken - The stored OAuth refresh token
 * @returns New access token + expiry, or null on failure
 */
async function refreshAccessToken(refreshToken: string): Promise<RefreshedToken | null> {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return (await res.json()) as RefreshedToken;
  } catch {
    return null;
  }
}

/**
 * Encodes an email as RFC 2822 base64url for Gmail API.
 *
 * @param to - Recipient email address
 * @param subject - Email subject
 * @param body - Email body (plain text or HTML)
 * @param isHtml - Whether body is HTML
 * @returns base64url-encoded RFC 2822 message
 */
function encodeEmail(to: string, subject: string, body: string, isHtml = false): string {
  const contentType = isHtml ? 'text/html' : 'text/plain';
  const email = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: ${contentType}; charset=utf-8`,
    `MIME-Version: 1.0`,
    '',
    body,
  ].join('\r\n');
  return Buffer.from(email).toString('base64url');
}

/**
 * POST /api/integrations/gmail/send
 * Sends an email via the Gmail API using the user's stored OAuth credentials.
 * Automatically refreshes expired tokens.
 *
 * @returns { ok: true, messageId: string } or error
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited as NextResponse;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 });

  const { tenantId, userId } = auth;

  let body: SendEmailBody;
  try {
    body = (await request.json()) as SendEmailBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { to, subject, body: emailBody, isHtml } = body;
  if (!to || !subject || !emailBody) {
    return NextResponse.json(
      { error: 'Missing required fields: to, subject, body' },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  // Fetch stored tokens
  const { data: integration, error: fetchError } = await tenantDb(tenantId)
    .from('email_integrations')
    .select('access_token, refresh_token, token_expires_at')
    .eq('user_id', userId)
    .eq('provider', 'gmail')
    .maybeSingle();

  if (fetchError || !integration) {
    return NextResponse.json({ error: 'Gmail not connected' }, { status: 400 });
  }

  let accessToken = integration.access_token as string;

  // Auto-refresh if expired (with 60-second buffer)
  const expiresAt = new Date(integration.token_expires_at as string).getTime();
  if (Date.now() > expiresAt - 60_000) {
    const refreshed = await refreshAccessToken(integration.refresh_token as string);
    if (!refreshed) {
      return NextResponse.json(
        { error: 'Token expired — please reconnect Gmail' },
        { status: 401 }
      );
    }
    accessToken = refreshed.access_token;
    // Update stored token
    await tenantDb(tenantId)
      .from('email_integrations')
      .update({
        access_token: accessToken,
        token_expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
      })
      .eq('user_id', userId)
      .eq('provider', 'gmail');
  }

  // Send via Gmail API
  try {
    const gmailRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw: encodeEmail(to, subject, emailBody, isHtml) }),
      signal: AbortSignal.timeout(10000),
    });

    if (!gmailRes.ok) {
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 502 });
    }

    const result = (await gmailRes.json()) as GmailSendResponse;

    // Update last_used_at
    await tenantDb(tenantId)
      .from('email_integrations')
      .update({ last_used_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('provider', 'gmail');

    // Audit log — fire-and-forget (ISO 27001 A.12.4)
    void admin.from('audit_log').insert({
      action: 'integration.gmail.send',
      resource_type: 'email',
      resource_id: result.id,
      metadata: JSON.stringify({ tenantId, userId, subject }),
    });

    return NextResponse.json({ ok: true, messageId: result.id });
  } catch {
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 502 });
  }
}
