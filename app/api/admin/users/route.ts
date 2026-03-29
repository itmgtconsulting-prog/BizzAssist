/**
 * Admin users API — /api/admin/users
 *
 * Returns all Supabase Auth users with their subscription data from app_metadata.
 * All data comes directly from Supabase — no localStorage involved.
 *
 * GET    — list all users with subscription info
 * POST   — create a new user (bypasses rate limits)
 * DELETE — permanently delete a user
 *
 * Only accessible by the admin user (verified via Supabase session).
 *
 * @see app/dashboard/admin/users/page.tsx — admin user management UI
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

/** Admin email — must match the one in subscriptions.ts */
const ADMIN_EMAIL = 'jjrchefen@hotmail.com';

/** Shape returned per user — includes subscription from app_metadata */
interface AdminUserRow {
  id: string;
  email: string;
  fullName: string;
  createdAt: string;
  lastSignIn: string | null;
  emailConfirmed: boolean;
  subscription: {
    planId: string;
    status: string;
    createdAt: string;
    approvedAt: string | null;
    tokensUsedThisMonth: number;
    periodStart: string;
    bonusTokens: number;
  } | null;
}

/**
 * Verify the caller is the admin user.
 * Returns the authenticated user or null if not admin.
 */
async function verifyAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email || user.email !== ADMIN_EMAIL) return null;
  return user;
}

/**
 * GET /api/admin/users — list all Supabase Auth users with subscription data.
 *
 * Returns users from Supabase Auth, including their subscription from app_metadata.
 * This is the single source of truth — no localStorage sync needed.
 *
 * @returns JSON array of AdminUserRow
 */
export async function GET(): Promise<NextResponse> {
  try {
    if (!(await verifyAdmin())) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const admin = createAdminClient();
    const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });

    if (error) {
      console.error('[admin/users] listUsers error:', error.message);
      return NextResponse.json({ error: 'Failed to list users' }, { status: 500 });
    }

    const users: AdminUserRow[] = data.users.map((u) => {
      const sub = u.app_metadata?.subscription as AdminUserRow['subscription'] | undefined;
      return {
        id: u.id,
        email: u.email ?? '',
        fullName: (u.user_metadata?.full_name as string) ?? '',
        createdAt: u.created_at,
        lastSignIn: u.last_sign_in_at ?? null,
        emailConfirmed: !!u.email_confirmed_at,
        subscription: sub
          ? {
              planId: sub.planId ?? 'demo',
              status: sub.status ?? 'pending',
              createdAt: sub.createdAt ?? u.created_at,
              approvedAt: sub.approvedAt ?? null,
              tokensUsedThisMonth: sub.tokensUsedThisMonth ?? 0,
              periodStart: sub.periodStart ?? u.created_at,
              bonusTokens: sub.bonusTokens ?? 0,
            }
          : null,
      };
    });

    return NextResponse.json(users);
  } catch (err) {
    console.error('[admin/users] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/admin/users — create a new user via the admin client.
 *
 * Bypasses Supabase's signup rate limiting. The user is created with a
 * confirmed email (no verification needed) and subscription in app_metadata.
 *
 * Body: { email: string, password: string, fullName?: string, subscription?: object }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    if (!(await verifyAdmin())) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { email, password, fullName, subscription } = await req.json();
    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password required' }, { status: 400 });
    }

    const admin = createAdminClient();

    // Create user with confirmed email (bypasses rate limits and email verification)
    const { data: newUser, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: fullName || email.split('@')[0],
      },
      app_metadata: subscription ? { subscription } : {},
    });

    if (createError) {
      console.error('[admin/users] Create error:', createError.message);
      return NextResponse.json({ error: createError.message }, { status: 400 });
    }

    return NextResponse.json({
      ok: true,
      user: {
        id: newUser.user.id,
        email: newUser.user.email,
      },
    });
  } catch (err) {
    console.error('[admin/users] Create unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/users — permanently delete a user and all their data.
 *
 * Body: { email: string }
 *
 * Performs a complete cleanup:
 *   1. Invalidates all active sessions (ban trick)
 *   2. Clears subscription from app_metadata
 *   3. Deletes the user from Supabase Auth entirely
 *
 * Cannot delete the admin user.
 */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  try {
    if (!(await verifyAdmin())) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { email } = await req.json();
    if (!email) {
      return NextResponse.json({ error: 'Email required' }, { status: 400 });
    }

    // Prevent deleting admin
    if (email === ADMIN_EMAIL) {
      return NextResponse.json({ error: 'Cannot delete admin user' }, { status: 400 });
    }

    // Find user by email
    const admin = createAdminClient();
    const { data: listData } = await admin.auth.admin.listUsers({ perPage: 1000 });
    const targetUser = listData?.users?.find((u) => u.email === email);

    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Step 1: Invalidate all sessions by temporarily banning the user
    try {
      await admin.auth.admin.updateUserById(targetUser.id, { ban_duration: '1s' });
      await new Promise((r) => setTimeout(r, 500));
    } catch {
      // Non-critical — continue with deletion
    }

    // Step 2: Clear subscription from app_metadata before deletion
    try {
      await admin.auth.admin.updateUserById(targetUser.id, {
        app_metadata: { subscription: null },
      });
    } catch {
      // Non-critical — user is being deleted anyway
    }

    // Step 3: Delete from Supabase Auth (removes user, sessions, MFA factors)
    const { error: deleteError } = await admin.auth.admin.deleteUser(targetUser.id);
    if (deleteError) {
      console.error('[admin/users] Delete error:', deleteError.message);
      return NextResponse.json({ error: 'Failed to delete user' }, { status: 500 });
    }

    return NextResponse.json({ ok: true, deletedEmail: email });
  } catch (err) {
    console.error('[admin/users] Delete unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
