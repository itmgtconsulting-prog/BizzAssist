/**
 * Admin domain members API — list/add/remove members.
 *
 * BIZZ-702: Super-admin can assign Domain Admins and invite members by email.
 *
 * GET    /api/admin/domains/:id/members — list members
 * POST   /api/admin/domains/:id/members — add/invite member
 * DELETE /api/admin/domains/:id/members — remove member (body: { userId })
 *
 * @module api/admin/domains/[id]/members
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
 * GET /api/admin/domains/:id/members — list domain members with user email.
 */
export async function GET(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const userId = await requireSuperAdmin();
  if (!userId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await context.params;
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

  // Enrich with user email
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
 * POST /api/admin/domains/:id/members — add or invite member.
 *
 * Body: { email, role: 'admin' | 'member' }
 */
export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const actorId = await requireSuperAdmin();
  if (!actorId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id: domainId } = await context.params;

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

  // BIZZ-722 Lag 8: Email domain guard — check whitelist before adding member
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

  // Include warning in response if soft-check (warn mode)
  const emailGuardWarning = guardResult?.warning || null;

  // Check if user exists
  const { data: usersPage } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const existingUser = usersPage?.users?.find((u) => u.email === email);

  let targetUserId: string;

  if (existingUser) {
    targetUserId = existingUser.id;
  } else {
    // Invite new user via Supabase
    const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email);
    if (inviteErr || !invited?.user) {
      logger.error('[admin/domains/members] Invite error:', inviteErr?.message);
      return NextResponse.json({ error: 'Could not invite user' }, { status: 500 });
    }
    targetUserId = invited.user.id;
  }

  // Insert domain_member
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: insertErr } = await (admin as any).from('domain_member').upsert(
    {
      domain_id: domainId,
      user_id: targetUserId,
      role,
      invited_by: actorId,
      invited_at: new Date().toISOString(),
      joined_at: existingUser ? new Date().toISOString() : null,
    },
    { onConflict: 'domain_id,user_id' }
  );

  if (insertErr) {
    logger.error('[admin/domains/members] Insert error:', insertErr.message);
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  // Audit log
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from('domain_audit_log').insert({
    domain_id: domainId,
    actor_user_id: actorId,
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
 * DELETE /api/admin/domains/:id/members — remove member.
 *
 * Body: { userId }
 */
export async function DELETE(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const actorId = await requireSuperAdmin();
  if (!actorId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id: domainId } = await context.params;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const targetUserId = typeof body.userId === 'string' ? body.userId : '';
  if (!targetUserId) return NextResponse.json({ error: 'userId is required' }, { status: 400 });

  const admin = createAdminClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin as any)
    .from('domain_member')
    .delete()
    .eq('domain_id', domainId)
    .eq('user_id', targetUserId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Audit
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from('domain_audit_log').insert({
    domain_id: domainId,
    actor_user_id: actorId,
    action: 'remove_member',
    target_type: 'user',
    target_id: targetUserId,
  });

  return NextResponse.json({ ok: true });
}
