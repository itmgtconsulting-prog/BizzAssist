/**
 * User subscription API — GET /api/subscription
 *
 * Returns the current user's subscription from their Supabase app_metadata.
 * Uses the ADMIN client to read fresh data directly from the Auth database,
 * bypassing JWT caching issues where app_metadata set by admin isn't
 * reflected in the user's JWT until token refresh.
 *
 * This is the server-side source of truth for subscriptions — works across
 * all browsers unlike localStorage.
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * GET /api/subscription — get the current user's subscription.
 *
 * Flow:
 *   1. Authenticate user via regular Supabase client (validates JWT)
 *   2. Use admin client to fetch fresh user data from Auth database
 *   3. Return the subscription from fresh app_metadata
 *
 * @returns JSON with subscription data or { subscription: null }
 */
export async function GET(): Promise<NextResponse> {
  try {
    // Step 1: Authenticate the caller via their JWT
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ subscription: null }, { status: 401 });
    }

    // Step 2: Use admin client to get FRESH user data from the Auth database.
    // This bypasses JWT caching — admin.auth.admin.getUserById reads directly
    // from the database, not from the JWT token.
    const admin = createAdminClient();
    const { data: freshUser, error } = await admin.auth.admin.getUserById(user.id);

    if (error || !freshUser?.user) {
      // Fallback to JWT data if admin lookup fails
      console.warn('[subscription] Admin getUserById failed, using JWT data:', error?.message);
      const subscription = user.app_metadata?.subscription ?? null;
      return NextResponse.json({
        email: user.email,
        fullName: (user.user_metadata?.full_name as string) ?? '',
        subscription,
      });
    }

    // Step 3: Return fresh data from database
    const subscription = freshUser.user.app_metadata?.subscription ?? null;
    const fullName = (freshUser.user.user_metadata?.full_name as string) ?? '';

    return NextResponse.json({
      email: freshUser.user.email,
      fullName,
      subscription,
    });
  } catch (err) {
    console.error('[subscription] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
