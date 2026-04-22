/**
 * Domain Admin Members API — manage users within a single domain.
 *
 * BIZZ-705: Endpoint that Domain Admin (not super-admin) can call to list,
 * invite, remove, and role-toggle members of their own domain.
 *
 * Difference from /api/admin/domains/:id/members (BIZZ-702):
 *   - This route requires assertDomainAdmin() — scoped to one domain.
 *   - Super-admin flag is NOT required.
 *   - Enforces domain.limits.max_users on invite (BIZZ-703).
 *   - Fail-safe: cannot remove the last admin of a domain.
 *
 * @module api/domain/[id]/admin/members
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertDomainAdmin } from '@/app/lib/domainAuth';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { logger } from '@/app/lib/logger';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET — list members with enriched email/name.
 */
export async function GET(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { id } = await context.params;

  try {
    await assertDomainAdmin(id);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: members } = (await (admin as any)
    .from('domain_member')
    .select('id, user_id, role, invited_at, joined_at')
    .eq('domain_id', id)
    .order('invited_at', { ascending: false })) as {
    data: Array<{
      id: string;
      user_id: string;
      role: string;
      invited_at: string;
      joined_at: string | null;
    }> | null;
  };

  const enriched = await Promise.all(
    (members ?? []).map(async (m) => {
      const { data: u } = await admin.auth.admin.getUserById(m.user_id);
      return {
        ...m,
        email: u?.user?.email ?? null,
        fullName: u?.user?.user_metadata?.full_name ?? null,
      };
    })
  );

  return NextResponse.json(enriched);
}

/**
 * POST — invite/add a member. Enforces max_users cap (BIZZ-703).
 * Body: { email: string, role: 'admin'|'member' }
 */
export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { id: domainId } = await context.params;

  let ctx;
  try {
    ctx = await assertDomainAdmin(domainId);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const role = body.role === 'admin' ? 'admin' : 'member';
  if (!email) return NextResponse.json({ error: 'email is required' }, { status: 400 });

  const admin = createAdminClient();

  // BIZZ-703: Enforce max_users cap
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: domainRow } = (await (admin as any)
    .from('domain')
    .select('limits')
    .eq('id', domainId)
    .maybeSingle()) as { data: { limits: Record<string, number> } | null };

  const maxUsers = Number(domainRow?.limits?.max_users ?? 50);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count: currentCount } = (await (admin as any)
    .from('domain_member')
    .select('id', { count: 'exact', head: true })
    .eq('domain_id', domainId)) as { count: number | null };

  if ((currentCount ?? 0) >= maxUsers) {
    return NextResponse.json(
      { error: `Maksimalt antal brugere (${maxUsers}) nået for dette domain` },
      { status: 403 }
    );
  }

  // BIZZ-722 Lag 8: Email domain guard
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: guardResult } = (await (admin as any).rpc('check_domain_email_guard', {
    p_domain_id: domainId,
    p_email: email,
  })) as { data: { allowed: boolean; enforcement: string; warning?: string } | null };

  if (guardResult && !guardResult.allowed) {
    return NextResponse.json(
      { error: guardResult.warning || 'Email-domæne er ikke tilladt for dette domain' },
      { status: 403 }
    );
  }
  const emailGuardWarning = guardResult?.warning || null;

  // Look up or invite user
  const { data: usersPage } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const existingUser = usersPage?.users?.find((u) => u.email === email);

  let targetUserId: string;
  if (existingUser) {
    targetUserId = existingUser.id;
  } else {
    const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email);
    if (inviteErr || !invited?.user) {
      logger.error('[domain/admin/members] Invite error:', inviteErr?.message);
      return NextResponse.json({ error: 'Could not invite user' }, { status: 500 });
    }
    targetUserId = invited.user.id;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: insertErr } = await (admin as any).from('domain_member').upsert(
    {
      domain_id: domainId,
      user_id: targetUserId,
      role,
      invited_by: ctx.userId,
      invited_at: new Date().toISOString(),
      joined_at: existingUser ? new Date().toISOString() : null,
    },
    { onConflict: 'domain_id,user_id' }
  );

  if (insertErr) {
    logger.error('[domain/admin/members] Insert error:', insertErr.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from('domain_audit_log').insert({
    domain_id: domainId,
    actor_user_id: ctx.userId,
    action: existingUser ? 'add_member' : 'invite_member',
    target_type: 'user',
    target_id: targetUserId,
    metadata: { email, role },
  });

  return NextResponse.json(
    { ok: true, userId: targetUserId, invited: !existingUser, emailGuardWarning },
    { status: 201 }
  );
}

/**
 * PATCH — toggle member role. Body: { userId, role: 'admin'|'member' }.
 */
export async function PATCH(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { id: domainId } = await context.params;

  let ctx;
  try {
    ctx = await assertDomainAdmin(domainId);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const targetUserId = typeof body.userId === 'string' ? body.userId : '';
  const role = body.role === 'admin' ? 'admin' : 'member';
  if (!targetUserId) return NextResponse.json({ error: 'userId is required' }, { status: 400 });

  const admin = createAdminClient();

  // Fail-safe: cannot demote oneself if the last admin
  if (role !== 'admin' && targetUserId === ctx.userId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { count: adminCount } = (await (admin as any)
      .from('domain_member')
      .select('id', { count: 'exact', head: true })
      .eq('domain_id', domainId)
      .eq('role', 'admin')) as { count: number | null };

    if ((adminCount ?? 0) <= 1) {
      return NextResponse.json(
        { error: 'Kan ikke fjerne sig selv som sidste admin' },
        { status: 400 }
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin as any)
    .from('domain_member')
    .update({ role })
    .eq('domain_id', domainId)
    .eq('user_id', targetUserId);

  if (error) {
    logger.error('[domain/admin/members] PATCH error:', error.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from('domain_audit_log').insert({
    domain_id: domainId,
    actor_user_id: ctx.userId,
    action: 'update_member_role',
    target_type: 'user',
    target_id: targetUserId,
    metadata: { role },
  });

  return NextResponse.json({ ok: true });
}

/**
 * DELETE — remove member. Body: { userId }.
 * Fail-safe: cannot remove the last admin.
 */
export async function DELETE(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { id: domainId } = await context.params;

  let ctx;
  try {
    ctx = await assertDomainAdmin(domainId);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const targetUserId = typeof body.userId === 'string' ? body.userId : '';
  if (!targetUserId) return NextResponse.json({ error: 'userId is required' }, { status: 400 });

  const admin = createAdminClient();

  // Fail-safe: cannot remove the last admin
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: target } = (await (admin as any)
    .from('domain_member')
    .select('role')
    .eq('domain_id', domainId)
    .eq('user_id', targetUserId)
    .maybeSingle()) as { data: { role: string } | null };

  if (target?.role === 'admin') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { count: adminCount } = (await (admin as any)
      .from('domain_member')
      .select('id', { count: 'exact', head: true })
      .eq('domain_id', domainId)
      .eq('role', 'admin')) as { count: number | null };

    if ((adminCount ?? 0) <= 1) {
      return NextResponse.json(
        { error: 'Kan ikke fjerne sidste admin — domainet ville blive låst' },
        { status: 400 }
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin as any)
    .from('domain_member')
    .delete()
    .eq('domain_id', domainId)
    .eq('user_id', targetUserId);

  if (error) {
    logger.error('[domain/admin/members] DELETE error:', error.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from('domain_audit_log').insert({
    domain_id: domainId,
    actor_user_id: ctx.userId,
    action: 'remove_member',
    target_type: 'user',
    target_id: targetUserId,
  });

  return NextResponse.json({ ok: true });
}
