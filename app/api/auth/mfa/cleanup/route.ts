/**
 * POST /api/auth/mfa/cleanup
 *
 * Deletes all unverified TOTP factors for the currently authenticated user
 * using the service-role admin client. This is necessary because client-side
 * mfa.unenroll() can fail when the session AAL level is inconsistent (e.g.
 * after a failed enrollment attempt or after unenrolling a verified factor),
 * leaving behind stale unverified factors that block subsequent mfa.enroll()
 * calls in Supabase JS v2.99+.
 *
 * Must be called before mfa.enroll() to ensure a clean slate.
 *
 * @returns { deleted: number } — count of unverified factors removed
 */
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

export async function POST(): Promise<NextResponse> {
  try {
    // Authenticate the caller via their session cookie
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    // Use admin client to read and delete unverified factors — bypasses the
    // AAL restrictions that cause client-side unenroll() to silently fail.
    const admin = createAdminClient();
    const { data: factorsData, error: listError } = await admin.auth.admin.mfa.listFactors({
      userId: user.id,
    });
    if (listError) {
      logger.error('[mfa/cleanup] listFactors error:', listError.message);
      return NextResponse.json({ error: 'Could not list factors' }, { status: 500 });
    }

    // Filter to unverified TOTP factors only
    const unverified = (factorsData?.factors ?? []).filter(
      (f) => f.status !== 'verified' && f.factor_type === 'totp'
    );

    let deleted = 0;
    for (const factor of unverified) {
      const { error: deleteError } = await admin.auth.admin.mfa.deleteFactor({
        userId: user.id,
        id: factor.id,
      });
      if (deleteError) {
        // Log but continue — delete remaining factors even if one fails
        logger.error('[mfa/cleanup] deleteFactor error:', deleteError.message);
      } else {
        deleted++;
      }
    }

    return NextResponse.json({ deleted });
  } catch (err) {
    logger.error('[mfa/cleanup] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
