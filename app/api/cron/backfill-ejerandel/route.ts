/**
 * Cron: Backfill ejerandel_pct på cvr_deltagerrelation.
 *
 * Finder person-deltager-relationer af typen 'register' eller 'reel_ejer'
 * hvor ejerandel_pct er NULL, henter ejerandel fra CVR ES via
 * /api/cvr-public/person, og gemmer resultatet.
 *
 * Schedule: dagligt 04:30 UTC (efter pull-cvr-aendringer 03:30).
 * Cap: 200 unikke personer pr run (CVR ES har rate limits).
 *
 * @module api/cron/backfill-ejerandel
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';

/** Max antal unikke personer per cron-run */
const PER_RUN_CAP = 200;

/**
 * Verificerer CRON_SECRET bearer + x-vercel-cron (i produktion).
 *
 * @param request - NextRequest
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

/** Ejerandels-info for én virksomhed */
interface EjerandelInfo {
  pct: number;
  fra: string | null;
  til: string | null;
}

/**
 * Henter ejerandel + periode fra CVR ES for en person og alle dens virksomheder.
 *
 * @param enhedsNummer - Personens enhedsNummer
 * @param host - API host
 * @param cookie - Auth cookie
 * @returns Map fra virksomhed_cvr → EjerandelInfo
 */
async function fetchEjerandele(
  enhedsNummer: number,
  host: string,
  cookie: string
): Promise<Map<string, EjerandelInfo>> {
  const result = new Map<string, EjerandelInfo>();
  try {
    const res = await fetch(`${host}/api/cvr-public/person?enhedsNummer=${enhedsNummer}`, {
      headers: { cookie },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return result;
    const data = await res.json();

    interface Rolle {
      rolle?: string;
      ejerandel?: string | null;
      fra?: string | null;
      til?: string | null;
    }
    interface Virksomhed {
      cvr: number;
      roller: Rolle[];
    }

    for (const v of (data?.virksomheder ?? []) as Virksomhed[]) {
      for (const r of v.roller ?? []) {
        if (r.ejerandel != null) {
          // Parse interval-streng til midtpunkt (fx "25-33.33%" → 29.17)
          const match = r.ejerandel.match(/([\d.]+)(?:-([\d.]+))?%/);
          if (match) {
            const low = parseFloat(match[1]);
            const high = match[2] ? parseFloat(match[2]) : low;
            result.set(String(v.cvr), {
              pct: (low + high) / 2,
              fra: r.fra ?? null,
              til: r.til ?? null,
            });
          }
          break; // Første ejerandel-rolle er nok
        }
      }
      // Hvis ingen ejerandel fundet → sæt 0 (registreret men ingen direkte)
      if (!result.has(String(v.cvr))) {
        result.set(String(v.cvr), { pct: 0, fra: null, til: null });
      }
    }
  } catch (err) {
    logger.warn(
      `[backfill-ejerandel] Fejl ved hentning af person ${enhedsNummer}:`,
      err instanceof Error ? err.message : err
    );
  }
  return result;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();
  const proto = request.headers.get('x-forwarded-proto') ?? 'http';
  const host = `${proto}://${request.headers.get('host') ?? 'localhost:3000'}`;
  const cookie = request.headers.get('cookie') ?? '';

  // Find relationer der mangler ejerandel_pct
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: missingRows } = await (admin as any)
    .from('cvr_deltagerrelation')
    .select('deltager_enhedsnummer, virksomhed_cvr')
    .in('type', ['register', 'reel_ejer'])
    .is('gyldig_til', null)
    .is('ejerandel_pct', null)
    .limit(2000);

  if (!missingRows?.length) {
    return NextResponse.json({
      status: 'done',
      processed: 0,
      message: 'Ingen manglende ejerandele',
    });
  }

  // Unikke personer
  const uniquePersons = Array.from(
    new Set(
      (missingRows as Array<{ deltager_enhedsnummer: number }>).map((r) => r.deltager_enhedsnummer)
    )
  ).slice(0, PER_RUN_CAP);

  let updated = 0;
  let errors = 0;

  for (const en of uniquePersons) {
    try {
      const ejerandele = await fetchEjerandele(en, host, cookie);

      // Opdater alle relationer for denne person
      for (const [virkCvr, info] of ejerandele) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (admin as any)
          .from('cvr_deltagerrelation')
          .update({
            ejerandel_pct: info.pct,
            ejerandel_fra: info.fra,
            ejerandel_til: info.til,
          })
          .eq('deltager_enhedsnummer', en)
          .eq('virksomhed_cvr', virkCvr)
          .in('type', ['register', 'reel_ejer'])
          .is('gyldig_til', null);
        if (!error) updated++;
        else errors++;
      }

      // Rate limit: 100ms pause mellem CVR ES kald
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      errors++;
    }
  }

  logger.info(
    `[backfill-ejerandel] Processed ${uniquePersons.length} persons, updated ${updated} rows, ${errors} errors`
  );

  return NextResponse.json({
    status: 'ok',
    personsProcessed: uniquePersons.length,
    rowsUpdated: updated,
    errors,
    remaining: (missingRows?.length ?? 0) - uniquePersons.length,
  });
}
