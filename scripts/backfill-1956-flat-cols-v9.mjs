#!/usr/bin/env node
/**
 * BIZZ-1956: Re-parse XBRL med v9 parser og opdater FLADE kolonner +
 * years JSONB i regnskab_cache, så M&A-radaren (Virksomhedshandler) ikke
 * længere viser magnitude-oppustede regnskabstal.
 *
 * Rod-årsag (samme som route.ts-fixet): v8-parseren brugte XBRL `decimals`
 * som skala-faktor (×10^-decimals). decimals er KUN præcision i XBRL 2.1 —
 * elementets indhold er allerede hele DKK. Kun iXBRL `scale` skalerer.
 * Resultat: decimals="-6"-felter blev ×1.000 for store (billion/trillion-
 * niveauer), decimals="-3" var ved et tilfælde korrekte. Radaren læser de
 * flade kolonner (rc.omsaetning osv.), som backfill-1946 fyldte med v8.
 *
 * Strategi:
 *  - Iterér alle cachede CVR'er i TEST-env hvor es_timestamp ikke er _v9
 *  - Fetch ES seneste regnskab → download XBRL → parseXbrl (v9, raw DKK)
 *  - UPDATE flade kolonner med raw DKK + years JSONB + es_timestamp = `*_v9`
 *
 * TEST-env (rlkjmqjxmkxuclehbrnl) har ingen direkte DB-URL i .env.local,
 * så reads/writes går via Supabase Management API (SUPABASE_ACCESS_TOKEN).
 *
 * Usage:
 *   node scripts/backfill-1956-flat-cols-v9.mjs [--project=rlkjmqjxmkxuclehbrnl] \
 *        [--concurrency=10] [--limit=N] [--cvrs=A,B] [--write-batch=20]
 */
import fs from 'fs';
import { parseXbrl, PARSER_VERSION } from './lib/regnskab-xbrl-parser.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true']; }));
const PROJECT = args.project || 'rlkjmqjxmkxuclehbrnl'; // test/develop env
const CONCURRENCY = parseInt(args.concurrency || '10', 10);
const WRITE_BATCH = parseInt(args['write-batch'] || '20', 10);
const LIMIT = parseInt(args.limit || '0', 10) || 999999999;
const CVRS_ARG = args.cvrs && args.cvrs !== 'true' ? args.cvrs.split(',') : null;

if (PARSER_VERSION !== 'v9') { console.error(`Parser version mismatch: expected v9, got ${PARSER_VERSION}`); process.exit(1); }

