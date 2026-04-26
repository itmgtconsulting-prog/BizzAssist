#!/usr/bin/env node
/**
 * BIZZ-914: Initial BBR cache backfill via Datafordeler GraphQL.
 *
 * Henter alle BBR bygninger i batch via BFE-nummre og gemmer i cache_bbr.
 * Kører paginated og throttled for at undgå rate-limits.
 *
 * Usage:
 *   node scripts/backfill-bbr-cache.mjs [--limit=1000] [--offset=0] [--dry-run]
 *
 * Forudsætninger:
 *   - DATAFORDELER_USER + DATAFORDELER_PASS i .env.local
 *   - SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY i .env.local
 *   - Migration 082 (cache_bbr tabel) applied
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import crypto from 'crypto';

config({ path: '.env.local' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DF_USER = process.env.DATAFORDELER_USER;
const DF_PASS = process.env.DATAFORDELER_PASS;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
if (!DF_USER || !DF_PASS) {
  console.error('Missing DATAFORDELER_USER or DATAFORDELER_PASS');
  process.exit(1);
}

const client = createClient(SUPABASE_URL, SUPABASE_KEY);

const args = process.argv.slice(2);
const LIMIT = args.find((a) => a.startsWith('--limit='))
  ? parseInt(args.find((a) => a.startsWith('--limit=')).split('=')[1], 10)
  : Infinity;
const OFFSET = args.find((a) => a.startsWith('--offset='))
  ? parseInt(args.find((a) => a.startsWith('--offset=')).split('=')[1], 10)
  : 0;
const DRY_RUN = args.includes('--dry-run');

const BATCH_SIZE = 100;
const DELAY_MS = 200;

const BBR_GRAPHQL = 'https://graphql.datafordeler.dk/BBR/v2';
const auth = Buffer.from(`${DF_USER}:${DF_PASS}`).toString('base64');

/**
 * Hent BBR data for et enkelt BFE-nummer via GraphQL.
 */
async function fetchBBR(bfeNummer) {
  const query = `{
    BBR_Bygning(first: 10, where: { ejerlejlighed: { bfeNummer: { eq: ${bfeNummer} } } }) {
      nodes { id opførelsesÅr samletBygningsAreal bygningensAnvendelse tagdækningsMateriale ydervæggensMateriale varmeinstallation }
    }
  }`;
  const res = await fetch(BBR_GRAPHQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  return res.json();
}

/**
 * Hent BFE-numre fra ejendommme i Supabase (fra eksisterende data).
 */
async function getBfeNumbers(offset, limit) {
  // Hent fra cache_vur eller ejendomme-data der allerede har BFE'er
  const { data, error } = await client
    .from('cache_vur')
    .select('bfe_nummer')
    .order('bfe_nummer', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error || !data) return [];
  return data.map((r) => r.bfe_nummer);
}

async function main() {
  console.log(
    `BBR Cache Backfill (LIMIT=${LIMIT === Infinity ? 'all' : LIMIT}, OFFSET=${OFFSET}, DRY=${DRY_RUN})`
  );

  let processed = 0;
  let cached = 0;
  let errors = 0;
  let offset = OFFSET;

  while (processed < LIMIT) {
    const bfes = await getBfeNumbers(offset, BATCH_SIZE);
    if (bfes.length === 0) {
      console.log('  Ingen flere BFE-numre.');
      break;
    }

    for (const bfe of bfes) {
      if (processed >= LIMIT) break;
      try {
        const data = await fetchBBR(bfe);
        if (DRY_RUN) {
          console.log(`  DRY: BFE ${bfe} → ${JSON.stringify(data).slice(0, 100)}`);
        } else if (data) {
          const rawJson = JSON.stringify(data);
          const hash = crypto.createHash('sha256').update(rawJson).digest('hex');
          const { error } = await client.from('cache_bbr').upsert(
            {
              bfe_nummer: bfe,
              raw_data: data,
              source_hash: hash,
              synced_at: new Date().toISOString(),
            },
            { onConflict: 'bfe_nummer' }
          );
          if (error) errors++;
          else cached++;
        }
        processed++;
        if (processed % 500 === 0) {
          console.log(`  processed=${processed}, cached=${cached}, errors=${errors}`);
        }
      } catch (err) {
        errors++;
        processed++;
      }
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }

    offset += BATCH_SIZE;
  }

  // Update sync status
  if (!DRY_RUN) {
    await client.from('data_sync_status').upsert(
      {
        source_name: 'bbr',
        last_sync_at: new Date().toISOString(),
        last_success: errors === 0 ? new Date().toISOString() : undefined,
        rows_synced: cached,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'source_name' }
    );
  }

  console.log(`\nDone. processed=${processed}, cached=${cached}, errors=${errors}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
