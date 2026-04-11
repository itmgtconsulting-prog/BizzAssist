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
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

/**
 * Inserts a row into audit_log using the admin client.
 * Fire-and-forget — never throws, never blocks the main response.
 *
 * @param entry - Audit log entry fields
 */
async function insertAuditLog(entry: {
  action: string;
  resource_type: string;
  resource_id: string;
  metadata: string;
}): Promise<void> {
  try {
    const admin = createAdminClient();
    await admin.from('audit_log').insert(entry);
  } catch (e: unknown) {
    logger.error('[audit] Failed to insert audit log:', e);
  }
}

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
      logger.error('[profile] Update name error:', error.message);
      return NextResponse.json({ error: 'Failed to update name' }, { status: 500 });
    }

    // Audit log — fire-and-forget (ISO 27001 A.12.4)
    insertAuditLog({
      action: 'user.profile.update_name',
      resource_type: 'user',
      resource_id: user.id,
      metadata: JSON.stringify({ updatedFields: ['full_name'] }),
    }).catch(() => {});

    return NextResponse.json({ ok: true, fullName: fullName.trim() });
  } catch (err) {
    logger.error('[profile] Unexpected error:', err);
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
      logger.error('[profile] Change password error:', updateError.message);
      return NextResponse.json({ error: 'Failed to change password' }, { status: 500 });
    }

    // Audit log — fire-and-forget (ISO 27001 A.12.4)
    insertAuditLog({
      action: 'user.profile.change_password',
      resource_type: 'user',
      resource_id: user.id,
      metadata: JSON.stringify({}),
    }).catch(() => {});

    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('[profile] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
