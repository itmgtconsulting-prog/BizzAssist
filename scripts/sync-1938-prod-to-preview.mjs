#!/usr/bin/env node
/**
 * BIZZ-1938 PROD → PREVIEW sync for cvr_deltagerrelation april+maj 2026 vinduet.
 *
 * Strategy: direct pg-to-pg copy via batch SELECT/INSERT (cleaner end faster end
 * Supabase Management API for 6M+ rows). Med ON CONFLICT DO UPDATE så vi
 * matcher PROD's nuværende state.
 *
 * Efter sync: REFRESH MATERIALIZED VIEW mv_virksomhedshandel_kandidater på preview.
 *
 * Usage:
 *   node scripts/sync-1938-prod-to-preview.mjs [--batch=5000] [--since=2026-04-01] [--until=2026-06-01]
 */
import fs from 'fs';
import pg from 'pg';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true']; }));
const BATCH = parseInt(args.batch || '5000', 10);
const SINCE = args.since || '2026-04-01';
const UNTIL = args.until || '2026-06-01';
const SKIP_REFRESH = args['skip-refresh'] === 'true' || args['skip-refresh'] === true;

const env = fs.readFileSync('/root/BizzAssist/.env.local', 'utf8');
const PROD = env.match(/^SUPABASE_PROD_DB_URL=(.+)$/m)?.[1];
const PREVIEW = env.match(/^SUPABASE_PREVIEW_DB_URL=(.+)$/m)?.[1];
if (!PROD || !PREVIEW) { console.error('Missing PROD or PREVIEW DB URL'); process.exit(1); }

const prod = new pg.Client({ connectionString: PROD });
const preview = new pg.Client({ connectionString: PREVIEW });
await prod.connect();
await preview.connect();

console.log(`[sync-1938] window: ${SINCE} → ${UNTIL}, batch=${BATCH}`);

// Step 1: count source rows
console.time('[sync-1938] count source');
const { rows: [{ count }] } = await prod.query(
  "SELECT COUNT(*) FROM cvr_deltagerrelation WHERE sidst_opdateret BETWEEN $1 AND $2",
  [SINCE, UNTIL]
);
console.timeEnd('[sync-1938] count source');
console.log(`[sync-1938] PROD source rows: ${count}`);

// Step 2: identify unique virksomhed_cvr in source — vi deleter ALLE matchende preview-rows
// for de cvr+type='register' kombinationer, så preview matcher PROD's nye periode-struktur.
console.time('[sync-1938] gather distinct virksomhed_cvr');
const { rows: cvrRows } = await prod.query(
  "SELECT DISTINCT virksomhed_cvr FROM cvr_deltagerrelation WHERE sidst_opdateret BETWEEN $1 AND $2",
  [SINCE, UNTIL]
);
console.timeEnd('[sync-1938] gather distinct virksomhed_cvr');
const cvrs = cvrRows.map(r => r.virksomhed_cvr);
console.log(`[sync-1938] distinct virksomhed_cvr: ${cvrs.length}`);

// Step 3: DELETE existing register-rows på preview for disse CVR'er (matcher 1938 backfill strategi)
// Vi rører IKKE non-register rows, så bestyrelse/direktion/etc. forbliver intakte.
console.log('[sync-1938] DELETE existing register-rows on preview (chunked)...');
const DELETE_CHUNK = 5000;
let deleted = 0;
console.time('[sync-1938] preview DELETE register-rows');
for (let i = 0; i < cvrs.length; i += DELETE_CHUNK) {
  const chunk = cvrs.slice(i, i + DELETE_CHUNK);
  const res = await preview.query(
    "DELETE FROM cvr_deltagerrelation WHERE virksomhed_cvr = ANY($1::text[]) AND type='register'",
    [chunk]
  );
  deleted += res.rowCount;
  if (i % 50000 === 0) console.log(`  ... deleted ${deleted} so far (${i}/${cvrs.length} cvrs processed)`);
}
console.timeEnd('[sync-1938] preview DELETE register-rows');
console.log(`[sync-1938] deleted ${deleted} preview register-rows`);

