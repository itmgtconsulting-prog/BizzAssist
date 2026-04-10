/**
 * GET  /api/tokens  — List all non-revoked API tokens for the current tenant
 * POST /api/tokens  — Create a new enterprise API token
 *
 * Auth: authenticated Supabase session required.
 *
 * GET response: array of ApiTokenRecord (metadata only — never the raw token).
 *
 * POST body: { name: string; scopes: string[]; expiresInDays?: number }
 * POST response: { token: string; record: ApiTokenRecord }
 *   The `token` field contains the FULL plaintext bearer token.
 *   It is returned exactly once and cannot be retrieved again.
 *
 * Token format: "bza_" + 32 random bytes encoded as base64url (no padding).
 * Only the SHA-256 hex digest is persisted in the database.
 *
 * Retention: indefinite while tenant is active; cascade on offboarding.
 * GDPR: rows carry tenant_id + user_id — can be deleted on user account removal.
 * ISO 27001 A.9: token hash stored, plaintext never persisted.
 *
 * @module api/tokens
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient, tenantDb } from '@/lib/supabase/admin';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum number of active tokens allowed per tenant. */
const MAX_TOKENS_PER_TENANT = 20;

/** Valid scope values for API token permissions. */
const VALID_SCOPES = ['read:properties', 'read:companies', 'read:people', 'read:ai'] as const;

/** Union type of all valid token scope strings. */
type TokenScope = (typeof VALID_SCOPES)[number];

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A single API token record as stored in tenant.api_tokens.
 * The token_hash is omitted — the client never receives the hash.
 */
export interface ApiTokenRecord {
  id: number;
  tenant_id: string;
  user_id: string;
  name: string;
  prefix: string;
  scopes: string[];
  last_used: string | null;
  expires_at: string | null;
  revoked: boolean;
  created_at: string;
}

/** Expected POST request body shape. */
interface CreateTokenBody {
  name: string;
  scopes: string[];
  expiresInDays?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolves the authenticated user's tenant_id from the public schema.
 * Returns null if the user has no tenant membership.
 *
 * @param userId - The authenticated Supabase user UUID
 * @returns Object with tenantId, or null
 */
async function resolveTenantId(userId: string): Promise<{ tenantId: string } | null> {
  const adminClient = createAdminClient();

  // The admin client uses the public schema by default — no .schema() call needed
  const { data: membership } = await adminClient
    .from('tenant_memberships')
    .select('tenant_id')
    .eq('user_id', userId)
    .limit(1)
    .single();

  if (!membership?.tenant_id) return null;
  return { tenantId: membership.tenant_id };
}

/**
 * Generates a cryptographically secure API token.
 * Format: "bza_" + 32 random bytes as base64url (no padding, 43 chars).
 * Total length: ~47 characters.
 *
 * Uses the Web Crypto API (available in both Node.js 20+ and Edge Runtime).
 *
 * @returns The raw plaintext bearer token string
 */
function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const base64 = Buffer.from(bytes).toString('base64url');
  return `bza_${base64}`;
}

/**
 * Computes the SHA-256 hex digest of a string.
 * Uses the Web Crypto API — no external dependencies.
 *
 * @param input - The string to hash (e.g. the raw bearer token)
 * @returns Lowercase hex SHA-256 digest
 */
async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ─── GET /api/tokens ─────────────────────────────────────────────────────────

