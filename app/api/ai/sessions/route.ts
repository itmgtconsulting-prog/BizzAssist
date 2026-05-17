/**
 * BIZZ-819 / BIZZ-1206: /api/ai/sessions — list + create chat sessions.
 *
 * Uses RPC-based aiChatDb to bypass PostgREST schema config dependency.
 *
 * GET  /api/ai/sessions?include_archived=0&limit=50
 *      → list sessions DESC by last_msg_at (archived excluded by default).
 * POST /api/ai/sessions
 *      body: { title?, context_type?, context_id? }
 *      → create session + return full row.
 *
 * @module api/ai/sessions
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAiChatDb } from '@/app/lib/aiChatDb';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { logger } from '@/app/lib/logger';

const CreateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  context_type: z.enum(['ejendom', 'virksomhed', 'person', 'sag']).optional(),
  context_id: z.string().max(200).optional(),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = await getAiChatDb();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = request.nextUrl;
  const includeArchived = url.searchParams.get('include_archived') === '1';
  const limitRaw = parseInt(url.searchParams.get('limit') || '50', 10);
  const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) ? limitRaw : 50, 200));

  try {
    const sessions = await ctx.listSessions({ includeArchived, limit });
    return NextResponse.json({ sessions });
  } catch (err) {
    logger.error('[ai/sessions GET]', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ctx = await getAiChatDb();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const rl = await checkRateLimit(request, rateLimit);
  if (rl) return rl;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }
  const parsed = CreateSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Input-fejl', details: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    const session = await ctx.createSession({
      title: parsed.data.title,
      contextType: parsed.data.context_type ?? null,
      contextId: parsed.data.context_id ?? null,
    });
    return NextResponse.json({ session }, { status: 201 });
  } catch (err) {
    logger.error('[ai/sessions POST]', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
