/**
 * BIZZ-819 (AI-chat Supabase 2/3): /api/ai/sessions — list + create
 * chat-sessions for current user.
 *
 * GET  /api/ai/sessions?include_archived=0&limit=50
 *      → list sessions DESC by last_msg_at (archived udeladt default).
 * POST /api/ai/sessions
 *      body: { title?, context_type?, context_id? }
 *      → opret session + return full row.
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = (ctx.db as any)
      .from('ai_chat_sessions')
      .select(
        'id, tenant_id, user_id, title, context_type, context_id, last_msg_at, archived_at, created_at, updated_at'
      )
      .eq('user_id', ctx.userId)
      .order('last_msg_at', { ascending: false })
      .limit(limit);
    if (!includeArchived) {
      q = q.is('archived_at', null);
    }
    const { data, error } = await q;
    if (error) {
      logger.error('[ai/sessions GET]', error.message);
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }
    return NextResponse.json({ sessions: data ?? [] });
  } catch (err) {
    logger.error('[ai/sessions GET] exception:', err);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (ctx.db as any)
      .from('ai_chat_sessions')
      .insert({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        title: parsed.data.title ?? 'Ny samtale',
        context_type: parsed.data.context_type ?? null,
        context_id: parsed.data.context_id ?? null,
      })
      .select(
        'id, tenant_id, user_id, title, context_type, context_id, last_msg_at, archived_at, created_at, updated_at'
      )
      .single();
    if (error || !data) {
      logger.error('[ai/sessions POST]', error?.message);
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }
    return NextResponse.json({ session: data }, { status: 201 });
  } catch (err) {
    logger.error('[ai/sessions POST] exception:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
