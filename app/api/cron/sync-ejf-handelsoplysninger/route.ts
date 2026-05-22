/**
 * Cron: Delta-sync EJF Handelsoplysninger — /api/cron/sync-ejf-handelsoplysninger
 *
 * Daglig inkrementel synkronisering af handelsoplysninger fra Datafordeler EJF
 * via GraphQL cursor-pagination. Upsert'er til public.ejf_handelsoplysninger.
 *
 * Strategi:
 *   Paginerer gennem EJF_Handelsoplysninger via OAuth token.
 *   Tracker cursor i ejf_ingest_runs (id = 'handelsoplysninger-sync') for resume.
 *   Processer op til MAX_PAGES * BATCH_SIZE rækker per kørsel (5 min budget).
 *
 * Sikring:
 *   - CRON_SECRET bearer + x-vercel-cron header i prod
 *   - Service role bypasser RLS for skrivning
 *   - Idempotent: UPSERT på id_lokal_id
 *
 * Trigger:
 *   - Vercel Cron: dagligt kl. 05:15 UTC
 *   - Manuel: GET med Authorization: Bearer <CRON_SECRET>
 *
 * @module api/cron/sync-ejf-handelsoplysninger
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { getSharedOAuthToken } from '@/app/lib/dfTokenCache';
import { getCertOAuthToken, isCertAuthConfigured } from '@/app/lib/dfCertAuth';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';
import { EJF_GQL_ENDPOINT } from '@/app/lib/serviceEndpoints';
import { withCronMonitor } from '@/app/lib/cronMonitor';

export const runtime = 'nodejs';
export const maxDuration = 300; // 5 min

/** Antal rækker per batch-upsert til Supabase */
const BATCH_SIZE = 500;

/** Max antal GraphQL-sider per kørsel */
const MAX_PAGES = 200;

/** Sikkerheds-margin i ms — stop pagination 30s før maxDuration */
const SAFETY_MARGIN_MS = 30_000;

/** Unik identifikator for denne cron i ejf_ingest_runs */
const RUN_ID_PREFIX = 'handelsoplysninger-sync';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Rå EJF_Handelsoplysninger node fra GraphQL */
interface RawHandelsoplysningerNode {
  id_lokalId: string | null;
  kontantKoebesum: number | null;
  samletKoebesum: number | null;
  loesoeresum: number | null;
  entreprisesum: number | null;
  koebsaftaleDato: string | null;
  valutakode: string | null;
  virkningFra: string | null;
  virkningTil: string | null;
  status: string | null;
  registreringFra: string | null;
  registreringTil: string | null;
}

/** GraphQL response shape */
interface GqlResponse {
  data?: {
    EJF_Handelsoplysninger?: {
      nodes: RawHandelsoplysningerNode[];
      pageInfo?: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
    };
  };
  errors?: { message: string; extensions?: { code?: string } }[];
}

