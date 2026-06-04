#!/usr/bin/env node
/**
 * Fast sync between Supabase envs via direct PostgreSQL connections.
 * 10-50x faster than Management API sync.
 *
 * Usage:
 *   node scripts/sync-pg-direct.mjs --from=prod --to=preview [--table=ejf_ejerskifte] [--all] [--batch=5000]
 */
import pg from 'pg';
import { config } from 'dotenv';
config({ path: '.env.local' });

const args = process.argv.slice(2);
const FROM_ENV = args.find(x => x.startsWith('--from='))?.split('=')[1] || 'prod';
const TO_ENV = args.find(x => x.startsWith('--to='))?.split('=')[1];
const TABLE_ARG = args.find(x => x.startsWith('--table='))?.split('=')[1];
const SYNC_ALL = args.includes('--all');
const BATCH_SIZE = (() => { const a = args.find(x => x.startsWith('--batch=')); return a ? parseInt(a.split('=')[1], 10) : 5000; })();

const DB_URLS = {
  prod: process.env.SUPABASE_PROD_DB_URL,
  preview: process.env.SUPABASE_PREVIEW_DB_URL,
  dev: process.env.SUPABASE_DEV_DB_URL,
};

if (!TO_ENV || !DB_URLS[FROM_ENV] || !DB_URLS[TO_ENV]) {
  console.error('Usage: --from=prod --to=preview|dev --table=name|--all');
  console.error('Available envs:', Object.keys(DB_URLS).filter(k => DB_URLS[k]).join(', '));
  process.exit(1);
}
if (!TABLE_ARG && !SYNC_ALL) { console.error('Specify --table=name or --all'); process.exit(1); }

const TABLE_DEFS = {
  ejf_ejerskifte: { pk: 'id_lokal_id', orderBy: 'bfe_nummer, id_lokal_id', conflict: 'ON CONFLICT (id_lokal_id) DO NOTHING' },
  ejf_handelsoplysninger: { pk: 'id_lokal_id', orderBy: 'id_lokal_id', conflict: 'ON CONFLICT (id_lokal_id) DO NOTHING' },
  ejf_administrator: { pk: 'id_lokal_id', orderBy: 'id_lokal_id', conflict: 'ON CONFLICT (id_lokal_id) DO NOTHING' },
  ejendomshandel: { pk: 'id', orderBy: 'bfe_nummer, id', conflict: 'ON CONFLICT DO NOTHING' },
  tinglysning_haeftelse: { pk: 'id', orderBy: 'bfe_nummer, id', conflict: 'ON CONFLICT (bfe_nummer, prioritet, status) DO NOTHING' },
  tinglysning_servitut: { pk: 'id', orderBy: 'bfe_nummer, id', conflict: 'ON CONFLICT DO NOTHING' },
  bbr_ejendom_status: { pk: 'bfe_nummer', orderBy: 'bfe_nummer', conflict: 'ON CONFLICT (bfe_nummer) DO NOTHING' },
  bfe_adresse_cache: { pk: 'bfe_nummer', orderBy: 'bfe_nummer', conflict: 'ON CONFLICT (bfe_nummer) DO NOTHING' },
  cvr_virksomhed_ejerskab: { pk: 'ejer_cvr,ejet_cvr', orderBy: 'ejer_cvr, ejet_cvr', conflict: 'ON CONFLICT (ejer_cvr, ejet_cvr) DO NOTHING' },
  ejerskifte_historik: { pk: 'id', orderBy: 'id', conflict: 'ON CONFLICT DO NOTHING' },
  vurdering_cache: { pk: 'bfe_nummer', orderBy: 'bfe_nummer', conflict: 'ON CONFLICT (bfe_nummer) DO NOTHING' },
  kommune_ref: { pk: 'kommune_kode', orderBy: 'kommune_kode', conflict: 'ON CONFLICT (kommune_kode) DO NOTHING' },
  ejf_ejerskab: { pk: 'bfe_nummer,ejer_ejf_id,virkning_fra', orderBy: 'bfe_nummer, ejer_ejf_id', conflict: 'ON CONFLICT (bfe_nummer, ejer_ejf_id, virkning_fra) DO NOTHING' },
  regnskab_cache: { pk: 'cvr', orderBy: 'cvr', conflict: 'ON CONFLICT (cvr) DO NOTHING' },
};

