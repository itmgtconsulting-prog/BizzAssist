/**
 * POST /api/admin/support-unlock
 *
 * Admin-only endpoint to unlock a user who has been permanently locked
 * out of the support chat due to abuse detection.
 *
 * Requires the caller to have `isAdmin: true` in their Supabase
 * `app_metadata` (same check used by other admin routes).
 *
 * Request body:
 *   { userId: string } — the user ID to unlock
 *
 * On success:
 *   - Sets `permanently_locked = false`
 *   - Clears `locked_until`
 *   - Records `unlocked_by` and `unlocked_at` for audit trail
 *
 * @returns { success: true } on success, error object on failure
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';
import { parseBody } from '@/app/lib/validate';

/** Zod schema for POST /api/admin/support-unlock request body */
const supportUnlockSchema = z
  .object({
    userId: z.string().min(1),
  })
  .passthrough();

interface _UnlockRequestBody {
  userId: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── Auth: require authenticated session ──
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const adminClient = createAdminClient();

  // ── Auth: verify admin role via app_metadata ──
  const { data: freshUser } = await adminClient.auth.admin.getUserById(user.id);
  if (!freshUser?.user?.app_metadata?.isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // ── Parse body ──
  const parsed = await parseBody(request, supportUnlockSchema);
  if (!parsed.success) return parsed.response;
  const { userId } = parsed.data;

  // ── Verify target user exists ──
  const { data: targetUser } = await adminClient.auth.admin.getUserById(userId);
  if (!targetUser?.user) {
    return NextResponse.json({ error: 'Bruger ikke fundet' }, { status: 404 });
  }

  // ── Apply unlock ──
  // Cast needed: the generated Supabase types don't include 'public' as a schema literal.
  // The structural type covers the .from().update().eq() chain used below.
  type SchemaSwitched = {
    schema: (s: string) => {
      from: (t: string) => {
        update: (v: Record<string, unknown>) => {
          eq: (c: string, v: unknown) => PromiseLike<{ error: { message: string } | null }>;
        };
      };
    };
  };
  const publicDb = (adminClient as unknown as SchemaSwitched).schema('public');
  const { error } = await publicDb
    .from('support_chat_abuse')
    .update({
      permanently_locked: false,
      locked_until: null,
      unlocked_by: user.id,
      unlocked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId);

  if (error) {
    logger.error('[admin/support-unlock] DB error:', error.message);
    return NextResponse.json({ error: 'Intern serverfejl' }, { status: 500 });
  }

  // Audit log — fire-and-forget (ISO 27001 A.12.4)
  void adminClient.from('audit_log').insert({
    action: 'admin.support.unlock_user',
    resource_type: 'user',
    resource_id: userId,
    metadata: JSON.stringify({ unlockedBy: user.id }),
  });

  return NextResponse.json({ success: true });
}
