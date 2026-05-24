#!/usr/bin/env node
/**
 * Refresh stale cvr_virksomhed entries from CVR ES.
 *
 * Finds entries where sidst_hentet_fra_cvr is older than 30 days
 * and re-fetches from CVR ES ElasticSearch.
 *
 * Usage:
 *   node scripts/refresh-stale-virksomheder.mjs [--limit=10000] [--concurrency=5]
 */
import pg from 'pg';
import { config } from 'dotenv';
config({ path: '/root/BizzAssist/.env.local' });

const args = process.argv.slice(2);
const LIMIT = (() => { const a = args.find(x => x.startsWith('--limit=')); return a ? parseInt(a.split('=')[1], 10) : 50000; })();
const CONCURRENCY = (() => { const a = args.find(x => x.startsWith('--concurrency=')); return a ? parseInt(a.split('=')[1], 10) : 5; })();

const CVR_ES_USER = process.env.CVR_ES_USER;
const CVR_ES_PASS = process.env.CVR_ES_PASS;
if (!CVR_ES_USER || !CVR_ES_PASS) { console.error('Missing CVR_ES creds'); process.exit(1); }

const pool = new pg.Pool({ connectionString: process.env.SUPABASE_PROD_DB_URL, max: CONCURRENCY + 2, statement_timeout: 300000 });

const esAuth = 'Basic ' + Buffer.from(`${CVR_ES_USER}:${CVR_ES_PASS}`).toString('base64');

let resolved = 0, failed = 0, idx = 0;

/**
 * Fetch and update one virksomhed.
 *
 * @param {number} cvr
 */
async function processOne(cvr) {
  try {
    const res = await fetch('http://distribution.virk.dk/cvr-permanent/virksomhed/_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: esAuth },
      body: JSON.stringify({ query: { term: { 'Vrvirksomhed.cvrNummer': cvr } }, _source: true, size: 1 }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) { failed++; return; }
    const data = await res.json();
    const src = data.hits?.hits?.[0]?._source?.Vrvirksomhed;
    if (!src) { failed++; return; }

    const navn = src.navne?.sort((a, b) => (b.periode?.gyldigFra || '').localeCompare(a.periode?.gyldigFra || ''))[0]?.navn || null;
    const branche = src.hovedbranche?.sort((a, b) => (b.periode?.gyldigFra || '').localeCompare(a.periode?.gyldigFra || ''))[0] || {};
    const form = src.virksomhedsform?.sort((a, b) => (b.periode?.gyldigFra || '').localeCompare(a.periode?.gyldigFra || ''))[0]?.kortBeskrivelse || null;
    const addr = src.beliggenhedsadresse?.sort((a, b) => (b.periode?.gyldigFra || '').localeCompare(a.periode?.gyldigFra || ''))[0] || null;
    const life = src.livsforloeb?.sort((a, b) => (b.periode?.gyldigFra || '').localeCompare(a.periode?.gyldigFra || ''))[0] || {};
    const ansatte = src.aarsbeskaeftigelse?.sort((a, b) => (b.aar || 0) - (a.aar || 0))[0] || {};

    const db = await pool.connect();
    try {
      await db.query(`
        UPDATE cvr_virksomhed SET
          navn=$2, branche_kode=$3, branche_tekst=$4, virksomhedsform=$5,
          stiftet=$6, ophoert=$7, ansatte_aar=$8, adresse_json=$9,
          raw_source=$10, sidst_hentet_fra_cvr=NOW()
        WHERE cvr=$1
      `, [cvr, navn, branche.branchekode||null, branche.branchetekst||null, form,
          life.periode?.gyldigFra?.substring(0,10)||null, life.periode?.gyldigTil?.substring(0,10)||null,
          ansatte.aar||null, JSON.stringify(addr), JSON.stringify(src)]);
    } finally { db.release(); }
    resolved++;
  } catch { failed++; }
}

// ── Main ───────────────────────────────────────────────────────────────────

const initDb = await pool.connect();
const { rows } = await initDb.query(`
  SELECT cvr FROM cvr_virksomhed
  WHERE sidst_hentet_fra_cvr < NOW() - INTERVAL '30 days'
  ORDER BY sidst_hentet_fra_cvr
  LIMIT $1
`, [LIMIT]);
initDb.release();

console.log(`Found ${rows.length} stale virksomheder, concurrency=${CONCURRENCY}`);
const startTime = Date.now();

while (idx < rows.length) {
  const batch = rows.slice(idx, idx + CONCURRENCY);
  await Promise.all(batch.map(r => processOne(r.cvr)));
  idx += batch.length;

  if (idx % 1000 === 0 || idx >= rows.length) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rate = (idx / (elapsed || 1)).toFixed(1);
    console.log(`  [${idx}/${rows.length}] resolved=${resolved} failed=${failed} ${rate}/s (${elapsed}s)`);
  }
}

console.log(`\nDone! resolved=${resolved} failed=${failed}`);
await pool.end();
