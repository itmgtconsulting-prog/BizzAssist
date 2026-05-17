/**
 * Cron: CVR deltager gap-fill — /api/cron/gap-fill-cvr-deltager
 *
 * Finder enhedsnumre i cvr_deltagerrelation der MANGLER i cvr_deltager.
 * Slår dem op i CVR ES (deltager-index for personer, virksomhed-index via
 * nested deltagerRelation for virksomheder) og upsert'er med navn.
 *
 * Løser data-gap: register-backfill indsatte relationer uden at sikre
 * at deltager-cache havde en entry for hvert enhedsNummer.
 *
 * Schedule: 0 6 * * * UTC (dagligt 06:00 — efter gap-fill-cvr)
 *
 * @module api/cron/gap-fill-cvr-deltager
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** Antal manglende per SQL-batch */
const GAP_BATCH_SIZE = 500;

/** Max fills per kørsel (Vercel 300s timeout) */
const MAX_FILLS_PER_RUN = 2000;

/** CVR ES batch-size per terms-query */
const ES_BATCH_SIZE = 50;

/** Safety-margin før Vercel maxDuration */
const SAFETY_MARGIN_MS = 30_000;

/**
 * Verificerer CRON_SECRET + (i prod) Vercel cron-header.
 *
 * @param request - Incoming request
 * @returns true hvis autoriseret
 */
function verifyCronSecret(request: NextRequest): boolean {
  if (process.env.VERCEL_ENV === 'production' && request.headers.get('x-vercel-cron') !== '1') {
    return false;
  }
  const secret = process.env.CRON_SECRET;
  const bearer = request.headers.get('authorization')?.replace('Bearer ', '');
  if (!secret || !bearer) return false;
  return safeCompare(secret, bearer);
}

/**
 * Slå deltagere op i CVR ES deltager-index via enhedsNummer.
 *
 * @param enhedsnumre - EnhedsNumre at slå op
 * @param auth - Basic Auth header
 * @returns Map af enhedsNummer → navn
 */
async function lookupDeltagere(enhedsnumre: number[], auth: string): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (enhedsnumre.length === 0) return result;

  const res = await fetch('http://distribution.virk.dk/cvr-permanent/deltager/_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({
      size: enhedsnumre.length,
      query: { terms: { 'Vrdeltagerperson.enhedsNummer': enhedsnumre } },
      _source: ['Vrdeltagerperson.enhedsNummer', 'Vrdeltagerperson.navne'],
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) return result;

  const json = (await res.json()) as {
    hits?: {
      hits?: Array<{
        _source?: {
          Vrdeltagerperson?: {
            enhedsNummer?: number;
            navne?: Array<{ navn?: string; periode?: { gyldigTil?: string | null } }>;
          };
        };
      }>;
    };
  };

  for (const hit of json.hits?.hits ?? []) {
    const src = hit._source?.Vrdeltagerperson;
    if (!src?.enhedsNummer) continue;
    const aktivtNavn = src.navne?.find((n) => !n.periode?.gyldigTil)?.navn ?? src.navne?.[0]?.navn;
    if (aktivtNavn) result.set(src.enhedsNummer, aktivtNavn);
  }

  return result;
}

/**
 * Slå virksomheds-deltagere op via virksomhed-index (nested deltagerRelation).
 * Bruges for enhedsnumre der IKKE findes i deltager-indexet (virksomheder som ejere).
 *
 * @param enhedsnumre - EnhedsNumre at slå op
 * @param auth - Basic Auth header
 * @returns Map af enhedsNummer → navn
 */
async function lookupVirksomhedsDeltagere(
  enhedsnumre: number[],
  auth: string
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (enhedsnumre.length === 0) return result;

  // Virksomheds-lookup kræver nested query — kør max 10 ad gangen
  for (let i = 0; i < enhedsnumre.length && i < 50; i++) {
    try {
      const res = await fetch('http://distribution.virk.dk/cvr-permanent/virksomhed/_search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({
          size: 1,
          query: {
            nested: {
              path: 'Vrvirksomhed.deltagerRelation',
              query: {
                term: {
                  'Vrvirksomhed.deltagerRelation.deltager.enhedsNummer': enhedsnumre[i],
                },
              },
            },
          },
          _source: [
            'Vrvirksomhed.deltagerRelation.deltager.enhedsNummer',
            'Vrvirksomhed.deltagerRelation.deltager.navne',
          ],
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) continue;

      const json = (await res.json()) as {
        hits?: {
          hits?: Array<{
            _source?: {
              Vrvirksomhed?: {
                deltagerRelation?: Array<{
                  deltager?: {
                    enhedsNummer?: number;
                    navne?: Array<{ navn?: string }>;
                  };
                }>;
              };
            };
          }>;
        };
      };

      for (const hit of json.hits?.hits ?? []) {
        for (const rel of hit._source?.Vrvirksomhed?.deltagerRelation ?? []) {
          if (rel.deltager?.enhedsNummer === enhedsnumre[i]) {
            const navn = rel.deltager?.navne?.[0]?.navn;
            if (navn) result.set(enhedsnumre[i], navn);
          }
        }
      }
    } catch {
      /* non-fatal */
    }
  }

  return result;
}

