/**
 * Cron: Ingest EJF bulk data — /api/cron/ingest-ejf-bulk
 *
 * BIZZ-534: Daglig bulk-ingest af EJF (Ejendoms-Fortegnelsen) ejerskabs-data
 * fra Datafordeler. Bygger public.ejf_ejerskab op så vi kan svare på
 * person→ejendomme uden grant til EJF_Ejerskab live-API.
 *
 * Strategi:
 *   Mode A (EJF_BULK_DUMP_URL sat):
 *     Download gzip-komprimeret JSON-Lines fil fra Datafordeler Udtræk.
 *     Stream-parse og batch-upsert til Supabase.
 *
 *   Mode B (default — GraphQL pagination):
 *     Paginer gennem EJFCustom_EjerskabBegraenset via eksisterende OAuth.
 *     Processer op til ~200.000 rækker per kørsel (5 min budget).
 *     Tracker cursor i ejf_ingest_runs for inkrementel synk.
 *
 * Sikring:
 *   - CRON_SECRET bearer + x-vercel-cron header i prod
 *   - Service role bypasser RLS for skrivning
 *   - Idempotent: UPSERT på PK (bfe_nummer, ejer_ejf_id, virkning_fra)
 *
 * Trigger:
 *   - Vercel Cron: dagligt kl. 04:00 UTC
 *   - Manuel: GET /api/cron/ingest-ejf-bulk med Authorization: Bearer <CRON_SECRET>
 *
 * @module api/cron/ingest-ejf-bulk
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { getSharedOAuthToken } from '@/app/lib/dfTokenCache';
import { getCertOAuthToken, isCertAuthConfigured } from '@/app/lib/dfCertAuth';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';
import { EJF_GQL_ENDPOINT } from '@/app/lib/serviceEndpoints';

export const runtime = 'nodejs';
export const maxDuration = 300; // 5 min — bulk-ingest kan tage tid

/** Antal rækker per batch-upsert til Supabase */
const BATCH_SIZE = 500;

/** Antal EJF-noder per GraphQL-request (max 1000 for EJFCustom_EjerskabBegraenset) */
const GQL_PAGE_SIZE = 1000;

/** Sikkerheds-margin i ms — stop pagination 30s før maxDuration */
const SAFETY_MARGIN_MS = 30_000;

/** Max antal sider per kørsel (sikkerhed mod uendelig loop) */
const MAX_PAGES_PER_RUN = 200;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Rå EJF-node fra GraphQL */
interface RawEjfNode {
  bestemtFastEjendomBFENr: number | null;
  ejerforholdskode: string | null;
  faktiskEjerandel_taeller: number | null;
  faktiskEjerandel_naevner: number | null;
  virkningFra: string | null;
  virkningTil: string | null;
  status: string | null;
  ejendeVirksomhedCVRNr_20_Virksomhed_CVRNummer_ref: {
    CVRNummer: number | null;
  } | null;
  ejendePersonBegraenset: {
    id: string | null;
    navn: { navn: string | null } | null;
    foedselsdato: string | null;
  } | null;
}

/** GraphQL response shape */
interface EjfGqlResponse {
  data?: {
    EJFCustom_EjerskabBegraenset?: {
      nodes: RawEjfNode[];
      pageInfo?: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
    };
  };
  errors?: { message: string; extensions?: { code?: string } }[];
}