/** Row shape for ejf_handelsoplysninger upsert */
interface HandelsoplysningerRow {
  id_lokal_id: string;
  kontant_koebesum: number | null;
  samlet_koebesum: number | null;
  loesoeresum: number | null;
  entreprisesum: number | null;
  koebsaftale_dato: string | null;
  valutakode: string | null;
  virkning_fra: string | null;
  virkning_til: string | null;
  status: string | null;
  registrering_fra: string | null;
  registrering_til: string | null;
  sidst_opdateret: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Verificerer at kaldet er autoriseret via CRON_SECRET + (i prod) Vercel cron header.
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
 * Henter OAuth token via shared secret (primær) eller cert (fallback).
 */
async function getToken(): Promise<string | null> {
  const token = await getSharedOAuthToken().catch(() => null);
  if (token) return token;
  if (isCertAuthConfigured()) {
    return getCertOAuthToken().catch(() => null);
  }
  return null;
}

/**
 * Bygger GraphQL query for en side af EJF_Handelsoplysninger.
 *
 * @param cursor - pagination cursor (null for første side)
 * @returns GraphQL query string
 */
function buildPageQuery(cursor: string | null): string {
  const vt = new Date().toISOString();
  const afterClause = cursor ? `, after: "${cursor}"` : '';
  return `{
    EJF_Handelsoplysninger(
      first: ${BATCH_SIZE}
      virkningstid: "${vt}"
      ${afterClause}
    ) {
      nodes {
        id_lokalId
        kontantKoebesum
        samletKoebesum
        loesoeresum
        entreprisesum
        koebsaftaleDato
        valutakode
        virkningFra
        virkningTil
        status
        registreringFra
        registreringTil
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }`;
}

/**
 * Mapper en rå GraphQL-node til en ejf_handelsoplysninger row.
 * Returnerer null hvis noden mangler id_lokalId.
 *
 * @param node - rå GraphQL node
 * @returns mappet row eller null
 */
function mapNodeToRow(node: RawHandelsoplysningerNode): HandelsoplysningerRow | null {
  if (!node.id_lokalId) return null;
  return {
    id_lokal_id: node.id_lokalId,
    kontant_koebesum: node.kontantKoebesum ?? null,
    samlet_koebesum: node.samletKoebesum ?? null,
    loesoeresum: node.loesoeresum ?? null,
    entreprisesum: node.entreprisesum ?? null,
    koebsaftale_dato: node.koebsaftaleDato ?? null,
    valutakode: node.valutakode ?? null,
    virkning_fra: node.virkningFra ?? null,
    virkning_til: node.virkningTil ?? null,
    status: node.status ?? null,
    registrering_fra: node.registreringFra ?? null,
    registrering_til: node.registreringTil ?? null,
    sidst_opdateret: new Date().toISOString(),
  };
}

/**
 * Batch-upsert rækker til ejf_handelsoplysninger. Dedupliker på id_lokal_id.
 * Returnerer antal upserted og failed.
 *
 * @param table - Supabase table reference
 * @param batch - rækker at upserte
 * @returns upsert resultat
 */
async function flushBatch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  batch: HandelsoplysningerRow[]
): Promise<{ upserted: number; failed: number }> {
  if (batch.length === 0) return { upserted: 0, failed: 0 };

  // Dedupliker på PK
  const seen = new Map<string, HandelsoplysningerRow>();
  for (const row of batch) {
    seen.set(row.id_lokal_id, row);
  }
  const deduped = Array.from(seen.values());

  const { error } = await table.upsert(deduped, {
    onConflict: 'id_lokal_id',
    ignoreDuplicates: false,
  });
  if (error) {
    logger.error('[sync-ejf-handelsoplysninger] Batch upsert fejl:', error.message);
    return { upserted: 0, failed: batch.length };
  }
  return { upserted: batch.length, failed: 0 };
}

/**
 * Henter gemt cursor fra ejf_ingest_runs for denne cron-type.
 *
 * @param ingestRuns - Supabase table reference for ejf_ingest_runs
 * @returns gemt cursor eller null
 */
async function getSavedCursor(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ingestRuns: any
): Promise<string | null> {
  const { data: lastRun } = await ingestRuns
    .select('error')
    .not('error', 'is', null)
    .ilike('error', `%${RUN_ID_PREFIX} cursor:%`)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastRun?.error) {
    const match = (lastRun.error as string).match(/cursor:\s*(\S+)/);
    if (match) return match[1];
  }
  return null;
}

// ─── Route handler ──────────────────────────────────────────────────────────

