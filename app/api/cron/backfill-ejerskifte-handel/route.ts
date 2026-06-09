/**
 * Cron: Backfill ejerskifte_historik med manglende EJF-handler
 *
 * BIZZ-2053: ejerskifte_historik manglede handler som findes i
 * v_ejerskifte_handel (ejf_ejerskifte ⋈ ejf_handelsoplysninger).
 * Ejendomspris Dashboard's handler-tabel kalder RPC boligpris_handler()
 * der læser ejerskifte_historik (filter i_alt_koebesum > 0, INNER JOIN
 * bbr_ejendom_status) — så handler uden en række i ejerskifte_historik
 * var usynlige i dashboardet (eks: Hvidovre kolonihavehuse, BBR-kode 540).
 *
 * Denne cron indsætter manglende handler DIREKTE fra EJF-tabellerne
 * (DB→DB, ingen ekstern API):
 *   - i_alt_koebesum   ← COALESCE(samlet_koebesum, kontant_koebesum)
 *   - kontant_koebesum ← kontant_koebesum
 *   - kommune_kode +
 *     byg021_anvendelse ← bbr_ejendom_status
 *   - historisk_kilde  = 'ejf_handel' (migration 171)
 *
 * Idempotens: ejer_navn er NULL for EJF-handler, og NULL er distinct i
 * Postgres unique-indekser, så unique-constrainten
 * (bfe_nummer, overtagelsesdato, ejer_navn) kan IKKE deduplikere.
 * Derfor dedupliceres manuelt med NOT EXISTS på (bfe_nummer,
 * overtagelsesdato) — dashboardet grupperer alligevel med
 * DISTINCT ON (bfe_nummer, overtagelsesdato).
 *
 * Bagud-katalog (~4,2 mio. rækker) blev fyldt via engangs-script.
 * Denne cron holder kun de seneste ~180 dages handler i sync — bundet
 * vindue så kørslen holder sig under SQL-runnerens 75s timeout.
 *
 * Retention: ejerskifte_historik er offentlige tinglysnings-/EJF-data
 * (ingen PII ud over ejer-navn, som her er NULL). Ingen sletning.
 *
 * Schedule: 50 4 * * * UTC (dagligt, efter backfill-ejerskifte-historik 30 4).
 *
 * @module api/cron/backfill-ejerskifte-handel
 */

import { NextRequest, NextResponse } from 'next/server';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';
import { createDefaultSqlRunner } from '@/app/lib/dataIntelligence/buildCatalog';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** Hvor mange dages handler der holdes i sync per kørsel (bundet vindue). */
const WINDOW_DAYS = 180;

/**
 * Idempotent INSERT … SELECT der indsætter manglende EJF-handler i
 * ejerskifte_historik for de seneste {@link WINDOW_DAYS} dage.
 *
 * DISTINCT ON (bfe, dato) vælger handelen med højeste købesum pr.
 * ejendom/dato. NOT EXISTS sikrer at allerede-eksisterende (bfe, dato)
 * ikke duplikeres.
 */
const BACKFILL_SQL = `
  WITH inserted AS (
    INSERT INTO public.ejerskifte_historik
      (bfe_nummer, overtagelsesdato, kontant_koebesum, i_alt_koebesum,
       koebsaftale_dato, kommune_kode, byg021_anvendelse, kilde, historisk_kilde)
    SELECT DISTINCT ON (e.bfe_nummer, e.overtagelsesdato::date)
      e.bfe_nummer,
      e.overtagelsesdato::date,
      h.kontant_koebesum,
      COALESCE(h.samlet_koebesum, h.kontant_koebesum),
      h.koebsaftale_dato,
      b.kommune_kode,
      b.byg021_anvendelse,
      'ejf_handel',
      'ejf_handel'
    FROM public.ejf_ejerskifte e
    JOIN public.ejf_handelsoplysninger h
      ON h.id_lokal_id = e.handelsoplysninger_lokal_id
    JOIN public.bbr_ejendom_status b
      ON b.bfe_nummer = e.bfe_nummer
    WHERE COALESCE(h.samlet_koebesum, h.kontant_koebesum) > 0
      AND e.overtagelsesdato IS NOT NULL
      AND e.overtagelsesdato >= (CURRENT_DATE - INTERVAL '${WINDOW_DAYS} days')
      AND NOT EXISTS (
        SELECT 1 FROM public.ejerskifte_historik eh
        WHERE eh.bfe_nummer = e.bfe_nummer
          AND eh.overtagelsesdato = e.overtagelsesdato::date
      )
    ORDER BY
      e.bfe_nummer,
      e.overtagelsesdato::date,
      COALESCE(h.samlet_koebesum, h.kontant_koebesum) DESC
    RETURNING 1
  )
  SELECT COUNT(*)::int AS inserted FROM inserted
`;

/**
 * GET handler — kræver CRON_SECRET bearer token + x-vercel-cron i prod.
 *
 * @param request - Next.js request (auth-headers tjekkes)
 * @returns JSON med antal indsatte handler + varighed
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  // ── Auth ──
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  const isProd = process.env.NODE_ENV === 'production';

  if (isProd && (!cronSecret || !safeCompare(token, cronSecret))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (isProd && !isVercelCron) {
    return NextResponse.json({ error: 'Missing x-vercel-cron' }, { status: 403 });
  }

  return withCronMonitor(
    { jobName: 'backfill-ejerskifte-handel', schedule: '50 4 * * *', intervalMinutes: 1440 },
    async () => {
      const start = Date.now();
      try {
        const sqlRunner = createDefaultSqlRunner();
        const rows = await sqlRunner(BACKFILL_SQL);
        const inserted = Number(rows[0]?.inserted ?? 0);
        const durationMs = Date.now() - start;
        logger.log(`[backfill-ejerskifte-handel] inserted=${inserted} ${durationMs}ms`);
        return NextResponse.json({ ok: true, inserted, windowDays: WINDOW_DAYS, durationMs });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        logger.error('[backfill-ejerskifte-handel] failed:', msg);
        return NextResponse.json({ error: 'Backfill fejlede' }, { status: 500 });
      }
    }
  );
}
