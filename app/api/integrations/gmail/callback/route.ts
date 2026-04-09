/**
 * Gmail OAuth callback — BIZZ-47
 *
 * GET /api/integrations/gmail/callback?code=...&state=...
 * Exchanges authorization code for tokens and stores in Supabase.
 *
 * Required env vars:
 *   GMAIL_CLIENT_ID
 *   GMAIL_CLIENT_SECRET
 *   GMAIL_REDIRECT_URI
 */

import { NextRequest, NextResponse } from 'next/server';
import { tenantDb } from '@/lib/supabase/admin';

/** Response shape from Google's token endpoint */
interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

/** Minimal user info from Google's userinfo endpoint */
interface GoogleUserInfo {
  email: string;
  name?: string;
}

/** Decoded state parameter containing userId and tenantId */
interface OAuthState {
  userId: string;
  tenantId: string;
}

/**
 * GET /api/integrations/gmail/callback
 * Handles Google OAuth 2.0 callback. Exchanges code for tokens,
 * fetches user info, and stores encrypted tokens in email_integrations.
 *
 * @returns Redirect to /dashboard/settings with success/error query param
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  const redirectBase = '/dashboard/settings';

  if (oauthError || !code || !state) {
    return NextResponse.redirect(
      new URL(
        `${redirectBase}?gmail=error&reason=${encodeURIComponent(oauthError ?? 'missing_params')}`,
        request.url
      )
    );
  }

  // Decode state (CSRF check)
  let stateData: OAuthState;
  try {
    stateData = JSON.parse(Buffer.from(state, 'base64url').toString()) as OAuthState;
  } catch {
    return NextResponse.redirect(
      new URL(`${redirectBase}?gmail=error&reason=invalid_state`, request.url)
    );
  }

  const { userId, tenantId } = stateData;
  const clientId = process.env.GMAIL_CLIENT_ID ?? '';
  const clientSecret = process.env.GMAIL_CLIENT_SECRET ?? '';
  const redirectUri = process.env.GMAIL_REDIRECT_URI ?? '';

  if (!clientId || !clientSecret || !redirectUri) {
    return NextResponse.redirect(
      new URL(`${redirectBase}?gmail=error&reason=not_configured`, request.url)
    );
  }

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!tokenRes.ok) {
      return NextResponse.redirect(
        new URL(`${redirectBase}?gmail=error&reason=token_exchange`, request.url)
      );
    }

    const tokens = (await tokenRes.json()) as GoogleTokenResponse;

    // Fetch user email
    const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(5000),
    });

    const userInfo = (await userRes.json()) as GoogleUserInfo;

    // Store in DB
    const { error: dbError } = await tenantDb(tenantId)
      .from('email_integrations')
      .upsert(
        {
          user_id: userId,
          provider: 'gmail',
          email_address: userInfo.email,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token ?? '',
          token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
          scopes: tokens.scope.split(' '),
          connected_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,provider' }
      );

    if (dbError) {
      return NextResponse.redirect(
        new URL(`${redirectBase}?gmail=error&reason=db_error`, request.url)
      );
    }

    return NextResponse.redirect(
      new URL(
        `${redirectBase}?gmail=connected&email=${encodeURIComponent(userInfo.email)}`,
        request.url
      )
    );
  } catch {
    return NextResponse.redirect(
      new URL(`${redirectBase}?gmail=error&reason=server_error`, request.url)
    );
  }
}
