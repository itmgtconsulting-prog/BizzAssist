/**
 * Cron: Tinglysning delta-sync — /api/cron/pull-tinglysning-aendringer
 *
 * BIZZ-650: Dagligt 5-dages rullende vindue på Tinglysning
 * /tinglysningsobjekter/aendringer. For hver ændret BFE slås
 * EJFCustom_EjerskabBegraenset op og upsert'es til public.ejf_ejerskab.
 *
 * Sikrer at ejf_ejerskab holdes frisk uden daglig fuld backfill. 5-dages
 * overlap betyder cron-fejl i op til 4 dage i træk fanger automatisk op
 * på næste successful run.
 *
 * Flow:
 *   1. Kald /tinglysningsobjekter/aendringer med datoFra = now - 5 days.
 *   2. Paginér via fraSide++ indtil FlereResultater = false eller safety-cap nås.
 *   3. Collect unique BFE-numre fra AendretTinglysningsobjektSamling.
 *   4. For hver BFE: fetchEjerskabForBFE → upsert via upsertEjfBatch.
 *   5. Gem last_run_at + stats til public.tinglysning_aendring_cursor.
 *
 * Sikring:
 *   - CRON_SECRET bearer + x-vercel-cron header (prod)
 *   - Service role bypasser RLS
 *   - Idempotent upsert (composite PK)
 *
 * Schedule: 15 3 * * * UTC (dagligt 03:15 — før andre daglige jobs).
 * Manuel trigger: GET med Authorization: Bearer $CRON_SECRET + optional
 *   query params ?windowDays=N&maxPages=M til at override defaults.
 *
 * @module api/cron/pull-tinglysning-aendringer
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';
import { tlPost } from '@/app/lib/tlFetch';
import {
  getEjfToken,
  fetchEjerskabForBFE,
  mapNodeToRow,
  upsertEjfBatch,
  type EjfRow,
} from '@/app/lib/ejfIngest';

export const runtime = 'nodejs';
export const maxDuration = 300; // 5 min — potentielt mange BFE-opslag

/** Default 5-dages rolling window (override via ?windowDays=N) */
const DEFAULT_WINDOW_DAYS = 5;

/** Sikkerheds-cap på Tinglysning pagination — 50 sider × 100 = 5K aendringer */
const MAX_AENDRINGER_PAGES = 50;

/** Batch-size for EJF-row upsert til Supabase */
const UPSERT_BATCH_SIZE = 500;

/** Sikkerhedsmargin i ms før maxDuration (stop BFE-loop tidligt) */
const SAFETY_MARGIN_MS = 30_000;

// ─── Types — Tinglysning aendringer response ──────────────────────────────────

interface AendretTinglysningsobjekt {
  EjendomIdentifikator?: {
    BestemtFastEjendomNummer?: string;
  };
  AendringsDato?: string;
}

