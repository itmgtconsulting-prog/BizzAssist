/**
 * DELETE /api/tokens/[id]  — Revoke an API token (soft-delete)
 *
 * Auth: authenticated Supabase session required.
 * The calling user must be the token owner OR a tenant admin.
 *
 * Sets `revoked = true` on the token. The row is never hard-deleted so
 * the audit trail is preserved (ISO 27001 A.12 — Audit logging).
 *
 * After revocation the token is immediately rejected by the verify endpoint.
 *
 * @module api/tokens/[id]
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient, tenantDb } from '@/lib/supabase/admin';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolves the authenticated user's tenant membership including their role.
 * Returns null if the user is unauthenticated or has no tenant membership.
 *
 * @param userId - The authenticated Supabase user UUID
 * @returns Object with tenantId and role, or null
 */
async function resolveTenantMembership(
  userId: string
): Promise<{ tenantId: string; role: string } | null> {
  const adminClient = createAdminClient();
  const { data } = await adminClient
    .from('tenant_memberships')
    .select('tenant_id, role')
    .eq('user_id', userId)
    .limit(1)
    .single();

  if (!data?.tenant_id) return null;
  return {
    tenantId: data.tenant_id,
    role: data.role,
  };
}

// ─── DELETE /api/tokens/[id] ─────────────────────────────────────────────────

/**
 * Revokes a specific API token by setting revoked=true.
 *
 * Only the token owner or a tenant admin may revoke a token.
 * Revoking an already-revoked token is idempotent (returns 204).
 *
 * @param request   - Incoming Next.js request
 * @param routeCtx  - Route context containing `params.id`
 * @returns 204 No Content on success, or an error response
 */
export async function DELETE(
  request: NextRequest,
  routeCtx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited as unknown as NextResponse;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const membership = await resolveTenantMembership(user.id);
  if (!membership) {
    return NextResponse.json({ error: 'Ingen tenant-tilknytning fundet' }, { status: 403 });
  }

  // ── Parse and validate token ID ──
  const { id: idStr } = await routeCtx.params;
  const id = parseInt(idStr, 10);
  if (isNaN(id) || id <= 0) {
    return NextResponse.json({ error: 'Ugyldig token-id' }, { status: 400 });
  }

  try {
    // ── Fetch the token to verify ownership ──
    const { data: token, error: fetchError } = await tenantDb(membership.tenantId)
      .from('api_tokens')
      .select('id, tenant_id, user_id, revoked')
      .eq('id', id)
      .eq('tenant_id', membership.tenantId)
      .single();

    if (fetchError || !token) {
      return NextResponse.json({ error: 'Token ikke fundet' }, { status: 404 });
    }

    // Already revoked — idempotent success
    if (token.revoked) {
      return new NextResponse(null, { status: 204 });
    }

    // ── Authorization: must be owner or admin ──
    const isOwner = token.user_id === user.id;
    const isAdmin = membership.role === 'tenant_admin';
    if (!isOwner && !isAdmin) {
      return NextResponse.json(
        { error: 'Kun tokenejer eller admin kan tilbagekalde denne nøgle' },
        { status: 403 }
      );
    }

    // ── Soft-revoke ──
    const { error: updateError } = await tenantDb(membership.tenantId)
      .from('api_tokens')
      .update({ revoked: true })
      .eq('id', id)
      .eq('tenant_id', membership.tenantId)
      .select('id')
      .single();

    if (updateError) throw updateError;

    // Audit log — fire-and-forget (ISO 27001 A.12.4 — access token lifecycle)
    void createAdminClient()
      .from('audit_log')
      .insert({
        action: 'api_token.revoke',
        resource_type: 'api_token',
        resource_id: String(id),
        metadata: JSON.stringify({
          tenantId: membership.tenantId,
          userId: user.id,
          revokedBy: isOwner ? 'owner' : 'admin',
        }),
      });

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    console.error('[tokens/[id]] DELETE fejlede:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