/**
 * GET /api/cron/sync-ejf-handelsoplysninger
 *
 * Delta-sync af EJF_Handelsoplysninger data via GraphQL cursor-pagination.
 *
 * Query params:
 *   - cursor: Resume fra denne cursor (optional)
 *   - reset: "true" for at starte forfra (ignorerer gemt cursor)
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return withCronMonitor(
    { jobName: 'sync-ejf-handelsoplysninger', schedule: '15 5 * * *', intervalMinutes: 1440 },
    async () => {
      const startTime = Date.now();
      const admin = createAdminClient();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ingestRuns = (admin as any).from('ejf_ingest_runs');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ejfTbl = (admin as any).from('ejf_handelsoplysninger');

      // Hent cursor — fra query param, gemt i DB, eller null
      const resetParam = request.nextUrl.searchParams.get('reset');
      const cursorParam = request.nextUrl.searchParams.get('cursor');
      let cursor: string | null = cursorParam ?? null;

      if (!cursor && resetParam !== 'true') {
        cursor = await getSavedCursor(ingestRuns);
      }

      // Opret run-row for tracking
      const { data: runRow, error: runErr } = await ingestRuns
        .insert({ started_at: new Date().toISOString() })
        .select('id')
        .single();

      if (runErr) {
        logger.error('[sync-ejf-handelsoplysninger] Kan ikke oprette run-row:', runErr.message);
        return NextResponse.json({ ok: false, error: 'Run-tracking fejlede' }, { status: 500 });
      }
      const runId = runRow!.id as number;

      // Hent OAuth token
      const token = await getToken();
      if (!token) {
        const errMsg = 'OAuth token ikke tilgængeligt — tjek DATAFORDELER_OAUTH_CLIENT_ID/SECRET';
        logger.error('[sync-ejf-handelsoplysninger]', errMsg);
        await ingestRuns
          .update({ finished_at: new Date().toISOString(), error: errMsg })
          .eq('id', runId);
        return NextResponse.json({ ok: false, error: errMsg }, { status: 500 });
      }

      let processed = 0;
      let inserted = 0;
      let failed = 0;
      let error: string | null = null;
      let pages = 0;
      let complete = false;

      try {
        while (pages < MAX_PAGES) {
          // Tjek tidsbudget
          if (Date.now() - startTime > maxDuration * 1000 - SAFETY_MARGIN_MS) {
            logger.log(
              `[sync-ejf-handelsoplysninger] Tidsbudget opbrugt efter ${pages} sider, cursor: ${cursor}`
            );
            break;
          }

          const query = buildPageQuery(cursor);
          const res = await fetch(proxyUrl(EJF_GQL_ENDPOINT), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
              ...proxyHeaders(),
            },
            body: JSON.stringify({ query }),
            signal: AbortSignal.timeout(proxyTimeout()),
            cache: 'no-store',
          });

          if (!res.ok) {
            error = `EJF GraphQL HTTP ${res.status}`;
            break;
          }

          const json = (await res.json()) as GqlResponse;

          // Auth-fejl check
          if (json.errors?.some((e) => e.extensions?.code === 'DAF-AUTH-0001')) {
            error = 'DAF-AUTH-0001 — mangler adgang til EJF_Handelsoplysninger';
            break;
          }

          const pageData = json.data?.EJF_Handelsoplysninger;
          const nodes = pageData?.nodes ?? [];
          const pageInfo = pageData?.pageInfo;

          if (nodes.length === 0) {
            complete = true;
            break;
          }

          // Map og batch-upsert
          let batch: HandelsoplysningerRow[] = [];
          for (const node of nodes) {
            processed++;
            const row = mapNodeToRow(node);
            if (!row) {
              failed++;
              continue;
            }
            batch.push(row);
            if (batch.length >= BATCH_SIZE) {
              const result = await flushBatch(ejfTbl, batch);
              inserted += result.upserted;
              failed += result.failed;
              batch = [];
            }
          }
          // Flush remaining
          if (batch.length > 0) {
            const result = await flushBatch(ejfTbl, batch);
            inserted += result.upserted;
            failed += result.failed;
            batch = [];
          }

          // Pagination
          if (pageInfo?.hasNextPage && pageInfo.endCursor) {
            cursor = pageInfo.endCursor;
          } else {
            complete = true;
            break;
          }

          pages++;
        }

        if (pages >= MAX_PAGES) {
          logger.log(
            `[sync-ejf-handelsoplysninger] Nåede max ${MAX_PAGES} sider, fortsæt næste kørsel`
          );
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      // Gem cursor i error-feltet for resume (kun hvis ikke komplet)
      const statusNote = complete
        ? null
        : cursor
          ? `Ufuldstændig kørsel — ${RUN_ID_PREFIX} cursor: ${cursor}`
          : error;

      await ingestRuns
        .update({
          finished_at: new Date().toISOString(),
          rows_processed: processed,
          rows_inserted: inserted,
          rows_updated: 0,
          rows_failed: failed,
          error: statusNote ?? error,
        })
        .eq('id', runId);

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      logger.log(
        `[sync-ejf-handelsoplysninger] Færdig: processed=${processed} inserted=${inserted} ` +
          `failed=${failed} complete=${complete} elapsed=${elapsed}s`
      );

      return NextResponse.json({
        ok: error == null,
        runId,
        rows: { processed, inserted, updated: 0, failed },
        complete,
        cursor,
        elapsed: `${elapsed}s`,
        error,
      });
    }
  );
}