const env = fs.readFileSync('/root/BizzAssist/.env.local', 'utf8');
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1]?.replace(/^["']|["']$/g, '');
const MGMT_TOKEN = get('SUPABASE_ACCESS_TOKEN');
const USER = get('CVR_ES_USER');
const PASS = get('CVR_ES_PASS');
if (!MGMT_TOKEN) { console.error('Missing SUPABASE_ACCESS_TOKEN'); process.exit(1); }
const esAuth = Buffer.from(`${USER}:${PASS}`).toString('base64');

console.log(`[1956] project=${PROJECT}, concurrency=${CONCURRENCY}, write-batch=${WRITE_BATCH}, parser=${PARSER_VERSION}`);

/**
 * Run SQL against the test env via Supabase Management API.
 * @param {string} sql - SQL statement(s) to execute
 * @returns {Promise<any>} parsed JSON result (array of rows) or throws
 */
async function mgmtQuery(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MGMT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`mgmt ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

/** SQL-safe numeric literal or NULL. */
function numLit(v) {
  return (v == null || Number.isNaN(v)) ? 'NULL' : String(Math.round(v));
}
/** SQL-safe single-quoted string literal (doubles embedded quotes). */
function strLit(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

async function fetchLatestRegnskab(cvr) {
  const r = await fetch('http://distribution.virk.dk/offentliggoerelser/_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip', Authorization: `Basic ${esAuth}` },
    body: JSON.stringify({
      query: { bool: { must: [{ term: { cvrNummer: parseInt(cvr, 10) } }, { term: { offentliggoerelsestype: 'regnskab' } }] } },
      sort: [{ offentliggoerelsesTidspunkt: { order: 'desc' } }],
      size: 10,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) return null;
  const data = await r.json();
  const candidates = (data.hits?.hits ?? []).map(h => h._source).filter(s => s.regnskab?.regnskabsperiode);
  for (const s of candidates) {
    const doc = (s.dokumenter || []).find(d => d.dokumentMimeType?.includes('xhtml')) ?? (s.dokumenter || []).find(d => d.dokumentMimeType?.includes('xml'));
    if (doc) return {
      offentliggjort: s.offentliggoerelsesTidspunkt,
      periodeStart: s.regnskab.regnskabsperiode.startDato,
      periodeSlut: s.regnskab.regnskabsperiode.slutDato,
      doc,
    };
  }
  return null;
}

async function fetchXbrl(doc) {
  const r = await fetch(doc.dokumentUrl, { signal: AbortSignal.timeout(45000), headers: { 'Accept-Encoding': 'gzip, deflate' } });
  if (!r.ok) return null;
  return await r.text();
}

/**
 * Process one CVR: fetch latest XBRL → parse v9 (raw DKK).
 * Returns { cvr, status, update? } where update is an SQL UPDATE string.
 */
async function processCvr(cvr, existingYearsByCvr) {
  let regn;
  try { regn = await fetchLatestRegnskab(cvr); }
  catch (e) { return { cvr, status: 'es-error', err: e.message }; }
  if (!regn) return { cvr, status: 'no-regnskab' };

  const xml = await fetchXbrl(regn.doc).catch(() => null);
  if (!xml) return { cvr, status: 'xbrl-error' };

  let parsed;
  try { parsed = parseXbrl(xml, regn.periodeStart, regn.periodeSlut); }
  catch (e) { return { cvr, status: 'parse-error', err: e.message }; }
  if (!parsed) return { cvr, status: 'parse-null' };

  let antalAnsatte = parsed.noegletal.antalAnsatte;
  if (antalAnsatte != null && (antalAnsatte < 0 || antalAnsatte > 2_000_000)) antalAnsatte = null;

  // Merge: keep older years, overwrite same aar with new v9 parse
  const existing = existingYearsByCvr.get(cvr);
  let years = [parsed];
  if (Array.isArray(existing) && existing.length > 0) {
    const map = new Map(existing.map(y => [y.aar, y]));
    map.set(parsed.aar, parsed);
    years = [...map.values()].sort((a, b) => b.aar - a.aar);
  }
  const esTimestamp = `${regn.offentliggjort}_v9`;
  const yearsJson = JSON.stringify(years);

  const update = `UPDATE regnskab_cache SET
    years = ${strLit(yearsJson)}::jsonb,
    es_timestamp = ${strLit(esTimestamp)},
    fetched_at = now(),
    seneste_aar = ${numLit(parsed.aar)},
    omsaetning = ${numLit(parsed.resultat.omsaetning)},
    bruttofortjeneste = ${numLit(parsed.resultat.bruttofortjeneste)},
    resultat_foer_skat = ${numLit(parsed.resultat.resultatFoerSkat)},
    aarsresultat = ${numLit(parsed.resultat.aaretsResultat)},
    egenkapital = ${numLit(parsed.balance.egenkapital)},
    aktiver_i_alt = ${numLit(parsed.balance.aktiverIAlt)},
    gaeld_i_alt = ${numLit(parsed.balance.gaeldsforpligtelserIAlt)},
    selskabskapital = ${numLit(parsed.balance.selskabskapital)},
    antal_ansatte = ${numLit(antalAnsatte)}
  WHERE cvr = ${strLit(cvr)};`;

  return { cvr, status: 'ok', aar: parsed.aar, update };
}

async function main() {
  let cvrs;
  if (CVRS_ARG) {
    cvrs = CVRS_ARG;
    console.log(`[1956] using --cvrs list: ${cvrs.length}`);
  } else {
    const rows = await mgmtQuery(`
      SELECT cvr FROM regnskab_cache
      WHERE (es_timestamp NOT LIKE '%\\_v9' OR es_timestamp IS NULL)
        AND jsonb_array_length(years) > 0
      ORDER BY cvr LIMIT ${LIMIT}
    `);
    cvrs = rows.map(r => r.cvr);
  }
  console.log(`[1956] ${cvrs.length} CVR'er at re-parse`);
  if (cvrs.length === 0) { console.log('[1956] intet at gøre.'); return; }

  // Pre-fetch existing years for all target CVRs in chunks (to merge old years)
  const existingYearsByCvr = new Map();
  for (let i = 0; i < cvrs.length; i += 500) {
    const chunk = cvrs.slice(i, i + 500);
    const list = chunk.map(c => strLit(c)).join(',');
    const rows = await mgmtQuery(`SELECT cvr, years FROM regnskab_cache WHERE cvr IN (${list})`);
    for (const row of rows) existingYearsByCvr.set(row.cvr, row.years);
  }
  console.log(`[1956] pre-loaded existing years for ${existingYearsByCvr.size} CVR'er`);

  let processed = 0, ok = 0, noRegn = 0, errors = 0;
  let pendingUpdates = [];
  const start = Date.now();

  async function flushWrites() {
    if (pendingUpdates.length === 0) return;
    const sql = pendingUpdates.join('\n');
    try { await mgmtQuery(sql); }
    catch (e) {
      // On batch failure, retry individually so one bad row doesn't lose the batch
      console.warn('  batch write failed, retrying individually:', e.message.slice(0, 120));
      for (const u of pendingUpdates) {
        try { await mgmtQuery(u); } catch (e2) { errors++; if (errors <= 10) console.warn('   write ERR', e2.message.slice(0, 100)); }
      }
    }
    pendingUpdates = [];
  }

  for (let i = 0; i < cvrs.length; i += CONCURRENCY) {
    const batch = cvrs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(c => processCvr(c, existingYearsByCvr).catch(e => ({ cvr: c, status: 'exception', err: e.message }))));
    for (const r of results) {
      processed++;
      if (r.status === 'ok') { ok++; pendingUpdates.push(r.update); }
      else if (r.status === 'no-regnskab') noRegn++;
      else { errors++; if (errors <= 10) console.warn(' ERR', r.cvr, r.status, r.err); }
    }
    if (pendingUpdates.length >= WRITE_BATCH) await flushWrites();
    if (processed % 1000 === 0 || processed === cvrs.length) {
      const el = (Date.now() - start) / 1000;
      const rate = processed / el;
      const eta = (cvrs.length - processed) / (rate || 1);
      console.log(`[1956] ${processed}/${cvrs.length} (${(processed / cvrs.length * 100).toFixed(1)}%) ok=${ok} no-regn=${noRegn} err=${errors} rate=${rate.toFixed(1)}/s eta=${(eta / 60).toFixed(0)}min`);
    }
  }
  await flushWrites();
  console.log(`\n[1956] DONE. ok=${ok}, no-regn=${noRegn}, err=${errors}`);
}

main().catch(e => { console.error(e); process.exit(1); });
