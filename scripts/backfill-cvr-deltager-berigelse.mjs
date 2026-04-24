#!/usr/bin/env node
/**
 * BIZZ-830 fase B — backfill for cvr_deltager enrichment-kolonner.
 *
 * Beregner is_aktiv, aktive_roller_json, antal_aktive_selskaber,
 * senest_indtraadt_dato og role_typer ved at aggregere over
 * cvr_deltagerrelation. Denormaliseret cache — source-of-truth
 * forbliver cvr_deltagerrelation, men filter-performance kræver
 * pre-aggregering.
 *
 * Idempotent: UPSERT pr. enhedsNummer. Sætter berigelse_sidst=now()
 * så daglig cron kan skelne færdig-processerede rækker fra nye.
 *
 * Kører manuelt:
 *   node scripts/backfill-cvr-deltager-berigelse.mjs [--limit=1000] [--dry-run]
 *
 * Batch: 500 deltagere pr. run, 100ms delay mellem batches — kun
 * DB-operationer, ingen eksterne API-kald, så rate-limit er kun
 * Supabase Free-tier-niveau.
 *
 * Miljø:
 *   * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *
 * Acceptance: Alle ~2M deltagere har is_aktiv + role_typer sat efter fuld run.
 */
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
import { createClient } from '@supabase/supabase-js';

loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const args = process.argv.slice(2);
const LIMIT = (() => {
  const a = args.find((x) => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : Infinity;
})();
const DRY_RUN = args.includes('--dry-run');
const ONLY_MISSING = args.includes('--only-missing'); // Skip rows der allerede har berigelse

const client = createClient(SUPABASE_URL, SERVICE_ROLE);

const BATCH_SIZE = 500;
const BATCH_DELAY_MS = 100;

/** Hvilke role-type-strings normaliseres til hvilket slot i role_typer[]. */
function normalizeRoleType(raw) {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.includes('direkt')) return 'direktør';
  if (lower.includes('bestyrelse')) return 'bestyrelsesmedlem';
  if (lower.includes('stifter')) return 'stifter';
  if (lower.includes('reel') && lower.includes('ejer')) return 'reel_ejer';
  if (lower === 'ejer' || lower.includes('ejer')) return 'ejer';
  if (lower.includes('suppleant')) return 'suppleant';
  if (lower.includes('formand')) return 'formand';
  return lower;
}

/**
 * Yielder enhedsNummer-batches i chunks af BATCH_SIZE.
 * Filter: --only-missing → berigelse_sidst IS NULL.
 */
async function* iterateDeltagerBatches(limit) {
  let offset = 0;
  let returned = 0;
  while (returned < limit) {
    let query = client
      .from('cvr_deltager')
      .select('"enhedsNummer"')
      .order('"enhedsNummer"', { ascending: true })
      .range(offset, offset + BATCH_SIZE - 1);
    if (ONLY_MISSING) {
      query = query.is('berigelse_sidst', null);
    }
    const { data, error } = await query;
    if (error) throw error;
    if (!data || data.length === 0) return;
    const ids = data.map((r) => Number(r.enhedsNummer)).filter((n) => Number.isFinite(n));
    if (ids.length === 0) return;
    yield ids;
    returned += ids.length;
    offset += BATCH_SIZE;
    if (returned >= limit) return;
    await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
  }
}

/**
 * Aggreger cvr_deltagerrelation for et batch af enhedsNummer'e.
 * Returnerer Map: enhedsNummer → {is_aktiv, aktive_roller_json, antal_aktive_selskaber, senest_indtraadt_dato, role_typer}.
 */
