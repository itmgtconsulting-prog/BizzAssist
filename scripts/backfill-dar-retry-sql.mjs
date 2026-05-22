#!/usr/bin/env node
/**
 * Retry DAR cache backfill for failed rows — uses Management API SQL
 * to bypass PostgREST statement timeout.
 *
 * Fetches from DAWA, upserts via direct SQL (no PostgREST timeout).
 *
 * Usage:
 *   node scripts/backfill-dar-retry-sql.mjs [--skip-to=0316] [--dry-run]
 */
import crypto from 'node:crypto';
import path from 'node:path';
import url from 'node:url';
import { config } from 'dotenv';

config({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SKIP_TO = args.find((x) => x.startsWith('--skip-to='))?.split('=')[1] || null;

const PROJECT_REF = 'xsyldjqcntiygrtfcszm'; // prod
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!ACCESS_TOKEN) { console.error('Missing SUPABASE_ACCESS_TOKEN'); process.exit(1); }

const PAGE_SIZE = 500;
const UPSERT_BATCH = 25; // Management API handles bigger batches

/** Kommuner der stadig har fejl efter retry-failed.mjs kørsel 2026-05-17. */
const FAILED_KOMMUNER = [
  '0167','0169','0250','0260','0316','0326','0330','0360','0370','0390',
  '0400','0420','0450','0492','0550','0580','0607','0630','0657','0661',
  '0706','0707','0710','0727','0730','0740','0746','0751','0756','0760',
  '0766','0773','0779','0787','0791','0810','0813','0820','0840','0846',
  '0849','0851','0860',
];

/**
 * Execute SQL via Supabase Management API (bypasses PostgREST timeout).
 *
 * @param {string} sql - SQL to execute
 * @returns {object} Parsed response
 */
async function execSql(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`SQL exec failed (${res.status}): ${txt.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Hent adgangsadresser fra DAWA.
 *
 * @param {string} kommune - Kommunekode
 * @param {number} page - Side-nummer
 * @returns {Promise<object[]>} Adresser
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
      if (res.status === 400) return [];
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
 * Escape a string for use in SQL.
 *
 * @param {string} str - Input
 * @returns {string} Escaped string
 */
function esc(str) {
  return str.replace(/'/g, "''");
}

/**
 * Upsert batch via Management API SQL.
 *
 * @param {object[]} rows - Rows to upsert
 * @returns {number} Number of errors
 */
async function upsertBatch(rows) {
  const values = rows.map((r) => {
    const json = esc(JSON.stringify(r.raw_data));
    return `('${r.adresse_id}', '${json}'::jsonb, '${r.source_hash}', now())`;
  }).join(',\n');

  const sql = `
    INSERT INTO public.cache_dar (adresse_id, raw_data, source_hash, synced_at)
    VALUES ${values}
    ON CONFLICT (adresse_id) DO UPDATE SET
      raw_data = EXCLUDED.raw_data,
      source_hash = EXCLUDED.source_hash,
      synced_at = EXCLUDED.synced_at;
  `;

  try {
    await execSql(sql);
    return 0;
  } catch (err) {
    console.error(`  SQL error: ${err.message.slice(0, 120)}`);
    return rows.length;
  }
}

/**
 * Find adresse_id'er der mangler i cache_dar for en kommune.
 *
 * @param {string} kommune - Kommunekode
 * @returns {Promise<Set<string>>} Set af cached adresse_id'er
 */
async function getCachedIds(kommune) {
  const result = await execSql(`
    SELECT adresse_id FROM public.cache_dar
    WHERE raw_data->>'kommunekode' = '${kommune}'
  `);
  const ids = new Set();
  if (Array.isArray(result)) {
    for (const row of result) ids.add(row.adresse_id);
  }
  return ids;
}

/**
 * Backfill én kommune — only missing rows.
 *
 * @param {string} kommune - Kommunekode
 * @returns {Promise<{cached: number, errors: number, skipped: number}>}
 */
async function backfillKommune(kommune) {
  // Get existing cached IDs for this kommune
  const existingIds = await getCachedIds(kommune);

  let page = 1;
  let cached = 0;
  let errors = 0;
  let skipped = 0;

  while (true) {
    const adresser = await fetchDawaPage(kommune, page);
    if (adresser.length === 0) break;

    // Filter to only missing ones
    const missing = adresser.filter((adr) => !existingIds.has(adr.id));
    skipped += adresser.length - missing.length;

    if (missing.length > 0) {
      const rows = missing.map((adr) => ({
        adresse_id: adr.id,
        raw_data: adr,
        source_hash: crypto.createHash('sha256').update(JSON.stringify(adr)).digest('hex'),
      }));

      if (!DRY_RUN) {
        for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
          const chunk = rows.slice(i, i + UPSERT_BATCH);
          const batchErrors = await upsertBatch(chunk);
          if (batchErrors > 0) errors += batchErrors;
          else cached += chunk.length;
          // Small delay to avoid Management API rate limit
          await new Promise((r) => setTimeout(r, 200));
        }
      } else {
        cached += rows.length;
      }
    }

    page++;
    await new Promise((r) => setTimeout(r, 100));
  }

  return { cached, errors, skipped };
}

/** Main. */
async function main() {
  console.log(`DAR retry via SQL (batch=${UPSERT_BATCH}) — ${FAILED_KOMMUNER.length} kommuner, DRY=${DRY_RUN}`);

  let totalCached = 0;
  let totalErrors = 0;
  let totalSkipped = 0;
  let skipping = !!SKIP_TO;

  for (const kommune of FAILED_KOMMUNER) {
    if (skipping) {
      if (kommune === SKIP_TO) { skipping = false; } else { continue; }
    }
    const { cached, errors, skipped } = await backfillKommune(kommune);
    totalCached += cached;
    totalErrors += errors;
    totalSkipped += skipped;
    console.log(`  kommune ${kommune}: cached=${cached}, errors=${errors}, skipped=${skipped}`);
  }

  console.log(`\nDone! cached=${totalCached}, errors=${totalErrors}, skipped=${totalSkipped}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