/** Row shape for ejf_ejerskab upsert */
interface EjfRow {
  bfe_nummer: number;
  ejer_ejf_id: string;
  virkning_fra: string;
  ejer_navn: string;
  ejer_foedselsdato: string | null;
  ejer_cvr: string | null;
  ejer_type: 'person' | 'virksomhed';
  ejerandel_taeller: number | null;
  ejerandel_naevner: number | null;
  status: string;
  virkning_til: string | null;
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
 * Bygger GraphQL query for en side af EJF-ejerskab.
 *
 * @param pageSize - antal noder per side
 * @param cursor - pagination cursor (null for første side)
 * @returns GraphQL query string
 */
function buildPageQuery(pageSize: number, cursor: string | null): string {
  const vt = new Date().toISOString();
  const afterClause = cursor ? `, after: "${cursor}"` : '';
  return `{
    EJFCustom_EjerskabBegraenset(
      first: ${pageSize}
      virkningstid: "${vt}"
      ${afterClause}
    ) {
      nodes {
        bestemtFastEjendomBFENr
        ejerforholdskode
        faktiskEjerandel_taeller
        faktiskEjerandel_naevner
        virkningFra
        virkningTil
        status
        ejendeVirksomhedCVRNr_20_Virksomhed_CVRNummer_ref {
          CVRNummer
        }
        ejendePersonBegraenset {
          id
          navn { navn }
          foedselsdato
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }`;
}

/**
 * Mapper en rå EJF GraphQL-node til en ejf_ejerskab row.
 * Returnerer null hvis noden mangler kritiske felter.
 */
function mapNodeToRow(node: RawEjfNode): EjfRow | null {
  const bfe = node.bestemtFastEjendomBFENr;
  if (bfe == null) return null;

  const person = node.ejendePersonBegraenset;
  const virksomhedRef = node.ejendeVirksomhedCVRNr_20_Virksomhed_CVRNummer_ref;
  const cvr = virksomhedRef?.CVRNummer ? String(virksomhedRef.CVRNummer) : null;
  const personNavn = person?.navn?.navn ?? null;
  const personId = person?.id ?? null;
  const foedselsdato = person?.foedselsdato ?? null;

  // Bestem ejer-type og -identifikation
  let ejerType: 'person' | 'virksomhed';
  let ejfId: string;
  let navn: string;

  if (personId && personNavn) {
    ejerType = 'person';
    ejfId = personId;
    navn = personNavn;
  } else if (cvr) {
    ejerType = 'virksomhed';
    // Brug CVR som stable ID for virksomheder (EJF har ikke altid et separat person-ID)
    ejfId = `virk-${cvr}`;
    navn = `CVR ${cvr}`;
  } else {
    // Hverken person eller virksomhed identificeret — skip
    return null;
  }

  const virkningFra = node.virkningFra ?? new Date(0).toISOString();
  const rawStatus = (node.status ?? '').toLowerCase();
  const status = rawStatus.includes('historisk') ? 'historisk' : 'gældende';

  return {
    bfe_nummer: bfe,
    ejer_ejf_id: ejfId,
    virkning_fra: virkningFra,
    ejer_navn: navn,
    ejer_foedselsdato: ejerType === 'person' ? foedselsdato : null,
    ejer_cvr: ejerType === 'virksomhed' ? cvr : null,
    ejer_type: ejerType,
    ejerandel_taeller: node.faktiskEjerandel_taeller ?? null,
    ejerandel_naevner: node.faktiskEjerandel_naevner ?? null,
    status,
    virkning_til: node.virkningTil ?? null,
    sidst_opdateret: new Date().toISOString(),
  };
}

/**
 * Batch-upsert rækker til ejf_ejerskab. Dedupliker først på PK-composite
 * (bfe_nummer, ejer_ejf_id, virkning_fra) — Postgres ON CONFLICT kan ikke
 * håndtere samme key to gange i én statement. Sidste forekomst vinder.
 * Returnerer antal upserted og failed.
 */
async function flushBatch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  batch: EjfRow[]
): Promise<{ upserted: number; failed: number }> {
  if (batch.length === 0) return { upserted: 0, failed: 0 };

  // Dedupliker på composite PK — EJF returnerer samme ejerskab flere gange
  // hvis der er historiske virkning_til-ændringer for samme (bfe, ejer, virkningFra)
  const seen = new Map<string, EjfRow>();
  for (const row of batch) {
    const key = `${row.bfe_nummer}|${row.ejer_ejf_id}|${row.virkning_fra}`;
    seen.set(key, row);
  }
  const deduped = Array.from(seen.values());
  const dupesRemoved = batch.length - deduped.length;

  const { error } = await table.upsert(deduped, {
    onConflict: 'bfe_nummer,ejer_ejf_id,virkning_fra',
    ignoreDuplicates: false,
  });
  if (error) {
    logger.error('[ingest-ejf-bulk] Batch upsert fejl:', error.message);
    return { upserted: 0, failed: batch.length };
  }
  // Tæller dupes som upserted (de repræsenterer de samme records) så statistik
  // afspejler processed-count korrekt
  return { upserted: deduped.length + dupesRemoved, failed: 0 };
}

// ─── Ingestion: Bulk file download ─────────────────────────────────────────

/**
 * Ingestion via bulk-fil download (Mode A).
 * Forventer gzip-komprimeret JSON-Lines format hvor hver linje er et EJF-record.
 */
