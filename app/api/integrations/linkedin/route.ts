/**
 * LinkedIn OAuth integration endpoints — BIZZ-48
 *
 * GET  /api/integrations/linkedin — Returns current connection status
 * DELETE /api/integrations/linkedin — Disconnects LinkedIn (revokes token best-effort)
 *
 * OAuth flow:
 *   1. User clicks "Forbind LinkedIn" → redirected to /api/integrations/linkedin/auth
 *   2. LinkedIn redirects to /api/integrations/linkedin/callback with ?code=...
 *   3. We exchange code for access token and store in Supabase
 *   4. Profile enrichment available via /api/integrations/linkedin/enrich
 *
 * Required env vars (add to .env.local when credentials are ready):
 *   LINKEDIN_CLIENT_ID=...
 *   LINKEDIN_CLIENT_SECRET=...
 *   LINKEDIN_REDIRECT_URI=https://app.bizzassist.dk/api/integrations/linkedin/callback
 *
 * Note: LinkedIn access tokens last 60 days. Standard OAuth does not provide
 * refresh tokens — user must reconnect after expiry.
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';

/** LinkedIn profile data stored in email_integrations */
interface LinkedInProfile {
  id: string;
  firstName: string;
  lastName: string;
  emailAddress: string;
}

/** Shape of the LinkedIn connection status response */
interface LinkedInStatus {
  connected: boolean;
  /** LinkedIn profile name when connected */
  name?: string;
  /** LinkedIn account email when connected */
  email?: string;
  connectedAt?: string;
  /** ISO timestamp when access token expires (60-day LinkedIn tokens) */
  expiresAt?: string;
}

/**
 * GET /api/integrations/linkedin
 * Returns whether LinkedIn is connected for the authenticated user.
 *
 * @returns LinkedInStatus JSON
 */
export async function GET(
  request: NextRequest
): Promise<NextResponse<LinkedInStatus | { error: string }>> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited as NextResponse<LinkedInStatus | { error: string }>;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 });

  const { tenantId, userId } = auth;
  const admin = createAdminClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any)
    .schema(tenantId)
    .from('email_integrations')
    .select('email_address, connected_at, token_expires_at, scopes')
    .eq('user_id', userId)
    .eq('provider', 'linkedin')
    .maybeSingle();

  if (error) return NextResponse.json({ error: 'DB error' }, { status: 500 });

  if (!data) return NextResponse.json({ connected: false });

  // Reconstruct name from scopes metadata — stored as first element: "firstName lastName"
  const nameScope = (data.scopes as string[]).find((s: string) => s.startsWith('name:'));
  const name = nameScope ? nameScope.slice(5) : undefined;

  return NextResponse.json({
    connected: true,
    email: data.email_address as string,
    name,
    connectedAt: data.connected_at as string,
    expiresAt: data.token_expires_at as string,
  });
}

/**
 * DELETE /api/integrations/linkedin
 * Disconnects LinkedIn by revoking the access token (best-effort) and
 * deleting the record from email_integrations.
 *
 * LinkedIn revoke endpoint: https://www.linkedin.com/oauth/v2/revoke
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin as any)
    .schema(tenantId)
    .from('email_integrations')
    .select('access_token')
    .eq('user_id', userId)
    .eq('provider', 'linkedin')
    .maybeSingle();

  // Revoke at LinkedIn (best-effort — don't fail if LinkedIn is unreachable)
  if (data?.access_token) {
    const clientId = process.env.LINKEDIN_CLIENT_ID;
    const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;

    if (clientId && clientSecret) {
      try {
        await fetch('https://www.linkedin.com/oauth/v2/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            token: data.access_token as string,
            client_id: clientId,
            client_secret: clientSecret,
          }),
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // Non-fatal — proceed with DB deletion
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin as any)
    .schema(tenantId)
    .from('email_integrations')
    .delete()
    .eq('user_id', userId)
    .eq('provider', 'linkedin');

  if (error) return NextResponse.json({ error: 'DB error' }, { status: 500 });

  return NextResponse.json({ ok: true });
}

export type { LinkedInProfile, LinkedInStatus };
