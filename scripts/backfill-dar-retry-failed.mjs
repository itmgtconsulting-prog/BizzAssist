#!/usr/bin/env node
/**
 * Genkør DAR cache backfill for kommuner der havde statement timeout fejl.
 * Bruger PostgREST via Supabase client med micro-batches (5 rækker) for at
 * undgå PROD statement timeout.
 *
 * Usage:
 *   node scripts/backfill-dar-retry-failed.mjs --env=prod [--skip-to=0316] [--dry-run]
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import crypto from 'crypto';
import path from 'node:path';
import url from 'node:url';

config({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const TARGET_ENV = args.find((x) => x.startsWith('--env='))?.split('=')[1] || 'local';
const SKIP_TO = args.find((x) => x.startsWith('--skip-to='))?.split('=')[1] || null;

const ENV_REFS = {
  local: 'wkzwxfhyfmvglrqtmebw',
  test: 'rlkjmqjxmkxuclehbrnl',
  prod: 'xsyldjqcntiygrtfcszm',
};

/**
 * Resolve Supabase client for target env.
 *
 * @returns {Promise<import('@supabase/supabase-js').SupabaseClient>}
 */
async function resolveClient() {
  if (TARGET_ENV === 'local') {
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

/** Kommuner der havde statement timeout fejl i DAR backfill 2026-05-15. */
const FAILED_KOMMUNER = [
  '0167','0169','0250','0260','0316','0326','0330','0360','0370','0390',
  '0400','0420','0450','0492','0550','0580','0607','0630','0657','0661',
  '0706','0707','0710','0727','0730','0740','0746','0751','0756','0760',
  '0766','0773','0779','0787','0791','0810','0813','0820','0840','0846',
  '0849','0851','0860',
];

const PAGE_SIZE = 500;
const UPSERT_BATCH = 5;

/**
 * Hent adgangsadresser fra DAWA med retry.
 *
 * @param kommune - Kommunekode
 * @param page - Side-nummer
 * @returns Array af adresser (tom = ingen flere)
 */
async function fetchDawaPage(kommune, page) {
  const params = new URLSearchParams({
    kommunekode: kommune, side: String(page), per_side: String(PAGE_SIZE),
    format: 'json', struktur: 'mini',
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://api.dataforsyningen.dk/adgangsadresser?${params}`, {
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 400) return []; // DAWA pagination cap (50 pages)
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt + 1) * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`DAWA ${res.status}`);
      return res.json();
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return [];
}

/**
 * Backfill én kommune.
 *
 * @param client - Supabase client
 * @param kommune - Kommunekode
 * @returns {{ cached: number, errors: number }}
 */
async function backfillKommune(client, kommune) {
  let page = 1;
  let cached = 0;
  let errors = 0;

  while (true) {
    const adresser = await fetchDawaPage(kommune, page);
    if (adresser.length === 0) break;

    const rows = adresser.map((adr) => ({
      adresse_id: adr.id,
      raw_data: adr,
      source_hash: crypto.createHash('sha256').update(JSON.stringify(adr)).digest('hex'),
      synced_at: new Date().toISOString(),
    }));

    if (!DRY_RUN) {
      for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
        const chunk = rows.slice(i, i + UPSERT_BATCH);
        const { error } = await client.from('cache_dar').upsert(chunk, { onConflict: 'adresse_id' });
        if (error) {
          errors += chunk.length;
          // Only log first few errors per kommune to avoid spam
          if (errors <= 20) console.error(`  ${kommune} p${page} [${i}]: ${error.message.slice(0, 80)}`);
        } else {
          cached += chunk.length;
        }
      }
    } else {
      cached += rows.length;
    }

    page++;
    await new Promise((r) => setTimeout(r, 150));
  }

  return { cached, errors };
}

/** Main. */
async function main() {
  const client = await resolveClient();
  console.log(`DAR retry (PostgREST batch=${UPSERT_BATCH}) for ${FAILED_KOMMUNER.length} kommuner — env=${TARGET_ENV}, DRY=${DRY_RUN}`);

  // Quick connectivity check (no count — too slow on 1.9M rows)
  const { data: check, error: cErr } = await client.from('cache_dar').select('adresse_id').limit(1);
  if (cErr) { console.error('DB check failed:', cErr.message); process.exit(1); }
  console.log(`DB connected, starting backfill...`);

  let totalCached = 0;
  let totalErrors = 0;
  let skipping = !!SKIP_TO;

  for (const kommune of FAILED_KOMMUNER) {
    if (skipping) {
      if (kommune === SKIP_TO) { skipping = false; } else { continue; }
    }
    const { cached, errors } = await backfillKommune(client, kommune);
    totalCached += cached;
    totalErrors += errors;
    console.log(`  kommune ${kommune}: cached=${cached}, errors=${errors}`);
  }

  console.log(`\nDone! cached=${totalCached}, errors=${totalErrors}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
