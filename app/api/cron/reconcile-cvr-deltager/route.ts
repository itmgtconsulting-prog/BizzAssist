/**
 * Cron/on-demand: CVR deltager reconciliation — /api/cron/reconcile-cvr-deltager
 *
 * BIZZ-1976: Validerings-check for at vores antagelse om watermark-baseret
 * delta-sync på `sidstIndlaest` faktisk fanger ALT. Tæller antal deltager-
 * dokumenter i CVR ES med sidstIndlaest i et [from,to]-vindue og sammenligner
 * med antal rækker i vores cvr_deltager-tabel i SAMME vindue. Et match (eller
 * DB ≥ ES) betyder, at vi har konsumeret hele feed'et for perioden; et
 * underskud (DB < ES) afslører tabt delta.
 *
 * Bruges som:
 *  - Baseline nu (BIZZ-1976) for at fastlægge en udgangsmåling.
 *  - Re-run om 1-2 uger for at bekræfte at antagelsen holder over tid.
 *
 * Read-only: laver ingen skrivninger, ændrer ikke watermark. Sikkert at køre
 * når som helst.
 *
 * Schedule: ikke i fast cron-loop — køres on-demand med CRON_SECRET. Params:
 *   ?days=14            vindue-bredde i dage (default 14), eller
 *   ?from=ISO&to=ISO    eksplicit vindue.
 *
 * @module api/cron/reconcile-cvr-deltager
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Default vindue-bredde i dage når hverken from/to eller days angives */
const DEFAULT_WINDOW_DAYS = 14;

/** CVR ES base URL */
const CVR_ES_BASE = 'http://distribution.virk.dk/cvr-permanent';

/**
 * Verificerer CRON_SECRET + (i prod) Vercel cron-header.
 *
 * @param request - Incoming request
 * @returns True hvis auth OK
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
 * Returnerer Basic auth header til CVR ES.
 *
 * @returns Auth header string eller null
 */
function getCvrEsAuthHeader(): string | null {
  const user = process.env.CVR_ES_USER;
  const pass = process.env.CVR_ES_PASS;
  if (!user || !pass) return null;
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

/**
 * Tæller deltager-dokumenter i CVR ES med sidstIndlaest i [from,to).
 *
 * Bruger _count-API'et (size:0-ækvivalent) — returnerer kun totalen, ingen
 * hits, så det er billigt selv for store vinduer.
 *
 * @param auth - Basic auth header
 * @param from - ISO nedre grænse (inklusiv)
 * @param to - ISO øvre grænse (eksklusiv)
 * @returns Antal dokumenter, eller null ved fejl
 */
async function countEs(auth: string, from: string, to: string): Promise<number | null> {
  try {
    const res = await fetch(`${CVR_ES_BASE}/deltager/_count`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({
        query: {
          range: {
            'Vrdeltagerperson.sidstIndlaest': { gte: from, lt: to },
          },
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      logger.warn(`[reconcile-deltager] ES _count HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as { count?: number };
    return typeof json.count === 'number' ? json.count : null;
  } catch (err) {
    logger.warn(
      `[reconcile-deltager] ES _count exception: ${err instanceof Error ? err.message : 'ukendt'}`
    );
    return null;
  }
}

/**
 * GET handler — kører reconciliation-check (read-only).
 *
 * @param request - GET request med CRON_SECRET auth
 * @returns JSON med ES-count, DB-count og diff
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return withCronMonitor(
    {
      jobName: 'reconcile-cvr-deltager',
      schedule: 'on-demand',
      intervalMinutes: 0,
      maxRuntimeMinutes: 1,
    },
    async () => {
      const auth = getCvrEsAuthHeader();
      if (!auth) {
        return NextResponse.json(
          { ok: false, error: 'CVR_ES_USER/PASS ikke konfigureret' },
          { status: 503 }
        );
      }

      // Vindue: eksplicit from/to, ellers [now − days, now).
      const fromRaw = request.nextUrl.searchParams.get('from');
      const toRaw = request.nextUrl.searchParams.get('to');
      const daysRaw = request.nextUrl.searchParams.get('days');
      const days = daysRaw ? parseInt(daysRaw, 10) : DEFAULT_WINDOW_DAYS;

      const to = toRaw ?? new Date().toISOString();
      const from = fromRaw ?? new Date(Date.parse(to) - days * 24 * 60 * 60 * 1000).toISOString();

      logger.log(`[reconcile-deltager] Vindue [${from}, ${to})`);

      // 1. CVR ES-count i vinduet.
      const esCount = await countEs(auth, from, to);
      if (esCount === null) {
        return NextResponse.json(
          { ok: false, error: 'CVR ES _count fejlede', from, to },
          { status: 502 }
        );
      }

      // 2. DB-count i samme vindue på cvr_deltager.sidst_indlaest.
      const admin = createAdminClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { count: dbCount, error: dbErr } = await (admin as any)
        .from('cvr_deltager')
        .select('enhedsnummer', { count: 'exact', head: true })
        .gte('sidst_indlaest', from)
        .lt('sidst_indlaest', to);

      if (dbErr) {
        return NextResponse.json(
          { ok: false, error: `DB count fejl: ${dbErr.message}`, from, to, esCount },
          { status: 500 }
        );
      }

      const db = dbCount ?? 0;
      // DB < ES = tabt delta i perioden. DB ≥ ES = fuld dækning (DB kan være
      // højere pga. genudgivelser konsolideret på samme enhedsnummer).
      const missing = Math.max(0, esCount - db);
      const coveragePct = esCount > 0 ? Math.round((db / esCount) * 10000) / 100 : 100;
      const verdict = missing === 0 ? 'FULD_DAEKNING' : 'UNDERSKUD';

      logger.log(
        `[reconcile-deltager] ES=${esCount} DB=${db} missing=${missing} ` +
          `coverage=${coveragePct}% verdict=${verdict}`
      );

      return NextResponse.json({
        ok: true,
        from,
        to,
        windowDays: days,
        esCount,
        dbCount: db,
        missing,
        coveragePct,
        verdict,
      });
    }
  );
}
