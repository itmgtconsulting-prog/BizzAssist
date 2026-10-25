/**
 * GET /api/cron/indexnow — push nye/ændrede offentlige URLs til IndexNow (Bing/Yandex).
 *
 * Henter sitemap_entries ændret inden for de seneste 2 døgn (cap 10.000),
 * bygger de offentlige URLs (/ejendom/<slug>/<id>, /virksomhed/<slug>/<id>) og
 * indsender dem til IndexNow. IndexNow er til NOTIFIKATION om ændringer — derfor
 * kun friske entiteter, ikke bulk-genindsendelse af hele kataloget.
 *
 * Google deltager ikke i IndexNow; dette forbedrer Bing/Yandex + AI-søgning.
 *
 * Auth:
 *   - Authorization: Bearer <CRON_SECRET>
 *   - x-vercel-cron: 1 (kun i production)
 *
 * Retention: ingen persistens; læser kun sitemap_entries.
 *
 * @module app/api/cron/indexnow
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { submitToIndexNow } from '@/app/lib/indexnow';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Site-roden (trimmet defensivt). */
const BASE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk')
  .trim()
  .replace(/\/$/, '');

/** Maks URLs pr. kørsel (IndexNow-grænse er 10.000 pr. request). */
const BATCH_CAP = 10_000;

/**
 * Verificerer at anmodningen er autoriseret via CRON_SECRET (+ x-vercel-cron i prod).
 *
 * @param request - Indgående request
 * @returns true hvis autoriseret
 */
function verifyCronSecret(request: NextRequest): boolean {
  if (process.env.VERCEL_ENV === 'production' && request.headers.get('x-vercel-cron') !== '1') {
    return false;
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = request.headers.get('authorization') ?? '';
  return safeCompare(auth, `Bearer ${secret}`);
}

/**
 * GET-handler — indsender friske URLs til IndexNow.
 *
 * @param request - Next.js request
 * @returns JSON { ok, submitted, batches, statuses } eller fejl-status
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!process.env.INDEXNOW_KEY) {
    return NextResponse.json({ error: 'INDEXNOW_KEY ikke konfigureret' }, { status: 503 });
  }

  try {
    const admin = createAdminClient();
    const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await admin
      .from('sitemap_entries')
      .select('type, slug, entity_id')
      .gt('updated_at', since)
      .order('updated_at', { ascending: false })
      .limit(BATCH_CAP);

    if (error) {
      logger.error('[cron/indexnow] db-fejl:', error.message);
      return NextResponse.json({ error: 'DB-fejl' }, { status: 500 });
    }

    const urls = (data ?? [])
      .filter((r) => (r.type === 'ejendom' || r.type === 'virksomhed') && r.slug && r.entity_id)
      .map((r) => `${BASE_URL}/${r.type}/${r.slug}/${r.entity_id}`);

    if (urls.length === 0) {
      return NextResponse.json({ ok: true, submitted: 0, note: 'ingen friske entiteter' });
    }

    const res = await submitToIndexNow(urls, BASE_URL);
    logger.log(
      `[cron/indexnow] indsendte ${res.submitted} URLs (statuser: ${res.statuses.join(',')})`
    );
    return NextResponse.json(res);
  } catch (err) {
    logger.error('[cron/indexnow] fejl:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Intern fejl' }, { status: 500 });
  }
}