/**
 * GET handler — gap-fill manglende cvr_deltager entries.
 *
 * @param request - Cron request
 * @returns Status JSON
 */
export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return withCronMonitor(
    {
      jobName: 'gap-fill-cvr-deltager',
      schedule: '0 6 * * *',
      intervalMinutes: 24 * 60,
      maxRuntimeMinutes: 5,
    },
    async () => {
      const cvrUser = process.env.CVR_ES_USER;
      const cvrPass = process.env.CVR_ES_PASS;
      if (!cvrUser || !cvrPass) {
        return NextResponse.json({ error: 'CVR_ES_USER/PASS ikke konfigureret' }, { status: 500 });
      }
      const auth = `Basic ${Buffer.from(`${cvrUser}:${cvrPass}`).toString('base64')}`;

      const admin = createAdminClient();
      const startMs = Date.now();
      let totalFilled = 0;
      let totalMissing = 0;
      let totalNotFound = 0;

      while (totalFilled < MAX_FILLS_PER_RUN) {
        if (Date.now() - startMs > maxDuration * 1000 - SAFETY_MARGIN_MS) {
          logger.log(`[gap-fill-deltager] Tidsbegrænsning (${totalFilled} fyldt)`);
          break;
        }

        // Find manglende enhedsnumre
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: missingRows } = await (admin as any)
          .rpc('gap_fill_missing_deltagere', {
            p_limit: GAP_BATCH_SIZE,
          })
          .maybeSingle();

        // Fallback: direkte SQL hvis RPC ikke eksisterer
        let missingEns: number[] = [];
        if (missingRows) {
          missingEns = (missingRows as number[]) ?? [];
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: sqlRows } = await (admin as any)
            .from('cvr_deltagerrelation')
            .select('deltager_enhedsnummer')
            .is('gyldig_til', null)
            .not('deltager_enhedsnummer', 'in', `(SELECT enhedsnummer FROM cvr_deltager)`)
            .limit(GAP_BATCH_SIZE);

          // Supabase .not('col', 'in', subquery) virker ikke — brug raw SQL
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: rawMissing } = await (admin as any).rpc('exec_sql', {
            sql: `SELECT DISTINCT dr.deltager_enhedsnummer AS en FROM public.cvr_deltagerrelation dr LEFT JOIN public.cvr_deltager d ON d.enhedsnummer = dr.deltager_enhedsnummer WHERE dr.gyldig_til IS NULL AND d.enhedsnummer IS NULL LIMIT ${GAP_BATCH_SIZE}`,
          });

          if (rawMissing && Array.isArray(rawMissing)) {
            missingEns = rawMissing.map((r: { en: number }) => r.en);
          } else if (sqlRows && Array.isArray(sqlRows)) {
            // Dedup
            missingEns = [
              ...new Set(
                (sqlRows as Array<{ deltager_enhedsnummer: number }>).map(
                  (r) => r.deltager_enhedsnummer
                )
              ),
            ];
          }
        }

        if (missingEns.length === 0) break;
        totalMissing += missingEns.length;

        // Batch-lookup i CVR ES
        const nameMap = new Map<number, string>();
        for (let i = 0; i < missingEns.length; i += ES_BATCH_SIZE) {
          const batch = missingEns.slice(i, i + ES_BATCH_SIZE);
          const personNames = await lookupDeltagere(batch, auth);
          for (const [en, navn] of personNames) nameMap.set(en, navn);

          // Virksomheds-fallback for dem der ikke fandtes som person
          const notFound = batch.filter((en) => !nameMap.has(en));
          if (notFound.length > 0) {
            const virkNames = await lookupVirksomhedsDeltagere(notFound.slice(0, 10), auth);
            for (const [en, navn] of virkNames) nameMap.set(en, navn);
          }
        }

        // Upsert fundne deltagere
        if (nameMap.size > 0) {
          const rows = [...nameMap.entries()].map(([en, navn]) => ({
            enhedsnummer: en,
            navn,
          }));

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { error: upsertErr } = await (admin as any)
            .from('cvr_deltager')
            .upsert(rows, { onConflict: 'enhedsnummer' });

          if (upsertErr) {
            logger.error('[gap-fill-deltager] Upsert fejl:', upsertErr);
          } else {
            totalFilled += rows.length;
          }
        }

        totalNotFound += missingEns.length - nameMap.size;
      }

      logger.log(
        `[gap-fill-deltager] Done: ${totalFilled} fyldt, ${totalNotFound} ikke fundet, ${totalMissing} total missing`
      );

      return NextResponse.json({
        filled: totalFilled,
        notFound: totalNotFound,
        totalMissing,
      });
    }
  );
}
