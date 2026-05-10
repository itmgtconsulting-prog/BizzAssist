/**
 * BIZZ-908: Daglig re-compute af cvr_deltager enrichment-kolonner.
 *
 * Finder deltagere hvis berigelse_sidst er ældre end 7 dage (eller NULL)
 * og re-aggregerer is_aktiv, antal_aktive_selskaber, role_typer fra
 * cvr_deltagerrelation. Cap 5000 pr run for at holde sig under
 * Vercel 300s maxDuration.
 *
 * Samme logik som scripts/backfill-cvr-deltager-berigelse.mjs men
 * tilpasset cron-context (auth-check, response-format, cap).
 *
 * Schedule: dagligt 04:15 UTC (efter pull-cvr-aendringer 03:30).
 *
 * @module api/cron/refresh-deltager-berigelse
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';

export const maxDuration = 300;

const PER_RUN_CAP = 5000;
const BATCH_SIZE = 500;
const STALE_DAYS = 7;

/**
 * Verificerer CRON_SECRET bearer + x-vercel-cron (i produktion).
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
 * Normaliserer rolle-type fra CVR-fritekst til standardiseret enum.
 */
function normalizeRoleType(raw: string | null): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.includes('direkt')) return 'direktør';
  if (lower.includes('bestyrelse')) return 'bestyrelsesmedlem';
  if (lower.includes('stifter')) return 'stifter';
  if (lower.includes('reel') && lower.includes('ejer')) return 'reel_ejer';
  if (lower === 'ejer' || lower.includes('fuldt ansvarlig')) return 'ejer';
  if (lower.includes('suppleant')) return 'suppleant';
  if (lower.includes('formand')) return 'formand';
  return lower;
}

interface RelationRow {
  deltager_enhedsnummer: number;
  virksomhed_cvr: string;
  type: string;
  gyldig_fra: string | null;
  gyldig_til: string | null;
}

/**
 * Aggregerer cvr_deltagerrelation for en batch enhedsnumre.
 * Returnerer Map med enrichment-data.
 */
async function aggregateForBatch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  enhedsnumre: number[]
): Promise<
  Map<
    number,
    {
      is_aktiv: boolean;
      aktive_roller_json: Array<{
        cvr: string;
        type: string;
        fra: string | null;
        til: string | null;
      }>;
      antal_aktive_selskaber: number;
      senest_indtraadt_dato: string | null;
      role_typer: string[];
      antal_historiske_virksomheder: number;
      totalt_antal_roller: number;
    }
  >
