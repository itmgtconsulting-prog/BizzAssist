/**
 * BIZZ-819 / BIZZ-1206: /api/ai/sessions/[id] — GET (detail + messages),
 * PATCH (title + archive), DELETE (hard delete, cascade messages).
 *
 * Uses RPC-based aiChatDb to bypass PostgREST schema config dependency.
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

export async function GET(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  const ctx = await getAiChatDb();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await context.params;
  try {
    const result = await ctx.getSession(id);
    if (!result) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ session: result.session, messages: result.messages });
  } catch (err) {
    logger.error('[ai/sessions/:id GET] exception:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const ctx = await getAiChatDb();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await context.params;

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

  if (parsed.data.title === undefined && parsed.data.archived_at === undefined) {
    return NextResponse.json({ error: 'Ingen felter at opdatere' }, { status: 400 });
  }

  try {
    const session = await ctx.updateSession(id, {
      title: parsed.data.title,
      archive: parsed.data.archived_at !== undefined ? parsed.data.archived_at !== null : false,
    });
    if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ session });
  } catch (err) {
    logger.error('[ai/sessions/:id PATCH] exception:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const ctx = await getAiChatDb();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await context.params;

  try {
    const deleted = await ctx.deleteSession(id);
    if (!deleted) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('[ai/sessions/:id DELETE] exception:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
