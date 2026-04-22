/**
 * Admin domain detail API — get/update/delete + suspend/activate.
 *
 * BIZZ-701: Super-admin only.
 *
 * GET    /api/admin/domains/:id — detail with counts
 * PATCH  /api/admin/domains/:id — update settings/plan/limits
 * DELETE /api/admin/domains/:id — hard delete (cascade)
 *
 * POST body actions:
 *   { action: 'suspend' } — suspend domain
 *   { action: 'activate' } — reactivate domain
 *
 * @module api/admin/domains/[id]
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { resolveTenantId } from '@/lib/api/auth';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { logger } from '@/app/lib/logger';

/** Validates super-admin access. */
async function requireSuperAdmin(): Promise<string | null> {
  const auth = await resolveTenantId();
  if (!auth) return null;
  const admin = createAdminClient();
  const { data: freshUser } = await admin.auth.admin.getUserById(auth.userId);
  if (!freshUser?.user?.app_metadata?.isAdmin) return null;
  return auth.userId;
}

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/admin/domains/:id — domain detail with member/template/case counts.
 */
export async function GET(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const userId = await requireSuperAdmin();
  if (!userId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await context.params;
  const admin = createAdminClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: domain } = (await (admin as any)
    .from('domain')
    .select('*')
    .eq('id', id)
    .maybeSingle()) as { data: Record<string, unknown> | null };

  if (!domain) return NextResponse.json({ error: 'Domain not found' }, { status: 404 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = admin as any;
  const [members, templates, cases] = await Promise.all([
    a.from('domain_member').select('id, user_id, role, joined_at').eq('domain_id', id),
    a.from('domain_template').select('id', { count: 'exact', head: true }).eq('domain_id', id),
    a.from('domain_case').select('id', { count: 'exact', head: true }).eq('domain_id', id),
  ]);

  return NextResponse.json({
    ...domain,
    members: members.data ?? [],
    memberCount: members.data?.length ?? 0,
    templateCount: templates.count ?? 0,
    caseCount: cases.count ?? 0,
  });
}

/**
 * PATCH /api/admin/domains/:id — update domain settings/plan/limits/status.
 */
export async function PATCH(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const userId = await requireSuperAdmin();
  if (!userId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await context.params;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Support action-based status changes
  const action = body.action as string | undefined;
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = admin as any;

  if (action === 'suspend' || action === 'activate') {
    const newStatus = action === 'suspend' ? 'suspended' : 'active';
    const { error } = await a
      .from('domain')
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await a.from('domain_audit_log').insert({
      domain_id: id,
      actor_user_id: userId,
      action: action === 'suspend' ? 'suspend_domain' : 'activate_domain',
      target_type: 'domain',
      target_id: id,
    });

    return NextResponse.json({ ok: true, status: newStatus });
  }

  // General update — name, settings, plan, limits
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.name === 'string') update.name = body.name.trim();
  if (typeof body.plan === 'string') update.plan = body.plan;
  if (body.limits) update.limits = body.limits;
  if (body.settings) update.settings = body.settings;

  const { data, error } = await a.from('domain').update(update).eq('id', id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await a.from('domain_audit_log').insert({
    domain_id: id,
    actor_user_id: userId,
    action: 'update_domain',
    target_type: 'domain',
    target_id: id,
    metadata: update,
  });

  return NextResponse.json(data);
}

/**
 * DELETE /api/admin/domains/:id — hard delete domain (CASCADE deletes all related data).
 */
export async function DELETE(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const userId = await requireSuperAdmin();
  if (!userId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await context.params;
  const admin = createAdminClient();

  // Audit BEFORE delete (cascade will remove audit_log too, so log in tenant audit)
  logger.log(`[admin/domains] Super-admin ${userId} deleting domain ${id}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin as any).from('domain').delete().eq('id', id);
  if (error) {
    logger.error('[admin/domains] Delete error:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
