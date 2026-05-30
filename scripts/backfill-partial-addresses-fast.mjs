#!/usr/bin/env node
/**
 * BIZZ-1794: Fast parallel fix of partial addresses in bfe_adresse_cache.
 *
 * Runs N concurrent workers, each fetching a DAWA address by UUID.
 * DAWA has no published rate limit for single-ID lookups — they respond
 * in ~150ms. With 10 concurrent requests we get ~60/s throughput.
 *
 * Usage:
 *   node scripts/backfill-partial-addresses-fast.mjs [--limit=50000] [--concurrency=10] [--dry-run]
 */
import pg from 'pg';
import { config } from 'dotenv';
config({ path: '/root/BizzAssist/.env.local' });

const args = process.argv.slice(2);
const LIMIT = (() => { const a = args.find(x => x.startsWith('--limit=')); return a ? parseInt(a.split('=')[1], 10) : 500000; })();
const CONCURRENCY = (() => { const a = args.find(x => x.startsWith('--concurrency=')); return a ? parseInt(a.split('=')[1], 10) : 10; })();
const DRY_RUN = args.includes('--dry-run');

const pool = new pg.Pool({ connectionString: process.env.SUPABASE_PROD_DB_URL, max: CONCURRENCY + 2, statement_timeout: 120000 });
const initClient = await pool.connect();

let resolved = 0;
let failed = 0;
let idx = 0;

/**
 * Fetch and update one address.
 *
 * @param {{bfe_nummer: number, dawa_id: string}} row
 */
async function processOne(row) {
  try {
    const res = await fetch(`https://api.dataforsyningen.dk/adgangsadresser/${row.dawa_id}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) { failed++; return; }
    const data = await res.json();
    const vejnavn = data.vejstykke?.navn || '';
    const husnr = data.husnr || '';
    if (!vejnavn) { failed++; return; }

    const adresse = `${vejnavn} ${husnr}`.trim();
    const postnr = String(data.postnummer?.nr || '');
    const postnrnavn = data.postnummer?.navn || '';
    const kommune = data.kommune?.navn || '';
    const kommune_kode = String(data.kommune?.kode || '').padStart(4, '0');

    if (!postnr) { failed++; return; }

    if (!DRY_RUN) {
      const dbClient = await pool.connect();
      try {
        await dbClient.query(`
          UPDATE bfe_adresse_cache
          SET adresse = $2, postnr = $3, postnrnavn = $4, kommune = $5, kommune_kode = $6,
              kilde = 'backfill_partial_fix', sidst_opdateret = NOW()
          WHERE bfe_nummer = $1
        `, [row.bfe_nummer, adresse, postnr, postnrnavn, kommune, kommune_kode]);
      } finally { dbClient.release(); }
    }
    resolved++;
  } catch {
    failed++;
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

const { rows } = await initClient.query(`
  SELECT bfe_nummer, dawa_id
  FROM bfe_adresse_cache
  WHERE dawa_id IS NOT NULL
    AND (postnr IS NULL OR postnr = '')
  ORDER BY bfe_nummer
  LIMIT $1
`, [LIMIT]);

const total = rows.length;
console.log(`Found ${total} partial addresses, concurrency=${CONCURRENCY}`);
if (DRY_RUN) console.log('DRY RUN\n');

const startTime = Date.now();

// Process in parallel batches
while (idx < total) {
  const batch = rows.slice(idx, idx + CONCURRENCY);
  await Promise.all(batch.map(processOne));
  idx += batch.length;

  if (idx % 1000 === 0 || idx >= total) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rate = (idx / (elapsed || 1)).toFixed(1);
    console.log(`  [${idx}/${total}] resolved=${resolved} failed=${failed} ${rate}/s (${elapsed}s)`);
  }
}

console.log(`\nDone! resolved=${resolved} failed=${failed} (${((resolved / total) * 100).toFixed(1)}%)`);

initClient.release();
const { rows: stats } = await pool.query(`
  SELECT count(*) as total,
    count(CASE WHEN postnr IS NOT NULL AND postnr != '' THEN 1 END) as med_postnr
  FROM bfe_adresse_cache
`);
console.log(`bfe_adresse_cache: ${stats[0].med_postnr}/${stats[0].total} (${(stats[0].med_postnr / stats[0].total * 100).toFixed(1)}%)`);

await pool.end();
