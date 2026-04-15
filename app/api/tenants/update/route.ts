/**
 * Tenant update API — PATCH /api/tenants/update
 *
 * Allows the tenant admin to update the organisation name.
 *
 * Authentication: Supabase session cookie (server-side).
 * Authorization:  Caller must hold role 'tenant_admin' in their tenant.
 *
 * Request body: { name: string }
 * Response:     { success: true } | { error: string }
 *
 * Data retention: tenants table — no additional retention beyond the tenant lifetime.
 *
 * @module api/tenants/update
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';
import { parseBody } from '@/app/lib/validate';

/** Zod schema for PATCH /api/tenants/update request body */
const tenantUpdateSchema = z.object({
  name: z.string().min(1),
}).passthrough();

// ─── Types ────────────────────────────────────────────────────────────────────

/** Expected PATCH request body */
interface UpdateTenantBody {
  name: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the authenticated user's tenant ID and role via the user-scoped client.
 * Returns null if unauthenticated or if the user has no tenant membership.
 *
 * @returns Tenant context or null
 */
async function resolveAuth(): Promise<{ userId: string; tenantId: string; role: string } | null> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    // Use admin client to bypass RLS for the membership lookup
    const admin = createAdminClient();
    const { data } = await admin
      .from('tenant_memberships')
      .select('tenant_id, role')
      .eq('user_id', user.id)
      .limit(1)
      .single();

    if (!data) return null;
    return { userId: user.id, tenantId: data.tenant_id, role: data.role };
  } catch {
    return null;
  }
}

// ─── Route Handler ────────────────────────────────────────────────────────────

/**
 * PATCH /api/tenants/update
 *
 * Updates the name of the authenticated user's tenant.
 * Only tenant admins are permitted to call this endpoint.
 *
 * @param request - Next.js server request with JSON body { name: string }
 * @returns JSON { success: true } or { error: string }
 */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveAuth();
  if (!auth) {
    return NextResponse.json({ error: 'Ikke godkendt' }, { status: 401 });
  }

  if (auth.role !== 'tenant_admin') {
    return NextResponse.json(
      { error: 'Kun tenant-administratorer kan opdatere organisationsdata' },
      { status: 403 }
    );
  }

  const parsed = await parseBody(request, tenantUpdateSchema);
  if (!parsed.success) return parsed.response;

  const name = parsed.data.name?.trim();
  if (!name || name.length < 2) {
    return NextResponse.json({ error: 'Virksomhedsnavn skal være mindst 2 tegn' }, { status: 422 });
  }
  if (name.length > 200) {
    return NextResponse.json(
      { error: 'Virksomhedsnavn er for langt (max 200 tegn)' },
      { status: 422 }
    );
  }

  try {
    const admin = createAdminClient();

    // Update tenant name
    const { error } = await admin
      .from('tenants')
      .update({ name, updated_at: new Date().toISOString() })
      .eq('id', auth.tenantId);

    if (error) {
      logger.error('[tenants/update] Supabase error:', (error as { message: string }).message);
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }

    // Audit log — fire-and-forget (same pattern as other routes)
    void admin.from('audit_log').insert({
      action: 'tenant.update',
      resource_type: 'tenant',
      resource_id: auth.tenantId,
      metadata: JSON.stringify({ updatedFields: ['name'], userId: auth.userId }),
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Intern serverfejl' }, { status: 500 });
  }
}
