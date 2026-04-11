/**
 * Admin subscription API — /api/admin/subscription
 *
 * All subscription mutations go directly to Supabase app_metadata.
 * This is the single source of truth — no localStorage sync needed.
 *
 * POST — perform an action on a user's subscription:
 *   - 'set'          — set/replace full subscription
 *   - 'approve'      — approve a pending subscription
 *   - 'reject'       — reject/cancel a subscription
 *   - 'changePlan'   — change the user's plan
 *   - 'removePlan'   — remove the user's subscription entirely
 *   - 'changeStatus' — change subscription status
 *   - 'addTokens'    — add bonus AI tokens
 *   - 'resetTokens'  — reset monthly token usage
 *
 * Only accessible by the admin user.
 *
 * @see app/lib/subscriptions.ts — subscription types and plan definitions
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendApprovalEmail } from '@/app/lib/email';
import { logger } from '@/app/lib/logger';

/**
 * Inserts a row into audit_log using an untyped client cast.
 * The audit_log table is not in the generated Supabase types, so we bypass
 * the type system here. Fire-and-forget — errors are only logged.
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
    logger.error('[audit] Failed to log subscription change:', e);
  }
}

/** Subscription shape stored in app_metadata */
interface SubData {
  planId: string;
  status: string;
  createdAt: string;
  approvedAt: string | null;
  tokensUsedThisMonth: number;
  periodStart: string;
  bonusTokens: number;
  isPaid: boolean;
}

/**
 * Find a Supabase Auth user by email using the admin client.
 *
 * @param admin - Supabase admin client
 * @param email - User email to find
 * @returns The user object or null
 */
async function findUserByEmail(admin: ReturnType<typeof createAdminClient>, email: string) {
  const { data: listData } = await admin.auth.admin.listUsers({ perPage: 1000 });
  return listData?.users?.find((u) => u.email === email) ?? null;
}

/**
 * Update a user's subscription in Supabase app_metadata.
 *
 * @param admin - Supabase admin client
 * @param userId - User ID to update
 * @param existingMetadata - Current app_metadata
 * @param subUpdates - Partial subscription updates to merge
 * @returns Updated subscription or error
 */
async function updateSubscription(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  existingMetadata: Record<string, unknown>,
  subUpdates: Partial<SubData>
) {
  const currentSub = (existingMetadata?.subscription as SubData) ?? {};
  const merged: SubData = {
    planId: subUpdates.planId ?? currentSub.planId ?? 'demo',
    status: subUpdates.status ?? currentSub.status ?? 'pending',
    createdAt: subUpdates.createdAt ?? currentSub.createdAt ?? new Date().toISOString(),
    approvedAt:
      subUpdates.approvedAt !== undefined ? subUpdates.approvedAt : (currentSub.approvedAt ?? null),
    tokensUsedThisMonth: subUpdates.tokensUsedThisMonth ?? currentSub.tokensUsedThisMonth ?? 0,
    periodStart: subUpdates.periodStart ?? currentSub.periodStart ?? new Date().toISOString(),
    bonusTokens: subUpdates.bonusTokens ?? currentSub.bonusTokens ?? 0,
    isPaid: subUpdates.isPaid ?? currentSub.isPaid ?? false,
  };

  const { error } = await admin.auth.admin.updateUserById(userId, {
    app_metadata: {
      ...existingMetadata,
      subscription: merged,
    },
  });

  if (error) return { error: error.message };
  return { subscription: merged };
}

