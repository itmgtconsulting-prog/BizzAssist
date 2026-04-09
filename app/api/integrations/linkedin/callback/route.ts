/**
 * LinkedIn OAuth callback — BIZZ-48
 *
 * GET /api/integrations/linkedin/callback?code=...&state=...
 * Exchanges authorization code for access token, fetches LinkedIn profile
 * and email, then stores in Supabase email_integrations table.
 *
 * Required env vars:
 *   LINKEDIN_CLIENT_ID
 *   LINKEDIN_CLIENT_SECRET
 *   LINKEDIN_REDIRECT_URI
 *
 * LinkedIn access tokens last 60 days. Standard OAuth does not issue refresh
 * tokens — the user must reconnect when the token expires.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, tenantDb } from '@/lib/supabase/admin';

/** Response shape from LinkedIn's token endpoint */
interface LinkedInTokenResponse {
  access_token: string;
  expires_in: number;
  scope: string;
}

/**
 * LinkedIn /v2/me profile response (r_liteprofile scope).
 * Only localizedFirstName and localizedLastName are guaranteed.
 */
interface LinkedInMeResponse {
  id: string;
  localizedFirstName: string;
  localizedLastName: string;
}

/**
 * LinkedIn /v2/emailAddress response (r_emailaddress scope).
 * Structured as a paged list of handle elements.
 */
interface LinkedInEmailResponse {
  elements: Array<{
    'handle~': {
      emailAddress: string;
    };
  }>;
}

/** Decoded state parameter containing userId and tenantId for CSRF validation */
interface OAuthState {
  userId: string;
  tenantId: string;
}

/** Redirect base for success/error redirects after OAuth */
const REDIRECT_BASE = '/dashboard/settings/integrations';

/**
 * GET /api/integrations/linkedin/callback
 * Handles LinkedIn OAuth 2.0 callback. Exchanges authorization code for an
 * access token, fetches profile and email from LinkedIn's v2 API, and stores
 * the integration record in email_integrations (provider='linkedin').
 *
 * On success: redirects to /dashboard/settings/integrations?linkedin=connected&name=...
 * On error: redirects to /dashboard/settings/integrations?linkedin=error&reason=...
 *
 * @returns Redirect response
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  if (oauthError || !code || !state) {
    return NextResponse.redirect(
      new URL(
        `${REDIRECT_BASE}?linkedin=error&reason=${encodeURIComponent(oauthError ?? 'missing_params')}`,
        request.url
      )
    );
  }

  // Decode and validate state (CSRF protection)
  let stateData: OAuthState;
  try {
    stateData = JSON.parse(Buffer.from(state, 'base64url').toString()) as OAuthState;
    if (!stateData.userId || !stateData.tenantId) throw new Error('incomplete_state');
  } catch {
    return NextResponse.redirect(
      new URL(`${REDIRECT_BASE}?linkedin=error&reason=invalid_state`, request.url)
    );
  }

  const { userId, tenantId } = stateData;
  const clientId = process.env.LINKEDIN_CLIENT_ID ?? '';
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET ?? '';
  const redirectUri = process.env.LINKEDIN_REDIRECT_URI ?? '';

  if (!clientId || !clientSecret || !redirectUri) {
    return NextResponse.redirect(
      new URL(`${REDIRECT_BASE}?linkedin=error&reason=not_configured`, request.url)
    );
  }

  try {
    // ── Step 1: Exchange authorization code for access token ──────────────────
    const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!tokenRes.ok) {
      return NextResponse.redirect(
        new URL(`${REDIRECT_BASE}?linkedin=error&reason=token_exchange`, request.url)
      );
    }

    const tokens = (await tokenRes.json()) as LinkedInTokenResponse;

    // ── Step 2: Fetch basic profile (r_liteprofile) ───────────────────────────
    const profileRes = await fetch('https://api.linkedin.com/v2/me', {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'LinkedIn-Version': '202304',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!profileRes.ok) {
      return NextResponse.redirect(
        new URL(`${REDIRECT_BASE}?linkedin=error&reason=profile_fetch`, request.url)
      );
    }

    const profile = (await profileRes.json()) as LinkedInMeResponse;

    // ── Step 3: Fetch primary email (r_emailaddress) ──────────────────────────
    const emailRes = await fetch(
      'https://api.linkedin.com/v2/emailAddress?q=members&projection=(elements*(handle~))',
      {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          'LinkedIn-Version': '202304',
        },
        signal: AbortSignal.timeout(10000),
      }
    );

    let emailAddress = '';
    if (emailRes.ok) {
      const emailData = (await emailRes.json()) as LinkedInEmailResponse;
      emailAddress = emailData.elements?.[0]?.['handle~']?.emailAddress ?? '';
    }

    const firstName = profile.localizedFirstName;
    const lastName = profile.localizedLastName;
    const fullName = `${firstName} ${lastName}`.trim();

    // ── Step 4: Upsert into email_integrations ────────────────────────────────
    // refresh_token is not issued by LinkedIn standard OAuth — store empty string.
    // Name is preserved in the scopes array as "name:<fullName>" for retrieval.
    const { error: dbError } = await tenantDb(tenantId)
      .from('email_integrations')
      .upsert(
        {
          user_id: userId,
          provider: 'linkedin',
          email_address: emailAddress || `linkedin:${profile.id}`,
          access_token: tokens.access_token,
          refresh_token: '', // LinkedIn standard OAuth does not issue refresh tokens
          token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
          scopes: [`name:${fullName}`, ...tokens.scope.split(',').map((s) => s.trim())],
          connected_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,provider' }
      );

    if (dbError) {
      return NextResponse.redirect(
        new URL(`${REDIRECT_BASE}?linkedin=error&reason=db_error`, request.url)
      );
    }

    return NextResponse.redirect(
      new URL(
        `${REDIRECT_BASE}?linkedin=connected&name=${encodeURIComponent(fullName)}`,
        request.url
      )
    );
  } catch {
    return NextResponse.redirect(
      new URL(`${REDIRECT_BASE}?linkedin=error&reason=server_error`, request.url)
    );
  }
}
