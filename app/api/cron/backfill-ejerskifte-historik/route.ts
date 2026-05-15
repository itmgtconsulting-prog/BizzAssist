/**
 * Cron: Backfill ejerskifte-historik med Tinglysning købesummer
 *
 * BIZZ-1454: Populerer public.ejerskifte_historik ved at:
 *   1. Hente nye ejerskifter fra ejf_ejerskab (virkning_fra seneste 30 dage
 *      eller alle hvis tabellen er tom).
 *   2. Berige med Tinglysning købesummer via fetchTinglysningPriceRowsByBfe.
 *   3. Tilføje kommune_kode + byg021_anvendelse fra bbr_ejendom_status.
 *   4. Upsert til ejerskifte_historik.
 *
 * Rate-limit: max 200 BFE-opslag per kørsel (Tinglysning API = 10 req/s).
 * Schedule: 30 4 * * * UTC (dagligt 04:30, efter pull-tinglysning-aendringer).
 *
 * @module api/cron/backfill-ejerskifte-historik
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';
import { fetchTinglysningPriceRowsByBfe, indexPriceRowsByDate } from '@/app/lib/tinglysningPrices';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** Max antal BFE'er der beriges per kørsel (Tinglysning rate limit). */
const MAX_BFES_PER_RUN = 200;

/** Concurrent requests mod Tinglysning (10 req/s limit). */
const CONCURRENCY = 4;

/**
 * Sleep utility for rate limiting.
 *
 * @param ms - millisekunder at vente
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * GET handler — kræver CRON_SECRET bearer token.
 */
