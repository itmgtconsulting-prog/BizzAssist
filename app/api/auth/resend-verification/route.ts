/**
 * POST /api/auth/resend-verification
 *
 * Resends the signup verification email for an unconfirmed user account.
 * Uses a standalone Supabase client (not cookie-based) so it works without
 * an authenticated session — the user hasn't confirmed their email yet.
 *
 * @param request - JSON body with { email: string }
 * @returns 200 on success, 400 if email missing, 500 on Supabase error
 */

import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const { email } = await request.json();

    if (!email || typeof email !== 'string') {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 });
    }

    // Use a standalone client with the anon key — auth.resend() is a public
    // endpoint that doesn't require a session or admin privileges.
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );

    const { error } = await supabase.auth.resend({
      type: 'signup',
      email,
      options: {
        emailRedirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback?type=signup`,
      },
    });

    if (error) {
      console.error('[resend-verification] Supabase error:', error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[resend-verification] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
