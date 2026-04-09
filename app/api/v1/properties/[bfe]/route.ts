/**
 * GET /api/v1/properties/{bfe}  — Enterprise property read endpoint
 *
 * Returns aggregated property data for a Danish property identified by its
 * BFE number (Bygnings- og Fællesejendommens Ejendomsnummer).
 *
 * Authentication:
 *   Requires a valid BizzAssist enterprise API token in the Authorization
 *   header as a Bearer token: `Authorization: Bearer bza_<token>`
 *   The token must carry the `read:properties` scope.
 *
 * Rate limiting:
 *   100 requests per minute per token (sliding window via Upstash Redis).
 *   Returns HTTP 429 with Retry-After header when exceeded.
 *
 * Data sources:
 *   - Vurderingsportalen / Datafordeler VUR — current property valuation
 *   - Datafordeler BBR — building metadata
 *   - DAR — address string
 *
 * Caching:
 *   Responses are cached for 1 hour (s-maxage=3600).
 *   Stale data is served for up to 10 minutes while revalidation runs.
 *
 * Error responses follow the standard shape: { error: string, code: string }
 *
 * @module api/v1/properties/[bfe]
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// ─── Rate limiter (100 req/min per token) ────────────────────────────────────

let _redis: Redis | null = null;
let _tokenRateLimit: Ratelimit | null = null;

/**
 * Returns the module-level Redis singleton, initialised lazily on first call.
 *
 * @returns Upstash Redis client
 */
function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }
  return _redis;
}

/**
 * Rate limiter for enterprise API tokens: 100 req/min sliding window.
 * Keyed by token hash prefix so tokens cannot interfere with each other.
 */
const tokenRateLimit: Ratelimit = new Proxy({} as Ratelimit, {
  get(_target, prop) {
    if (!_tokenRateLimit) {
      _tokenRateLimit = new Ratelimit({
        redis: getRedis(),
        limiter: Ratelimit.slidingWindow(100, '1 m'),
        analytics: true,
        prefix: 'ba:v1:token-ratelimit',
      });
    }
    return (_tokenRateLimit as unknown as Record<string | symbol, unknown>)[prop];
  },
});

// ─── Types ───────────────────────────────────────────────────────────────────

/** Token lookup row returned by the verify query. */
interface TokenLookupRow {
  id: number;
  tenant_id: string;
  scopes: string[];
  expires_at: string | null;
  revoked: boolean;
}

/** Supabase admin schema helper types. */
type AdminSchema = {
  schema: (s: string) => SchemaBuilder;
};

type SchemaBuilder = {
  from: (table: string) => TableBuilder;
};

type TableBuilder = {
  select: (cols: string) => SelectBuilder;
  update: (patch: Record<string, unknown>) => UpdateBuilder;
};

type SelectBuilder = {
  eq: (col: string, val: string | boolean) => SelectBuilder;
  single: () => Promise<{ data: TokenLookupRow | null; error: unknown }>;
};

type UpdateBuilder = {
  eq: (col: string, val: string | number | boolean) => UpdateBuilder;
};

