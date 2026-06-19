#!/usr/bin/env node
/**
 * Sync tables from PROD to PREVIEW/DEV via Supabase Management API.
 *
 * Strategy: backfill PROD → copy to other envs. This ensures data parity.
 * Reads in batches from PROD, inserts to target with ON CONFLICT DO NOTHING.
 *
 * Usage:
 *   node scripts/sync-prod-to-env.mjs --target=preview [--table=bbr_ejendom_status] [--batch=2000]
 *   node scripts/sync-prod-to-env.mjs --target=dev --all
 *   node scripts/sync-prod-to-env.mjs --target=preview --all
 */
import https from 'node:https';
import { config } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, '..', '.env.local') });

const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const ENV_REFS = { dev: 'wkzwxfhyfmvglrqtmebw', preview: 'rlkjmqjxmkxuclehbrnl', prod: 'xsyldjqcntiygrtfcszm' };

const args = process.argv.slice(2);
const TARGET_ENV = args.find(x => x.startsWith('--target='))?.split('=')[1];
const TABLE_ARG = args.find(x => x.startsWith('--table='))?.split('=')[1];
const SYNC_ALL = args.includes('--all');
const BATCH_SIZE = (() => { const a = args.find(x => x.startsWith('--batch=')); return a ? parseInt(a.split('=')[1], 10) : 2000; })();

if (!TARGET_ENV || !ENV_REFS[TARGET_ENV]) { console.error('Usage: --target=preview|dev'); process.exit(1); }
if (!TABLE_ARG && !SYNC_ALL) { console.error('Specify --table=<name> or --all'); process.exit(1); }

const SOURCE_REF = ENV_REFS.prod;
const TARGET_REF = ENV_REFS[TARGET_ENV];