/**
 * Lists all non-revoked API tokens for the authenticated user's tenant.
 * Returns metadata only — the raw token and hash are never included.
 *
 * @param request - Incoming Next.js request
 * @returns JSON array of ApiTokenRecord
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited as unknown as NextResponse;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const membership = await resolveTenantId(user.id);
  if (!membership) {
    return NextResponse.json({ error: 'Ingen tenant-tilknytning fundet' }, { status: 403 });
  }

  try {
    const { data, error } = await tenantDb(membership.tenantId)
      .from('api_tokens')
      .select(
        'id, tenant_id, user_id, name, prefix, scopes, last_used, expires_at, revoked, created_at'
      )
      .eq('tenant_id', membership.tenantId)
      .eq('revoked', false)
      .order('created_at', { ascending: false })
      .limit(MAX_TOKENS_PER_TENANT);

    if (error) throw error;

    return NextResponse.json(data ?? []);
  } catch (err) {
    console.error('[tokens] GET fejlede:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}

// ─── POST /api/tokens ────────────────────────────────────────────────────────

/**
 * Creates a new enterprise API token for the authenticated tenant.
 *
 * Flow:
 *   1. Validate request body (name, scopes, optional expiresInDays)
 *   2. Check tenant has fewer than MAX_TOKENS_PER_TENANT active tokens
 *   3. Generate a cryptographically random token
 *   4. Hash with SHA-256 and store the hash (NEVER the plaintext)
 *   5. Return the plaintext token exactly once in the response
 *
 * @param request - Incoming Next.js request with JSON body
 * @returns { token: string; record: ApiTokenRecord } — token is the FULL bearer value
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited as unknown as NextResponse;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const membership = await resolveTenantId(user.id);
  if (!membership) {
    return NextResponse.json({ error: 'Ingen tenant-tilknytning fundet' }, { status: 403 });
  }

  // ── Parse body ──
  let body: CreateTokenBody;
  try {
    body = (await request.json()) as CreateTokenBody;
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  const { name, scopes, expiresInDays } = body;

  // ── Validate name ──
  if (typeof name !== 'string' || name.trim().length === 0) {
    return NextResponse.json({ error: 'name er påkrævet' }, { status: 400 });
  }
  if (name.trim().length > 100) {
    return NextResponse.json({ error: 'name må maks være 100 tegn' }, { status: 400 });
  }

  // ── Validate scopes ──
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return NextResponse.json({ error: 'Mindst ét scope er påkrævet' }, { status: 400 });
  }
  const invalidScopes = scopes.filter((s) => !VALID_SCOPES.includes(s as TokenScope));
  if (invalidScopes.length > 0) {
    return NextResponse.json(
      {
        error: `Ugyldige scopes: ${invalidScopes.join(', ')}. Tilladte: ${VALID_SCOPES.join(', ')}`,
      },
      { status: 400 }
    );
  }

  // ── Validate expiresInDays ──
  let expiresAt: string | null = null;
  if (expiresInDays !== undefined) {
    if (
      typeof expiresInDays !== 'number' ||
      !Number.isInteger(expiresInDays) ||
      expiresInDays < 1 ||
      expiresInDays > 3650
    ) {
      return NextResponse.json(
        { error: 'expiresInDays skal være et heltal mellem 1 og 3650' },
        { status: 400 }
      );
    }
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + expiresInDays);
    expiresAt = expiry.toISOString();
  }

  try {
    // ── Check token count limit ──
    const { data: existing } = await tenantDb(membership.tenantId)
      .from('api_tokens')
      .select('id')
      .eq('tenant_id', membership.tenantId)
      .eq('revoked', false)
      .limit(MAX_TOKENS_PER_TENANT);

    if (existing && existing.length >= MAX_TOKENS_PER_TENANT) {
      return NextResponse.json(
        { error: `Maks ${MAX_TOKENS_PER_TENANT} aktive nøgler pr. tenant` },
        { status: 422 }
      );
    }

    // ── Generate and hash token ──
    const rawToken = generateToken();
    const tokenHash = await sha256Hex(rawToken);

    // Prefix: first 12 chars of the raw token shown in UI (e.g. "bza_xYzA1234")
    const prefix = rawToken.slice(0, 12);

    // ── Insert into DB ──
    const { data: record, error } = await tenantDb(membership.tenantId)
      .from('api_tokens')
      .insert({
        tenant_id: membership.tenantId,
        user_id: user.id,
        name: name.trim(),
        token_hash: tokenHash,
        prefix,
        scopes,
        expires_at: expiresAt,
        revoked: false,
      })
      .select(
        'id, tenant_id, user_id, name, prefix, scopes, last_used, expires_at, revoked, created_at'
      )
      .single();

    if (error) throw error;

    // Audit log — fire-and-forget (ISO 27001 A.12.4 — access token lifecycle)
    void createAdminClient()
      .from('audit_log')
      .insert({
        action: 'api_token.create',
        resource_type: 'api_token',
        resource_id: record ? String(record.id) : '',
        metadata: JSON.stringify({
          tenantId: membership.tenantId,
          userId: user.id,
          tokenName: name.trim(),
          scopes,
          prefix,
        }),
      });

    // ── Return plaintext token ONCE — it cannot be retrieved again ──
    return NextResponse.json({ token: rawToken, record }, { status: 201 });
  } catch (err) {
    console.error('[tokens] POST fejlede:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