// Step 4: COPY new rows from PROD in batches with INSERT ON CONFLICT DO UPDATE
// for non-register rows (de er ikke deleted) får ON CONFLICT effekt.
console.log('[sync-1938] copying PROD → preview...');
let offset = 0;
let inserted = 0;
const startCopy = Date.now();
const COLS = ['virksomhed_cvr','deltager_enhedsnummer','type','gyldig_fra','gyldig_til','ejerandel_pct','sidst_opdateret','sidst_hentet_fra_cvr','ejer_cvr'];
while (offset < parseInt(count, 10)) {
  const { rows } = await prod.query(`
    SELECT ${COLS.join(',')}
    FROM cvr_deltagerrelation
    WHERE sidst_opdateret BETWEEN $1 AND $2
    ORDER BY virksomhed_cvr, deltager_enhedsnummer, type, gyldig_fra
    OFFSET $3 LIMIT $4
  `, [SINCE, UNTIL, offset, BATCH]);
  if (rows.length === 0) break;
  const placeholders = [];
  const params = [];
  let p = 1;
  for (const r of rows) {
    placeholders.push(`(${COLS.map(() => `$${p++}`).join(',')})`);
    for (const col of COLS) params.push(r[col]);
  }
  await preview.query(
    `INSERT INTO cvr_deltagerrelation (${COLS.join(',')})
     VALUES ${placeholders.join(',')}
     ON CONFLICT (virksomhed_cvr, deltager_enhedsnummer, type, gyldig_fra) DO UPDATE SET
       gyldig_til = EXCLUDED.gyldig_til,
       ejerandel_pct = EXCLUDED.ejerandel_pct,
       sidst_opdateret = EXCLUDED.sidst_opdateret,
       sidst_hentet_fra_cvr = EXCLUDED.sidst_hentet_fra_cvr,
       ejer_cvr = COALESCE(EXCLUDED.ejer_cvr, cvr_deltagerrelation.ejer_cvr)`,
    params
  );
  inserted += rows.length;
  offset += rows.length;
  if (offset % 50000 === 0 || offset === parseInt(count, 10)) {
    const el = (Date.now() - startCopy) / 1000;
    const rate = inserted / el;
    const eta = (parseInt(count, 10) - offset) / rate;
    console.log(`  ${offset}/${count} (${(offset/count*100).toFixed(1)}%) rate=${rate.toFixed(0)}/s eta=${(eta/60).toFixed(0)}min`);
  }
}
console.log(`[sync-1938] inserted/upserted ${inserted} rows`);

// Step 5: REFRESH MV på preview
if (!SKIP_REFRESH) {
  console.log('[sync-1938] REFRESH MATERIALIZED VIEW mv_virksomhedshandel_kandidater on preview...');
  console.time('[sync-1938] preview MV refresh');
  try {
    await preview.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_virksomhedshandel_kandidater');
    console.log('[sync-1938] MV refreshed CONCURRENTLY');
  } catch (e) {
    console.log('[sync-1938] CONCURRENTLY fail:', e.message, '— retry without');
    await preview.query('REFRESH MATERIALIZED VIEW mv_virksomhedshandel_kandidater');
    console.log('[sync-1938] MV refreshed');
  }
  console.timeEnd('[sync-1938] preview MV refresh');
}

// Step 6: verify signal counts
console.log('\n[sync-1938] verifying M&A signals on preview MV...');
for (const env of [['PROD', prod], ['PREVIEW', preview]]) {
  const [name, client] = env;
  try {
    const r = await client.query(`
      SELECT signal_type, COUNT(*) as n FROM mv_virksomhedshandel_kandidater
      GROUP BY signal_type ORDER BY n DESC
    `);
    console.log(` ${name} signals:`);
    for (const x of r.rows) console.log(`  ${x.signal_type}: ${x.n}`);
  } catch (e) {
    console.log(` ${name} signal query failed: ${e.message}`);
  }
}

await prod.end();
await preview.end();
console.log('\n[sync-1938] DONE');
