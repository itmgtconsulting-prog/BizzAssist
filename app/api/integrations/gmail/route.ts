/**
 * Gmail OAuth integration endpoints — BIZZ-47
 *
 * GET  /api/integrations/gmail — Returns current connection status
 * DELETE /api/integrations/gmail — Disconnects Gmail (revokes token)
 *
 * OAuth flow:
 *   1. User clicks "Connect Gmail" → redirected to /api/integrations/gmail/auth
 *   2. Google redirects to /api/integrations/gmail/callback with ?code=...
 *   3. We exchange code for tokens and store encrypted in Supabase
 *   4. User can now send emails via /api/integrations/gmail/send
 *
 * Required env vars (add to .env.local when credentials are ready):
 *   GMAIL_CLIENT_ID=...apps.googleusercontent.com
 *   GMAIL_CLIENT_SECRET=...
 *   GMAIL_REDIRECT_URI=https://app.bizzassist.dk/api/integrations/gmail/callback
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient, tenantDb } from '@/lib/supabase/admin';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';

/** Shape of the Gmail connection status response */
interface GmailStatus {
  connected: boolean;
  email?: string | null;
  connectedAt?: string;
  scopes?: string[];
}

/**
 * GET /api/integrations/gmail
 * Returns whether Gmail is connected for the authenticated user.
 *
 * @returns GmailStatus JSON
 */
export async function GET(
  request: NextRequest
): Promise<NextResponse<GmailStatus | { error: string }>> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited as NextResponse<GmailStatus | { error: string }>;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 });

  const { tenantId, userId } = auth;
  const { data, error } = await tenantDb(tenantId)
    .from('email_integrations')
    .select('email_address, connected_at, scopes')
    .eq('user_id', userId)
    .eq('provider', 'gmail')
    .maybeSingle();

  if (error) return NextResponse.json({ error: 'DB error' }, { status: 500 });

  if (!data) return NextResponse.json({ connected: false });

  return NextResponse.json({
    connected: true,
    email: data.email_address,
    connectedAt: data.connected_at,
    scopes: data.scopes,
  });
}

/**
 * DELETE /api/integrations/gmail
 * Disconnects Gmail by revoking the token and deleting from DB.
 *
 * @returns { ok: true } on success
 */
export async function DELETE(
  request: NextRequest
): Promise<NextResponse<{ ok: boolean } | { error: string }>> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited as NextResponse<{ ok: boolean } | { error: string }>;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 });

  const { tenantId, userId } = auth;
  const admin = createAdminClient();

  // Fetch token for revocation
  const { data } = await tenantDb(tenantId)
    .from('email_integrations')
    .select('access_token')
    .eq('user_id', userId)
    .eq('provider', 'gmail')
    .maybeSingle();

  // Revoke at Google (best-effort — don't fail if Google is unreachable)
  if (data?.access_token) {
    try {
      await fetch(
        `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(data.access_token as string)}`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(5000),
        }
      );
    } catch {
      // Non-fatal — proceed with DB deletion
    }
  }

  const { error } = await tenantDb(tenantId)
    .from('email_integrations')
    .delete()
    .eq('user_id', userId)
    .eq('provider', 'gmail');

  if (error) return NextResponse.json({ error: 'DB error' }, { status: 500 });

  // Audit log — fire-and-forget (ISO 27001 A.12.4)
  void admin.from('audit_log').insert({
    action: 'integration.gmail.disconnect',
    resource_type: 'integration',
    resource_id: userId,
    metadata: JSON.stringify({ tenantId, provider: 'gmail' }),
  });

  return NextResponse.json({ ok: true });
}
