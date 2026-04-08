/**
 * Token usage tracking API — POST /api/subscription/track-tokens
 *
 * Increments the current user's tokensUsedThisMonth in Supabase app_metadata.
 * Called from the AI chat panel after each response.
 *
 * @module api/subscription/track-tokens
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * POST /api/subscription/track-tokens — increment token usage.
 *
 * Body: { tokensUsed: number }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // Authenticate user
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { tokensUsed } = body as { tokensUsed: unknown };

    // Validate: must be a positive integer no greater than 10 000 (one API call max).
    // This prevents a compromised browser from inflating token counts arbitrarily.
    if (
      typeof tokensUsed !== 'number' ||
      !Number.isInteger(tokensUsed) ||
      tokensUsed <= 0 ||
      tokensUsed > 10_000
    ) {
      return NextResponse.json(
        { error: 'tokensUsed skal være et positivt heltal ≤ 10000' },
        { status: 400 }
      );
    }

    // Get fresh user data to read current token count
    const admin = createAdminClient();
    const { data: freshUser, error } = await admin.auth.admin.getUserById(user.id);

    if (error || !freshUser?.user) {
      console.error('[track-tokens] getUserById error:', error?.message);
      return NextResponse.json({ error: 'Failed to read user' }, { status: 500 });
    }

    const metadata = freshUser.user.app_metadata ?? {};
    const sub = (metadata.subscription as Record<string, unknown>) ?? {};
    const currentTokens = (sub.tokensUsedThisMonth as number) ?? 0;

    // Update token count
    const { error: updateError } = await admin.auth.admin.updateUserById(user.id, {
      app_metadata: {
        ...metadata,
        subscription: {
          ...sub,
          tokensUsedThisMonth: currentTokens + tokensUsed,
        },
      },
    });

    if (updateError) {
      console.error('[track-tokens] Update error:', updateError.message);
      return NextResponse.json({ error: 'Failed to update' }, { status: 500 });
    }

    return NextResponse.json({ ok: true, total: currentTokens + tokensUsed });
  } catch (err) {
    console.error('[track-tokens] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
