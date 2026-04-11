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
import { createAdminClient, tenantDb } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

/**
 * Inserts a row into audit_log using an untyped client cast.
 * The audit_log table is not in the generated Supabase types.
 * Fire-and-forget — errors are only logged.
 *
 * @param client - Admin Supabase client
 * @param entry  - Audit log entry fields
 */
async function insertAuditLog(
  client: ReturnType<typeof createAdminClient>,
  entry: { action: string; resource_type: string; resource_id: string; metadata: string }
): Promise<void> {
  try {
    await client.from('audit_log').insert(entry);
  } catch (e: unknown) {
    logger.error('[audit] Failed to insert audit log:', e);
  }
}

/** Shape returned per user — includes subscription from app_metadata */
interface AdminUserRow {
  id: string;
  email: string;
  fullName: string;
  createdAt: string;
  lastSignIn: string | null;
  emailConfirmed: boolean;
  isAdmin: boolean;
  subscription: {
    planId: string;
    status: string;
    createdAt: string;
    approvedAt: string | null;
    tokensUsedThisMonth: number;
    periodStart: string;
    bonusTokens: number;
    isPaid?: boolean;
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
  if (!user) return null;
  const admin = createAdminClient();
  const { data: freshUser } = await admin.auth.admin.getUserById(user.id);
  if (freshUser?.user?.app_metadata?.isAdmin) return user;
  return null;
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
      logger.error('[admin/users] listUsers error:', error.code ?? '[DB error]');
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
        isAdmin: !!u.app_metadata?.isAdmin,
        subscription: sub
          ? {
              planId: sub.planId ?? 'demo',
              status: sub.status ?? 'pending',
              createdAt: sub.createdAt ?? u.created_at,
              approvedAt: sub.approvedAt ?? null,
              tokensUsedThisMonth: sub.tokensUsedThisMonth ?? 0,
              periodStart: sub.periodStart ?? u.created_at,
              bonusTokens: sub.bonusTokens ?? 0,
              isPaid: sub.isPaid ?? false,
            }
          : null,
      };
    });

    return NextResponse.json(users);
  } catch (err) {
    logger.error('[admin/users] Unexpected error:', err);
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
      logger.error('[admin/users] Create error:', createError.code ?? '[DB error]');
      return NextResponse.json({ error: 'Failed to create user' }, { status: 400 });
    }

    // Audit log — fire-and-forget (ISO 27001 A.12.4)
    await insertAuditLog(admin, {
      action: 'admin.user.create',
      resource_type: 'user',
      resource_id: newUser.user.id,
      metadata: JSON.stringify({ createdEmail: email }),
    });

    return NextResponse.json({
      ok: true,
      user: {
        id: newUser.user.id,
        email: newUser.user.email,
      },
    });
  } catch (err) {
    logger.error('[admin/users] Create unexpected error:', err);
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

    // Find user by email
    const admin = createAdminClient();
    const { data: listData } = await admin.auth.admin.listUsers({ perPage: 1000 });
    const targetUser = listData?.users?.find((u) => u.email === email);

    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Prevent deleting admin users
    if (targetUser.app_metadata?.isAdmin) {
      return NextResponse.json({ error: 'Cannot delete admin user' }, { status: 400 });
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

    // Step 3: Audit log BEFORE deletion — the row will be gone after
    await insertAuditLog(admin, {
      action: 'admin.user.delete',
      resource_type: 'user',
      resource_id: targetUser.id,
      metadata: JSON.stringify({ deletedEmail: email }),
    });

    // Step 4: Cascade-delete all tenant-scoped data for this user.
    // We look up the user's tenant membership to find the schema name,
    // then remove all personal data from tenant tables before deleting auth.
    // Also marks the tenant as closed so the nightly purge cron can enforce
    // the 30-day post-closure GDPR erasure (BIZZ-131).
    try {
      const { data: membership } = await admin
        .from('tenant_memberships')
        .select('tenant_id')
        .eq('user_id', targetUser.id)
        .limit(1)
        .single();

      if (membership?.tenant_id) {
        const tenantId: string = membership.tenant_id;

        const { data: tenantRow } = await admin
          .from('tenants')
          .select('schema_name')
          .eq('id', tenantId)
          .single();

        const schemaName: string | null = tenantRow?.schema_name ?? null;

        if (schemaName) {
          // Delete from each tenant-schema table where user_id matches.
          const db = tenantDb(schemaName);

          await db.from('recent_entities').delete().eq('user_id', targetUser.id);
          await db.from('saved_entities').delete().eq('user_id', targetUser.id);
          await db.from('notifications').delete().eq('user_id', targetUser.id);
          // BIZZ-134: also erase search history and activity entries for this user.
          // GDPR Art. 17 requires complete erasure of all personal data on deletion.
          await db.from('recent_searches').delete().eq('user_id', targetUser.id);
          await db.from('activity_log').delete().eq('user_id', targetUser.id);

          // Drop the schema entirely via raw SQL — all personal data has already
          // been deleted above. Dropping the schema now ensures that re-registering
          // with the same email starts from a completely clean slate.
          // GDPR Art. 17: data is already erased above; the empty schema has no
          // retention value so it is dropped immediately rather than after 30 days.
          try {
            const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
            const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
            if (supabaseUrl && accessToken) {
              const projectRef = supabaseUrl.replace('https://', '').split('.')[0];
              await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ query: `DROP SCHEMA IF EXISTS ${schemaName} CASCADE` }),
                signal: AbortSignal.timeout(10000),
              });
            }
          } catch (dropErr) {
            logger.error('[admin/users] Schema drop error (non-fatal):', dropErr);
          }
        }

        // Delete tenant membership and tenant record so re-registration with the
        // same email starts from a clean slate (no orphaned rows).
        await admin.from('tenant_memberships').delete().eq('tenant_id', tenantId);
        await admin.from('tenants').delete().eq('id', tenantId);
      }
    } catch (cascadeErr) {
      // Non-critical path — log but do not abort deletion.
      // The auth record deletion below is the source of truth for GDPR erasure.
      logger.error('[admin/users] Cascade delete error (non-fatal):', cascadeErr);
    }

    // Step 5: Delete from Supabase Auth (removes user, sessions, MFA factors)
    const { error: deleteError } = await admin.auth.admin.deleteUser(targetUser.id);
    if (deleteError) {
      logger.error('[admin/users] Delete error:', deleteError.code ?? '[DB error]');
      return NextResponse.json({ error: 'Failed to delete user' }, { status: 500 });
    }

    return NextResponse.json({ ok: true, deletedEmail: email });
  } catch (err) {
    logger.error('[admin/users] Delete unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
