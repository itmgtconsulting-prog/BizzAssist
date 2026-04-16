/**
 * GET /api/admin/ai-feedback — list AI feedback entries for admin triage
 *
 * BIZZ-231: Admin endpoint for reviewing unmet AI needs.
 * Only accessible to admin users. Returns the most recent feedback entries.
 *
 * Query params:
 *   ?type=tool_failure|no_data|user_thumbs_down|missing_capability — filter by type
 *   ?limit=50 — max entries (default 50, max 200)
 *
 * Auth: admin-only (checks is_admin flag).
 * GDPR: no PII in response — only question text, feedback type, context.
 * Retention: 12 months.
 *
 * @module api/admin/ai-feedback
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient, tenantDb } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';
import { parseQuery } from '@/app/lib/validate';

/** Zod schema for GET query parameters */
const querySchema = z.object({
  type: z
    .enum(['tool_failure', 'no_data', 'user_thumbs_down', 'missing_capability', 'all'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Admin check
  const admin = createAdminClient();
  const { data: membership } = await admin
    .from('tenant_memberships')
    .select('role')
    .eq('user_id', auth.userId)
    .eq('tenant_id', auth.tenantId)
    .single();

  if (!membership || membership.role !== 'tenant_admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const parsed = parseQuery(request, querySchema);
  if (!parsed.success) return parsed.response;
  const { type: typeFilter, limit } = parsed.data;

  try {
    let query = tenantDb('tenant')
      .from('ai_feedback_log')
      .select(
        'id, feedback_type, question_text, ai_response_snippet, page_context, jira_ticket_id, created_at'
      )
      .eq('tenant_id', auth.tenantId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (typeFilter && typeFilter !== 'all') {
      query = query.eq('feedback_type', typeFilter);
    }

    const { data, error } = await query;

    if (error) {
      logger.error('[admin/ai-feedback] Query error:', error);
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }

    return NextResponse.json(data ?? []);
  } catch (err) {
    logger.error('[admin/ai-feedback] GET error:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
