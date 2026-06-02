#!/usr/bin/env node
/**
 * Foreløbig sync af regnskab_cache PROD → PREVIEW.
 * Kun v7-rows (BIZZ-1936 backfilled) — øvrige rows er ældre cached versions.
 */
import fs from 'fs';
import pg from 'pg';

const env = fs.readFileSync('/root/BizzAssist/.env.local', 'utf8');
const PROD = env.match(/^SUPABASE_PROD_DB_URL=(.+)$/m)?.[1];
const PREVIEW = env.match(/^SUPABASE_PREVIEW_DB_URL=(.+)$/m)?.[1];
const BATCH = parseInt(process.env.BATCH || '500', 10);

const prod = new pg.Client({ connectionString: PROD });
const preview = new pg.Client({ connectionString: PREVIEW });
await prod.connect(); await preview.connect();

const { rows: [{ count }] } = await prod.query("SELECT COUNT(*) FROM regnskab_cache WHERE es_timestamp LIKE '%_v7'");
console.log(`PROD v7-cached regnskab rows: ${count}, batch=${BATCH}`);

let offset = 0;
let inserted = 0;
const start = Date.now();
while (offset < parseInt(count, 10)) {
  const { rows } = await prod.query(`
    SELECT cvr, years, es_timestamp, fetched_at FROM regnskab_cache
    WHERE es_timestamp LIKE '%_v7'
    ORDER BY cvr OFFSET $1 LIMIT $2
  `, [offset, BATCH]);
  if (rows.length === 0) break;
  const placeholders = [];
  const params = [];
  let p = 1;
  for (const r of rows) {
    placeholders.push(`($${p++},$${p++}::jsonb,$${p++},$${p++})`);
    params.push(r.cvr, JSON.stringify(r.years), r.es_timestamp, r.fetched_at);
  }
  await preview.query(`
    INSERT INTO regnskab_cache (cvr, years, es_timestamp, fetched_at)
    VALUES ${placeholders.join(',')}
    ON CONFLICT (cvr) DO UPDATE SET
      years = EXCLUDED.years,
      es_timestamp = EXCLUDED.es_timestamp,
      fetched_at = EXCLUDED.fetched_at
  `, params);
  inserted += rows.length;
  offset += rows.length;
  if (offset % 5000 === 0 || offset === parseInt(count, 10)) {
    const el = (Date.now() - start) / 1000;
    console.log(`  ${offset}/${count} (${(offset/count*100).toFixed(1)}%) rate=${(inserted/el).toFixed(0)}/s`);
  }
}

const { rows: [{ count: pCount }] } = await preview.query("SELECT COUNT(*) FROM regnskab_cache WHERE es_timestamp LIKE '%_v7'");
console.log(`\nPREVIEW v7-cached rows after sync: ${pCount}`);
await prod.end(); await preview.end();
console.log('DONE');
