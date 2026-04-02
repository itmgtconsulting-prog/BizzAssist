/**
 * Self-service subscription cancellation — POST /api/subscription/cancel
 *
 * Cancels the authenticated user's subscription by setting status to 'cancelled'
 * in app_metadata. Used for plans assigned by admin (no Stripe subscription).
 * For Stripe-paid plans, use /api/stripe/cancel-subscription instead.
 *
 * @returns JSON with { ok: true } or error
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(): Promise<NextResponse> {
  try {
    // 1. Authenticate
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Get fresh user data
    const admin = createAdminClient();
    const { data: freshUser } = await admin.auth.admin.getUserById(user.id);
    const metadata = freshUser?.user?.app_metadata ?? {};
    const subscription = metadata.subscription as Record<string, unknown> | null;

    if (!subscription) {
      return NextResponse.json({ error: 'No subscription found' }, { status: 400 });
    }

    // 3. Set subscription status to cancelled
    await admin.auth.admin.updateUserById(user.id, {
      app_metadata: {
        ...metadata,
        subscription: {
          ...subscription,
          status: 'cancelled',
        },
      },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[subscription/cancel] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
