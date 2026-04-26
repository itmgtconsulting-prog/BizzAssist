/**
 * POST /api/team/leave — caller forlader sin tenant.
 *
 * BIZZ-271: Self-serve exit. Samme sidste-admin-guard som DELETE på
 * /api/team/[userId] så en tenant ikke ender uden admin. Efter leave
 * har user ikke længere adgang til tenant-scoped data.
 *
 * @module app/api/team/leave
 */

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { resolveTeamContext } from '@/app/lib/teamAuth';
import { writeAuditLog } from '@/app/lib/auditLog';
import { logger } from '@/app/lib/logger';

export async function POST(): Promise<NextResponse> {
  const ctx = await resolveTeamContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const admin = createAdminClient();

    // Sidste-admin-guard
    if (ctx.role === 'tenant_admin') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { count } = await (admin as any)
        .from('tenant_memberships')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', ctx.tenantId)
        .eq('role', 'tenant_admin');
      if ((typeof count === 'number' ? count : 0) <= 1) {
        return NextResponse.json(
          { error: 'Du er sidste admin. Udnævn en anden admin før du forlader teamet.' },
          { status: 409 }
        );
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (admin as any)
      .from('tenant_memberships')
      .delete()
      .eq('tenant_id', ctx.tenantId)
      .eq('user_id', ctx.userId);
    if (error) {
      logger.error('[team/leave] db error:', error.message);
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }

    void writeAuditLog({
      action: 'team.leave',
      resource_type: 'tenant_membership',
      resource_id: ctx.userId,
      metadata: JSON.stringify({
        tenant_id: ctx.tenantId,
        former_role: ctx.role,
      }),
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error('[team/leave]', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
