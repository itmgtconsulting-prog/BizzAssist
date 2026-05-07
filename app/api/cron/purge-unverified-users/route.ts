/**
 * GET /api/cron/purge-unverified-users
 *
 * BIZZ-1173: Sletter brugere der ikke har verificeret email indenfor 48 timer.
 * Kører dagligt via Vercel cron. Cascader til tenant_memberships via
 * Supabase admin deleteUser.
 *
 * @retention 48 timer — brugere uden email_confirmed_at slettes efter denne periode
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/app/lib/logger';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Antal timer en bruger har til at verificere email */
const VERIFICATION_WINDOW_HOURS = 48;

/**
 * Sletter ikke-verificerede brugere ældre end 48 timer.
 *
 * @param request - Next.js request
 * @returns JSON med antal slettede brugere
 */
export async function GET(request: NextRequest) {
  // Verificer cron-secret
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  const bearerToken = authHeader?.replace('Bearer ', '');

  if (
    process.env.NODE_ENV === 'production' &&
    (!cronSecret || bearerToken !== cronSecret) &&
    !isVercelCron
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const admin = createAdminClient();
    const cutoff = new Date(Date.now() - VERIFICATION_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

    // Hent brugere der ikke har verificeret email og er ældre end 48 timer
    const {
      data: { users },
      error: listError,
    } = await admin.auth.admin.listUsers({
      perPage: 100,
    });

    if (listError) {
      logger.error('[purge-unverified] Fejl ved listUsers:', listError);
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 200 });
    }

    const unverified = users.filter(
      (u) => !u.email_confirmed_at && u.created_at && new Date(u.created_at).toISOString() < cutoff
    );

    let deleted = 0;
    for (const user of unverified) {
      try {
        const { error: deleteError } = await admin.auth.admin.deleteUser(user.id);
        if (deleteError) {
          logger.warn(`[purge-unverified] Fejl ved sletning af ${user.email}:`, deleteError);
        } else {
          deleted++;
          logger.log(
            `[purge-unverified] Slettet ikke-verificeret bruger: ${user.email} (oprettet ${user.created_at})`
          );
        }
      } catch (err) {
        logger.warn(`[purge-unverified] Uventet fejl ved sletning:`, err);
      }
    }

    logger.log(`[purge-unverified] Færdig: ${deleted}/${unverified.length} brugere slettet`);

    return NextResponse.json({ deleted, total: unverified.length, cutoff }, { status: 200 });
  } catch (err) {
    logger.error('[purge-unverified] Uventet fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 200 });
  }
}
