/**
 * Admin bootstrap — POST /api/admin/bootstrap
 *
 * One-time endpoint to set the first admin user's isAdmin flag.
 * Requires BOOTSTRAP_SECRET (a dedicated env var) as authorization.
 * Should be disabled/removed after first use in production.
 *
 * Security: uses a separate BOOTSTRAP_SECRET — never the service role key —
 * so that a leaked request body cannot be used to derive database credentials.
 *
 * @param req - JSON body with { email: string, secret: string }
 * @returns JSON with { ok: true } or error
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { parseBody } from '@/app/lib/validate';

/** Zod schema for POST /api/admin/bootstrap request body */
const bootstrapPostSchema = z.object({
  email: z.string().min(1),
  secret: z.string().min(1),
}).passthrough();

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const parsed = await parseBody(req, bootstrapPostSchema);
    if (!parsed.success) return parsed.response;
    const { email, secret } = parsed.data;

    // Require a dedicated bootstrap secret — never compare against the service role key,
    // which is a database credential and must never travel over the wire.
    const bootstrapSecret = process.env.BOOTSTRAP_SECRET;
    if (!bootstrapSecret) {
      return NextResponse.json({ error: 'Bootstrap not configured' }, { status: 503 });
    }
    if (!safeCompare(secret, bootstrapSecret)) {
      return NextResponse.json({ error: 'Invalid secret' }, { status: 403 });
    }

    const admin = createAdminClient();

    // Prevent re-bootstrapping if any admin already exists
    const {
      data: { users: allUsers },
    } = await admin.auth.admin.listUsers({ perPage: 1000 });
    const alreadyBootstrapped = (allUsers ?? []).some((u) => u.app_metadata?.isAdmin === true);
    if (alreadyBootstrapped) {
      return NextResponse.json(
        { error: 'Bootstrap already completed — endpoint is disabled.' },
        { status: 409 }
      );
    }

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
    logger.error('[admin/bootstrap] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
