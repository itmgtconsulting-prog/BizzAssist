/**
 * Profile API — /api/profile
 *
 * PUT  — update display name (user_metadata.full_name)
 * POST — change password (verifies current password first)
 *
 * Both operations use the authenticated user's session (cookies).
 * Password verification uses signInWithPassword to confirm current password
 * before allowing the change.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * PUT /api/profile — update display name.
 *
 * Body: { fullName: string }
 */
export async function PUT(req: NextRequest): Promise<NextResponse> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { fullName } = await req.json();

    if (typeof fullName !== 'string' || fullName.trim().length === 0) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }

    const { error } = await supabase.auth.updateUser({
      data: { full_name: fullName.trim() },
    });

    if (error) {
      console.error('[profile] Update name error:', error.message);
      return NextResponse.json({ error: 'Failed to update name' }, { status: 500 });
    }

    return NextResponse.json({ ok: true, fullName: fullName.trim() });
  } catch (err) {
    console.error('[profile] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/profile — change password.
 *
 * Body: { currentPassword: string, newPassword: string }
 *
 * Verifies the current password by re-authenticating, then updates.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user || !user.email) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { currentPassword, newPassword } = await req.json();

    if (!currentPassword || !newPassword) {
      return NextResponse.json({ error: 'Both passwords required' }, { status: 400 });
    }

    if (newPassword.length < 6) {
      return NextResponse.json({ error: 'password_too_short' }, { status: 400 });
    }

    // Verify current password by re-authenticating
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: user.email,
      password: currentPassword,
    });

    if (signInError) {
      return NextResponse.json({ error: 'wrong_password' }, { status: 400 });
    }

    // Update to new password
    const { error: updateError } = await supabase.auth.updateUser({
      password: newPassword,
    });

    if (updateError) {
      const msg = (updateError.message ?? '').toLowerCase();
      if (msg.includes('same password') || msg.includes('different')) {
        return NextResponse.json({ error: 'same_password' }, { status: 400 });
      }
      console.error('[profile] Change password error:', updateError.message);
      return NextResponse.json({ error: 'Failed to change password' }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[profile] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
