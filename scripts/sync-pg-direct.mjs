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

/**
 * Format a value for a PostgreSQL array column (data_type = 'ARRAY').
 * node-pg returns array columns as JS arrays, which escVal would wrongly
 * serialise as jsonb. We build an ARRAY[...]::elemtype[] literal instead so
 * each element is escaped individually and the column type matches.
 *
 * @param v - The JS array value (or null) from the source row
 * @param udtName - The column udt_name, e.g. '_text', '_int4'
 * @returns A SQL array literal expression
 */
function escArray(v, udtName) {
  if (v === null || v === undefined) return 'NULL';
  const elemType = udtName.replace(/^_/, '');
  if (!Array.isArray(v) || v.length === 0) return `ARRAY[]::${elemType}[]`;
  const elems = v.map(e => {
    if (e === null || e === undefined) return 'NULL';
    if (typeof e === 'boolean') return e ? 'TRUE' : 'FALSE';
    if (typeof e === 'number') return String(e);
    return `'${String(e).replace(/'/g, "''")}'`;
  }).join(', ');
  return `ARRAY[${elems}]::${elemType}[]`;
}

/**
 * Run a query with a client-side timeout. pg's statement_timeout is server-side
 * and cannot notify the client when the TCP socket is dead (half-open). This
 * races the query against a hard wall-clock timer so we never hang forever.
 *
 * @param {pg.Client} client - PG client
 * @param {string} sql - SQL to execute
 * @param {Array} params - query params (optional)
 * @param {number} timeoutMs - wall-clock timeout (default 120s)
 * @returns {Promise<pg.QueryResult>}
 */
function queryWithTimeout(client, sql, params = [], timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('QueryClientTimeout')), timeoutMs);
    client.query(sql, params).then(
      res => { clearTimeout(timer); resolve(res); },
      err => { clearTimeout(timer); reject(err); },
    );
  });
}

async function syncTable(srcClient, dstClient, tableName) {
  const def = TABLE_DEFS[tableName];
  if (!def) { console.error(`Unknown table: ${tableName}`); return; }

  const srcCount = (await queryWithTimeout(srcClient, `SELECT count(*) FROM ${tableName}`)).rows[0].count;
  const dstCount = (await queryWithTimeout(dstClient, `SELECT count(*) FROM ${tableName}`)).rows[0].count;

  console.log(`\n=== ${tableName} ===`);
  console.log(`  ${FROM_ENV}: ${srcCount}, ${TO_ENV}: ${dstCount}`);

  if (parseInt(dstCount) >= parseInt(srcCount)) {
    console.log(`  Skipping — target already has >= source`);
    return;
  }

  // Get columns from source (with type info so array columns are formatted correctly)
  const colRes = await queryWithTimeout(srcClient, `SELECT column_name, data_type, udt_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`, [tableName]);
  const colMeta = colRes.rows.map(r => ({ name: r.column_name, isArray: r.data_type === 'ARRAY', udt: r.udt_name }));
  const cols = colMeta.map(c => c.name);
  const colList = cols.join(', ');

  const orderCols = def.orderBy.split(',').map(c => c.trim());
  let fetched = 0, inserted = 0, errors = 0;
  const startTime = Date.now();

  // Delta optimisation: start cursor from target's max PK value so we only
  // transfer genuinely new rows. For tables with a single-column orderBy this
  // avoids re-sending millions of existing rows through ON CONFLICT DO NOTHING.
  let cursorWhere = '';
  if (orderCols.length === 1) {
    const maxRes = await queryWithTimeout(dstClient, `SELECT MAX(${orderCols[0]}) AS mx FROM ${tableName}`);
    const maxVal = maxRes.rows[0]?.mx;
    if (maxVal !== null && maxVal !== undefined) {
      cursorWhere = `${orderCols[0]} > ${escVal(maxVal)}`;
      console.log(`  Delta mode: starting after ${orderCols[0]} = ${maxVal}`);
    }
  }

  while (true) {
    const sql = cursorWhere
      ? `SELECT ${colList} FROM ${tableName} WHERE ${cursorWhere} ORDER BY ${def.orderBy} LIMIT ${BATCH_SIZE}`
      : `SELECT ${colList} FROM ${tableName} ORDER BY ${def.orderBy} LIMIT ${BATCH_SIZE}`;

    const { rows } = await queryWithTimeout(srcClient, sql);
    if (rows.length === 0) break;

    // Update cursor
    const last = rows[rows.length - 1];
    if (orderCols.length === 1) {
      cursorWhere = `${orderCols[0]} > ${escVal(last[orderCols[0]])}`;
    } else {
      cursorWhere = `(${orderCols.join(', ')}) > (${orderCols.map(c => escVal(last[c])).join(', ')})`;
    }

    // Build INSERT
    const values = rows.map(row => `(${colMeta.map(cm => cm.isArray ? escArray(row[cm.name], cm.udt) : escVal(row[cm.name])).join(', ')})`).join(',\n');
    try {
      await queryWithTimeout(dstClient, `INSERT INTO ${tableName} (${colList}) VALUES ${values} ${def.conflict}`);
      inserted += rows.length;
    } catch (e) {
      errors++;
      if (errors <= 3) console.error(`  [ERR]: ${e.message.substring(0, 100)}`);
      // Connection-level error: break out so the outer reconnect logic can handle it
      if (/ECONNRESET|EPIPE|connection error|not queryable|terminated|QueryClientTimeout/i.test(e.message)) {
        console.log(`  [CONN LOST] after ${inserted} inserts — bubbling up for reconnect`);
        throw e;
      }
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

const PG_OPTS = (url) => ({
  connectionString: url,
  statement_timeout: 300000,
  query_timeout: 120000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 30000,
});

/**
 * Create fresh PG client connections. Used both at startup and on reconnect.
 *
 * @returns {Promise<{src: pg.Client, dst: pg.Client}>}
 */
async function connect() {
  const src = new pg.Client(PG_OPTS(DB_URLS[FROM_ENV]));
  const dst = new pg.Client(PG_OPTS(DB_URLS[TO_ENV]));
  // Prevent unhandled 'error' events from crashing the process.
  // Socket-level errors (ECONNRESET, EPIPE) are emitted on the Client
  // independently of any running query. We swallow them here; the next
  // queryWithTimeout() call will fail and trigger the reconnect logic.
  src.on('error', (err) => console.log(`  [src socket error] ${err.message}`));
  dst.on('error', (err) => console.log(`  [dst socket error] ${err.message}`));
  await src.connect();
  await dst.connect();
  return { src, dst };
}

async function main() {
  console.log(`Sync ${FROM_ENV.toUpperCase()} → ${TO_ENV.toUpperCase()} via direct PG`);

  let { src, dst } = await connect();
  console.log('Connected to both databases');

  const tables = SYNC_ALL ? Object.keys(TABLE_DEFS) : [TABLE_ARG];
  for (const t of tables) {
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await syncTable(src, dst, t);
        break;
      } catch (err) {
        const isConn = /QueryClientTimeout|Connection terminated|connection error|not queryable|ECONNRESET|EPIPE|timeout/i.test(err.message);
        if (!isConn || attempt === MAX_RETRIES) throw err;
        console.log(`  [RECONNECT] ${t}: ${err.message} — reconnecting (attempt ${attempt + 1}/${MAX_RETRIES})`);
        try { src.end().catch(() => {}); dst.end().catch(() => {}); } catch {}
        ({ src, dst } = await connect());
        console.log('  [RECONNECT] connected — retrying table');
      }
    }
  }

  await src.end();
  await dst.end();
  console.log('\n=== All syncs complete ===');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
