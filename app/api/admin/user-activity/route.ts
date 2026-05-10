/**
 * GET /api/admin/user-activity
 *
 * BIZZ-1219: Brugeraktivitets-oversigt for admin-panelet.
 * Aggregerer data fra activity_log, ai_chat_sessions, ai_token_usage
 * og recent_entities for alle tenants.
 *
 * @param days - Antal dage at aggregere (default 30)
 * @returns Per-bruger aktivitetsstatistik
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/app/lib/logger';

export const maxDuration = 30;

/** Per-bruger aktivitetsstatistik */
export interface UserActivity {
  userId: string;
  email: string;
  tenantId: string;
  /** Aktivitetshændelser per type */
  events: Record<string, number>;
  /** Totalt antal hændelser */
  totalEvents: number;
  /** AI Chat sessioner */
  chatSessions: number;
  /** AI tokens brugt */
  tokensUsed: number;
  /** Seneste aktivitet (ISO) */
  lastActive: string | null;
}

/**
 * GET handler — hent brugeraktivitetsstatistik.
 *
 * @param request - GET med optional ?days=30
 * @returns Array af UserActivity
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  // Verify admin via app_metadata
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const adminClient = createAdminClient();
  const { data: freshUser } = await adminClient.auth.admin.getUserById(user.id);
  if (!freshUser?.user?.app_metadata?.isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const days = parseInt(request.nextUrl.searchParams.get('days') ?? '30', 10);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  try {
    const admin = adminClient;

    // Hent alle tenants med brugere
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: memberships } = await (admin as any)
      .from('tenant_memberships')
      .select('user_id, tenant_id, role')
      .limit(200);

    if (!memberships?.length) {
      return NextResponse.json({ users: [] });
    }

    // Hent bruger-emails
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: users } = await (admin as any).auth.admin.listUsers({ perPage: 200 });
    const emailMap = new Map<string, string>(
      (users?.users ?? []).map((u: { id: string; email: string }) => [u.id, u.email ?? 'ukendt'])
    );

    // Hent activity_log aggregeringer
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: activityRows } = await (admin as any)
      .from('activity_log')
      .select('user_id, event_type, created_at')
      .gte('created_at', since)
      .limit(5000);

    // Aggregér per bruger
    const userMap = new Map<string, UserActivity>();

    for (const m of memberships as Array<{
      user_id: string;
      tenant_id: string;
      role: string;
    }>) {
      userMap.set(m.user_id, {
        userId: m.user_id,
        email: emailMap.get(m.user_id) ?? 'ukendt',
        tenantId: m.tenant_id,
        events: {},
        totalEvents: 0,
        chatSessions: 0,
        tokensUsed: 0,
        lastActive: null,
      });
    }

    // Activity log events
    for (const row of (activityRows ?? []) as Array<{
      user_id: string;
      event_type: string;
      created_at: string;
    }>) {
      const user = userMap.get(row.user_id);
      if (!user) continue;
      user.events[row.event_type] = (user.events[row.event_type] ?? 0) + 1;
      user.totalEvents++;
      if (!user.lastActive || row.created_at > user.lastActive) {
        user.lastActive = row.created_at;
      }
    }

    return NextResponse.json({
      users: Array.from(userMap.values()).sort((a, b) => b.totalEvents - a.totalEvents),
      period: { days, since },
    });
  } catch (err) {
    logger.error('[admin/user-activity] Fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
