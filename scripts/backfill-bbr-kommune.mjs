#!/usr/bin/env node
/**
 * BIZZ-1466 — Backfill kommune_kode i bbr_ejendom_status via BBR GraphQL
 *
 * Problem: 496K rækker mangler kommune_kode (lave BFE-numre, aldrig beriget).
 * Løsning: BBR_Grund GraphQL → bestemtFastEjendomBFENr → jordstykke →
 *          kommunekode. Batch 50 BFE'er per GraphQL-kald.
 *
 * Kører manuelt:
 *   node scripts/backfill-bbr-kommune.mjs [--limit=1000] [--dry-run] [--offset=0]
 *
 * Kører mod PROD Supabase (SUPABASE_URL fra .env.local).
 * Idempotent — sætter kun kommune_kode hvor den er NULL.
 *
 * Forventes at køre i 4-8 timer for alle 496K rækker.
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
const DF_API_KEY = process.env.DATAFORDELER_API_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
if (!DF_API_KEY) {
  console.error('Missing DATAFORDELER_API_KEY');
  process.exit(1);
}

const args = process.argv.slice(2);
const LIMIT = (() => {
  const a = args.find((x) => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : Infinity;
})();
const OFFSET = (() => {
  const a = args.find((x) => x.startsWith('--offset='));
  return a ? parseInt(a.split('=')[1], 10) : 0;
})();
const DRY_RUN = args.includes('--dry-run');

const client = createClient(SUPABASE_URL, SERVICE_ROLE);

const BBR_GQL_ENDPOINT =
  'https://services.datafordeler.dk/BBR/BBRPublic/1/rest/GraphQL/ejendom';

const BATCH_SIZE = 50;
const DELAY_MS = 500;

/**
 * Hent kommunekode for en batch BFE-numre via BBR_Grund GraphQL.
 *
 * @param {number[]} bfeNumre - BFE-numre at slå op
 * @returns {Map<number, number>} BFE → kommunekode
 */
async function fetchKommuneForBatch(bfeNumre) {
  const query = `query($vt: DafDateTime!, $bfes: [Int!]!) {
    BBR_Grund(first: 500, virkningstid: $vt, where: { bestemtFastEjendomBFENr: { in: $bfes } }) {
      nodes {
        bestemtFastEjendomBFENr
        jordstykke {
          jordstykke {
            nodes {
              kommunekode
            }
          }
        }
      }
    }
  }`;

  const vt = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
  const res = await fetch(`${BBR_GQL_ENDPOINT}?apiKey=${DF_API_KEY}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query, variables: { vt, bfes: bfeNumre } }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    console.error(`  [bbr] HTTP ${res.status} for batch ${bfeNumre.slice(0, 3)}...`);
    return new Map();
  }

  const json = await res.json();
  if (json.errors) {
    console.error('  [bbr] GraphQL errors:', JSON.stringify(json.errors).slice(0, 200));
    return new Map();
  }

  const grunde = json.data?.BBR_Grund?.nodes ?? [];
  /** @type {Map<number, number>} */
  const result = new Map();

  for (const g of grunde) {
    const bfe = Number(g.bestemtFastEjendomBFENr);
    if (!Number.isFinite(bfe)) continue;

    // Udlæs kommunekode fra jordstykke
    const jordstykker = (g.jordstykke ?? [])
      .flatMap((j) => j?.jordstykke?.nodes ?? []);
    for (const j of jordstykker) {
      const kk = Number(j?.kommunekode);
      if (Number.isFinite(kk) && kk > 0) {
        result.set(bfe, kk);
        break;
      }
    }
  }
  return result;
}

/** Sleep utility. */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Main ──
async function main() {
  console.log(`Backfill kommune_kode — limit=${LIMIT}, offset=${OFFSET}, dryRun=${DRY_RUN}`);

  let processed = 0;
  let updated = 0;
  let notFound = 0;
  let errors = 0;
  let page = 0;
  const PAGE_SIZE = 1000;

  while (processed < LIMIT) {
    // Hent BFE'er der mangler kommune_kode
    const { data: rows, error: fetchErr } = await client
      .from('bbr_ejendom_status')
      .select('bfe_nummer')
      .is('kommune_kode', null)
      .eq('is_udfaset', false)
      .order('bfe_nummer', { ascending: true })
      .range(OFFSET + page * PAGE_SIZE, OFFSET + (page + 1) * PAGE_SIZE - 1);

    if (fetchErr) {
      console.error('DB fetch error:', fetchErr.message);
      break;
    }
    if (!rows || rows.length === 0) {
      console.log('No more rows with NULL kommune_kode');
      break;
    }

    const bfes = rows.map((r) => r.bfe_nummer);
    console.log(`\nPage ${page}: ${bfes.length} BFE'er (first=${bfes[0]}, last=${bfes[bfes.length - 1]})`);

    // Process i batches af BATCH_SIZE
    for (let i = 0; i < bfes.length && processed < LIMIT; i += BATCH_SIZE) {
      const batch = bfes.slice(i, Math.min(i + BATCH_SIZE, bfes.length));
      const kommuneMap = await fetchKommuneForBatch(batch);

      for (const bfe of batch) {
        processed++;
        const kk = kommuneMap.get(bfe);
        if (!kk) {
          notFound++;
          continue;
        }

        if (DRY_RUN) {
          console.log(`  [dry] BFE ${bfe} → kommune ${kk}`);
          updated++;
          continue;
        }

        const { error: upErr } = await client
          .from('bbr_ejendom_status')
          .update({ kommune_kode: kk })
          .eq('bfe_nummer', bfe);

        if (upErr) {
          errors++;
          if (errors <= 5) console.error(`  UPDATE error BFE ${bfe}:`, upErr.message);
        } else {
          updated++;
        }
      }

      const pct = LIMIT === Infinity ? '' : ` (${((processed / LIMIT) * 100).toFixed(1)}%)`;
      process.stdout.write(
        `\r  processed=${processed}${pct} updated=${updated} notFound=${notFound} errors=${errors}`
      );

      await sleep(DELAY_MS);
    }

    // Hvis vi fik færre end PAGE_SIZE er vi færdige
    if (rows.length < PAGE_SIZE) break;
    page++;
  }

  console.log(`\n\nDone! processed=${processed} updated=${updated} notFound=${notFound} errors=${errors}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
