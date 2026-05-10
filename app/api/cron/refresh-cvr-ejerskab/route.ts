/**
 * Cron: CVR ejerskab + deltagerrelation sync — /api/cron/refresh-cvr-ejerskab
 *
 * BIZZ-1188 + BIZZ-1189: For ændrede virksomheder (sidstOpdateret >= now-5d)
 * henter deltagerRelation fra CVR ES og opdaterer:
 *   - cvr_virksomhed_ejerskab (virksomhed→virksomhed ejerskab)
 *   - cvr_deltagerrelation (virksomhed→person relationer)
 *
 * Bruger pull-cvr-aendringer pattern med search_after og rolling window.
 *
 * Schedule: 0 4 * * * UTC (dagligt 04:00 — 15 min efter deltager-delta).
 *
 * @module api/cron/refresh-cvr-ejerskab
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';

export const runtime = 'nodejs';
export const maxDuration = 300;

const DEFAULT_WINDOW_DAYS = 5;
const ES_PAGE_SIZE = 200;
const MAX_ES_PAGES = 150;
const UPSERT_BATCH_SIZE = 200;
const SAFETY_MARGIN_MS = 30_000;
const CVR_ES_BASE = 'http://distribution.virk.dk/cvr-permanent';

/** Ejerandel interval-koder fra CVR ES → procent */
const INTERVAL_MAP: Record<string, { min: number; max: number }> = {
  PROCENT_0_0: { min: 0, max: 0 },
  PROCENT_0_4_99: { min: 0, max: 4.99 },
  PROCENT_5_9_99: { min: 5, max: 9.99 },
  PROCENT_10_14_99: { min: 10, max: 14.99 },
  PROCENT_15_19_99: { min: 15, max: 19.99 },
  PROCENT_20_24_99: { min: 20, max: 24.99 },
  PROCENT_25_33_32: { min: 25, max: 33.32 },
  PROCENT_33_34_49_99: { min: 33.34, max: 49.99 },
  PROCENT_50_66_65: { min: 50, max: 66.65 },
  PROCENT_66_67_89_99: { min: 66.67, max: 89.99 },
  PROCENT_90_100: { min: 90, max: 100 },
  PROCENT_100_100: { min: 100, max: 100 },
};

// ─── Auth ────────────────────────────────────────────────────────────────────

