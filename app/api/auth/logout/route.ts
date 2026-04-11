/**
 * POST /api/auth/logout
 *
 * Server-side logout — invalidates the current Supabase session.
 * Use this instead of client-side signOut() to ensure session cookies
 * are properly cleared server-side.
 *
 * @returns { success: true } on success, { error: string } on failure
 */
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/app/lib/logger';

export async function POST(): Promise<NextResponse> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    await supabase.auth.signOut();
    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error('[logout] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
