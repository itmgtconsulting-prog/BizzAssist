/**
 * GET /api/admin/users/[id]/activity
 *
 * Aggregates user activity data for the admin user detail panel.
 * Combines activity_log events, AI chat sessions, token usage, and feedback.
 *
 * Auth: super-admin only (isAdmin flag in app_metadata).
 * Platform-wide admin view: any user may be inspected; the user's activity is
 * read from their own per-tenant schema (resolved from their primary membership).
 *
 * @param params.id - Supabase Auth user UUID
 * @returns JSON with activity statistics and timeline
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient, tenantDb } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

/** Activity event from tenant.activity_log */
interface ActivityEvent {
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

/** AI chat session summary */
interface ChatSessionSummary {
  id: string;
  title: string | null;
  created_at: string;
  message_count: number;
  total_tokens_in: number;
  total_tokens_out: number;
}

/** Aggregated activity response */
interface UserActivityResponse {
  /** Event counts by type (last 30 days) */
  eventCounts: Record<string, number>;
  /** Recent activity timeline (last 50 events) */
  timeline: ActivityEvent[];
  /** AI chat session count (last 30 days) */
  chatSessionCount: number;
  /** Total AI tokens used (last 30 days) */
  aiTokensUsed: number;
  /** Recent chat sessions (last 10) */
  recentChats: ChatSessionSummary[];
  /** Active days in last 7 and 30 days */
  activeDays7: number;
  activeDays30: number;
}

/**
 * Verify the caller is a super-admin.
 *
 * @returns Authenticated user or null
 */
async function verifyAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const admin = createAdminClient();
  const { data: freshUser } = await admin.auth.admin.getUserById(user.id);
  if (freshUser?.user?.app_metadata?.isAdmin) return user;
  return null;
}

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    if (!(await verifyAdmin())) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id: userId } = await context.params;

    // Validate UUID format
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
      return NextResponse.json({ error: 'Ugyldigt bruger-id' }, { status: 400 });
    }

    const admin = createAdminClient();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // activity_log / ai_chat_sessions / ai_token_usage live in the target user's
    // per-tenant tenant_<slug> schema (BIZZ-2288 — the shared 'tenant' schema is
    // not PostgREST-exposed). Resolve the user's primary (oldest) membership,
    // matching resolveTenantId's deterministic choice.
    const { data: membership } = await admin
      .from('tenant_memberships')
      .select('tenant_id')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    const { data: tenantRow } = membership?.tenant_id
      ? await admin.from('tenants').select('schema_name').eq('id', membership.tenant_id).single()
      : { data: null };
    const schemaName = (tenantRow as { schema_name?: string } | null)?.schema_name ?? null;

    // User with no resolvable tenant schema → empty activity (never 500).
    if (!schemaName) {
      const empty: UserActivityResponse = {
        eventCounts: {},
        timeline: [],
        chatSessionCount: 0,
        aiTokensUsed: 0,
        recentChats: [],
        activeDays7: 0,
        activeDays30: 0,
      };
      return NextResponse.json(empty);
    }

    const db = tenantDb(schemaName);

    // Fetch activity_log events (last 30 days)
    const { data: events } = await db
      .from('activity_log')
      .select('event_type, payload, created_at')
      .eq('user_id', userId)
      .gte('created_at', thirtyDaysAgo)
      .order('created_at', { ascending: false })
      .limit(200);

    const activityEvents = (events ?? []) as ActivityEvent[];

    // Count events by type
    const eventCounts: Record<string, number> = {};
    for (const e of activityEvents) {
      eventCounts[e.event_type] = (eventCounts[e.event_type] ?? 0) + 1;
    }

    // Active days calculation
    const uniqueDays30 = new Set(activityEvents.map((e) => e.created_at.slice(0, 10)));
    const uniqueDays7 = new Set(
      activityEvents
        .filter((e) => e.created_at >= sevenDaysAgo)
        .map((e) => e.created_at.slice(0, 10))
    );

    // AI chat sessions (last 30 days)
    const { data: chatSessions } = await db
      .from('ai_chat_sessions')
      .select('id, title, created_at')
      .eq('user_id', userId)
      .gte('created_at', thirtyDaysAgo)
      .order('created_at', { ascending: false })
      .limit(10);

    const sessions = (chatSessions ?? []) as Array<{
      id: string;
      title: string | null;
      created_at: string;
    }>;

    // AI token usage (last 30 days)
    const { data: tokenRows } = await db
      .from('ai_token_usage')
      .select('tokens_in, tokens_out')
      .eq('user_id', userId)
      .gte('created_at', thirtyDaysAgo);

    let totalTokensIn = 0;
    let totalTokensOut = 0;
    for (const r of (tokenRows ?? []) as Array<{ tokens_in: number; tokens_out: number }>) {
      totalTokensIn += r.tokens_in ?? 0;
      totalTokensOut += r.tokens_out ?? 0;
    }

    // Build chat session summaries with message counts
    const recentChats: ChatSessionSummary[] = sessions.map((s) => ({
      id: s.id,
      title: s.title,
      created_at: s.created_at,
      message_count: 0,
      total_tokens_in: 0,
      total_tokens_out: 0,
    }));

    const response: UserActivityResponse = {
      eventCounts,
      timeline: activityEvents.slice(0, 50),
      chatSessionCount: sessions.length,
      aiTokensUsed: totalTokensIn + totalTokensOut,
      recentChats,
      activeDays7: uniqueDays7.size,
      activeDays30: uniqueDays30.size,
    };

    return NextResponse.json(response);
  } catch (err) {
    logger.error('[admin/users/[id]/activity] Error:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
