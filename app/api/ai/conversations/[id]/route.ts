/**
 * GET    /api/ai/conversations/[id]  — get a single conversation with messages
 * DELETE /api/ai/conversations/[id]  — delete a conversation
 *
 * BIZZ-235: Supabase-backed conversation persistence.
 *
 * @module api/ai/conversations/[id]
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { getTenantContext } from '@/lib/db/tenant';
import { logger } from '@/app/lib/logger';
import { writeAuditLog } from '@/app/lib/auditLog';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/ai/conversations/[id]
 * Returns the conversation with all its messages.
 */
export async function GET(_request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  if (!id) return NextResponse.json({ error: 'Manglende id' }, { status: 400 });

  try {
    const db = await getTenantContext(auth.tenantId);
    const conversation = await db.aiConversations.get(id);
    if (!conversation) {
      return NextResponse.json({ error: 'Samtale ikke fundet' }, { status: 404 });
    }

    const messages = await db.aiConversations.getMessages(id);
    return NextResponse.json({ ...conversation, messages });
  } catch (err) {
    logger.error('[ai/conversations/[id]] GET error:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}

/**
 * DELETE /api/ai/conversations/[id]
 * Deletes a conversation and its messages.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  if (!id) return NextResponse.json({ error: 'Manglende id' }, { status: 400 });

  try {
    const db = await getTenantContext(auth.tenantId);
    await db.aiConversations.delete(id);
    writeAuditLog({
      action: 'ai_conversation.delete',
      resource_type: 'ai_conversation',
      resource_id: id,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('[ai/conversations/[id]] DELETE error:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