/** Verificerer CRON_SECRET */
function verifyCronSecret(request: NextRequest): boolean {
  if (process.env.VERCEL_ENV === 'production' && request.headers.get('x-vercel-cron') !== '1') {
    return false;
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = request.headers.get('authorization') ?? '';
  return safeCompare(auth, `Bearer ${secret}`);
}

/** Returnerer Basic auth header til CVR ES */
function getCvrEsAuthHeader(): string | null {
  const user = process.env.CVR_ES_USER;
  const pass = process.env.CVR_ES_PASS;
  if (!user || !pass) return null;
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

// ─── Mapping ─────────────────────────────────────────────────────────────────

interface EjerskabRow {
  ejer_cvr: string;
  ejet_cvr: string;
  ejerandel_min: number | null;
  ejerandel_max: number | null;
  gyldig_fra: string | null;
  sidst_hentet_fra_cvr: string;
}

interface DeltagerRelRow {
  virksomhed_cvr: string;
  deltager_enhedsnummer: number;
  type: string;
  ejerandel_pct: number | null;
  gyldig_fra: string;
  gyldig_til: string | null;
  sidst_opdateret: string | null;
  sidst_hentet_fra_cvr: string;
}

/**
 * Ekstraher ejerskab og deltagerrelationer fra deltagerRelation.
 *
 * @param cvrNummer - CVR for virksomheden
 * @param deltagerRelation - deltagerRelation array fra CVR ES
 * @param enhedsNummerToCvr - Mapping cache
 * @returns Ejerskab + deltagerrelation rows
 */
function extractRelations(
  cvrNummer: string,
  deltagerRelation: Record<string, unknown>[],
  enhedsNummerToCvr: Map<number, string>
): { ejerskab: EjerskabRow[]; relationer: DeltagerRelRow[] } {
  const ejerskab: EjerskabRow[] = [];
  const relationer: DeltagerRelRow[] = [];
  const now = new Date().toISOString();

  for (const rel of deltagerRelation) {
    const deltager = rel.deltager as Record<string, unknown> | undefined;
    if (!deltager) continue;

    const enhedsNummer = deltager.enhedsNummer as number | undefined;
    const enhedstype = deltager.enhedstype as string | undefined;
    if (!enhedsNummer) continue;

    const organisationer = (rel.organisationer as Record<string, unknown>[]) ?? [];

    // BIZZ-1188: Virksomheds-ejerskab
    if (enhedstype === 'VIRKSOMHED') {
      const deltagerCvr = enhedsNummerToCvr.get(enhedsNummer);
      if (deltagerCvr && deltagerCvr !== cvrNummer) {
        for (const org of organisationer) {
          if ((org.hovedtype as string) !== 'REGISTER') continue;

          const allAttrSources = [
            ...((org.attributter as Record<string, unknown>[]) ?? []),
            ...((org.medlemsData as Record<string, unknown>[]) ?? []).flatMap(
              (md) => (md.attributter as Record<string, unknown>[]) ?? []
            ),
          ];

          let ejerandelMin: number | null = null;
          let ejerandelMax: number | null = null;
          let gyldigFra: string | null = null;

          for (const attr of allAttrSources) {
            if ((attr.type as string) !== 'EJERANDEL_PROCENT') continue;
            const vaerdier = (attr.vaerdier as Record<string, unknown>[]) ?? [];
            const aktiv = vaerdier.find(
              (v) => !(v.periode as Record<string, unknown> | undefined)?.gyldigTil
            );
            if (!aktiv) continue;
            const kode = aktiv.vaerdi as string;
            const interval = INTERVAL_MAP[kode];
            if (interval) {
              ejerandelMin = interval.min;
              ejerandelMax = interval.max;
            }
            gyldigFra =
              ((aktiv.periode as Record<string, unknown> | undefined)?.gyldigFra as string)?.slice(
                0,
                10
              ) ?? null;
          }

          ejerskab.push({
            ejer_cvr: deltagerCvr,
            ejet_cvr: cvrNummer,
            ejerandel_min: ejerandelMin,
            ejerandel_max: ejerandelMax,
            gyldig_fra: gyldigFra,
            sidst_hentet_fra_cvr: now,
          });
        }
      }
    }

    // BIZZ-1189: Person-relationer
    if (enhedstype === 'PERSON' || !enhedstype) {
      for (const org of organisationer) {
        const medlemsData = (org.medlemsData as Record<string, unknown>[]) ?? [];
        for (const md of medlemsData) {
          const attrs = (md.attributter as Record<string, unknown>[]) ?? [];
          for (const attr of attrs) {
            if ((attr.type as string) !== 'FUNKTION') continue;
            const vaerdier = (attr.vaerdier as Record<string, unknown>[]) ?? [];
            for (const v of vaerdier) {
              const rolleRaw = v.vaerdi as string;
              if (!rolleRaw) continue;
              const rolle = rolleRaw.toLowerCase().slice(0, 50);
              const periodeObj = v.periode as Record<string, unknown> | undefined;
              relationer.push({
                virksomhed_cvr: cvrNummer,
                deltager_enhedsnummer: enhedsNummer,
                type: rolle,
                ejerandel_pct: null,
                gyldig_fra: ((periodeObj?.gyldigFra as string) ?? '').slice(0, 10) || '1900-01-01',
                gyldig_til: ((periodeObj?.gyldigTil as string) ?? '').slice(0, 10) || null,
                sidst_opdateret: null,
                sidst_hentet_fra_cvr: now,
              });
            }
          }
        }
      }
    }
  }

  return { ejerskab, relationer };
}

// ─── Route handler ────────────────────────────────────────────────────────────

/**
 * GET handler — synkroniserer ejerskab + deltagerrelationer for ændrede virksomheder.
 *
 * @param request - GET request med CRON_SECRET auth
 * @returns JSON med sync-stats
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return withCronMonitor(
    {
      jobName: 'refresh-cvr-ejerskab',
      schedule: '0 4 * * *',
      intervalMinutes: 24 * 60,
      maxRuntimeMinutes: 5,
    },
    async () => {
      const startTime = Date.now();
      const auth = getCvrEsAuthHeader();
      if (!auth) {
        return NextResponse.json(
          { ok: false, error: 'CVR_ES_USER/PASS ikke konfigureret' },
          { status: 503 }
        );
      }

      const windowDays = parseInt(
        request.nextUrl.searchParams.get('windowDays') ?? String(DEFAULT_WINDOW_DAYS),
        10
      );
      const maxPages = parseInt(
        request.nextUrl.searchParams.get('maxPages') ?? String(MAX_ES_PAGES),
        10
      );
      const fromDate = new Date(Date.now() - windowDays * 86400_000).toISOString();

      logger.log(`[cvr-ejerskab] Starter: window ${fromDate} (${windowDays}d)`);

      // 1. Byg enhedsNummer→CVR mapping fra cvr_virksomhed
      const admin = createAdminClient();
      const enhedsNummerToCvr = new Map<number, string>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: mappingData } = await (admin as any)
        .from('cvr_virksomhed')
        .select('cvr_nummer,enheds_nummer')
        .not('enheds_nummer', 'is', null)
        .limit(1000);
      if (mappingData) {
        for (const row of mappingData as { cvr_nummer: string; enheds_nummer: number }[]) {
          enhedsNummerToCvr.set(row.enheds_nummer, row.cvr_nummer);
        }
      }

      // 2. Fetch ændrede virksomheder med deltagerRelation
      let searchAfter: unknown[] | null = null;
      let pagesFetched = 0;
      let esError: string | null = null;
      const allEjerskab: EjerskabRow[] = [];
      const allRelationer: DeltagerRelRow[] = [];

      while (pagesFetched < maxPages) {
        if (Date.now() - startTime > maxDuration * 1000 - SAFETY_MARGIN_MS) break;

        const body: Record<string, unknown> = {
          _source: ['Vrvirksomhed.cvrNummer', 'Vrvirksomhed.deltagerRelation'],
          size: ES_PAGE_SIZE,
          sort: [{ 'Vrvirksomhed.sidstOpdateret': 'asc' }, { 'Vrvirksomhed.cvrNummer': 'asc' }],
          query: {
            range: { 'Vrvirksomhed.sidstOpdateret': { gte: fromDate } },
          },
        };
        if (searchAfter) body.search_after = searchAfter;

        try {
          const res = await fetch(`${CVR_ES_BASE}/virksomhed/_search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: auth },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) {
            esError = `CVR ES HTTP ${res.status}`;
            break;
          }
          const json = (await res.json()) as {
            hits?: { hits?: Array<{ _source?: Record<string, unknown>; sort?: unknown[] }> };
          };
          const hits = json.hits?.hits ?? [];
          if (hits.length === 0) break;

          for (const hit of hits) {
            const vr = hit._source?.Vrvirksomhed as Record<string, unknown> | undefined;
            if (!vr) continue;
            const cvr = vr.cvrNummer as number | undefined;
            if (!cvr) continue;
            const deltaRelation = (vr.deltagerRelation as Record<string, unknown>[]) ?? [];
            if (deltaRelation.length === 0) continue;

            // Berig mapping med deltagere fra dette resultat
            for (const rel of deltaRelation) {
              const d = rel.deltager as Record<string, unknown> | undefined;
              if (d?.enhedstype === 'VIRKSOMHED' && d.enhedsNummer && d.cvrNummer) {
                enhedsNummerToCvr.set(d.enhedsNummer as number, String(d.cvrNummer));
              }
            }

            const { ejerskab, relationer } = extractRelations(
              String(cvr),
              deltaRelation,
              enhedsNummerToCvr
            );
            allEjerskab.push(...ejerskab);
            allRelationer.push(...relationer);
          }

          pagesFetched++;
          const last = hits[hits.length - 1];
          if (!last.sort || hits.length < ES_PAGE_SIZE) break;
          searchAfter = last.sort;
        } catch (err) {
          esError = err instanceof Error ? err.message : 'CVR ES fetch exception';
          break;
        }
      }

      if (esError && allEjerskab.length === 0 && allRelationer.length === 0) {
        return NextResponse.json({ ok: false, error: esError }, { status: 502 });
      }

      logger.log(
        `[cvr-ejerskab] Hentet ${allEjerskab.length} ejerskab, ${allRelationer.length} relationer over ${pagesFetched} sider`
      );

      // 3. Batch upsert
      let ejerskabUpserted = 0;
      let relationerUpserted = 0;

      for (let i = 0; i < allEjerskab.length; i += UPSERT_BATCH_SIZE) {
        if (Date.now() - startTime > maxDuration * 1000 - SAFETY_MARGIN_MS) break;
        const batch = allEjerskab.slice(i, i + UPSERT_BATCH_SIZE);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (admin as any)
          .from('cvr_virksomhed_ejerskab')
          .upsert(batch, { onConflict: 'ejer_cvr,ejet_cvr', ignoreDuplicates: false });
        if (error) {
          logger.error('[cvr-ejerskab] ejerskab upsert fejl:', error.message);
        } else {
          ejerskabUpserted += batch.length;
        }
      }

      for (let i = 0; i < allRelationer.length; i += UPSERT_BATCH_SIZE) {
        if (Date.now() - startTime > maxDuration * 1000 - SAFETY_MARGIN_MS) break;
        const batch = allRelationer.slice(i, i + UPSERT_BATCH_SIZE);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (admin as any).from('cvr_deltagerrelation').upsert(batch, {
          onConflict: 'virksomhed_cvr,deltager_enhedsnummer,type,gyldig_fra',
          ignoreDuplicates: false,
        });
        if (error) {
          logger.error('[cvr-ejerskab] deltagerrelation upsert fejl:', error.message);
        } else {
          relationerUpserted += batch.length;
        }
      }

      const durationMs = Date.now() - startTime;
      logger.log(
        `[cvr-ejerskab] Done: ${ejerskabUpserted} ejerskab, ${relationerUpserted} relationer, ${durationMs}ms`
      );

      return NextResponse.json({
        ok: true,
        windowDays,
        fromDate,
        pagesFetched,
        ejerskabFound: allEjerskab.length,
        relationerFound: allRelationer.length,
        ejerskabUpserted,
        relationerUpserted,
        partialError: esError,
        durationMs,
      });
    }
  );
}
