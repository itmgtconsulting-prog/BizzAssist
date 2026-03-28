/**
 * Admin subscription API — POST /api/admin/subscription
 *
 * Saves a user's subscription data in their Supabase app_metadata.
 * This makes subscription data available across browsers (not just localStorage).
 *
 * Only accessible by the admin user.
 *
 * @see app/lib/subscriptions.ts — subscription types and helpers
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

const ADMIN_EMAIL = 'jjrchefen@hotmail.com';

/**
 * POST /api/admin/subscription — set a user's subscription in app_metadata.
 *
 * Body: { email, planId, status, approvedAt, tokensUsedThisMonth, periodStart, bonusTokens, createdAt }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // Verify caller is admin
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user?.email || user.email !== ADMIN_EMAIL) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await req.json();
    const { email, ...subData } = body;

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

    // Store subscription in app_metadata (only settable by service role)
    const { error: updateError } = await admin.auth.admin.updateUserById(targetUser.id, {
      app_metadata: {
        ...targetUser.app_metadata,
        subscription: {
          planId: subData.planId,
          status: subData.status,
          createdAt: subData.createdAt ?? new Date().toISOString(),
          approvedAt: subData.approvedAt ?? null,
          tokensUsedThisMonth: subData.tokensUsedThisMonth ?? 0,
          periodStart: subData.periodStart ?? new Date().toISOString(),
          bonusTokens: subData.bonusTokens ?? 0,
        },
      },
    });

    if (updateError) {
      console.error('[admin/subscription] Update error:', updateError.message);
      return NextResponse.json({ error: 'Failed to update' }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[admin/subscription] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