function escVal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return String(v);
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (Array.isArray(v) || typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function syncTable(srcClient, dstClient, tableName) {
  const def = TABLE_DEFS[tableName];
  if (!def) { console.error(`Unknown table: ${tableName}`); return; }

  const srcCount = (await srcClient.query(`SELECT count(*) FROM ${tableName}`)).rows[0].count;
  const dstCount = (await dstClient.query(`SELECT count(*) FROM ${tableName}`)).rows[0].count;

  console.log(`\n=== ${tableName} ===`);
  console.log(`  ${FROM_ENV}: ${srcCount}, ${TO_ENV}: ${dstCount}`);

  if (parseInt(dstCount) >= parseInt(srcCount)) {
    console.log(`  Skipping — target already has >= source`);
    return;
  }

  // Get columns from source
  const colRes = await srcClient.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`, [tableName]);
  const cols = colRes.rows.map(r => r.column_name);
  const colList = cols.join(', ');

  const orderCols = def.orderBy.split(',').map(c => c.trim());
  let cursorWhere = '';
  let fetched = 0, inserted = 0, errors = 0;
  const startTime = Date.now();

  while (true) {
    const sql = cursorWhere
      ? `SELECT ${colList} FROM ${tableName} WHERE ${cursorWhere} ORDER BY ${def.orderBy} LIMIT ${BATCH_SIZE}`
      : `SELECT ${colList} FROM ${tableName} ORDER BY ${def.orderBy} LIMIT ${BATCH_SIZE}`;

    const { rows } = await srcClient.query(sql);
    if (rows.length === 0) break;

    // Update cursor
    const last = rows[rows.length - 1];
    if (orderCols.length === 1) {
      cursorWhere = `${orderCols[0]} > ${escVal(last[orderCols[0]])}`;
    } else {
      cursorWhere = `(${orderCols.join(', ')}) > (${orderCols.map(c => escVal(last[c])).join(', ')})`;
    }

    // Build INSERT
    const values = rows.map(row => `(${cols.map(c => escVal(row[c])).join(', ')})`).join(',\n');
    try {
      await dstClient.query(`INSERT INTO ${tableName} (${colList}) VALUES ${values} ${def.conflict}`);
      inserted += rows.length;
    } catch (e) {
      errors++;
      if (errors <= 3) console.error(`  [ERR]: ${e.message.substring(0, 100)}`);
    }

    fetched += rows.length;
    if (fetched % (BATCH_SIZE * 5) === 0 || rows.length < BATCH_SIZE) {
      const rate = (fetched / ((Date.now() - startTime) / 1000)).toFixed(0);
      console.log(`  [${fetched}/${srcCount}] inserted=${inserted} errors=${errors} ${rate} rows/s`);
    }

    if (rows.length < BATCH_SIZE) break;
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`  Done! ${elapsed} min, synced=${inserted}, errors=${errors}`);
}

async function main() {
  console.log(`Sync ${FROM_ENV.toUpperCase()} → ${TO_ENV.toUpperCase()} via direct PG`);

  const srcClient = new pg.Client({ connectionString: DB_URLS[FROM_ENV], statement_timeout: 300000 });
  const dstClient = new pg.Client({ connectionString: DB_URLS[TO_ENV], statement_timeout: 300000 });

  await srcClient.connect();
  await dstClient.connect();
  console.log('Connected to both databases');

  const tables = SYNC_ALL ? Object.keys(TABLE_DEFS) : [TABLE_ARG];
  for (const t of tables) await syncTable(srcClient, dstClient, t);

  await srcClient.end();
  await dstClient.end();
  console.log('\n=== All syncs complete ===');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
