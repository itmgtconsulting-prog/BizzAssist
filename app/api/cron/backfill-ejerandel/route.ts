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

export const maxDuration = 300;
import { logger } from '@/app/lib/logger';

/** Max antal unikke personer per cron-run (holdes under Vercel 300s timeout) */
const PER_RUN_CAP = 80;

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

const CVR_ES_BASE = 'http://distribution.virk.dk/cvr-permanent';
const CVR_ES_USER = process.env.CVR_ES_USER ?? '';
const CVR_ES_PASS = process.env.CVR_ES_PASS ?? '';

/** Ejerandels-info for én virksomhed */
interface EjerandelInfo {
  pct: number;
  fra: string | null;
  til: string | null;
}

/**
 * Henter ejerandel + periode direkte fra CVR ES for en person.
 * Slår op via Elasticsearch-query — kræver IKKE session/auth.
 *
 * @param enhedsNummer - Personens enhedsNummer
 * @returns Map fra virksomhed_cvr → EjerandelInfo
 */
async function fetchEjerandele(enhedsNummer: number): Promise<Map<string, EjerandelInfo>> {
  const result = new Map<string, EjerandelInfo>();
  if (!CVR_ES_USER || !CVR_ES_PASS) return result;

  try {
    const auth = Buffer.from(`${CVR_ES_USER}:${CVR_ES_PASS}`).toString('base64');
    const esQuery = {
      query: {
        bool: {
          must: [{ term: { 'Vrvirksomhed.deltagerRelation.deltager.enhedsNummer': enhedsNummer } }],
        },
      },
      _source: ['Vrvirksomhed.cvrNummer', 'Vrvirksomhed.deltagerRelation'],
      size: 100,
    };

    const res = await fetch(`${CVR_ES_BASE}/virksomhed/_search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
      body: JSON.stringify(esQuery),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return result;

    const esData = await res.json();
    interface EsHit {
      _source?: {
        Vrvirksomhed?: {
          cvrNummer?: number;
          deltagerRelation?: Array<{
            deltager?: { enhedsNummer?: number };
            organisationer?: Array<{
              medlemsData?: Array<{
                attributter?: Array<{
                  type?: string;
                  vaerdier?: Array<{
                    vaerdi?: string | number;
                    periode?: { gyldigFra?: string | null; gyldigTil?: string | null };
                  }>;
                }>;
              }>;
            }>;
          }>;
        };
      };
    }

    for (const hit of (esData?.hits?.hits ?? []) as EsHit[]) {
      const virk = hit._source?.Vrvirksomhed;
      if (!virk?.cvrNummer) continue;
      const cvrStr = String(virk.cvrNummer);

      // Find denne persons deltagerRelation
      const rel = (virk.deltagerRelation ?? []).find(
        (dr) => dr.deltager?.enhedsNummer === enhedsNummer
      );
      if (!rel) {
        result.set(cvrStr, { pct: 0, fra: null, til: null });
        continue;
      }

      // Søg EJERANDEL_PROCENT i medlemsData
      let found = false;
      for (const org of rel.organisationer ?? []) {
        for (const medl of org.medlemsData ?? []) {
          for (const attr of medl.attributter ?? []) {
            if (attr.type !== 'EJERANDEL_PROCENT') continue;
            // Find aktuel (gyldigTil === null) værdi
            const current = (attr.vaerdier ?? []).find((v) => v.periode?.gyldigTil == null);
            if (!current) continue;
            const val =
              typeof current.vaerdi === 'number'
                ? current.vaerdi
                : parseFloat(String(current.vaerdi ?? ''));
            if (isNaN(val)) continue;
            result.set(cvrStr, {
              pct: Math.round(val * 10000) / 100, // 0.25 → 25.00
              fra: current.periode?.gyldigFra ?? null,
              til: null, // aktuel
            });
            found = true;
            break;
          }
          if (found) break;
        }
        if (found) break;
      }
      if (!found) result.set(cvrStr, { pct: 0, fra: null, til: null });
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

  // Samle alle updates for batch-SQL
  const allUpdates: Array<{
    en: number;
    cvr: string;
    pct: number;
    fra: string | null;
    til: string | null;
  }> = [];

  for (const en of uniquePersons) {
    try {
      const ejerandele = await fetchEjerandele(en);
      for (const [virkCvr, info] of ejerandele) {
        allUpdates.push({ en, cvr: virkCvr, pct: info.pct, fra: info.fra, til: info.til });
      }
    } catch {
      errors++;
    }
  }

  // Batch-update via SQL for performance (1 query i stedet for N)
  if (allUpdates.length > 0) {
    const BATCH_SIZE = 500;
    for (let i = 0; i < allUpdates.length; i += BATCH_SIZE) {
      const batch = allUpdates.slice(i, i + BATCH_SIZE);
      const values = batch
        .map((u) => {
          const fra = u.fra ? `'${u.fra}'` : 'NULL';
          const til = u.til ? `'${u.til}'` : 'NULL';
          return `(${u.en}, '${u.cvr}', ${u.pct}, ${fra}::date, ${til}::date)`;
        })
        .join(',\n');
      const sql = `
        UPDATE cvr_deltagerrelation AS t
        SET ejerandel_pct = v.pct, ejerandel_fra = v.fra, ejerandel_til = v.til
        FROM (VALUES ${values}) AS v(en, cvr, pct, fra, til)
        WHERE t.deltager_enhedsnummer = v.en::bigint
          AND t.virksomhed_cvr = v.cvr
          AND t.type IN ('register', 'reel_ejer')
          AND t.gyldig_til IS NULL
      `;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (admin as any).rpc('exec_sql', { query: sql });
      if (error) {
        // Fallback: enkelt-updates
        for (const u of batch) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { error: e2 } = await (admin as any)
            .from('cvr_deltagerrelation')
            .update({ ejerandel_pct: u.pct, ejerandel_fra: u.fra, ejerandel_til: u.til })
            .eq('deltager_enhedsnummer', u.en)
            .eq('virksomhed_cvr', u.cvr)
            .in('type', ['register', 'reel_ejer'])
            .is('gyldig_til', null);
          if (!e2) updated++;
          else errors++;
        }
      } else {
        updated += batch.length;
      }
    }
  }

  logger.log(
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
