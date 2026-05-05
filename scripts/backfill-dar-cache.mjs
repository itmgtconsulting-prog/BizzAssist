#!/usr/bin/env node
/**
 * BIZZ-915: Initial DAR adresse cache backfill via DAWA API.
 *
 * Henter alle adgangsadresser fra DAWA og gemmer i cache_dar.
 * DAWA API er gratis og uautentificeret.
 *
 * Usage:
 *   node scripts/backfill-dar-cache.mjs [--limit=10000] [--kommune=0167] [--dry-run]
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import crypto from 'crypto';

config({ path: '.env.local' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

const client = createClient(SUPABASE_URL, SUPABASE_KEY);

const args = process.argv.slice(2);
const LIMIT = args.find((a) => a.startsWith('--limit='))
  ? parseInt(args.find((a) => a.startsWith('--limit=')).split('=')[1], 10)
  : Infinity;
const KOMMUNE = args.find((a) => a.startsWith('--kommune='))
  ? args.find((a) => a.startsWith('--kommune=')).split('=')[1]
  : null;
const DRY_RUN = args.includes('--dry-run');

const BATCH_SIZE = 500;
const DELAY_MS = 100;

/**
 * Hent adgangsadresser fra DAWA med pagination.
 */
async function fetchDawaPage(page) {
  const params = new URLSearchParams({
    side: String(page),
    per_side: String(BATCH_SIZE),
    format: 'json',
    struktur: 'mini',
  });
  if (KOMMUNE) params.set('kommunekode', KOMMUNE);

  const url = `https://api.dataforsyningen.dk/adgangsadresser?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`DAWA ${res.status}`);
  return res.json();
}

async function main() {
  console.log(
    `DAR Cache Backfill (LIMIT=${LIMIT === Infinity ? 'all' : LIMIT}, KOMMUNE=${KOMMUNE || 'alle'}, DRY=${DRY_RUN})`
  );

  let processed = 0;
  let cached = 0;
  let errors = 0;
  let page = 1;

  while (processed < LIMIT) {
    const adresser = await fetchDawaPage(page);
    if (adresser.length === 0) break;

    const batch = [];
    for (const adr of adresser) {
      if (processed >= LIMIT) break;
      const rawJson = JSON.stringify(adr);
      const hash = crypto.createHash('sha256').update(rawJson).digest('hex');
      batch.push({
        adresse_id: adr.id,
        raw_data: adr,
        source_hash: hash,
        synced_at: new Date().toISOString(),
      });
      processed++;
    }

    if (DRY_RUN) {
      console.log(`  DRY page ${page}: ${batch.length} adresser (sample: ${batch[0]?.adresse_id})`);
    } else {
      const { error } = await client.from('cache_dar').upsert(batch, { onConflict: 'adresse_id' });
      if (error) {
        console.error(`  Page ${page} upsert fejl:`, error.message);
        errors += batch.length;
      } else {
        cached += batch.length;
      }
    }

    if (processed % 5000 === 0) {
      console.log(`  processed=${processed}, cached=${cached}, errors=${errors}`);
    }

    page++;
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  if (!DRY_RUN) {
    await client.from('data_sync_status').upsert(
      {
        source_name: 'dar',
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