/**
 * POST /api/admin/subscription — perform a subscription action.
 *
 * Body: { email, action, ...actionData }
 *
 * Actions:
 *   - set:          { email, action: 'set', planId, status, ... }
 *   - approve:      { email, action: 'approve' }
 *   - reject:       { email, action: 'reject' }
 *   - changePlan:   { email, action: 'changePlan', planId }
 *   - changeStatus: { email, action: 'changeStatus', status }
 *   - addTokens:    { email, action: 'addTokens', tokens }
 *   - resetTokens:  { email, action: 'resetTokens' }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // Verify caller is admin
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    // Check admin role in app_metadata
    const adminClient = createAdminClient();
    const { data: freshCaller } = await adminClient.auth.admin.getUserById(user.id);
    if (!freshCaller?.user?.app_metadata?.isAdmin) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await req.json();
    const { email, action = 'set', ...rest } = body;

    if (!email) {
      return NextResponse.json({ error: 'Email required' }, { status: 400 });
    }

    const admin = adminClient;
    const targetUser = await findUserByEmail(admin, email);
    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const metadata = targetUser.app_metadata ?? {};
    const currentSub = (metadata.subscription as SubData) ?? {};
    const now = new Date().toISOString();

    let result;

    switch (action) {
      case 'approve':
        result = await updateSubscription(admin, targetUser.id, metadata, {
          status: 'active',
          approvedAt: now,
        });
        // Send approval notification email — fire-and-forget (non-blocking)
        if (targetUser.email) {
          // Look up the plan's display name from plan_configs
          const { data: planRow } = await admin
            .from('plan_configs')
            .select('name_da')
            .eq('plan_id', currentSub.planId ?? 'demo')
            .limit(1)
            .single();
          const planName =
            (planRow as { name_da?: string } | null)?.name_da ?? currentSub.planId ?? 'Demo';
          const fullName = (targetUser.user_metadata?.full_name as string | undefined) ?? undefined;
          sendApprovalEmail({ to: targetUser.email, fullName, planName }).catch((err) =>
            logger.error('[admin/subscription] Approval email error (non-fatal):', err)
          );
        }
        break;

      case 'reject':
        result = await updateSubscription(admin, targetUser.id, metadata, {
          status: 'cancelled',
        });
        break;

      case 'changePlan':
        if (!rest.planId) {
          return NextResponse.json({ error: 'planId required' }, { status: 400 });
        }
        result = await updateSubscription(admin, targetUser.id, metadata, {
          planId: rest.planId,
        });
        break;

      case 'removePlan': {
        // Set subscription to null explicitly — Supabase shallow-merges app_metadata,
        // so omitting the key won't remove it. We must set it to null.
        const { error: removeErr } = await admin.auth.admin.updateUserById(targetUser.id, {
          app_metadata: { ...metadata, subscription: null },
        });
        if (removeErr) {
          return NextResponse.json({ error: removeErr.message }, { status: 500 });
        }
        // BIZZ-108: audit log includes old subscription state so the change is traceable.
        await insertAuditLog(admin, {
          action: 'admin.subscription.removePlan',
          resource_type: 'subscription',
          resource_id: targetUser.id,
          metadata: JSON.stringify({ changedBy: user.id, old: currentSub, new: null }),
        });
        return NextResponse.json({ ok: true, subscription: null });
      }

      case 'changeStatus':
        if (!rest.status) {
          return NextResponse.json({ error: 'status required' }, { status: 400 });
        }
        result = await updateSubscription(admin, targetUser.id, metadata, {
          status: rest.status,
          approvedAt: rest.status === 'active' && !currentSub.approvedAt ? now : undefined,
        });
        break;

      case 'addTokens': {
        const tokens = parseInt(rest.tokens, 10);
        if (!tokens || tokens <= 0) {
          return NextResponse.json({ error: 'Valid token amount required' }, { status: 400 });
        }
        result = await updateSubscription(admin, targetUser.id, metadata, {
          bonusTokens: (currentSub.bonusTokens ?? 0) + tokens,
        });
        break;
      }

      case 'resetTokens':
        result = await updateSubscription(admin, targetUser.id, metadata, {
          tokensUsedThisMonth: 0,
          periodStart: now,
        });
        break;

      case 'markPaid':
        result = await updateSubscription(admin, targetUser.id, metadata, {
          isPaid: rest.isPaid !== false,
        });
        break;

      case 'toggleAdmin': {
        // Set isAdmin flag directly on app_metadata (not inside subscription)
        const newIsAdmin = rest.isAdmin !== false;
        const { error: adminErr } = await admin.auth.admin.updateUserById(targetUser.id, {
          app_metadata: {
            ...metadata,
            isAdmin: newIsAdmin,
          },
        });
        if (adminErr) {
          return NextResponse.json({ error: adminErr.message }, { status: 500 });
        }
        // BIZZ-108: audit log records old and new admin flag value for traceability.
        await insertAuditLog(admin, {
          action: 'admin.subscription.toggleAdmin',
          resource_type: 'subscription',
          resource_id: targetUser.id,
          metadata: JSON.stringify({
            changedBy: user.id,
            old: { isAdmin: !!metadata.isAdmin },
            new: { isAdmin: newIsAdmin },
          }),
        });
        return NextResponse.json({ ok: true, isAdmin: newIsAdmin });
      }

      case 'set':
      default:
        // Full set — used when creating users or bulk-setting subscription
        result = await updateSubscription(admin, targetUser.id, metadata, {
          planId: rest.planId,
          status: rest.status,
          createdAt: rest.createdAt ?? now,
          approvedAt: rest.approvedAt ?? null,
          tokensUsedThisMonth: rest.tokensUsedThisMonth ?? 0,
          periodStart: rest.periodStart ?? now,
          bonusTokens: rest.bonusTokens ?? 0,
          isPaid: rest.isPaid ?? false,
        });
        break;
    }

    if (result.error) {
      logger.error('[admin/subscription]', action, 'error:', result.error);
      return NextResponse.json({ error: 'Failed to update' }, { status: 500 });
    }

    // BIZZ-108: audit log records action, admin who made the change, and old/new
    // subscription state so every plan/token/status mutation is fully traceable.
    await insertAuditLog(admin, {
      action: `admin.subscription.${action}`,
      resource_type: 'subscription',
      resource_id: targetUser.id,
      metadata: JSON.stringify({
        changedBy: user.id,
        old: currentSub,
        new: result.subscription ?? null,
      }),
    });

    return NextResponse.json({ ok: true, subscription: result.subscription });
  } catch (err) {
    logger.error('[admin/subscription] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
