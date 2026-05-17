/**
 * BIZZ-819 / BIZZ-1206: /api/ai/sessions/[id]/messages — GET incremental
 * messages + POST append message.
 *
 * Uses RPC-based aiChatDb to bypass PostgREST schema config dependency.
 *
 * GET ?since=<iso> fetcher messages oprettet EFTER timestamp (bruges
 * af Realtime-fallback polling).
 *
 * POST appender én message + opdaterer session.last_msg_at.
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

  const since = request.nextUrl.searchParams.get('since');
  try {
    if (since) {
      // Incremental poll — use RPC
      const messages = await ctx.getMessagesSince(id, since);
      return NextResponse.json({ messages });
    }

    // Full session load — use getSession which verifies ownership
    const result = await ctx.getSession(id);
    if (!result) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ messages: result.messages });
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
    // Content can be string or structured array — stringify for RPC if needed
    const contentStr =
      typeof parsed.data.content === 'string'
        ? parsed.data.content
        : JSON.stringify(parsed.data.content);

    const message = await ctx.insertMessage({
      sessionId: id,
      role: parsed.data.role,
      content: contentStr,
      toolCalls: parsed.data.tool_calls ?? null,
      tokenCount: (parsed.data.tokens_in ?? 0) + (parsed.data.tokens_out ?? 0) || undefined,
    });

    return NextResponse.json({ message }, { status: 201 });
  } catch (err) {
    logger.error('[ai/sessions/:id/messages POST] exception:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
