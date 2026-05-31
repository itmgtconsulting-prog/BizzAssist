import pg from 'pg';
import fs from 'fs';

const env = fs.readFileSync('/root/BizzAssist/.env.local', 'utf8');
const PROD = env.match(/^SUPABASE_PROD_DB_URL=(.+)$/m)?.[1];
const PREVIEW = env.match(/^SUPABASE_PREVIEW_DB_URL=(.+)$/m)?.[1];

const TEST_BFES = [100165396, 100165661, 100165662, 100165681, 100165686, 100165687, 100165688, 100165689, 100165692, 100165693, 100165694, 100165704, 100165711, 100165712, 100165717, 100165718, 100165724, 100165725, 100165744, 100435359, 100435360, 100435361, 100435362, 100435363, 100435364, 100435365, 100435366, 100435367, 100435368, 100435369, 100435370, 100435371, 100435372, 100077825, 100077625];

const prod = new pg.Client({ connectionString: PROD });
const preview = new pg.Client({ connectionString: PREVIEW });
await prod.connect();
await preview.connect();

// Helper: read from prod, DELETE+INSERT to preview (handles tables without unique constraints)
async function syncTable(table, columns, deleteWhere, where) {
  console.log(`\n=== ${table} ===`);
  const { rows } = await prod.query(`SELECT ${columns.join(',')} FROM ${table} WHERE ${where}`);
  console.log(' PROD rows:', rows.length);
  if (rows.length === 0) return;

  await preview.query(`DELETE FROM ${table} WHERE ${deleteWhere}`);
  const placeholders = [];
  const params = [];
  let p = 1;
  for (const r of rows) {
    placeholders.push('(' + columns.map(() => `$${p++}`).join(',') + ')');
    for (const col of columns) params.push(r[col]);
  }
  await preview.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders.join(',')}`, params);
  console.log(' Synced to preview:', rows.length);
}

// Helper: upsert (for tables with unique constraints like bfe_adresse_cache)
async function upsertTable(table, columns, pkCols, where) {
  console.log(`\n=== ${table} (upsert) ===`);
  const { rows } = await prod.query(`SELECT ${columns.join(',')} FROM ${table} WHERE ${where}`);
  console.log(' PROD rows:', rows.length);
  if (rows.length === 0) return;
  const placeholders = [];
  const params = [];
  let p = 1;
  for (const r of rows) {
    placeholders.push('(' + columns.map(() => `$${p++}`).join(',') + ')');
    for (const col of columns) params.push(r[col]);
  }
  const updateCols = columns.filter(c => !pkCols.includes(c)).map(c => `${c}=EXCLUDED.${c}`).join(',');
  await preview.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders.join(',')} ON CONFLICT (${pkCols.join(',')}) DO UPDATE SET ${updateCols}`, params);
  console.log(' Upserted to preview:', rows.length);
}

const bfeList = TEST_BFES.join(',');

await upsertTable('bfe_adresse_cache',
  ['bfe_nummer', 'adresse', 'etage', 'doer', 'postnr', 'postnrnavn', 'kommune', 'kommune_kode', 'dawa_id', 'ejendomstype', 'kilde', 'sidst_opdateret'],
  ['bfe_nummer'],
  `bfe_nummer IN (${bfeList})`
);

await syncTable('tinglysning_haeftelse',
  ['bfe_nummer', 'prioritet', 'type', 'hovedstol_dkk', 'kreditor_navn', 'kreditor_cvr', 'tinglyst_dato', 'akt_navn', 'status', 'sidst_opdateret'],
  `bfe_nummer IN (${bfeList})`,
  `bfe_nummer IN (${bfeList})`
);

await syncTable('ejendomshandel',
  ['bfe_nummer', 'dato', 'koebsaftale_dato', 'tinglyst_dato', 'koebesum', 'samlet_koebesum', 'andel_taeller', 'andel_naevner', 'koeber_navne', 'koeber_cvrs', 'kilde', 'sidst_opdateret'],
  `bfe_nummer IN (${bfeList}) AND kilde='tinglysning-summarisk'`,
  `bfe_nummer IN (${bfeList}) AND kilde='tinglysning-summarisk'`
);

await upsertTable('tinglysning_summarisk_cache',
  ['uuid', 'bfe_nummer', 'payload', 'fetched_at'],
  ['uuid'],
  `bfe_nummer IN (${bfeList})`
);

console.log('\n✓ Sync complete');
await prod.end();
await preview.end();