> {
  const nowIso = new Date().toISOString().slice(0, 10);
  const { data, error } = await admin
    .from('cvr_deltagerrelation')
    .select('deltager_enhedsnummer, virksomhed_cvr, type, gyldig_fra, gyldig_til')
    .in('deltager_enhedsnummer', enhedsnumre);

  if (error) {
    logger.error('[refresh-deltager] relation query fejlede:', error.message);
    return new Map();
  }

  const perDeltager = new Map<
    number,
    {
      aktive: Array<{ cvr: string; type: string; fra: string | null; til: string | null }>;
      aktiveCvrs: Set<string>;
      roleTypes: Set<string>;
      maxFra: string | null;
      historiskeCvrs: Set<string>;
      totalRoller: number;
    }
  >();

  for (const row of (data ?? []) as RelationRow[]) {
    const enr = Number(row.deltager_enhedsnummer);
    if (!Number.isFinite(enr)) continue;
    if (!perDeltager.has(enr)) {
      perDeltager.set(enr, {
        aktive: [],
        aktiveCvrs: new Set(),
        roleTypes: new Set(),
        maxFra: null,
        historiskeCvrs: new Set(),
        totalRoller: 0,
      });
    }
    const acc = perDeltager.get(enr)!;
    const erAktiv = !row.gyldig_til || row.gyldig_til > nowIso;
    const normType = normalizeRoleType(row.type);
    if (normType) acc.roleTypes.add(normType);
    // BIZZ-823: Track alle roller og historiske virksomheder
    acc.totalRoller++;
    if (row.gyldig_til) acc.historiskeCvrs.add(row.virksomhed_cvr);
    if (erAktiv) {
      acc.aktive.push({
        cvr: row.virksomhed_cvr,
        type: row.type,
        fra: row.gyldig_fra,
        til: row.gyldig_til,
      });
      acc.aktiveCvrs.add(row.virksomhed_cvr);
      if (row.gyldig_fra && (!acc.maxFra || row.gyldig_fra > acc.maxFra))
        acc.maxFra = row.gyldig_fra;
    }
  }

  const result = new Map<
    number,
    {
      is_aktiv: boolean;
      aktive_roller_json: Array<{
        cvr: string;
        type: string;
        fra: string | null;
        til: string | null;
      }>;
      antal_aktive_selskaber: number;
      senest_indtraadt_dato: string | null;
      role_typer: string[];
      antal_historiske_virksomheder: number;
      totalt_antal_roller: number;
    }
  >();

  for (const enr of enhedsnumre) {
    const acc = perDeltager.get(enr);
    result.set(
      enr,
      acc
        ? {
            is_aktiv: acc.aktive.length > 0,
            aktive_roller_json: acc.aktive,
            antal_aktive_selskaber: acc.aktiveCvrs.size,
            senest_indtraadt_dato: acc.maxFra,
            role_typer: Array.from(acc.roleTypes),
            antal_historiske_virksomheder: acc.historiskeCvrs.size,
            totalt_antal_roller: acc.totalRoller,
          }
        : {
            is_aktiv: false,
            aktive_roller_json: [],
            antal_aktive_selskaber: 0,
            senest_indtraadt_dato: null,
            role_typer: [],
            antal_historiske_virksomheder: 0,
            totalt_antal_roller: 0,
          }
    );
  }
  return result;
}

/**
 * GET endpoint (Vercel cron). Re-computer enrichment for stale deltagere.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Hent stale deltagere (berigelse_sidst < cutoff ELLER NULL)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: staleRows, error: fetchErr } = await (admin as any)
    .from('cvr_deltager')
    .select('enhedsnummer')
    .or(`berigelse_sidst.lt.${cutoff},berigelse_sidst.is.null`)
    .order('enhedsnummer', { ascending: true })
    .limit(PER_RUN_CAP);

  if (fetchErr) {
    logger.error('[refresh-deltager] fetch stale fejlede:', fetchErr.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  const rows = (staleRows ?? []) as Array<{ enhedsnummer: number }>;
  if (rows.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, updated: 0, note: 'no stale rows' });
  }

  let processed = 0;
  let updated = 0;
  let errors = 0;
  const nowIso = new Date().toISOString();

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE).map((r) => Number(r.enhedsnummer));

    try {
      const aggs = await aggregateForBatch(admin, chunk);
      const upsertRows = Array.from(aggs.entries()).map(([enr, agg]) => ({
        enhedsnummer: enr,
        is_aktiv: agg.is_aktiv,
        aktive_roller_json: agg.aktive_roller_json,
        antal_aktive_selskaber: agg.antal_aktive_selskaber,
        senest_indtraadt_dato: agg.senest_indtraadt_dato,
        role_typer: agg.role_typer,
        antal_historiske_virksomheder: agg.antal_historiske_virksomheder,
        totalt_antal_roller: agg.totalt_antal_roller,
        berigelse_sidst: nowIso,
      }));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: upsertErr } = await (admin as any)
        .from('cvr_deltager')
        .upsert(upsertRows, { onConflict: 'enhedsnummer' });

      if (upsertErr) {
        logger.error('[refresh-deltager] upsert fejl:', upsertErr.message);
        errors += chunk.length;
      } else {
        updated += upsertRows.length;
      }
      processed += chunk.length;
    } catch (err) {
      logger.error('[refresh-deltager] batch fejl:', (err as Error)?.message ?? 'unknown');
      errors += chunk.length;
    }
  }

  return NextResponse.json({
    ok: true,
    processed,
    updated,
    errors,
    capReached: rows.length >= PER_RUN_CAP,
  });
}