/** Table sync definitions. */
const TABLE_DEFS = {
  bbr_ejendom_status: {
    pk: 'bfe_nummer',
    orderBy: 'bfe_nummer',
    columns: 'bfe_nummer, kommune_kode, is_udfaset, bbr_status_code, samlet_boligareal, samlet_erhvervsareal, grundareal, bebygget_areal, opfoerelsesaar, ombygningsaar, byg021_anvendelse, energimaerke, energimaerke_dato, antal_etager, antal_boligenheder, tagmateriale, ydervaeg_materiale, varmeinstallation, opvarmningsform, supplerende_varme, vandforsyning, afloebsforhold, fredning, bevaringsvaerdighed, ejerforholdskode',
    conflict: 'ON CONFLICT (bfe_nummer) DO NOTHING',
  },
  ejendomshandel: {
    pk: 'id',
    orderBy: 'id',
    columns: 'bfe_nummer, dato, koebsaftale_dato, tinglyst_dato, type, andel_taeller, andel_naevner, koebesum, samlet_koebesum, koeber_navne, koeber_cvrs, saelger_navne, saelger_cvrs, kilde, sidst_opdateret',
    conflict: 'ON CONFLICT DO NOTHING',
  },
  tinglysning_haeftelse: {
    pk: 'id',
    orderBy: 'id',
    columns: 'bfe_nummer, prioritet, type, hovedstol_dkk, kreditor_navn, kreditor_cvr, tinglyst_dato, akt_navn, status, sidst_opdateret',
    conflict: 'ON CONFLICT (bfe_nummer, prioritet, status) DO NOTHING',
  },
  tinglysning_servitut: {
    pk: 'id',
    orderBy: 'id',
    columns: 'bfe_nummer, prioritet, tekst, type, tinglyst_dato, akt_navn, paataleberettiget, sidst_opdateret',
    conflict: 'ON CONFLICT DO NOTHING',
  },
  ejerskifte_historik: {
    pk: 'id',
    orderBy: 'id',
    columns: 'bfe_nummer, overtagelsesdato, fratraedelsesdato, ejer_navn, ejer_cvr, ejer_type, ejerandel_taeller, ejerandel_naevner, kontant_koebesum, i_alt_koebesum, koebsaftale_dato, dokument_id, kommune_kode, byg021_anvendelse, boligareal_m2, m2_pris, historisk_kilde, kilde, created_at',
    conflict: 'ON CONFLICT DO NOTHING',
  },
  vurdering_cache: {
    pk: 'bfe_nummer',
    orderBy: 'bfe_nummer',
    columns: 'bfe_nummer, vurderinger, ejendomsvaerdi, grundvaerdi, vurderingsaar, benyttelseskode, grundskyldspromille, bebyggelsesprocent, kommune_kode, fetched_at',
    conflict: 'ON CONFLICT (bfe_nummer) DO NOTHING',
  },
  kommune_ref: {
    pk: 'kommune_kode',
    orderBy: 'kommune_kode',
    columns: 'kommune_kode, kommunenavn, region',
    conflict: 'ON CONFLICT (kommune_kode) DO NOTHING',
  },
  bfe_adresse_cache: {
    pk: 'bfe_nummer',
    orderBy: 'bfe_nummer',
    columns: 'bfe_nummer, adresse, etage, doer, postnr, postnrnavn, kommune, kommune_kode, dawa_id, ejendomstype, kilde, sidst_opdateret',
    conflict: 'ON CONFLICT (bfe_nummer) DO NOTHING',
  },
  cvr_virksomhed_ejerskab: {
    pk: 'ejer_cvr,ejet_cvr',
    orderBy: 'ejer_cvr, ejet_cvr',
    columns: 'ejer_cvr, ejet_cvr, ejerandel_pct, ejerandel_min, ejerandel_max, gyldig_fra, gyldig_til, sidst_opdateret',
    conflict: 'ON CONFLICT (ejer_cvr, ejet_cvr) DO NOTHING',
  },
  ejf_ejerskifte: {
    pk: 'id_lokal_id',
    orderBy: 'bfe_nummer',
    columns: 'id_lokal_id, bfe_nummer, overdragelsesmaade, overtagelsesdato, handelsoplysninger_lokal_id, virkning_fra, virkning_til, status, registrering_fra, registrering_til, sidst_opdateret',
    conflict: 'ON CONFLICT (id_lokal_id) DO NOTHING',
  },
  ejf_administrator: {
    pk: 'id_lokal_id',
    orderBy: 'id_lokal_id',
    columns: 'id_lokal_id, bfe_nummer, administrator_type, virksomhed_cvr, person_navn, person_lokal_id, virkning_fra, virkning_til, status, sidst_opdateret',
    conflict: 'ON CONFLICT (id_lokal_id) DO NOTHING',
  },
  ejf_handelsoplysninger: {
    pk: 'id_lokal_id',
    orderBy: 'id_lokal_id',
    columns: 'id_lokal_id, kontant_koebesum, samlet_koebesum, loesoeresum, entreprisesum, koebsaftale_dato, valutakode, virkning_fra, virkning_til, status, registrering_fra, registrering_til, sidst_opdateret',
    conflict: 'ON CONFLICT (id_lokal_id) DO NOTHING',
  },
};

/**
 * Execute SQL via Supabase Management API with retry.
 */
function runSqlOnce(sql, ref) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query: sql });
    const timer = setTimeout(() => { req.destroy(); resolve({ message: 'timeout' }); }, 120000);
    const req = https.request({ hostname: 'api.supabase.com', path: `/v1/projects/${ref}/database/query`, method: 'POST', headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', (e) => { clearTimeout(timer); resolve({ message: e.code || e.message }); });
    req.write(body); req.end();
  });
}

async function runSql(sql, ref, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await runSqlOnce(sql, ref);
    if (r?.message && (r.message.includes('ECONNRESET') || r.message.includes('timeout') || r.message.includes('ETIMEDOUT') || r.message.includes('ThrottlerException'))) {
      if (attempt < retries) {
        await new Promise(res => setTimeout(res, 3000 * (attempt + 1)));
        continue;
      }
    }
    return r;
  }
  return { message: 'max retries' };
}

/**
 * Escape a value for SQL INSERT.
 */
function escVal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return 'NULL';
    return `ARRAY[${v.map(x => `'${String(x).replace(/'/g, "''")}'`).join(',')}]`;
  }
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * Sync one table from PROD to target.
 */
