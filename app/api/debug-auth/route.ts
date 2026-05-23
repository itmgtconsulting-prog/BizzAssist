/**
 * GET /api/debug-auth — Temporary debug endpoint for auth issues.
 * REMOVE AFTER DEBUGGING.
 */
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';

export async function GET(): Promise<NextResponse> {
  try {
    const cookieStore = await cookies();
    const allCookies = cookieStore.getAll();
    const authCookies = allCookies.filter((c) => c.name.includes('auth'));

    const supabase = await createClient();
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    return NextResponse.json({
      cookieCount: allCookies.length,
      authCookieNames: authCookies.map((c) => c.name),
      authCookieSizes: authCookies.map((c) => c.value.length),
      userId: user?.id ?? null,
      userEmail: user?.email ?? null,
      authError: error?.message ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : 'unknown',
      },
      { status: 500 }
    );
  }
}
