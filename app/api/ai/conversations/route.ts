/**
 * GET  /api/ai/conversations  — list all conversations for the current user
 * POST /api/ai/conversations  — create a new conversation
 *
 * BIZZ-235: Supabase-backed conversation persistence (replaces localStorage).
 * Uses existing lib/db/tenant.ts aiConversations API.
 *
 * Auth: authenticated Supabase session required.
 * GDPR: conversation data is tenant-scoped and cascade-deleted on account removal.
 * Retention: indefinite while tenant is active.
 *
 * @module api/ai/conversations
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveTenantId } from '@/lib/api/auth';
import { getTenantContext } from '@/lib/db/tenant';
import { parseBody } from '@/app/lib/validate';
import { logger } from '@/app/lib/logger';

const createSchema = z.object({
  title: z.string().trim().max(200).optional(),
});

/**
 * GET /api/ai/conversations
 * Returns all conversations for the authenticated user's tenant, newest first.
 */
export async function GET(): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const db = await getTenantContext(auth.tenantId);
    const conversations = await db.aiConversations.list();
    return NextResponse.json(conversations);
  } catch (err) {
    logger.error('[ai/conversations] GET error:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}

/**
 * POST /api/ai/conversations
 * Creates a new empty conversation. Returns the created conversation object.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = await parseBody(request, createSchema);
  if (!parsed.success) return parsed.response;

  try {
    const db = await getTenantContext(auth.tenantId);
    const conversation = await db.aiConversations.create({
      title: parsed.data.title || undefined,
    });
    return NextResponse.json(conversation, { status: 201 });
  } catch (err) {
    logger.error('[ai/conversations] POST error:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
