#!/usr/bin/env node
/**
 * BIZZ-1273: Backfill ejer_enheds_nummer i ejf_ejerskab for person-ejere.
 *
 * Matcher ejf_ejerskab.ejer_navn mod cvr_deltager.navn for at linke
 * ejendoms-ejerskab til person-enhedsNummer. Muliggør navigation fra
 * ejendom → person → virksomheder i datamodellen.
 *
 * Strategi:
 *   1. Hent person-ejere fra ejf_ejerskab hvor ejer_enheds_nummer IS NULL
 *   2. Batch-match mod cvr_deltager.navn (eksakt match — navne er normaliserede)
 *   3. UPDATE ejf_ejerskab SET ejer_enheds_nummer = matched enhedsnummer
 *
 * Usage:
 *   node scripts/backfill-ejf-ejer-enheds-nummer.mjs [--limit=10000] [--dry-run]
 *
 * Kræver i .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * @retention Permanent — ingen ny PII, kun link mellem offentlige registre
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

config({ path: '.env.local' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith('--limit='));
const TOTAL_LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;
const DRY_RUN = args.includes('--dry-run');
const BATCH_SIZE = 500;

/**
 * Hent unikke person-navne fra ejf_ejerskab der mangler ejer_enheds_nummer.
 *
 * @param {number} offset - Offset for paginering
 * @param {number} limit - Batch størrelse
 * @returns {Promise<string[]>} Unikke navne
 */
async function fetchUnmatchedNames(offset, limit) {
  const { data, error } = await supabase
    .from('ejf_ejerskab')
    .select('ejer_navn')
    .eq('ejer_type', 'person')
    .is('ejer_enheds_nummer', null)
    .eq('status', 'gældende')
    .range(offset, offset + limit - 1);

  if (error) throw new Error(`Fetch fejl: ${error.message}`);
  // Dedup navne i denne batch
  return [...new Set((data ?? []).map((r) => r.ejer_navn))];
}

/**
 * Match navne mod cvr_deltager og returner Map<navn, enhedsNummer>.
 *
 * @param {string[]} navne - Person-navne at matche
 * @returns {Promise<Map<string, number>>} Matched navne → enhedsNummer
 */
async function matchNavneTilDeltager(navne) {
  if (navne.length === 0) return new Map();

  // Batch i chunks af 50 (PostgREST .in() limit)
  const result = new Map();
  for (let i = 0; i < navne.length; i += 50) {
    const chunk = navne.slice(i, i + 50);
    const { data, error } = await supabase
      .from('cvr_deltager')
      .select('enhedsnummer, navn')
      .in('navn', chunk);

    if (error) {
      console.warn(`Match-fejl for chunk ${i}: ${error.message}`);
      continue;
    }

    for (const row of data ?? []) {
      // Første match vinder (der kan være homonymer — acceptabelt for bulk)
      if (!result.has(row.navn)) {
        result.set(row.navn, row.enhedsnummer);
      }
    }
  }

  return result;
}

/**
 * Opdater ejf_ejerskab med matchede ejer_enheds_nummer.
 *
 * @param {string} navn - Person-navn
 * @param {number} enhedsNummer - Matched enhedsNummer
 * @returns {Promise<number>} Antal opdaterede rækker
 */
async function updateEjerskab(navn, enhedsNummer) {
  if (DRY_RUN) return 0;

  const { count, error } = await supabase
    .from('ejf_ejerskab')
    .update({ ejer_enheds_nummer: enhedsNummer })
    .eq('ejer_navn', navn)
    .eq('ejer_type', 'person')
    .is('ejer_enheds_nummer', null)
    .select('*', { count: 'exact', head: true });

  if (error) {
    console.warn(`Update fejl for "${navn}": ${error.message}`);
    return 0;
  }
  return count ?? 0;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`BIZZ-1273: Backfill ejer_enheds_nummer${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`Limit: ${TOTAL_LIMIT === Infinity ? 'unlimited' : TOTAL_LIMIT}`);

  let offset = 0;
  let totalMatched = 0;
  let totalUpdated = 0;
  let totalProcessed = 0;

  while (totalProcessed < TOTAL_LIMIT) {
    const batchLimit = Math.min(BATCH_SIZE, TOTAL_LIMIT - totalProcessed);
    const navne = await fetchUnmatchedNames(offset, batchLimit);

    if (navne.length === 0) {
      console.log('Ingen flere umatchede person-ejere.');
      break;
    }

    console.log(`Batch offset=${offset}: ${navne.length} unikke navne`);

    const matches = await matchNavneTilDeltager(navne);
    console.log(`  → ${matches.size}/${navne.length} matched i cvr_deltager`);

    for (const [navn, enhedsNummer] of matches) {
      const updated = await updateEjerskab(navn, enhedsNummer);
      totalUpdated += updated;
      totalMatched++;
    }

    totalProcessed += batchLimit;
    offset += batchLimit;

    // Kort pause for at undgå rate limiting
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log('\n── Resultat ──');
  console.log(`Processeret: ${totalProcessed} rækker`);
  console.log(`Matchede navne: ${totalMatched}`);
  console.log(`Opdaterede rækker: ${totalUpdated}`);
  if (DRY_RUN) console.log('(DRY RUN — ingen data ændret)');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