async function handler(request: NextRequest): Promise<NextResponse> {
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

  const start = Date.now();
  const supabase = createAdminClient();

  // ── 1. Find BFE'er med nye ejerskifter der ikke er i historik endnu ──
  const { data: lastRow } = await supabase
    .from('ejerskifte_historik')
    .select('created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  const sinceDate = lastRow?.created_at
    ? new Date(new Date(lastRow.created_at).getTime() - 7 * 86_400_000).toISOString().slice(0, 10)
    : '2020-01-01';

  logger.info(`[backfill-ejerskifte] since=${sinceDate}`);

  // Hent ejerskifter der endnu ikke er backfilled
  const { data: ejerskifter, error: ejfError } = await supabase
    .from('ejf_ejerskab')
    .select(
      'bfe_nummer, ejer_navn, ejer_cvr, ejer_type, ejerandel_taeller, ejerandel_naevner, virkning_fra, virkning_til, status'
    )
    .eq('status', 'gældende')
    .gte('virkning_fra', sinceDate)
    .order('virkning_fra', { ascending: false })
    .limit(MAX_BFES_PER_RUN * 2);

  if (ejfError) {
    logger.error('[backfill-ejerskifte] EJF query failed:', ejfError.message);
    return NextResponse.json({ error: ejfError.message }, { status: 500 });
  }

  if (!ejerskifter || ejerskifter.length === 0) {
    return NextResponse.json({
      ok: true,
      message: 'Ingen nye ejerskifter at berige',
      durationMs: Date.now() - start,
    });
  }

  // Unikke BFE-numre
  const uniqueBfes = [...new Set(ejerskifter.map((e) => e.bfe_nummer))].slice(0, MAX_BFES_PER_RUN);

  logger.info(
    `[backfill-ejerskifte] ${ejerskifter.length} ejerskifter, ${uniqueBfes.length} unikke BFE'er`
  );

  // ── 2. Hent BBR-data for kommune + anvendelse ──
  const { data: bbrData } = await supabase
    .from('bbr_ejendom_status')
    .select('bfe_nummer, kommune_kode, byg021_anvendelse')
    .in('bfe_nummer', uniqueBfes);

  const bbrMap = new Map<
    number,
    { kommune_kode: number | null; byg021_anvendelse: number | null }
  >();
  for (const b of bbrData ?? []) {
    bbrMap.set(b.bfe_nummer, {
      kommune_kode: b.kommune_kode,
      byg021_anvendelse: b.byg021_anvendelse,
    });
  }

  // ── 3. Berig med Tinglysning købesummer (concurrent, rate-limited) ──
  const priceMap = new Map<
    number,
    Map<
      string,
      {
        kontant: number | null;
        ialt: number | null;
        koebsaftale: string | null;
        dokId: string | null;
      }
    >
  >();

  let fetched = 0;
  let priced = 0;

  for (let i = 0; i < uniqueBfes.length; i += CONCURRENCY) {
    const batch = uniqueBfes.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((bfe) => fetchTinglysningPriceRowsByBfe(bfe))
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const bfe = batch[j];
      fetched++;
      if (result.status === 'fulfilled' && result.value.length > 0) {
        const indexed = indexPriceRowsByDate(result.value);
        const m = new Map<
          string,
          {
            kontant: number | null;
            ialt: number | null;
            koebsaftale: string | null;
            dokId: string | null;
          }
        >();
        for (const [date, row] of indexed) {
          m.set(date, {
            kontant: row.kontantKoebesum,
            ialt: row.iAltKoebesum,
            koebsaftale: row.koebsaftaleDato,
            dokId: row.dokumentId,
          });
          priced++;
        }
        priceMap.set(bfe, m);
      }
    }

    // Rate limit: ~10 req/s → 4 concurrent * 400ms gap ≈ 10 req/s
    if (i + CONCURRENCY < uniqueBfes.length) {
      await sleep(400);
    }
  }

  // ── 4. Upsert til ejerskifte_historik ──
  let inserted = 0;
  let errors = 0;
  const rows = [];

  for (const ej of ejerskifter) {
    if (!uniqueBfes.includes(ej.bfe_nummer)) continue;

    const bbr = bbrMap.get(ej.bfe_nummer);
    const dateKey = ej.virkning_fra ? new Date(ej.virkning_fra).toISOString().slice(0, 10) : null;
    const prices = dateKey ? priceMap.get(ej.bfe_nummer)?.get(dateKey) : undefined;

    rows.push({
      bfe_nummer: ej.bfe_nummer,
      overtagelsesdato: dateKey,
      fratraedelsesdato: ej.virkning_til
        ? new Date(ej.virkning_til).toISOString().slice(0, 10)
        : null,
      ejer_navn: ej.ejer_navn,
      ejer_cvr: ej.ejer_cvr,
      ejer_type: ej.ejer_type,
      ejerandel_taeller: ej.ejerandel_taeller,
      ejerandel_naevner: ej.ejerandel_naevner,
      kontant_koebesum: prices?.kontant ?? null,
      i_alt_koebesum: prices?.ialt ?? null,
      koebsaftale_dato: prices?.koebsaftale ?? null,
      dokument_id: prices?.dokId ?? null,
      kommune_kode: bbr?.kommune_kode ?? null,
      byg021_anvendelse: bbr?.byg021_anvendelse ?? null,
    });
  }

  // Batch upsert 500 at a time
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error: upsertError } = await supabase
      .from('ejerskifte_historik')
      .upsert(batch, { onConflict: 'bfe_nummer,overtagelsesdato,ejer_navn' });

    if (upsertError) {
      logger.error('[backfill-ejerskifte] upsert failed:', upsertError.message);
      errors++;
    } else {
      inserted += batch.length;
    }
  }

  const elapsed = Date.now() - start;
  logger.info(
    `[backfill-ejerskifte] done: ${inserted} inserted, ${priced} priced, ${errors} errors, ${elapsed}ms`
  );

  return NextResponse.json({
    ok: true,
    ejerskifter: ejerskifter.length,
    uniqueBfes: uniqueBfes.length,
    fetched,
    priced,
    inserted,
    errors,
    durationMs: elapsed,
  });
}

export const GET = withCronMonitor('backfill-ejerskifte-historik', handler);
