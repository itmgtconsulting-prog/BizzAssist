/**
 * POST /api/ai/feedback — log AI feedback (unmet needs, thumbs down, tool failures)
 *
 * BIZZ-237: Captures when the AI can't answer a question or when users give
 * negative feedback. Used to identify missing tools/data and prioritise new
 * features. Data is tenant-scoped and available in the admin dashboard.
 *
 * Body: {
 *   questionText: string,
 *   feedbackType: 'tool_failure' | 'no_data' | 'user_thumbs_down' | 'missing_capability',
 *   aiResponseSnippet?: string,
 *   pageContext?: string,
 *   conversationId?: string,
 *   metadata?: Record<string, unknown>
 * }
 *
 * Auth: authenticated Supabase session required.
 * GDPR: tenant-scoped, cascade-deleted on account removal.
 * Retention: 12 months.
 *
 * @module api/ai/feedback
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveTenantId } from '@/lib/api/auth';
import { tenantDb } from '@/lib/supabase/admin';
import { parseBody } from '@/app/lib/validate';
import { logger } from '@/app/lib/logger';

const feedbackSchema = z.object({
  questionText: z.string().min(1).max(5000),
  feedbackType: z.enum(['tool_failure', 'no_data', 'user_thumbs_down', 'missing_capability']),
  aiResponseSnippet: z.string().max(500).optional(),
  pageContext: z.string().max(500).optional(),
  conversationId: z.string().uuid().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * POST /api/ai/feedback
 * Logs a feedback entry for the AI assistant.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = await parseBody(request, feedbackSchema);
  if (!parsed.success) return parsed.response;

  try {
    // Insert into tenant-schema ai_feedback_log via typed tenant helper.
    const { error } = await tenantDb('tenant')
      .from('ai_feedback_log')
      .insert({
        tenant_id: auth.tenantId,
        user_id: auth.userId,
        conversation_id: parsed.data.conversationId ?? null,
        question_text: parsed.data.questionText,
        feedback_type: parsed.data.feedbackType,
        ai_response_snippet: parsed.data.aiResponseSnippet ?? null,
        page_context: parsed.data.pageContext ?? null,
        metadata: parsed.data.metadata ?? {},
      });

    if (error) {
      logger.error('[ai/feedback] Insert error:', error);
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }

    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    logger.error('[ai/feedback] POST error:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
