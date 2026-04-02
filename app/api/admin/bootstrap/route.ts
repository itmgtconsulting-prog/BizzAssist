/**
 * Admin bootstrap — POST /api/admin/bootstrap
 *
 * One-time endpoint to set the first admin user's isAdmin flag.
 * Requires SUPABASE_SERVICE_ROLE_KEY as authorization to prevent abuse.
 * Should be disabled/removed after first use in production.
 *
 * @param req - JSON body with { email: string }
 * @returns JSON with { ok: true } or error
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const { email, secret } = await req.json();

    // Require the service role key as proof of server access
    if (secret !== process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return NextResponse.json({ error: 'Invalid secret' }, { status: 403 });
    }

    if (!email) {
      return NextResponse.json({ error: 'Email required' }, { status: 400 });
    }

    const admin = createAdminClient();
    const { data: listData } = await admin.auth.admin.listUsers({ perPage: 1000 });
    const targetUser = listData?.users?.find((u) => u.email === email);

    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const metadata = targetUser.app_metadata ?? {};
    await admin.auth.admin.updateUserById(targetUser.id, {
      app_metadata: { ...metadata, isAdmin: true },
    });

    return NextResponse.json({ ok: true, email, isAdmin: true });
  } catch (err) {
    console.error('[admin/bootstrap] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
