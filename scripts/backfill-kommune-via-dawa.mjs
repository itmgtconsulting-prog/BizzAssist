#!/usr/bin/env node
/**
 * Backfill kommune_kode i bbr_ejendom_status via DAWA adgangsadresser.
 *
 * DAWA endpoint: /adgangsadresser?bfenummer=X&format=json&struktur=mini
 * Returnerer kommunekode for ejerlejligheder og andre BFE'er.
 *
 * Usage:
 *   node scripts/backfill-kommune-via-dawa.mjs [--limit=10000] [--batch=20] [--dry-run]
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

const SUPABASE_ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

const ENV_REFS = {
  dev: 'wkzwxfhyfmvglrqtmebw',
  preview: 'rlkjmqjxmkxuclehbrnl',
  prod: 'xsyldjqcntiygrtfcszm',
};

const envArg = process.argv.find((x) => x.startsWith('--env='))?.split('=')[1];
const PROJECT_REF = envArg
  ? ENV_REFS[envArg]
  : (process.env.NEXT_PUBLIC_SUPABASE_URL || '').match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1] || '';

if (!SUPABASE_ACCESS_TOKEN || !PROJECT_REF) {
  console.error('Missing SUPABASE_ACCESS_TOKEN or unknown --env. Use --env=dev|preview|prod');
  process.exit(1);
}

/** Execute SQL via Supabase Management API (bypasses PostgREST statement timeout). */
async function runSql(sql) {
  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return []; }
  } catch (err) {
    return { message: `runSql error: ${err.message}` };
  }
}

const args = process.argv.slice(2);
const LIMIT = (() => { const a = args.find(x => x.startsWith('--limit=')); return a ? parseInt(a.split('=')[1], 10) : 10000; })();
const BATCH_SIZE = (() => { const a = args.find(x => x.startsWith('--batch=')); return a ? parseInt(a.split('=')[1], 10) : 20; })();
const DRY_RUN = args.includes('--dry-run');

const START_CURSOR = (() => { const a = args.find(x => x.startsWith('--cursor=')); return a ? parseInt(a.split('=')[1], 10) : 0; })();
const DELAY_MS = 300;
const DAWA_TIMEOUT = 10000;

/**
 * Hent kommunekode fra DAWA for ét BFE-nummer via fetch.
 *
 * @param bfe - BFE-nummer
 * @returns kommunekode (string "0306") eller null
 */
async function fetchKommuneForBfe(bfe) {
  try {
    const res = await fetch(
      `https://api.dataforsyningen.dk/adgangsadresser?bfenummer=${bfe}&format=json&struktur=mini`,
      { signal: AbortSignal.timeout(DAWA_TIMEOUT) }
    );
    if (res.status === 429) return 'RATE_LIMITED';
    if (!res.ok) return null;
    const arr = await res.json();
    return Array.isArray(arr) && arr.length > 0 ? arr[0].kommunekode || null : null;
  } catch {
    return null;
  }
}

async function main() {
  console.log(`Kommune backfill via DAWA — limit=${LIMIT}, batch=${BATCH_SIZE}, dryRun=${DRY_RUN}`);

  let updated = 0;
  let notFound = 0;
  let errors = 0;
  let processed = 0;
  let cursor = START_CURSOR; // BFE cursor — use --cursor=199999 to skip ejerlejligheder

  while (processed < LIMIT) {
    // Hent batch af BFE'er med manglende kommune_kode via Management API
    const bfes = await runSql(
      `SELECT bfe_nummer FROM bbr_ejendom_status WHERE kommune_kode IS NULL AND bfe_nummer > ${cursor} ORDER BY bfe_nummer LIMIT ${BATCH_SIZE}`
    );

    if (!Array.isArray(bfes) || bfes.length === 0) { console.log('Ingen flere BFE\'er med manglende kommune_kode'); break; }

    cursor = bfes[bfes.length - 1].bfe_nummer;

    // Hent kommune for hver BFE parallelt (begrænset batch)
    const results = await Promise.all(bfes.map(b => fetchKommuneForBfe(b.bfe_nummer)));

    // Rate limit check
    if (results.includes('RATE_LIMITED')) {
      console.log('  DAWA rate limited — venter 10s');
      await new Promise(r => setTimeout(r, 10000));
      continue; // Retry same batch
    }

    // Batch update dem der har kommune
    const updates = [];
    for (let i = 0; i < bfes.length; i++) {
      processed++;
      const kommune = results[i];
      if (kommune && kommune !== 'RATE_LIMITED') {
        const kode = parseInt(kommune, 10);
        if (!isNaN(kode)) {
          updates.push({ bfe: bfes[i].bfe_nummer, kommune: kode });
        }
      } else {
        notFound++;
      }
    }

    if (updates.length > 0 && !DRY_RUN) {
      // Batch update via single SQL UPDATE with CASE
      const cases = updates.map(u => `WHEN ${u.bfe} THEN ${u.kommune}`).join(' ');
      const bfeList = updates.map(u => u.bfe).join(',');
      const sql = `UPDATE bbr_ejendom_status SET kommune_kode = CASE bfe_nummer ${cases} END WHERE bfe_nummer IN (${bfeList})`;
      const result = await runSql(sql);
      if (result?.message) {
        errors += updates.length;
        if (errors <= 5) console.error('  SQL error:', result.message.slice(0, 200));
      } else {
        updated += updates.length;
      }
    } else if (DRY_RUN) {
      updated += updates.length;
    }

    if (processed % 200 === 0 || updates.length > 0) {
      console.log(`  processed=${processed} updated=${updated} notFound=${notFound} errors=${errors} cursor=${cursor}`);
    }

    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log(`\nDone! processed=${processed} updated=${updated} notFound=${notFound} errors=${errors}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
