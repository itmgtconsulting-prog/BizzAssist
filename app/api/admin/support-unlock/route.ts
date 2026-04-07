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
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

interface UnlockRequestBody {
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
  let body: UnlockRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  const { userId } = body;
  if (!userId || typeof userId !== 'string') {
    return NextResponse.json({ error: 'userId er påkrævet' }, { status: 400 });
  }

  // ── Verify target user exists ──
  const { data: targetUser } = await adminClient.auth.admin.getUserById(userId);
  if (!targetUser?.user) {
    return NextResponse.json({ error: 'Bruger ikke fundet' }, { status: 404 });
  }

  // ── Apply unlock ──
  // Cast needed because the generated Supabase types don't include 'public' as a schema literal.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const publicDb = (adminClient as unknown as { schema: (s: string) => any }).schema('public');
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
    console.error('[admin/support-unlock] DB error:', error.message);
    return NextResponse.json({ error: 'Intern serverfejl' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