async function ingestFromBulkFile(
  dumpUrl: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  startTime: number
): Promise<{
  processed: number;
  inserted: number;
  failed: number;
  cursor: string | null;
  error: string | null;
}> {
  let processed = 0;
  let inserted = 0;
  let failed = 0;
  let batch: EjfRow[] = [];

  try {
    const res = await fetch(dumpUrl, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok || !res.body) {
      return {
        processed: 0,
        inserted: 0,
        failed: 0,
        cursor: null,
        error: `Download fejlede: HTTP ${res.status}`,
      };
    }

    // Stream-decompress og parse linje-for-linje
    const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';

    while (true) {
      // Tjek tidsbudget
      if (Date.now() - startTime > maxDuration * 1000 - SAFETY_MARGIN_MS) {
        logger.warn('[ingest-ejf-bulk] Tidsbudget opbrugt under bulk-download');
        break;
      }

      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const node = JSON.parse(trimmed) as RawEjfNode;
          processed++;
          const row = mapNodeToRow(node);
          if (!row) continue;
          batch.push(row);
          if (batch.length >= BATCH_SIZE) {
            const result = await flushBatch(table, batch);
            inserted += result.upserted;
            failed += result.failed;
            batch = [];
          }
        } catch {
          failed++;
        }
      }
    }

    // Flush remaining
    if (batch.length > 0) {
      const result = await flushBatch(table, batch);
      inserted += result.upserted;
      failed += result.failed;
    }

    return { processed, inserted, failed, cursor: null, error: null };
  } catch (err) {
    return {
      processed,
      inserted,
      failed,
      cursor: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Ingestion: GraphQL pagination ──────────────────────────────────────────

/**
 * Ingestion via GraphQL pagination (Mode B).
 * Paginerer gennem EJFCustom_EjerskabBegraenset og upsert'er i batches.
 * Tracker cursor for inkrementel synk på tværs af cron-runs.
 *
 * @param startCursor - Resume fra denne cursor (null = start forfra)
 */
async function ingestFromGraphQL(
  token: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  startCursor: string | null,
  startTime: number
): Promise<{
  processed: number;
  inserted: number;
  failed: number;
  cursor: string | null;
  error: string | null;
  complete: boolean;
}> {
  let processed = 0;
  let inserted = 0;
  let failed = 0;
  let cursor = startCursor;
  let pages = 0;
  let complete = false;

  try {
    while (pages < MAX_PAGES_PER_RUN) {
      // Tjek tidsbudget
      if (Date.now() - startTime > maxDuration * 1000 - SAFETY_MARGIN_MS) {
        logger.log(`[ingest-ejf-bulk] Tidsbudget opbrugt efter ${pages} sider, cursor: ${cursor}`);
        break;
      }

      const query = buildPageQuery(GQL_PAGE_SIZE, cursor);
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
        return {
          processed,
          inserted,
          failed,
          cursor,
          error: `EJF GraphQL HTTP ${res.status}`,
          complete: false,
        };
      }

      const json = (await res.json()) as EjfGqlResponse;

      // Auth-fejl check
      if (json.errors?.some((e) => e.extensions?.code === 'DAF-AUTH-0001')) {
        return {
          processed,
          inserted,
          failed,
          cursor,
          error: 'DAF-AUTH-0001 — mangler adgang til EJF',
          complete: false,
        };
      }

      const pageData = json.data?.EJFCustom_EjerskabBegraenset;
      const nodes = pageData?.nodes ?? [];
      const pageInfo = pageData?.pageInfo;

      if (nodes.length === 0) {
        complete = true;
        break;
      }

      // Map og batch-upsert
      let batch: EjfRow[] = [];
      for (const node of nodes) {
        processed++;
        const row = mapNodeToRow(node);
        if (!row) {
          failed++;
          continue;
        }
        batch.push(row);
        if (batch.length >= BATCH_SIZE) {
          const result = await flushBatch(table, batch);
          inserted += result.upserted;
          failed += result.failed;
          batch = [];
        }
      }
      // Flush remaining batch
      if (batch.length > 0) {
        const result = await flushBatch(table, batch);
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

    if (pages >= MAX_PAGES_PER_RUN) {
      logger.log(`[ingest-ejf-bulk] Nåede max ${MAX_PAGES_PER_RUN} sider, fortsæt næste kørsel`);
    }

    return { processed, inserted, failed, cursor, error: null, complete };
  } catch (err) {
    return {
      processed,
      inserted,
      failed,
      cursor,
      error: err instanceof Error ? err.message : String(err),
      complete: false,
    };
  }
}

// ─── Route handler ──────────────────────────────────────────────────────────

/**
 * GET /api/cron/ingest-ejf-bulk
 *
 * Triggerer EJF bulk-ingest. Understøtter to modes:
 *   - Mode A: Bulk-fil download (når EJF_BULK_DUMP_URL er sat)
 *   - Mode B: GraphQL pagination (default)
 *
 * Query params:
 *   - cursor: Resume fra denne cursor (kun Mode B, optional)
 *   - reset: "true" for at starte forfra (ignorerer gemt cursor)
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startTime = Date.now();
  const dumpUrl = process.env.EJF_BULK_DUMP_URL;
  const admin = createAdminClient();

  // BIZZ-534: nye tabeller, endnu ikke i auto-generated types
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ingestRuns = (admin as any).from('ejf_ingest_runs');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ejfTbl = (admin as any).from('ejf_ejerskab');

  // Hent evt. cursor fra forrige kørsel for inkrementel synk
  const resetParam = request.nextUrl.searchParams.get('reset');
  const cursorParam = request.nextUrl.searchParams.get('cursor');
  let startCursor: string | null = cursorParam ?? null;

  if (!startCursor && resetParam !== 'true') {
    // Find seneste ufærdige kørsel med gemt cursor
    const { data: lastRun } = await ingestRuns
      .select('error')
      .not('error', 'is', null)
      .ilike('error', '%cursor:%')
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastRun?.error) {
      const match = (lastRun.error as string).match(/cursor:\s*(\S+)/);
      if (match) startCursor = match[1];
    }
  }

  // Opret run-row for tracking
  const { data: runRow, error: runErr } = await ingestRuns
    .insert({ started_at: new Date().toISOString() })
    .select('id')
    .single();

  if (runErr) {
    logger.error('[ingest-ejf-bulk] Kan ikke oprette run-row:', runErr.message);
    return NextResponse.json({ ok: false, error: 'Run-tracking fejlede' }, { status: 500 });
  }
  const runId = runRow!.id as number;

  let processed = 0;
  let inserted = 0;
  let failed = 0;
  let error: string | null = null;
  let endCursor: string | null = null;
  let complete = false;
  let mode: 'bulk-file' | 'graphql' = 'graphql';

  if (dumpUrl) {
    // ── Mode A: Bulk-fil download ──
    mode = 'bulk-file';
    logger.log('[ingest-ejf-bulk] Mode A: Bulk-fil download fra', dumpUrl);
    const result = await ingestFromBulkFile(dumpUrl, ejfTbl, startTime);
    processed = result.processed;
    inserted = result.inserted;
    failed = result.failed;
    error = result.error;
    complete = !error;
  } else {
    // ── Mode B: GraphQL pagination ──
    const token = await getToken();
    if (!token) {
      error = 'OAuth token ikke tilgængeligt — tjek DATAFORDELER_OAUTH_CLIENT_ID/SECRET';
      logger.error('[ingest-ejf-bulk]', error);
    } else {
      mode = 'graphql';
      logger.log(
        `[ingest-ejf-bulk] Mode B: GraphQL pagination, startCursor: ${startCursor ?? 'null'}`
      );
      const result = await ingestFromGraphQL(token, ejfTbl, startCursor, startTime);
      processed = result.processed;
      inserted = result.inserted;
      failed = result.failed;
      endCursor = result.cursor;
      error = result.error;
      complete = result.complete;
    }
  }

  // Gem cursor i error-feltet for resume (kun hvis ikke komplet)
  const statusNote = complete
    ? null
    : endCursor
      ? `Ufuldstændig kørsel — cursor: ${endCursor}`
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
    `[ingest-ejf-bulk] Færdig: mode=${mode} processed=${processed} inserted=${inserted} ` +
      `failed=${failed} complete=${complete} elapsed=${elapsed}s`
  );

  return NextResponse.json({
    ok: error == null,
    runId,
    mode,
    rows: { processed, inserted, updated: 0, failed },
    complete,
    cursor: endCursor,
    elapsed: `${elapsed}s`,
    error,
  });
}