async function syncTable(tableName) {
  const def = TABLE_DEFS[tableName];
  if (!def) { console.error(`Unknown table: ${tableName}`); return; }

  // Get source count
  const countRes = await runSql(`SELECT count(*) as cnt FROM ${tableName}`, SOURCE_REF);
  const sourceCount = countRes?.[0]?.cnt ?? 0;

  // Get target count
  const targetCount = (await runSql(`SELECT count(*) as cnt FROM ${tableName}`, TARGET_REF))?.[0]?.cnt ?? 0;

  console.log(`\n=== ${tableName} ===`);
  console.log(`  PROD: ${sourceCount} rows, ${TARGET_ENV.toUpperCase()}: ${targetCount} rows`);

  if (parseInt(targetCount) >= parseInt(sourceCount)) {
    console.log(`  Skipping — target already has >= source rows`);
    return;
  }

  const cols = def.columns.split(',').map(c => c.trim());
  const orderCols = def.orderBy.split(',').map(c => c.trim());
  let inserted = 0;
  let errors = 0;
  let fetched = 0;
  const startTime = Date.now();

  // Build cursor WHERE clause from last row
  let cursorWhere = '';

  while (true) {
    // Read batch from PROD using cursor-based pagination (no OFFSET)
    let readSql;
    if (cursorWhere) {
      readSql = `SELECT ${def.columns} FROM ${tableName} WHERE ${cursorWhere} ORDER BY ${def.orderBy} LIMIT ${BATCH_SIZE}`;
    } else {
      readSql = `SELECT ${def.columns} FROM ${tableName} ORDER BY ${def.orderBy} LIMIT ${BATCH_SIZE}`;
    }

    const rows = await runSql(readSql, SOURCE_REF);

    if (rows?.message) {
      errors++;
      if (errors <= 5) console.error(`  [READ ERR]: ${rows.message.substring(0, 100)}`);
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    if (!Array.isArray(rows) || rows.length === 0) break;

    // Update cursor from last row
    const lastRow = rows[rows.length - 1];
    if (orderCols.length === 1) {
      const col = orderCols[0];
      const val = escVal(lastRow[col]);
      cursorWhere = `${col} > ${val}`;
    } else {
      // Composite key — use row-value comparison
      const vals = orderCols.map(c => escVal(lastRow[c]));
      cursorWhere = `(${orderCols.join(', ')}) > (${vals.join(', ')})`;
    }

    // Build INSERT
    const values = rows.map(row => {
      const vals = cols.map(c => escVal(row[c]));
      return `(${vals.join(', ')})`;
    }).join(',\n');

    const insertSql = `INSERT INTO ${tableName} (${def.columns}) VALUES ${values} ${def.conflict}`;

    const result = await runSql(insertSql, TARGET_REF);
    if (result?.message) {
      errors++;
      if (errors <= 5) console.error(`  [INSERT ERR]: ${result.message.substring(0, 150)}`);
    } else {
      inserted += rows.length;
    }

    fetched += rows.length;
    if (fetched % (BATCH_SIZE * 5) === 0 || rows.length < BATCH_SIZE) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = (fetched / ((Date.now() - startTime) / 1000)).toFixed(0);
      console.log(`  [${fetched}/${sourceCount}] inserted=${inserted} errors=${errors} ${rate} rows/s (${elapsed}s)`);
    }

    if (rows.length < BATCH_SIZE) break;

    // Rate limit
    await new Promise(r => setTimeout(r, 300));
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`  Done! ${elapsed} min, synced ${inserted} rows, ${errors} errors`);
}

async function main() {
  process.on('uncaughtException', (err) => {
    if (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ETIMEDOUT') {
      console.error(`  [WARN] uncaught ${err.code} — ignoring`);
      return;
    }
    console.error('Fatal:', err);
    process.exit(1);
  });

  console.log(`Sync PROD → ${TARGET_ENV.toUpperCase()}`);
  console.log(`Source: ${SOURCE_REF}, Target: ${TARGET_REF}`);
  console.log(`Batch size: ${BATCH_SIZE}`);

  const tables = SYNC_ALL ? Object.keys(TABLE_DEFS) : [TABLE_ARG];

  for (const table of tables) {
    await syncTable(table);
  }

  console.log('\n=== All syncs complete ===');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
