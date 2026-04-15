/**
 * Shared Datafordeler OAuth token cache.
 *
 * Replaces per-route module-level _cachedToken variables with a single
 * shared cache. Prevents duplicate token requests when multiple routes
 * are called concurrently (e.g., property detail page loading vurdering +
 * ejerskab + salgshistorik simultaneously).
 *
 * BIZZ-251: Centralize Datafordeler OAuth token cache across all routes.
 *
 * @module app/lib/dfTokenCache
 */

import { logger } from '@/app/lib/logger';

const TOKEN_URL = 'https://auth.datafordeler.dk/realms/distribution/protocol/openid-connect/token';

/** Cached token with expiry timestamp */
let _cachedToken: { token: string; expiresAt: number } | null = null;

/** In-flight token request promise (mutex to prevent concurrent requests) */
let _tokenPromise: Promise<string | null> | null = null;

/**
 * Gets an OAuth token from Datafordeler using client_credentials grant.
 * Returns cached token if still valid (with 60s safety margin).
 * Uses mutex to prevent concurrent duplicate requests.
 *
 * @returns OAuth Bearer token, or null if credentials are missing or request fails
 */
export async function getSharedOAuthToken(): Promise<string | null> {
  const clientId = process.env.DATAFORDELER_OAUTH_CLIENT_ID;
  const clientSecret = process.env.DATAFORDELER_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) return null;

  // Return cached token if still valid (60s safety margin)
  if (_cachedToken && _cachedToken.expiresAt > Date.now() + 60_000) {
    return _cachedToken.token;
  }

  // If a token request is already in flight, await it
  if (_tokenPromise) return _tokenPromise;

  // Start new token request with mutex
  _tokenPromise = (async () => {
    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        logger.error(`[dfTokenCache] Token request failed: ${res.status}`);
        return null;
      }

      const json = (await res.json()) as { access_token: string; expires_in: number };
      _cachedToken = {
        token: json.access_token,
        expiresAt: Date.now() + json.expires_in * 1000,
      };

      return json.access_token;
    } catch (err) {
      logger.error('[dfTokenCache] Token request error:', err);
      return null;
    } finally {
      _tokenPromise = null;
    }
  })();

  return _tokenPromise;
}