interface AendringerResponse {
  AendredeTinglysningsobjekterHentResultat?: {
    AendretTinglysningsobjektSamling?: AendretTinglysningsobjekt[];
    SoegningResultatInterval?: {
      FraNummer?: string | number;
      TilNummer?: string | number;
      FlereResultater?: boolean;
    };
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Verificerer CRON_SECRET + (i prod) Vercel cron-header.
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
 * Beregner datoFra/datoTil for et rolling window.
 *
 * @param now - reference tidspunkt (nu)
 * @param windowDays - størrelse på rolling window i dage
 * @returns { datoFra, datoTil } i YYYY-MM-DD format (Tinglysning's forventede input)
 */
export function computeWindow(now: Date, windowDays: number): { datoFra: string; datoTil: string } {
  const fromMs = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const iso = (t: number) => new Date(t).toISOString().split('T')[0];
  return { datoFra: iso(fromMs), datoTil: iso(now.getTime()) };
}

/**
 * Ekstraherer unikke BFE-numre fra en Tinglysning aendringer-respons.
 * Filtrerer null/invalid BFE'er fra.
 */
export function extractUniqueBfes(items: AendretTinglysningsobjekt[]): number[] {
  const set = new Set<number>();
  for (const it of items) {
    const raw = it.EjendomIdentifikator?.BestemtFastEjendomNummer;
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) continue;
    set.add(n);
  }
  return Array.from(set);
}

// ─── Core ingestion ───────────────────────────────────────────────────────────

/**
 * Paginerer Tinglysning aendringer og returnerer samlet liste af objekter.
 * Stopper ved FlereResultater=false eller MAX_AENDRINGER_PAGES.
 */
async function fetchAllAendringer(
  datoFra: string,
  datoTil: string,
  maxPages: number
): Promise<{ items: AendretTinglysningsobjekt[]; pagesFetched: number; error: string | null }> {
  const items: AendretTinglysningsobjekt[] = [];
  let fraSide = 1;
  let pagesFetched = 0;

  while (pagesFetched < maxPages) {
    const body = {
      AendredeTinglysningsobjekterHentType: { bog: 'EJENDOM', datoFra, datoTil, fraSide },
    };
    try {
      const res = await tlPost('/tinglysningsobjekter/aendringer', body);
      if (res.status !== 200) {
        return {
          items,
          pagesFetched,
          error: `Tinglysning aendringer HTTP ${res.status}`,
        };
      }
      const json = JSON.parse(res.body) as AendringerResponse;
      const result = json.AendredeTinglysningsobjekterHentResultat;
      const raw = result?.AendretTinglysningsobjektSamling ?? [];
      items.push(...raw);
      pagesFetched++;
      const flere = result?.SoegningResultatInterval?.FlereResultater === true;
      if (!flere) break;
      fraSide++;
    } catch (err) {
      return {
        items,
        pagesFetched,
        error: err instanceof Error ? err.message : 'Tinglysning fetch exception',
      };
    }
  }

  return { items, pagesFetched, error: null };
}

/**
 * For hver BFE: fetch EJFCustom_EjerskabBegraenset → map → batch-upsert.
 * Stop tidligt hvis nærmer os maxDuration.
 */
async function syncBfesToEjfEjerskab(
  bfes: number[],
  startTime: number
): Promise<{ bfesProcessed: number; rowsUpserted: number; rowsFailed: number }> {
  const token = await getEjfToken();
  if (!token) {
    logger.error('[tl-delta] OAuth token kunne ikke hentes');
    return { bfesProcessed: 0, rowsUpserted: 0, rowsFailed: 0 };
  }

  const admin = createAdminClient();
  const table = admin.from('ejf_ejerskab');

  let bfesProcessed = 0;
  let rowsUpserted = 0;
  let rowsFailed = 0;
  let batch: EjfRow[] = [];

  for (const bfe of bfes) {
    // Abort-check før hvert EJF-kald for at undgå Vercel timeout
    if (Date.now() - startTime > maxDuration * 1000 - SAFETY_MARGIN_MS) {
      logger.warn('[tl-delta] Safety margin ramt — flush og stop');
      break;
    }

    const nodes = await fetchEjerskabForBFE(bfe, token);
    if (nodes === null) {
      continue; // Error logged i helper
    }
    for (const node of nodes) {
      const row = mapNodeToRow(node);
      if (row) batch.push(row);
    }
    bfesProcessed++;

    // Flush når batch er fuld
    if (batch.length >= UPSERT_BATCH_SIZE) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await upsertEjfBatch(table as any, batch);
      rowsUpserted += res.upserted;
      rowsFailed += res.failed;
      batch = [];
    }
  }

  // Final flush
  if (batch.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await upsertEjfBatch(table as any, batch);
    rowsUpserted += res.upserted;
    rowsFailed += res.failed;
  }

  return { bfesProcessed, rowsUpserted, rowsFailed };
}

/**
 * Opdaterer tinglysning_aendring_cursor singleton med stats fra seneste run.
 * Best-effort — fejl her må ikke fejl-markere hele cron (fordi ejf_ejerskab
 * allerede er opdateret).
 */
async function updateCursor(stats: {
  fromDate: string;
  toDate: string;
  rowsProcessed: number;
  bfesProcessed: number;
  error: string | null;
}): Promise<void> {
  const admin = createAdminClient();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).from('tinglysning_aendring_cursor').upsert(
      {
        id: 'default',
        last_run_at: new Date().toISOString(),
        last_from_date: new Date(stats.fromDate).toISOString(),
        last_to_date: new Date(stats.toDate).toISOString(),
        rows_processed: stats.rowsProcessed,
        bfes_processed: stats.bfesProcessed,
        error: stats.error,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' }
    );
  } catch (err) {
    logger.error('[tl-delta] Cursor update fejl:', err instanceof Error ? err.message : err);
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return withCronMonitor(
    {
      jobName: 'pull-tinglysning-aendringer',
      schedule: '15 3 * * *',
      intervalMinutes: 24 * 60,
      maxRuntimeMinutes: 5,
    },
    async () => {
      const startTime = Date.now();

      // Optional query-params override (manuel trigger kan teste med smaller window)
      const windowDaysRaw = request.nextUrl.searchParams.get('windowDays');
      const maxPagesRaw = request.nextUrl.searchParams.get('maxPages');
      const windowDays = windowDaysRaw ? parseInt(windowDaysRaw, 10) : DEFAULT_WINDOW_DAYS;
      const maxPages = maxPagesRaw ? parseInt(maxPagesRaw, 10) : MAX_AENDRINGER_PAGES;

      const { datoFra, datoTil } = computeWindow(new Date(), windowDays);

      logger.log(
        `[tl-delta] Starter: window ${datoFra}…${datoTil} (${windowDays}d), maxPages=${maxPages}`
      );

      // 1. Fetch aendringer med pagination
      const aendringer = await fetchAllAendringer(datoFra, datoTil, maxPages);
      if (aendringer.error && aendringer.items.length === 0) {
        // Fuld fejl — log og abort (cursor opdateres med error)
        await updateCursor({
          fromDate: datoFra,
          toDate: datoTil,
          rowsProcessed: 0,
          bfesProcessed: 0,
          error: aendringer.error,
        });
        return NextResponse.json(
          {
            ok: false,
            error: aendringer.error,
            windowDays,
            datoFra,
            datoTil,
          },
          { status: 502 }
        );
      }

      // 2. Extract unique BFE-numre
      const bfes = extractUniqueBfes(aendringer.items);
      logger.log(
        `[tl-delta] ${aendringer.items.length} aendringer → ${bfes.length} unique BFE (${aendringer.pagesFetched} pages)`
      );

      // 3. Sync hver BFE til ejf_ejerskab
      const sync = await syncBfesToEjfEjerskab(bfes, startTime);

      // 4. Update cursor
      await updateCursor({
        fromDate: datoFra,
        toDate: datoTil,
        rowsProcessed: sync.rowsUpserted,
        bfesProcessed: sync.bfesProcessed,
        error: aendringer.error, // pagination-warn propagates even on partial success
      });

      const durationMs = Date.now() - startTime;
      logger.log(
        `[tl-delta] Done: ${sync.bfesProcessed}/${bfes.length} BFE, ${sync.rowsUpserted} rows upserted, ${sync.rowsFailed} failed, ${durationMs}ms`
      );

      return NextResponse.json({
        ok: true,
        windowDays,
        datoFra,
        datoTil,
        aendringerFound: aendringer.items.length,
        pagesFetched: aendringer.pagesFetched,
        bfesUnique: bfes.length,
        bfesProcessed: sync.bfesProcessed,
        rowsUpserted: sync.rowsUpserted,
        rowsFailed: sync.rowsFailed,
        partialError: aendringer.error,
        durationMs,
      });
    }
  );
}
