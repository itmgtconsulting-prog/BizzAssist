/**
 * POST /api/ai/conversations/[id]/messages — add a message to a conversation
 *
 * BIZZ-235: Supabase-backed conversation persistence.
 * Used by the useAIChat hook to persist messages server-side.
 *
 * @module api/ai/conversations/[id]/messages
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveTenantId } from '@/lib/api/auth';
import { getTenantContext } from '@/lib/db/tenant';
import { parseBody } from '@/app/lib/validate';
import { logger } from '@/app/lib/logger';

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(100_000),
  tokensUsed: z.number().int().min(0).optional(),
});

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/ai/conversations/[id]/messages
 * Adds a new message to the specified conversation.
 */
export async function POST(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  if (!id) return NextResponse.json({ error: 'Manglende conversation id' }, { status: 400 });

  const parsed = await parseBody(request, messageSchema);
  if (!parsed.success) return parsed.response;

  try {
    const db = await getTenantContext(auth.tenantId);

    // Verify conversation exists
    const conversation = await db.aiConversations.get(id);
    if (!conversation) {
      return NextResponse.json({ error: 'Samtale ikke fundet' }, { status: 404 });
    }

    const message = await db.aiConversations.addMessage(
      id,
      parsed.data.role,
      parsed.data.content,
      parsed.data.tokensUsed
    );

    return NextResponse.json(message, { status: 201 });
  } catch (err) {
    logger.error('[ai/conversations/[id]/messages] POST error:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