async function aggregateForBatch(enhedsNumre) {
  const nowIso = new Date().toISOString().slice(0, 10);
  const { data, error } = await client
    .from('cvr_deltagerrelation')
    .select('"deltager_enhedsNummer", virksomhed_cvr, type, gyldig_fra, gyldig_til')
    .in('deltager_enhedsNummer', enhedsNumre);
  if (error) throw error;

  const perDeltager = new Map();
  for (const row of data ?? []) {
    const enr = Number(row.deltager_enhedsNummer);
    if (!Number.isFinite(enr)) continue;
    if (!perDeltager.has(enr)) {
      perDeltager.set(enr, {
        aktive: [],
        aktiveCvrs: new Set(),
        roleTypes: new Set(),
        maxFra: null,
      });
    }
    const acc = perDeltager.get(enr);
    const erAktiv = !row.gyldig_til || row.gyldig_til > nowIso;
    const normType = normalizeRoleType(row.type);
    if (normType) acc.roleTypes.add(normType);
    if (erAktiv) {
      acc.aktive.push({
        cvr: row.virksomhed_cvr,
        type: row.type,
        fra: row.gyldig_fra,
        til: row.gyldig_til,
      });
      acc.aktiveCvrs.add(row.virksomhed_cvr);
      if (row.gyldig_fra && (!acc.maxFra || row.gyldig_fra > acc.maxFra)) {
        acc.maxFra = row.gyldig_fra;
      }
    }
  }

  const result = new Map();
  for (const enr of enhedsNumre) {
    const acc = perDeltager.get(enr);
    if (!acc) {
      // Ingen relationer — markér som inaktiv med tom array
      result.set(enr, {
        is_aktiv: false,
        aktive_roller_json: [],
        antal_aktive_selskaber: 0,
        senest_indtraadt_dato: null,
        role_typer: [],
      });
      continue;
    }
    result.set(enr, {
      is_aktiv: acc.aktive.length > 0,
      aktive_roller_json: acc.aktive,
      antal_aktive_selskaber: acc.aktiveCvrs.size,
      senest_indtraadt_dato: acc.maxFra,
      role_typer: Array.from(acc.roleTypes),
    });
  }
  return result;
}

async function main() {
  console.log(`Starter backfill (LIMIT=${LIMIT === Infinity ? 'all' : LIMIT}, DRY=${DRY_RUN}, ONLY_MISSING=${ONLY_MISSING})`);
  let totalProcessed = 0;
  let totalUpdated = 0;
  let totalErrors = 0;

  for await (const batch of iterateDeltagerBatches(LIMIT)) {
    try {
      const aggs = await aggregateForBatch(batch);
      if (DRY_RUN) {
        const sample = Array.from(aggs.entries()).slice(0, 2);
        console.log(`  DRY: ${batch.length} enhedsnumre, sample:`, JSON.stringify(sample, null, 2).slice(0, 400));
      } else {
        const now = new Date().toISOString();
        const rows = Array.from(aggs.entries()).map(([enr, agg]) => ({
          enhedsNummer: enr,
          is_aktiv: agg.is_aktiv,
          aktive_roller_json: agg.aktive_roller_json,
          antal_aktive_selskaber: agg.antal_aktive_selskaber,
          senest_indtraadt_dato: agg.senest_indtraadt_dato,
          role_typer: agg.role_typer,
          berigelse_sidst: now,
        }));
        // UPSERT på enhedsNummer. Kolonner der ikke er del af payload
        // bevares (navn, adresse_json osv. fra fase A).
        const { error } = await client
          .from('cvr_deltager')
          .upsert(rows, { onConflict: 'enhedsNummer' });
        if (error) {
          console.error(`  ERROR batch starting at ${batch[0]}:`, error.message);
          totalErrors += batch.length;
          continue;
        }
        totalUpdated += rows.length;
      }
      totalProcessed += batch.length;
      if (totalProcessed % 10000 === 0) {
        console.log(`  processed=${totalProcessed}, updated=${totalUpdated}, errors=${totalErrors}`);
      }
    } catch (err) {
      console.error(`  ERROR processing batch:`, err.message);
      totalErrors += batch.length;
    }
  }

  console.log(`\nFaerdig. processed=${totalProcessed}, updated=${totalUpdated}, errors=${totalErrors}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
