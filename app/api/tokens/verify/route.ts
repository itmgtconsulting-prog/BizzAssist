/**
 * POST /api/tokens/verify  — Verify a bearer token and return its claims
 *
 * This is an internal middleware helper used by public enterprise API routes
 * (e.g. /api/v1/properties/[bfe]) to authenticate incoming requests.
 *
 * Flow:
 *   1. Parse the raw token from the request body
 *   2. Compute its SHA-256 hash
 *   3. Look it up in tenant.api_tokens where revoked=false
 *   4. Check for expiry
 *   5. Update last_used timestamp (fire-and-forget, non-blocking)
 *   6. Return { valid: true, tenantId, scopes } or { valid: false }
 *
 * Security:
 *   • The endpoint is rate-limited at the standard API rate (60 req/min per IP).
 *   • It NEVER returns the token hash or any PII (ISO 27001 A.9).
 *   • last_used updates are fire-and-forget so a slow DB does not block callers.
 *
 * This route is intended for server-to-server calls only.
 * It should not be called directly from client-side code.
 *
 * @module api/tokens/verify
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { logger } from '@/app/lib/logger';
import { parseBody } from '@/app/lib/validate';
import { writeAuditLog } from '@/app/lib/auditLog';

/** Zod schema for POST /api/tokens/verify request body */
const verifyTokenSchema = z
  .object({
    token: z.string().trim().min(1),
  })
  .passthrough();

// ─── Types ───────────────────────────────────────────────────────────────────

/** Row fetched from tenant.api_tokens during verification. */
interface TokenLookupRow {
  id: number;
  tenant_id: string;
  scopes: string[];
  expires_at: string | null;
  revoked: boolean;
}

/** Successful verification response body. */
interface VerifySuccessResponse {
  valid: true;
  tenantId: string;
  scopes: string[];
}

/** Failure response body — no details to avoid information leakage. */
interface VerifyFailureResponse {
  valid: false;
}

/** Union of all possible verify response shapes. */
type VerifyResponse = VerifySuccessResponse | VerifyFailureResponse;

// ─── Supabase schema helpers ──────────────────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Computes the SHA-256 hex digest of a token string.
 * Mirrors the hashing done at token creation time in /api/tokens (POST).
 *
 * @param input - The raw bearer token string to hash
 * @returns Lowercase hex SHA-256 digest
 */
async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Asynchronously records the current timestamp as last_used for a token row.
 * Called fire-and-forget after a successful verify so it does not add latency.
 *
 * @param tokenId - The numeric primary key of the api_tokens row to update
 */
function touchLastUsed(tokenId: number): void {
  const adminClient = createAdminClient();
  // Intentionally not awaited — background update
  void (adminClient as unknown as AdminSchema)
    .schema('tenant')
    .from('api_tokens')
    .update({ last_used: new Date().toISOString() })
    .eq('id', tokenId);
}

// ─── POST /api/tokens/verify ─────────────────────────────────────────────────

/**
 * Verifies a raw bearer token and returns its associated claims.
 *
 * Expected body: { token: string }
 * Returns:
 *   200 { valid: true, tenantId, scopes } — token is valid
 *   200 { valid: false }                  — token not found, revoked, or expired
 *   400 { error }                         — malformed request body
 *   429                                   — rate limit exceeded
 *
 * Intentionally returns 200 with valid:false (not 401) so callers can
 * distinguish "verify endpoint error" from "token rejected" easily.
 *
 * @param request - Incoming Next.js request with JSON body { token: string }
 * @returns JSON VerifyResponse
 */
export async function POST(
  request: NextRequest
): Promise<NextResponse<VerifyResponse | { error: string }>> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited as unknown as NextResponse<VerifyResponse | { error: string }>;

  // ── Parse body ──
  const parsed = await parseBody(request, verifyTokenSchema);
  if (!parsed.success)
    return parsed.response as unknown as NextResponse<VerifyResponse | { error: string }>;
  const token = parsed.data.token;

  // ── Basic format check — tokens always start with "bza_" ──
  if (!token.startsWith('bza_')) {
    return NextResponse.json<VerifyFailureResponse>({ valid: false });
  }

  try {
    const tokenHash = await sha256Hex(token);
    const adminClient = createAdminClient();

    const { data: row } = await (adminClient as unknown as AdminSchema)
      .schema('tenant')
      .from('api_tokens')
      .select('id, tenant_id, scopes, expires_at, revoked')
      .eq('token_hash', tokenHash)
      .eq('revoked', false)
      .single();

    // Not found or already revoked
    if (!row) {
      return NextResponse.json<VerifyFailureResponse>({ valid: false });
    }

    // Check expiry
    if (row.expires_at !== null && new Date(row.expires_at) < new Date()) {
      return NextResponse.json<VerifyFailureResponse>({ valid: false });
    }

    // Fire-and-forget last_used update (non-blocking)
    touchLastUsed(row.id);

    // Audit: api token used (fire-and-forget — ISO 27001 A.12.4)
    void writeAuditLog({
      action: 'api_token_used',
      resource_type: 'api_token',
      resource_id: String(row.id),
      metadata: JSON.stringify({ tenant_id: row.tenant_id, scopes: row.scopes }),
    });

    return NextResponse.json<VerifySuccessResponse>({
      valid: true,
      tenantId: row.tenant_id,
      scopes: row.scopes,
    });
  } catch (err) {
    logger.error('[tokens/verify] POST fejlede:', err);
    // Return invalid rather than 500 to avoid leaking DB errors to callers
    return NextResponse.json<VerifyFailureResponse>({ valid: false });
  }
}
