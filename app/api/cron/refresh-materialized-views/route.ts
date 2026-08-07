/**
 * GET /api/cron/refresh-materialized-views
 *
 * BIZZ-920 / BIZZ-2209: Verificerer at de materialized views holdes friske.
 *
 * ARKITEKTUR (mig. 198): selve refreshet sker nu via pg_cron INDE i databasen,
 * ikke her. De tunge MV'er (op til 6.9M rækker) kan ikke refreshes inden for
 * Vercel-funktionens 300s-loft — pg_cron har ingen HTTP/tidsgrænse og bruger
 * function-level statement_timeout=0. Denne rute er derfor blevet en let
 * VERIFIER: den læser data_sync_status (som refresh_materialized_view() selv
 * opdaterer) og rapporterer `degraded` hvis en MV er forældet eller senest
 * fejlede — så watchdoggen fanger en knækket pg_cron-plan uden falske
 * 300s-timeout-alarmer.
 *
 * @module api/cron/refresh-materialized-views
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { withCronMonitor } from '@/app/lib/cronMonitor';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Maks. alder for en MV's seneste succesfulde refresh før den regnes som
 * forældet. pg_cron refresher dagligt (05:00–08:10 UTC, mig. 198); 26t giver
 * buffer til en enkelt oversprunget/forsinket kørsel uden falsk alarm.
 */
const STALE_HOURS = 26;

/**
 * Verificerer CRON_SECRET bearer + x-vercel-cron (i produktion).
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
 * De materialized views hvis friskhed verificeres. Selve refreshet er
 * scheduleret i pg_cron (mig. 198); denne liste er kontrakten for HVILKE MV'er
 * der forventes holdt friske, så en manglende data_sync_status-post (pg_cron-
 * job aldrig kørt) også fanges.
 */
const VIEWS = [
  'mv_analyse_ejendom',
  'mv_analyse_virksomhed',
  'mv_ejendom_master',
  'mv_ejerskab_beriget',
  'mv_virksomhed_struktur',
  'mv_deltager_beriget',
  'mv_virksomhed_portefolje',
  'mv_kommune_statistik',
  'mv_boligpris_maaned',
  // BIZZ-2056: flad handler-MV bag boligpris-tabellen.
  'mv_boligpris_handler',
  // BIZZ-2054: M&A-radarens kandidat-MV.
  'mv_virksomhedshandel_kandidater',
];

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // BIZZ-2209: verificér pg_cron-drevet MV-friskhed (refresher ikke selv længere).
  return withCronMonitor('refresh-materialized-views', async () => {
    const admin = createAdminClient();
    const staleCutoff = Date.now() - STALE_HOURS * 60 * 60 * 1000;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any)
      .from('data_sync_status')
      .select('source_name, last_success, last_error')
      .in('source_name', VIEWS);
    if (error) throw new Error(`data_sync_status opslag fejlede: ${error.message}`);

    const bySource = new Map<string, { last_success: string | null; last_error: string | null }>(
      (
        (data ?? []) as Array<{
          source_name: string;
          last_success: string | null;
          last_error: string | null;
        }>
      ).map((r) => [r.source_name, { last_success: r.last_success, last_error: r.last_error }])
    );

    // En MV er forældet hvis den mangler helt, aldrig har lykkedes, eller
    // seneste succes er ældre end STALE_HOURS.
    const stale = VIEWS.filter((view) => {
      const row = bySource.get(view);
      if (!row || !row.last_success) return true;
      return new Date(row.last_success).getTime() < staleCutoff;
    });
    const freshCount = VIEWS.length - stale.length;

    const degraded =
      stale.length > 0
        ? `${stale.length}/${VIEWS.length} MV forældet (>${STALE_HOURS}t / pg_cron ikke kørt): ${stale.join(', ')}`
        : undefined;

    return {
      response: NextResponse.json({ ok: stale.length === 0, freshCount, stale }),
      metrics: { itemsProcessed: VIEWS.length, itemsWritten: freshCount },
      degraded,
    };
  });
}
