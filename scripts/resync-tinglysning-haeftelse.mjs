#!/usr/bin/env node
/**
 * BIZZ-1827: Batch re-sync tinglysning_haeftelse via PROD cron endpoint.
 *
 * Reads BFEs with NULL hovedstol_dkk from DB, then calls
 * /api/cron/sync-tinglysning-detail?bfes=X,Y,Z on PROD in batches.
 *
 * Usage:
 *   node scripts/resync-tinglysning-haeftelse.mjs [--limit=5000] [--batch=200] [--dry-run]
 */
import pg from 'pg';
import { config } from 'dotenv';
config({ path: '/root/BizzAssist/.env.local' });

const args = process.argv.slice(2);
const LIMIT = (() => { const a = args.find(x => x.startsWith('--limit=')); return a ? parseInt(a.split('=')[1], 10) : 10000; })();
const BATCH = (() => { const a = args.find(x => x.startsWith('--batch=')); return a ? parseInt(a.split('=')[1], 10) : 200; })();
const DRY_RUN = args.includes('--dry-run');

const CRON_SECRET = process.env.CRON_SECRET;
const PROD_URL = 'https://bizzassist.dk';

if (!CRON_SECRET) { console.error('Missing CRON_SECRET'); process.exit(1); }

const client = new pg.Client({ connectionString: process.env.SUPABASE_PROD_DB_URL, statement_timeout: 120000 });
await client.connect();

// Get BFEs needing re-sync
const { rows } = await client.query(`
  SELECT DISTINCT bfe_nummer FROM tinglysning_haeftelse
  WHERE hovedstol_dkk IS NULL
  ORDER BY bfe_nummer
  LIMIT $1
`, [LIMIT]);

console.log(`Found ${rows.length} BFEs needing re-sync, batch=${BATCH}`);
if (DRY_RUN) console.log('DRY RUN\n');

let batchNum = 0;
let totalOk = 0;
let totalErr = 0;
const startTime = Date.now();

for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH).map(r => r.bfe_nummer);
  batchNum++;

  if (DRY_RUN) {
    console.log(`  Batch ${batchNum}: ${batch.length} BFEs (${batch[0]}...${batch[batch.length - 1]})`);
    totalOk += batch.length;
    continue;
  }

  try {
    const url = `${PROD_URL}/api/cron/sync-tinglysning-detail?bfes=${batch.join(',')}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${CRON_SECRET}`,
        'x-vercel-cron': '1',
      },
      signal: AbortSignal.timeout(300000), // 5 min per batch
    });

    if (res.ok) {
      const data = await res.json();
      totalOk += batch.length;
      console.log(`  Batch ${batchNum}: ${batch.length} BFEs → ${res.status} haeftelser=${data.haeftelserUpserted || '?'}`);
    } else {
      totalErr += batch.length;
      console.log(`  Batch ${batchNum}: ${batch.length} BFEs → ERROR ${res.status}`);
    }
  } catch (e) {
    totalErr += batch.length;
    console.log(`  Batch ${batchNum}: ERROR ${e.message?.substring(0, 50)}`);
  }

  // Wait between batches to not overload Vercel
  await new Promise(r => setTimeout(r, 2000));

  if (batchNum % 10 === 0) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`  --- Progress: ${i + batch.length}/${rows.length} ok=${totalOk} err=${totalErr} (${elapsed}s) ---`);
  }
}

console.log(`\nDone! ok=${totalOk} err=${totalErr}`);

// Check remaining
const { rows: remaining } = await client.query("SELECT count(*) FROM tinglysning_haeftelse WHERE hovedstol_dkk IS NULL");
console.log(`Remaining NULL hovedstol: ${remaining[0].count}`);

await client.end();
