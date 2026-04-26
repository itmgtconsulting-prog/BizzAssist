/**
 * BIZZ-819: /api/ai/sessions/[id]/messages — GET incremental messages
 * + POST append message.
 *
 * GET ?since=<iso> fetcher messages oprettet EFTER timestamp (bruges
 * af Realtime-fallback polling).
 *
 * POST appender én message + opdaterer session.last_msg_at atomisk
 * via trigger (UPDATE ai_chat_sessions). Caller ejer role-validering.
 *
 * @module api/ai/sessions/[id]/messages
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAiChatDb } from '@/app/lib/aiChatDb';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { logger } from '@/app/lib/logger';

const AppendSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  // Claude content kan være string eller struktureret array (text-blocks,
  // tool_use, tool_result). JSONB-felt accepterer begge.
  content: z.union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())]),
  tokens_in: z.number().int().nonnegative().optional(),
  tokens_out: z.number().int().nonnegative().optional(),
  model: z.string().max(100).optional(),
  tool_calls: z.union([z.array(z.unknown()), z.null()]).optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const ctx = await getAiChatDb();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await context.params;

  // Verificér ownership via session-join
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: session } = await (ctx.db as any)
    .from('ai_chat_sessions')
    .select('user_id')
    .eq('id', id)
    .maybeSingle();
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (session.user_id !== ctx.userId)
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const since = request.nextUrl.searchParams.get('since');
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = (ctx.db as any)
      .from('ai_chat_messages')
      .select('id, session_id, role, content, tokens_in, tokens_out, model, tool_calls, created_at')
      .eq('session_id', id)
      .order('created_at', { ascending: true });
    if (since) q = q.gt('created_at', since);
    const { data, error } = await q;
    if (error) {
      logger.error('[ai/sessions/:id/messages GET]', error.message);
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }
    return NextResponse.json({ messages: data ?? [] });
  } catch (err) {
    logger.error('[ai/sessions/:id/messages GET] exception:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const ctx = await getAiChatDb();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const rl = await checkRateLimit(request, rateLimit);
  if (rl) return rl;

  const { id } = await context.params;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: session } = await (ctx.db as any)
    .from('ai_chat_sessions')
    .select('user_id')
    .eq('id', id)
    .maybeSingle();
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (session.user_id !== ctx.userId)
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }
  const parsed = AppendSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Input-fejl', details: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    const now = new Date().toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: msg, error: mErr } = await (ctx.db as any)
      .from('ai_chat_messages')
      .insert({
        session_id: id,
        role: parsed.data.role,
        content: parsed.data.content,
        tokens_in: parsed.data.tokens_in ?? null,
        tokens_out: parsed.data.tokens_out ?? null,
        model: parsed.data.model ?? null,
        tool_calls: parsed.data.tool_calls ?? null,
      })
      .select('id, session_id, role, content, tokens_in, tokens_out, model, tool_calls, created_at')
      .single();
    if (mErr || !msg) {
      logger.error('[ai/sessions/:id/messages POST]', mErr?.message);
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }

    // Bump session.last_msg_at (updated_at opdateres af trigger)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (ctx.db as any).from('ai_chat_sessions').update({ last_msg_at: now }).eq('id', id);

    return NextResponse.json({ message: msg }, { status: 201 });
  } catch (err) {
    logger.error('[ai/sessions/:id/messages POST] exception:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
