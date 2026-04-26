/**
 * GET /api/team — returnér alle aktive medlemmer + pending invitations
 *                 for den authenticated users tenant.
 *
 * BIZZ-271: Bruges af /dashboard/settings/organisation UI. Tilgængelig
 * for alle tenant-medlemmer (ikke kun admin) så de kan se hvem der er
 * i deres organisation — admin-handlinger (invite/role-change/remove)
 * ligger i separate routes med admin-gate.
 *
 * Response:
 *   {
 *     members: [{ user_id, email, full_name, role, joined_at }, ...],
 *     invitations: [{ id, email, role, invited_by, expires_at }, ...]
 *   }
 *
 * @module app/api/team
 */

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { resolveTeamContext } from '@/app/lib/teamAuth';
import { logger } from '@/app/lib/logger';

export async function GET(): Promise<NextResponse> {
  const ctx = await resolveTeamContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const admin = createAdminClient();

    // Step 1: fetch memberships for tenant — join til users for email/navn
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: memberships } = (await (admin as any)
      .from('tenant_memberships')
      .select('user_id, role, created_at, users:user_id(email, full_name)')
      .eq('tenant_id', ctx.tenantId)) as {
      data: Array<{
        user_id: string;
        role: string;
        created_at: string;
        users: { email: string; full_name: string | null } | null;
      }> | null;
    };

    const members = (memberships ?? []).map((m) => ({
      user_id: m.user_id,
      email: m.users?.email ?? '(unknown)',
      full_name: m.users?.full_name ?? null,
      role: m.role,
      joined_at: m.created_at,
      is_self: m.user_id === ctx.userId,
    }));

    // Step 2: pending (not-yet-accepted, ikke udløbet) invitations
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: invites } = (await (admin as any)
      .from('tenant_invitations')
      .select('id, email, role, invited_by, expires_at, created_at, accepted_at')
      .eq('tenant_id', ctx.tenantId)
      .is('accepted_at', null)
      .gt('expires_at', new Date().toISOString())) as {
      data: Array<{
        id: string;
        email: string;
        role: string;
        invited_by: string | null;
        expires_at: string;
        created_at: string;
        accepted_at: string | null;
      }> | null;
    };

    return NextResponse.json({
      members,
      invitations: invites ?? [],
      // Echo viewer's own role så UI kan gating actions
      viewer_role: ctx.role,
    });
  } catch (err) {
    logger.error('[team GET]', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