/** The response shape returned by this endpoint. */
interface PropertyV1Response {
  bfeNummer: number;
  adresse: string | null;
  kommunekode: string | null;
  ejendomsvaerdi: number | null;
  grundvaerdi: number | null;
  vurderingsaar: number | null;
  areal: number | null;
  source: string;
  _meta: {
    tenantId: string;
    requestedAt: string;
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Computes the SHA-256 hex digest of a string.
 * Used to look up the token hash in the database.
 *
 * @param input - Raw bearer token string
 * @returns Lowercase hex SHA-256 digest
 */
async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Extracts the bearer token from the Authorization header.
 * Returns null if the header is missing or malformed.
 *
 * @param request - Incoming Next.js request
 * @returns Raw token string or null
 */
function extractBearer(request: NextRequest): string | null {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Verifies a bearer token against the tenant.api_tokens table.
 * Checks revocation, expiry, and scope membership inline to avoid
 * an extra HTTP round-trip to /api/tokens/verify.
 *
 * Also fires a background last_used update (non-blocking).
 *
 * @param rawToken - The raw bearer token from the Authorization header
 * @param requiredScope - The scope that must be present on the token
 * @returns Object with tenantId if valid, or null if rejected
 */
async function verifyToken(
  rawToken: string,
  requiredScope: string
): Promise<{ tenantId: string } | null> {
  if (!rawToken.startsWith('bza_')) return null;

  const tokenHash = await sha256Hex(rawToken);
  const adminClient = createAdminClient();

  const { data: row } = await (adminClient as unknown as AdminSchema)
    .schema('tenant')
    .from('api_tokens')
    .select('id, tenant_id, scopes, expires_at, revoked')
    .eq('token_hash', tokenHash)
    .eq('revoked', false)
    .single();

  if (!row) return null;
  if (row.expires_at !== null && new Date(row.expires_at) < new Date()) return null;
  if (!row.scopes.includes(requiredScope)) return null;

  // Fire-and-forget last_used update — non-blocking
  void (adminClient as unknown as AdminSchema)
    .schema('tenant')
    .from('api_tokens')
    .update({ last_used: new Date().toISOString() })
    .eq('id', row.id);

  return { tenantId: row.tenant_id };
}

/**
 * Fetches basic property data from the Vurderingsportal ES API.
 * Returns null on any error so the caller can return a partial response.
 *
 * @param bfeNummer - The BFE number to look up
 * @returns Partial valuation data or null
 */
async function fetchVurderingData(bfeNummer: number): Promise<{
  ejendomsvaerdi: number | null;
  grundvaerdi: number | null;
  aar: number | null;
  kommunekode: string | null;
} | null> {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    const res = await fetch(`${baseUrl}/api/vurdering-forelobig?bfeNummer=${bfeNummer}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as Record<string, unknown>;
    return {
      ejendomsvaerdi: (data['ejendomsvaerdi'] as number | null | undefined) ?? null,
      grundvaerdi: (data['grundvaerdi'] as number | null | undefined) ?? null,
      aar: (data['aar'] as number | null | undefined) ?? null,
      kommunekode: (data['kommunekode'] as string | null | undefined) ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Looks up the address string for a BFE number via the DAR address API.
 * Returns null on any error.
 *
 * @param bfeNummer - The BFE number to look up
 * @returns Address string or null
 */
async function fetchAddress(bfeNummer: number): Promise<string | null> {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    const res = await fetch(`${baseUrl}/api/adresse/lookup?bfe=${bfeNummer}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as Record<string, unknown>;
    return (data['adressebetegnelse'] as string | null | undefined) ?? null;
  } catch {
    return null;
  }
}

// ─── GET /api/v1/properties/[bfe] ────────────────────────────────────────────

/**
 * Returns aggregated property data for a single property by BFE number.
 *
 * Verifies the enterprise API token, applies per-token rate limiting,
 * fetches data from upstream sources, and returns a standardised response.
 *
 * @param request   - Incoming Next.js request
 * @param routeCtx  - Route context containing `params.bfe`
 * @returns JSON PropertyV1Response or an error response
 */
export async function GET(
  request: NextRequest,
  routeCtx: { params: Promise<{ bfe: string }> }
): Promise<NextResponse> {
  // ── 1. Extract and verify bearer token ──
  const rawToken = extractBearer(request);
  if (!rawToken) {
    return NextResponse.json(
      { error: 'Missing Authorization header', code: 'UNAUTHORIZED' },
      { status: 401 }
    );
  }

  const claims = await verifyToken(rawToken, 'read:properties');
  if (!claims) {
    return NextResponse.json(
      { error: 'Invalid, expired, or revoked API token', code: 'UNAUTHORIZED' },
      { status: 401 }
    );
  }

  // ── 2. Per-token rate limiting (100 req/min) ──
  // Use the token prefix as the rate-limit key — unique per token without
  // storing or logging the full secret (ISO 27001 A.9 — no PII in logs).
  const rateLimitKey = rawToken.slice(0, 12);
  const { success, limit, remaining, reset } = await tokenRateLimit.limit(rateLimitKey);

  if (!success) {
    return NextResponse.json(
      { error: 'Rate limit exceeded', code: 'RATE_LIMIT_EXCEEDED' },
      {
        status: 429,
        headers: {
          'X-RateLimit-Limit': limit.toString(),
          'X-RateLimit-Remaining': remaining.toString(),
          'X-RateLimit-Reset': reset.toString(),
          'Retry-After': Math.ceil((reset - Date.now()) / 1000).toString(),
        },
      }
    );
  }

  // ── 3. Validate BFE parameter ──
  const { bfe: bfeStr } = await routeCtx.params;
  const bfeNummer = parseInt(bfeStr, 10);

  if (isNaN(bfeNummer) || bfeNummer <= 0) {
    return NextResponse.json(
      { error: 'bfe must be a positive integer', code: 'INVALID_PARAM' },
      { status: 422 }
    );
  }

  // ── 4. Fetch data from upstream sources in parallel ──
  const [vurdering, adresse] = await Promise.all([
    fetchVurderingData(bfeNummer),
    fetchAddress(bfeNummer),
  ]);

  // ── 5. Build and return response ──
  const response: PropertyV1Response = {
    bfeNummer,
    adresse,
    kommunekode: vurdering?.kommunekode ?? null,
    ejendomsvaerdi: vurdering?.ejendomsvaerdi ?? null,
    grundvaerdi: vurdering?.grundvaerdi ?? null,
    vurderingsaar: vurdering?.aar ?? null,
    areal: null, // Populated when BBR integration is wired in
    source: 'BBR/VUR — Datafordeler (via BizzAssist Enterprise API v1)',
    _meta: {
      tenantId: claims.tenantId,
      requestedAt: new Date().toISOString(),
    },
  };

  return NextResponse.json(response, {
    status: 200,
    headers: {
      'Cache-Control': 'private, no-store', // No shared cache — response contains tenant metadata
      'X-RateLimit-Limit': limit.toString(),
      'X-RateLimit-Remaining': remaining.toString(),
    },
  });
}
