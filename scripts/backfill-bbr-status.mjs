#!/usr/bin/env node
/**
 * BIZZ-785 iter 2a — backfill script for bbr_ejendom_status.
 *
 * Henter alle kendte BFE'er fra DAWA-sitemap-agnostiske kilder og
 * spørger BBR for bygning-status per BFE. Konsoliderer til
 * is_udfaset=true hvis ALLE bygninger på ejendommen har status
 * ∈ {Nedrevet/slettet, Bygning nedrevet, Bygning bortfaldet}
 * (samme logik som BIZZ-787 banner-trigger).
 *
 * Kører manuelt:
 *   node scripts/backfill-bbr-status.mjs [--limit=100] [--dry-run]
 *
 * Batch: 50 BFE'er pr. BBR-kald med 500ms delay — respekterer rate-
 * limit hos Datafordeler. ~46k ejendomme → ~8 minutter for fuld run.
 *
 * Idempotent: UPSERT pr. bfe_nummer, opdaterer status_last_checked_at.
 * Kan køres hver nat eller ad hoc.
 *
 * Miljø:
 *   * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (til upsert)
 *   * DATAFORDELER_USER + DATAFORDELER_PASS (til BBR-kald)
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
const BBR_USER = process.env.DATAFORDELER_USER;
const BBR_PASS = process.env.DATAFORDELER_PASS;

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
if (!BBR_USER || !BBR_PASS) {
  console.error('Missing DATAFORDELER_USER / DATAFORDELER_PASS');
  process.exit(1);
}

const args = process.argv.slice(2);
const LIMIT = (() => {
  const a = args.find((x) => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : Infinity;
})();
const DRY_RUN = args.includes('--dry-run');

const RETIRED_STATUSES = new Set([
  'Nedrevet/slettet',
  'Bygning nedrevet',
  'Bygning bortfaldet',
]);

const client = createClient(SUPABASE_URL, SERVICE_ROLE);

/**
 * Kilde til BFE-numre: ejf_ejerskab-tabellen (komplet sidste backfill
 * fra Datafordeler Filudtræk — 7.6M rows). Unike bfe_nummer'er vi
 * har "set" via ejerskab er en fornuftig start-population.
 */
async function* iterateBfeNumbers(limit) {
  let offset = 0;
  const pageSize = 1000;
  let returned = 0;
  while (returned < limit) {
    const { data, error } = await client
      .from('ejf_ejerskab')
      .select('bfe_nummer')
      .not('bfe_nummer', 'is', null)
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) return;
    for (const row of data) {
      if (returned >= limit) return;
      yield Number(row.bfe_nummer);
      returned++;
    }
    offset += pageSize;
  }
}

/**
 * Kalder BBR GraphQL for en liste af BFE'er. Returnerer map
 * bfe_nummer → { is_udfaset, adgangsadresse_id, bbr_status_code }.
 * Batch-størrelse 50 pr. kald.
 */
async function fetchBbrStatusForBfeBatch(bfeNumre) {
  // Placeholder: den rigtige BBR query kan afledes fra app/lib/fetchBbrData.ts
  // (fetchBbrByBfe). For at holde scriptet selvstændigt og ikke importere
  // Next.js runtime, loggger vi bare at vi ville kalde her.
  // Iter 2b replacer dette med et rigtigt HTTP-kald.
  console.log(`[bbr] Skipping live BBR-query for ${bfeNumre.length} BFE'er (iter 2a scaffold)`);
  return new Map();
}

async function main() {
  console.log(`[backfill] Starting — limit=${LIMIT === Infinity ? 'ALL' : LIMIT}, dry-run=${DRY_RUN}`);
  const unique = new Set();
  for await (const bfe of iterateBfeNumbers(LIMIT)) {
    unique.add(bfe);
  }
  console.log(`[backfill] ${unique.size} unike BFE-numre at process.`);

  const all = Array.from(unique);
  let processed = 0;
  let upserted = 0;
  const BATCH = 50;
  for (let i = 0; i < all.length; i += BATCH) {
    const chunk = all.slice(i, i + BATCH);
    const statusMap = await fetchBbrStatusForBfeBatch(chunk);
    const rows = [];
    for (const bfe of chunk) {
      const entry = statusMap.get(bfe);
      if (!entry) continue;
      rows.push({
        bfe_nummer: bfe,
        adgangsadresse_id: entry.adgangsadresse_id ?? null,
        is_udfaset: entry.is_udfaset,
        bbr_status_code: entry.bbr_status_code ?? null,
        status_last_checked_at: new Date().toISOString(),
      });
    }
    if (!DRY_RUN && rows.length > 0) {
      const { error } = await client
        .from('bbr_ejendom_status')
        .upsert(rows, { onConflict: 'bfe_nummer' });
      if (error) {
        console.error(`[backfill] upsert error på batch ${i}:`, error.message);
      } else {
        upserted += rows.length;
      }
    }
    processed += chunk.length;
    if (processed % 500 === 0) {
      console.log(`[backfill] processed=${processed}, upserted=${upserted}`);
    }
    // Rate-limit hensyn — 500ms mellem batches
    if (i + BATCH < all.length) await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`[backfill] Done. processed=${processed}, upserted=${upserted}`);
}

main().catch((err) => {
  console.error('[backfill] Fatal:', err);
  process.exit(1);
});
