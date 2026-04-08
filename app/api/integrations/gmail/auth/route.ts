/**
 * Gmail OAuth authorization redirect — BIZZ-47
 *
 * GET /api/integrations/gmail/auth
 * Redirects user to Google's OAuth consent screen.
 *
 * Required env vars:
 *   GMAIL_CLIENT_ID      - Google Cloud OAuth 2.0 Client ID
 *   GMAIL_REDIRECT_URI   - Must match Google Cloud Console exactly
 *
 * Scopes requested:
 *   - gmail.send        — Send emails on behalf of user
 *   - userinfo.email    — Get user's email address
 *   - userinfo.profile  — Get user's display name
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ');

/**
 * GET /api/integrations/gmail/auth
 * Builds the Google OAuth URL with state parameter (userId) and redirects.
 *
 * @returns 302 redirect to Google OAuth or 503 if not configured
 */
export async function GET(_request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 });

  const clientId = process.env.GMAIL_CLIENT_ID;
  const redirectUri = process.env.GMAIL_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return NextResponse.json(
      {
        error:
          'Gmail integration not configured. Add GMAIL_CLIENT_ID and GMAIL_REDIRECT_URI to environment variables.',
      },
      { status: 503 }
    );
  }

  // State: base64url-encoded JSON with userId + tenantId for CSRF protection
  const state = Buffer.from(
    JSON.stringify({ userId: auth.userId, tenantId: auth.tenantId })
  ).toString('base64url');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline', // Get refresh token
    prompt: 'consent', // Always show consent to get refresh token
    state,
  });

  return NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}
