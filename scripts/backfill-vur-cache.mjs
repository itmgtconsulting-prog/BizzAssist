#!/usr/bin/env node
/**
 * BIZZ-917: Initial VUR vurdering cache backfill via Datafordeler GraphQL.
 *
 * Henter ejendomsvurderinger for BFE-numre og gemmer i cache_vur.
 * Bruger BFEKrydsreference → Ejendomsvurdering GraphQL queries.
 *
 * Usage:
 *   node scripts/backfill-vur-cache.mjs [--limit=1000] [--dry-run]
 *
 * Forudsætninger:
 *   - DATAFORDELER_USER + DATAFORDELER_PASS i .env.local
 *   - Migration 082 (cache_vur tabel) applied
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import crypto from 'crypto';

config({ path: '.env.local' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DF_USER = process.env.DATAFORDELER_USER;
const DF_PASS = process.env.DATAFORDELER_PASS;

if (!SUPABASE_URL || !SUPABASE_KEY || !DF_USER || !DF_PASS) {
  console.error('Missing credentials');
  process.exit(1);
}

const client = createClient(SUPABASE_URL, SUPABASE_KEY);
const dfAuth = Buffer.from(`${DF_USER}:${DF_PASS}`).toString('base64');

const args = process.argv.slice(2);
const LIMIT = args.find((a) => a.startsWith('--limit='))
  ? parseInt(args.find((a) => a.startsWith('--limit=')).split('=')[1], 10)
  : Infinity;
const DRY_RUN = args.includes('--dry-run');

const BATCH_SIZE = 50;
const DELAY_MS = 300;
const VUR_GRAPHQL = 'https://graphql.datafordeler.dk/VUR/v2';

/**
 * Hent vurderinger for et BFE-nummer.
 */
async function fetchVur(bfe) {
  // Step 1: Krydsreference
  const krydsQuery = `{ VUR_BFEKrydsreference(first: 100, where: { BFEnummer: { eq: ${bfe} } }) { nodes { fkEjendomsvurderingID } } }`;
  const krydsRes = await fetch(VUR_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${dfAuth}` },
    body: JSON.stringify({ query: krydsQuery }),
    signal: AbortSignal.timeout(15000),
  });
  if (!krydsRes.ok) return null;
  const krydsData = await krydsRes.json();
  const vurIds = (krydsData.data?.VUR_BFEKrydsreference?.nodes || []).map((n) => n.fkEjendomsvurderingID).filter(Boolean);
  if (vurIds.length === 0) return { bfe, vurderinger: [] };

  // Step 2: Vurderinger
  const ids = vurIds.map((id) => `"${id}"`).join(',');
  const vurQuery = `{ VUR_Ejendomsvurdering(first: 100, where: { id: { in: [${ids}] } }) { nodes { id aar ejendomvaerdiBeloeb grundvaerdiBeloeb vurderetAreal benyttelseKode juridiskKategoriTekst } } }`;
  const vurRes = await fetch(VUR_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${dfAuth}` },
    body: JSON.stringify({ query: vurQuery }),
    signal: AbortSignal.timeout(15000),
  });
  if (!vurRes.ok) return null;
  const vurData = await vurRes.json();
  return {
    bfe,
    vurderinger: vurData.data?.VUR_Ejendomsvurdering?.nodes || [],
  };
}

/**
 * Hent BFE-numre der endnu ikke er cached.
 */
async function getUncachedBfes(offset, limit) {
  // Hent fra ejendomme der har BFE — brug bbr_berigelse eller ejerskab
  const { data, error } = await client
    .rpc('get_uncached_vur_bfes', { p_offset: offset, p_limit: limit })
    .catch(() => ({ data: null, error: { message: 'RPC not available' } }));

  if (error || !data) {
    // Fallback: hent fra cache_bbr (allerede cached BBR BFE'er)
    const { data: bbrData } = await client
      .from('cache_bbr')
      .select('bfe_nummer')
      .order('bfe_nummer')
      .range(offset, offset + limit - 1);
    return (bbrData || []).map((r) => r.bfe_nummer);
  }
  return data.map((r) => r.bfe_nummer);
}

async function main() {
  console.log(`VUR Cache Backfill (LIMIT=${LIMIT === Infinity ? 'all' : LIMIT}, DRY=${DRY_RUN})`);

  let processed = 0;
  let cached = 0;
  let errors = 0;
  let offset = 0;

  while (processed < LIMIT) {
    const bfes = await getUncachedBfes(offset, BATCH_SIZE);
    if (bfes.length === 0) break;

    for (const bfe of bfes) {
      if (processed >= LIMIT) break;
      try {
        const data = await fetchVur(bfe);
        if (DRY_RUN) {
          console.log(`  DRY: BFE ${bfe} → ${(data?.vurderinger || []).length} vurderinger`);
        } else if (data) {
          const rawJson = JSON.stringify(data);
          const hash = crypto.createHash('sha256').update(rawJson).digest('hex');
          const { error } = await client.from('cache_vur').upsert(
            { bfe_nummer: bfe, raw_data: data, source_hash: hash, synced_at: new Date().toISOString() },
            { onConflict: 'bfe_nummer' }
          );
          if (error) errors++;
          else cached++;
        }
        processed++;
      } catch (err) {
        errors++;
        processed++;
      }
      if (processed % 200 === 0) {
        console.log(`  processed=${processed}, cached=${cached}, errors=${errors}`);
      }
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
    offset += BATCH_SIZE;
  }

  if (!DRY_RUN) {
    await client.from('data_sync_status').upsert(
      { source_name: 'vur', last_sync_at: new Date().toISOString(), rows_synced: cached, updated_at: new Date().toISOString() },
      { onConflict: 'source_name' }
    );
  }

  console.log(`\nDone. processed=${processed}, cached=${cached}, errors=${errors}`);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
