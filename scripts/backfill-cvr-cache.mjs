#!/usr/bin/env node
/**
 * BIZZ-916: Initial CVR virksomheds cache backfill via CVR ES.
 *
 * Henter virksomheder fra CVR Elasticsearch og gemmer i cache_cvr.
 * Bruger scroll-API for efficient batch-hentning.
 *
 * Usage:
 *   node scripts/backfill-cvr-cache.mjs [--limit=10000] [--dry-run]
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import crypto from 'crypto';

config({ path: '.env.local' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CVR_USER = process.env.CVR_ES_USER;
const CVR_PASS = process.env.CVR_ES_PASS;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}
if (!CVR_USER || !CVR_PASS) {
  console.error('Missing CVR_ES_USER or CVR_ES_PASS');
  process.exit(1);
}

const client = createClient(SUPABASE_URL, SUPABASE_KEY);
const cvrAuth = Buffer.from(`${CVR_USER}:${CVR_PASS}`).toString('base64');

const args = process.argv.slice(2);
const LIMIT = args.find((a) => a.startsWith('--limit='))
  ? parseInt(args.find((a) => a.startsWith('--limit=')).split('=')[1], 10)
  : Infinity;
const DRY_RUN = args.includes('--dry-run');

const BATCH_SIZE = 200;
const DELAY_MS = 200;

/**
 * Hent virksomheder fra CVR ES med scroll-API.
 */
async function fetchCvrBatch(scrollId) {
  const url = scrollId
    ? 'http://distribution.virk.dk/_search/scroll'
    : 'http://distribution.virk.dk/cvr-permanent/virksomhed/_search?scroll=5m';

  const body = scrollId
    ? JSON.stringify({ scroll: '5m', scroll_id: scrollId })
    : JSON.stringify({
        size: BATCH_SIZE,
        _source: [
          'Vrvirksomhed.cvrNummer',
          'Vrvirksomhed.virksomhedMetadata.nyesteNavn.navn',
          'Vrvirksomhed.virksomhedMetadata.nyesteHovedbranche',
          'Vrvirksomhed.virksomhedMetadata.nyesteStatus',
          'Vrvirksomhed.virksomhedMetadata.nyesteBeliggenhedsadresse',
        ],
        query: { match_all: {} },
        sort: [{ 'Vrvirksomhed.cvrNummer': 'asc' }],
      });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${cvrAuth}`,
    },
    body,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`CVR ES ${res.status}`);
  return res.json();
}

async function main() {
  console.log(`CVR Cache Backfill (LIMIT=${LIMIT === Infinity ? 'all' : LIMIT}, DRY=${DRY_RUN})`);

  let processed = 0;
  let cached = 0;
  let errors = 0;
  let scrollId = null;

  while (processed < LIMIT) {
    const result = await fetchCvrBatch(scrollId);
    scrollId = result._scroll_id;
    const hits = result.hits?.hits || [];
    if (hits.length === 0) break;

    const batch = [];
    for (const hit of hits) {
      if (processed >= LIMIT) break;
      const vrk = hit._source?.Vrvirksomhed;
      if (!vrk?.cvrNummer) { processed++; continue; }

      const compact = {
        cvr: vrk.cvrNummer,
        name: vrk.virksomhedMetadata?.nyesteNavn?.navn ?? null,
        branche: vrk.virksomhedMetadata?.nyesteHovedbranche?.branchetekst ?? null,
        status: vrk.virksomhedMetadata?.nyesteStatus?.status ?? null,
        adresse: vrk.virksomhedMetadata?.nyesteBeliggenhedsadresse ?? null,
      };

      const rawJson = JSON.stringify(compact);
      const hash = crypto.createHash('sha256').update(rawJson).digest('hex');
      batch.push({
        cvr_nummer: vrk.cvrNummer,
        raw_data: compact,
        source_hash: hash,
        synced_at: new Date().toISOString(),
      });
      processed++;
    }

    if (DRY_RUN) {
      console.log(`  DRY: ${batch.length} virksomheder (sample: CVR ${batch[0]?.cvr_nummer})`);
    } else if (batch.length > 0) {
      const { error } = await client.from('cache_cvr').upsert(batch, { onConflict: 'cvr_nummer' });
      if (error) {
        console.error(`  Upsert fejl:`, error.message);
        errors += batch.length;
      } else {
        cached += batch.length;
      }
    }

    if (processed % 5000 === 0) {
      console.log(`  processed=${processed}, cached=${cached}, errors=${errors}`);
    }

    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  if (!DRY_RUN) {
    await client.from('data_sync_status').upsert(
      {
        source_name: 'cvr',
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
