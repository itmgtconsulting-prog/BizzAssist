/**
 * BIZZ-819: /api/ai/sessions/[id] — GET (detail + messages), PATCH
 * (title + archived_at), DELETE (hard delete, cascade messages).
 *
 * @module api/ai/sessions/[id]
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAiChatDb } from '@/app/lib/aiChatDb';
import { logger } from '@/app/lib/logger';

const PatchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  archived_at: z.union([z.string().datetime(), z.null()]).optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Gate: fetch session by id + verify user ownership. Returns null hvis
 * ikke findes eller forbidden.
 */
async function loadOwnedSession(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  sessionId: string,
  userId: string
): Promise<{
  id: string;
  user_id: string;
} | null> {
  const { data } = await db
    .from('ai_chat_sessions')
    .select('id, user_id')
    .eq('id', sessionId)
    .maybeSingle();
  if (!data || data.user_id !== userId) return null;
  return data as { id: string; user_id: string };
}

export async function GET(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  const ctx = await getAiChatDb();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await context.params;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: session, error: sErr } = await (ctx.db as any)
      .from('ai_chat_sessions')
      .select(
        'id, tenant_id, user_id, title, context_type, context_id, last_msg_at, archived_at, created_at, updated_at'
      )
      .eq('id', id)
      .maybeSingle();
    if (sErr || !session) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (session.user_id !== ctx.userId)
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: messages } = await (ctx.db as any)
      .from('ai_chat_messages')
      .select('id, session_id, role, content, tokens_in, tokens_out, model, tool_calls, created_at')
      .eq('session_id', id)
      .order('created_at', { ascending: true });

    return NextResponse.json({ session, messages: messages ?? [] });
  } catch (err) {
    logger.error('[ai/sessions/:id GET] exception:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const ctx = await getAiChatDb();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await context.params;
  const own = await loadOwnedSession(ctx.db, id, ctx.userId);
  if (!own) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Input-fejl', details: parsed.error.issues },
      { status: 400 }
    );
  }

  const update: Record<string, unknown> = {};
  if (parsed.data.title !== undefined) update.title = parsed.data.title;
  if (parsed.data.archived_at !== undefined) update.archived_at = parsed.data.archived_at;
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'Ingen felter at opdatere' }, { status: 400 });
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (ctx.db as any)
      .from('ai_chat_sessions')
      .update(update)
      .eq('id', id)
      .select(
        'id, tenant_id, user_id, title, context_type, context_id, last_msg_at, archived_at, created_at, updated_at'
      )
      .single();
    if (error || !data) {
      logger.error('[ai/sessions/:id PATCH]', error?.message);
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }
    return NextResponse.json({ session: data });
  } catch (err) {
    logger.error('[ai/sessions/:id PATCH] exception:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const ctx = await getAiChatDb();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await context.params;
  const own = await loadOwnedSession(ctx.db, id, ctx.userId);
  if (!own) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    // ON DELETE CASCADE fjerner tilknyttede messages automatisk
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (ctx.db as any).from('ai_chat_sessions').delete().eq('id', id);
    if (error) {
      logger.error('[ai/sessions/:id DELETE]', error.message);
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('[ai/sessions/:id DELETE] exception:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
