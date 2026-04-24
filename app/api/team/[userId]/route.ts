/**
 * PATCH /api/team/[userId] — ændre role for et eksisterende medlem.
 * DELETE /api/team/[userId] — fjern medlem fra tenant.
 *
 * BIZZ-271: Kun tenant_admin. Begge handlinger kræver at target-user
 * allerede er medlem af den kaldende admins tenant (cross-tenant attacks
 * er blokeret fordi update/delete køres med tenant-filter).
 *
 * Safety-invariants:
 *   - Admin kan ikke ændre sin egen rolle (undgå self-demote-lockout —
 *     leave-endpoint håndterer eget-exit)
 *   - Sidste admin-row i tenant kan ikke fjernes (tenant ville være uden admin)
 *
 * @module app/api/team/[userId]
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireTenantAdmin } from '@/app/lib/teamAuth';
import { writeAuditLog } from '@/app/lib/auditLog';
import { logger } from '@/app/lib/logger';

type RouteContext = { params: Promise<{ userId: string }> };

const patchSchema = z.object({
  role: z.enum(['tenant_admin', 'tenant_member', 'tenant_viewer']),
});

/**
 * Tæl antal tenant_admins i tenant. Bruges til at forhindre at sidste
 * admin fjernes eller degraderes.
 */
async function countAdmins(adminClient: ReturnType<typeof createAdminClient>, tenantId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count } = await (adminClient as any)
    .from('tenant_memberships')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('role', 'tenant_admin');
  return typeof count === 'number' ? count : 0;
}

export async function PATCH(req: NextRequest, context: RouteContext): Promise<NextResponse> {
  const ctx = await requireTenantAdmin();
  if (!ctx) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { userId: targetUserId } = await context.params;
  if (targetUserId === ctx.userId) {
    return NextResponse.json({ error: 'Du kan ikke ændre din egen rolle' }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Input-fejl' }, { status: 400 });
  }
  const { role: newRole } = parsed.data;

  try {
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: existing } = (await (admin as any)
      .from('tenant_memberships')
      .select('id, role')
      .eq('tenant_id', ctx.tenantId)
      .eq('user_id', targetUserId)
      .maybeSingle()) as { data: { id: string; role: string } | null };

    if (!existing) {
      return NextResponse.json({ error: 'Medlem ikke fundet' }, { status: 404 });
    }
    if (existing.role === newRole) {
      return NextResponse.json({ success: true, noop: true });
    }

    // Guard: Hvis vi degraderer en admin til non-admin, sikre at der er
    // mindst én anden admin tilbage.
    if (existing.role === 'tenant_admin' && newRole !== 'tenant_admin') {
      const adminCount = await countAdmins(admin, ctx.tenantId);
      if (adminCount <= 1) {
        return NextResponse.json(
          { error: 'Kan ikke degradere sidste admin. Udnævn en anden admin først.' },
          { status: 409 }
        );
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (admin as any)
      .from('tenant_memberships')
      .update({ role: newRole })
      .eq('id', existing.id);
    if (error) {
      logger.error('[team/[userId] PATCH] db error:', error.message);
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }

    void writeAuditLog({
      action: 'team.role_changed',
      resource_type: 'tenant_membership',
      resource_id: existing.id,
      metadata: JSON.stringify({
        tenant_id: ctx.tenantId,
        target_user_id: targetUserId,
        from_role: existing.role,
        to_role: newRole,
      }),
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error('[team/[userId] PATCH]', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  const ctx = await requireTenantAdmin();
  if (!ctx) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { userId: targetUserId } = await context.params;
  if (targetUserId === ctx.userId) {
    return NextResponse.json(
      { error: 'Du kan ikke fjerne dig selv. Brug /api/team/leave.' },
      { status: 400 }
    );
  }

  try {
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: existing } = (await (admin as any)
      .from('tenant_memberships')
      .select('id, role')
      .eq('tenant_id', ctx.tenantId)
      .eq('user_id', targetUserId)
      .maybeSingle()) as { data: { id: string; role: string } | null };

    if (!existing) {
      return NextResponse.json({ error: 'Medlem ikke fundet' }, { status: 404 });
    }

    // Sidste-admin-guard
    if (existing.role === 'tenant_admin') {
      const adminCount = await countAdmins(admin, ctx.tenantId);
      if (adminCount <= 1) {
        return NextResponse.json(
          { error: 'Kan ikke fjerne sidste admin. Udnævn en anden admin først.' },
          { status: 409 }
        );
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (admin as any)
      .from('tenant_memberships')
      .delete()
      .eq('id', existing.id);
    if (error) {
      logger.error('[team/[userId] DELETE] db error:', error.message);
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }

    void writeAuditLog({
      action: 'team.member_removed',
      resource_type: 'tenant_membership',
      resource_id: existing.id,
      metadata: JSON.stringify({
        tenant_id: ctx.tenantId,
        target_user_id: targetUserId,
        former_role: existing.role,
      }),
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error('[team/[userId] DELETE]', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
