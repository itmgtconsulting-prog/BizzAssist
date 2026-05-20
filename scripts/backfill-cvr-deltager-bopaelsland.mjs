#!/usr/bin/env node
/**
 * BIZZ-1566 Backfill 6: Populér cvr_deltager.bopaelsland fra CVR ES.
 *
 * Scroller CVR ES deltager-index og opdaterer bopaelsland-kolonne
 * for alle deltagere der har en beliggenhedsadresse med landekode.
 *
 * Usage:
 *   node scripts/backfill-cvr-deltager-bopaelsland.mjs [--env=prod|preview|dev] [--limit=10000] [--dry-run]
 *
 * Idempotent: UPDATE WHERE bopaelsland IS NULL.
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

config({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const CVR_ES_USER = process.env.CVR_ES_USER;
const CVR_ES_PASS = process.env.CVR_ES_PASS;
if (!CVR_ES_USER || !CVR_ES_PASS) { console.error('Missing CVR_ES_USER / CVR_ES_PASS'); process.exit(1); }
const CVR_AUTH = Buffer.from(`${CVR_ES_USER}:${CVR_ES_PASS}`).toString('base64');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = (() => { const a = args.find(x => x.startsWith('--limit=')); return a ? parseInt(a.split('=')[1], 10) : Infinity; })();
const TARGET_ENV = args.find((x) => x.startsWith('--env='))?.split('=')[1] || 'local';

const ENV_REFS = {
  local: 'wkzwxfhyfmvglrqtmebw',
  dev: 'wkzwxfhyfmvglrqtmebw',
  preview: 'rlkjmqjxmkxuclehbrnl',
  prod: 'xsyldjqcntiygrtfcszm',
};

/**
 * Resolve Supabase client.
 *
 * @returns {Promise<import('@supabase/supabase-js').SupabaseClient>}
 */
async function resolveClient() {
  if (TARGET_ENV === 'local' || TARGET_ENV === 'dev') {
    return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  const ref = ENV_REFS[TARGET_ENV];
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!ref || !token) { console.error('Missing env ref or SUPABASE_ACCESS_TOKEN'); process.exit(1); }
  const keysRes = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const keys = await keysRes.json();
  const sk = keys.find((k) => k.name === 'service_role')?.api_key;
  if (!sk) { console.error('service_role key not found'); process.exit(1); }
  return createClient(`https://${ref}.supabase.co`, sk);
}

/**
 * Finder gældende (åben) periode i et tidsbestemt array.
 *
 * @param arr - Array med periode-objekter
 * @returns Gældende element eller seneste
 */
function gyldigNu(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.find((x) => x.periode?.gyldigTil == null) ?? arr[arr.length - 1];
}

/**
 * Scroll CVR ES deltager-index og yield batches af {enhedsNummer, landekode}.
 *
 * @param batchSize - Antal hits per scroll
 */
async function* scrollDeltagere(batchSize = 2000) {
  const searchBody = {
    size: batchSize,
    _source: ['Vrdeltagerperson.enhedsNummer', 'Vrdeltagerperson.beliggenhedsadresse'],
    sort: [{ 'Vrdeltagerperson.enhedsNummer': 'asc' }],
    query: { match_all: {} },
  };

  let searchAfter = null;
  while (true) {
    const body = searchAfter
      ? { ...searchBody, search_after: searchAfter }
      : searchBody;

    const res = await fetch('http://distribution.virk.dk/cvr-permanent/deltager/_search', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${CVR_AUTH}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      console.error(`CVR ES error: ${res.status}`);
      break;
    }

    const data = await res.json();
    const hits = data.hits?.hits || [];
    if (hits.length === 0) break;

    const batch = [];
    for (const hit of hits) {
      const del = hit._source?.Vrdeltagerperson;
      if (!del?.enhedsNummer) continue;

      const adresser = Array.isArray(del.beliggenhedsadresse) ? del.beliggenhedsadresse : [];
      const adresse = gyldigNu(adresser);
      const landekode = adresse?.landekode || null;

      if (landekode) {
        batch.push({ enhedsNummer: del.enhedsNummer, landekode });
      }
    }

    yield batch;
    searchAfter = hits[hits.length - 1].sort;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Main. */
async function main() {
  console.log(`cvr_deltager bopaelsland backfill — env=${TARGET_ENV}, limit=${LIMIT === Infinity ? 'all' : LIMIT}, DRY=${DRY_RUN}`);

  const client = await resolveClient();
  let processed = 0;
  let updated = 0;
  let errors = 0;

  for await (const batch of scrollDeltagere()) {
    if (processed >= LIMIT) break;

    if (!DRY_RUN) {
      // Update in sub-batches of 50
      for (let i = 0; i < batch.length; i += 50) {
        const chunk = batch.slice(i, i + 50);
        // Group by landekode for efficient UPDATE
        const byLand = new Map();
        for (const { enhedsNummer, landekode } of chunk) {
          if (!byLand.has(landekode)) byLand.set(landekode, []);
          byLand.get(landekode).push(enhedsNummer);
        }

        for (const [land, ids] of byLand) {
          const { error } = await client
            .from('cvr_deltager')
            .update({ bopaelsland: land })
            .in('enhedsnummer', ids)
            .is('bopaelsland', null);

          if (error) {
            errors += ids.length;
            if (errors <= 10) console.error(`  Update error: ${error.message.slice(0, 100)}`);
          } else {
            updated += ids.length;
          }
        }
      }
    }

    processed += batch.length;
    if (processed % 10000 === 0 || batch.length < 1000) {
      console.log(`  processed=${processed}, updated=${updated}, errors=${errors}`);
    }
  }

  console.log(`\nDone! processed=${processed}, updated=${updated}, errors=${errors}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
