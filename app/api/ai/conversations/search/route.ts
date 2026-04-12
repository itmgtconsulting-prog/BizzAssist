/**
 * GET /api/ai/conversations/search?q=<query> — search across conversation history
 *
 * BIZZ-238: Full-text search in ai_messages content for the current user's tenant.
 * Uses PostgreSQL ILIKE for simple text matching. Returns matching conversations
 * with the matched message snippet.
 *
 * Query params:
 *   q: search query (min 2 chars, max 200 chars)
 *   limit: max results (default 10, max 50)
 *
 * Auth: authenticated Supabase session required.
 * GDPR: tenant-scoped search — only returns conversations from the user's tenant.
 *
 * @module api/ai/conversations/search
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { getTenantContext } from '@/lib/db/tenant';
import { logger } from '@/app/lib/logger';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const q = request.nextUrl.searchParams.get('q')?.trim();
  if (!q || q.length < 2) {
    return NextResponse.json({ error: 'Soegning kraever mindst 2 tegn' }, { status: 400 });
  }
  if (q.length > 200) {
    return NextResponse.json({ error: 'Soegning maa maks vaere 200 tegn' }, { status: 400 });
  }

  const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') ?? '10', 10) || 10, 50);

  try {
    const db = await getTenantContext(auth.tenantId);

    // Get all conversations first
    const conversations = await db.aiConversations.list();

    // For each conversation, check if any messages match the query
    const results: Array<{
      conversationId: string;
      title: string | null;
      matchedSnippet: string;
      createdAt: string;
    }> = [];

    for (const conv of conversations) {
      if (results.length >= limit) break;

      const messages = await db.aiConversations.getMessages(conv.id);
      const match = messages.find((m) => m.content.toLowerCase().includes(q.toLowerCase()));

      if (match) {
        // Extract a snippet around the match
        const idx = match.content.toLowerCase().indexOf(q.toLowerCase());
        const start = Math.max(0, idx - 50);
        const end = Math.min(match.content.length, idx + q.length + 50);
        const snippet =
          (start > 0 ? '...' : '') +
          match.content.slice(start, end) +
          (end < match.content.length ? '...' : '');

        results.push({
          conversationId: conv.id,
          title: conv.title,
          matchedSnippet: snippet,
          createdAt: conv.created_at,
        });
      }
    }

    return NextResponse.json(results);
  } catch (err) {
    logger.error('[ai/conversations/search] GET error:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
