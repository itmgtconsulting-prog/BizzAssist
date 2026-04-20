/**
 * LinkedIn OAuth authorization redirect — BIZZ-48
 *
 * GET /api/integrations/linkedin/auth
 * Redirects user to LinkedIn's OAuth consent screen.
 *
 * Required env vars:
 *   LINKEDIN_CLIENT_ID    - LinkedIn App Client ID
 *   LINKEDIN_REDIRECT_URI - Must match LinkedIn App settings exactly
 *
 * Scopes requested:
 *   - r_liteprofile     — Read basic profile (name, ID)
 *   - r_emailaddress    — Read primary email address
 *
 * Note: w_member_social (post on behalf of user) is omitted from the initial
 * request as enrichment is read-only. Add it when posting features are built.
 * Profile enrichment APIs (people search) require LinkedIn Partner Program —
 * see /api/integrations/linkedin/enrich for details.
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { logger } from '@/app/lib/logger';

/** Scopes for basic LinkedIn profile + email read access */
const SCOPES = ['r_liteprofile', 'r_emailaddress'].join(' ');

/**
 * GET /api/integrations/linkedin/auth
 * Builds the LinkedIn OAuth URL with state parameter and redirects.
 * State carries { userId, tenantId } encoded as base64url JSON for CSRF protection.
 *
 * @returns 302 redirect to LinkedIn OAuth consent screen, or 401/503 on error
 */
export async function GET(_request: NextRequest): Promise<NextResponse> {
  // BIZZ-598: Wrap i try/catch — manglende auth/env-håndtering bør ikke
  // kaskade til klienten. Logger til Sentry via logger-wrapper.
  try {
    const auth = await resolveTenantId();
    if (!auth) return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 });

    const clientId = process.env.LINKEDIN_CLIENT_ID;
    const redirectUri = process.env.LINKEDIN_REDIRECT_URI;

    if (!clientId || !redirectUri) {
      return NextResponse.json(
        {
          error:
            'LinkedIn integration not configured. Add LINKEDIN_CLIENT_ID and LINKEDIN_REDIRECT_URI to environment variables.',
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
      state,
    });

    return NextResponse.redirect(
      `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`
    );
  } catch (err) {
    logger.error('[linkedin/auth] Uventet fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
