#!/usr/bin/env node
/**
 * BIZZ-1946: Re-parse XBRL med v8 parser og opdater FLADE kolonner i
 * regnskab_cache med fortegns-korrekte hele-DKK værdier.
 *
 * v7-parser bug:
 *  - scale="0" tolket som "antag millioner" (×1.000.000) → inflation
 *  - sign="-" ignoreret → tab vist som overskud
 *  - U-pure/antal felter blev scaled → 3 ansatte vist som 3 millioner
 *
 * Strategi:
 *  - Iterér alle cached CVR'er
 *  - Fetch ES offentliggoerelser (senest regnskab)
 *  - Download XBRL doc
 *  - parseXbrl med v8 (extractValue honorerer scale/sign/U-pure)
 *  - UPDATE flade kolonner med raw DKK (IKKE normaliserAlleAar → den ÷1000 til T DKK)
 *  - Også opdater years JSONB + es_timestamp = `*_v8` (så route.ts cache-hit virker fremover)
 *
 * Usage:
 *   node scripts/backfill-1946-flat-cols-v8.mjs --target=preview [--concurrency=10] [--limit=N] [--cvrs=A,B]
 */
import fs from 'fs';
import pg from 'pg';
import { parseXbrl, normaliserAlleAar, deduplicateYears, PARSER_VERSION } from './lib/regnskab-xbrl-parser.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true']; }));
const TARGET = args.target || 'preview';
const CONCURRENCY = parseInt(args.concurrency || '10', 10);
const LIMIT = parseInt(args.limit || '0', 10) || 999999999;
const CVRS_ARG = args.cvrs && args.cvrs !== 'true' ? args.cvrs.split(',') : null;
const SKIP_FETCH = args['skip-fetch'] === 'true' || args['skip-fetch'] === true;

if (PARSER_VERSION !== 'v8') { console.error(`Parser version mismatch: expected v8, got ${PARSER_VERSION}`); process.exit(1); }

const env = fs.readFileSync('/root/BizzAssist/.env.local', 'utf8');
const URLS = {
  prod: env.match(/^SUPABASE_PROD_DB_URL=(.+)$/m)?.[1],
  preview: env.match(/^SUPABASE_PREVIEW_DB_URL=(.+)$/m)?.[1],
  dev: env.match(/^SUPABASE_DEV_DB_URL=(.+)$/m)?.[1],
};
const DB_URL = URLS[TARGET];
if (!DB_URL) { console.error('Unknown --target:', TARGET); process.exit(1); }
const USER = env.match(/^CVR_ES_USER=(.+)$/m)?.[1];
const PASS = env.match(/^CVR_ES_PASS=(.+)$/m)?.[1];
const esAuth = Buffer.from(`${USER}:${PASS}`).toString('base64');
const pool = new pg.Pool({ connectionString: DB_URL, max: Math.min(CONCURRENCY + 4, 20) });

console.log(`[1946] target=${TARGET}, concurrency=${CONCURRENCY}, parser=${PARSER_VERSION}`);

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
 * Process one CVR: fetch latest XBRL → parse v8 (raw DKK) → UPDATE flat columns.
 * Returns { cvr, status, fields_updated? }
 */
async function processCvr(cvr) {
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

  // Clamp antal_ansatte (skulle aldrig være > 2M, men just in case parser fejler)
  let antalAnsatte = parsed.noegletal.antalAnsatte;
  if (antalAnsatte != null && (antalAnsatte < 0 || antalAnsatte > 2_000_000)) antalAnsatte = null;

  // UPDATE flat columns med RAW DKK værdier (IKKE T DKK)
  // Også opdater years JSONB med v8 parse + es_timestamp så route.ts cache-hit virker
  const esTimestamp = `${regn.offentliggjort}_v8`;
  // Få fuld years-array fra eksisterende cache; opdater [0] med ny parse
  const client = await pool.connect();
  try {
    // Læs eksisterende years
    const { rows: existing } = await client.query('SELECT years FROM regnskab_cache WHERE cvr=$1', [cvr]);
    let years = parsed ? [parsed] : [];
    if (existing.length > 0 && Array.isArray(existing[0].years)) {
      // merge: behold ældre years, overskriv samme aar med ny parse
      const map = new Map((existing[0].years).map(y => [y.aar, y]));
      map.set(parsed.aar, parsed);
      years = [...map.values()].sort((a, b) => b.aar - a.aar);
    }
    await client.query(`
      UPDATE regnskab_cache SET
        years        = $2::jsonb,
        es_timestamp = $3,
        fetched_at   = now(),
        seneste_aar       = $4,
        omsaetning        = $5,
        bruttofortjeneste = $6,
        resultat_foer_skat= $7,
        aarsresultat      = $8,
        egenkapital       = $9,
        aktiver_i_alt     = $10,
        gaeld_i_alt       = $11,
        selskabskapital   = $12,
        antal_ansatte     = $13
      WHERE cvr=$1
    `, [
      cvr,
      JSON.stringify(years),
      esTimestamp,
      parsed.aar,
      parsed.resultat.omsaetning,
      parsed.resultat.bruttofortjeneste,
      parsed.resultat.resultatFoerSkat,
      parsed.resultat.aaretsResultat,
      parsed.balance.egenkapital,
      parsed.balance.aktiverIAlt,
      parsed.balance.gaeldsforpligtelserIAlt,
      parsed.balance.selskabskapital,
      antalAnsatte,
    ]);
    return { cvr, status: 'ok', aar: parsed.aar };
  } catch (e) {
    return { cvr, status: 'db-error', err: e.message };
  } finally {
    client.release();
  }
}

async function main() {
  let cvrs;
  if (CVRS_ARG) {
    cvrs = CVRS_ARG;
    console.log(`[1946] using --cvrs list: ${cvrs.length}`);
  } else {
    console.time('[1946] cvr list');
    const { rows } = await pool.query(`
      SELECT cvr FROM regnskab_cache
      WHERE (es_timestamp NOT LIKE '%_v8' OR es_timestamp IS NULL)
        AND jsonb_array_length(years) > 0
      ORDER BY cvr LIMIT $1
    `, [LIMIT]);
    cvrs = rows.map(r => r.cvr);
    console.timeEnd('[1946] cvr list');
  }
  console.log(`[1946] ${cvrs.length} CVR'er at re-parse`);

  let processed = 0, ok = 0, noRegn = 0, errors = 0;
  const start = Date.now();
  for (let i = 0; i < cvrs.length; i += CONCURRENCY) {
    const batch = cvrs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(c => processCvr(c).catch(e => ({ cvr: c, status: 'exception', err: e.message }))));
    for (const r of results) {
      processed++;
      if (r.status === 'ok') ok++;
      else if (r.status === 'no-regnskab') noRegn++;
      else { errors++; if (errors <= 5) console.warn(' ERR', r.cvr, r.status, r.err); }
    }
    if (processed % 1000 === 0 || processed === cvrs.length) {
      const el = (Date.now() - start) / 1000;
      const rate = processed / el;
      const eta = (cvrs.length - processed) / rate;
      console.log(`[1946] ${processed}/${cvrs.length} (${(processed/cvrs.length*100).toFixed(1)}%) ok=${ok} no-regn=${noRegn} err=${errors} rate=${rate.toFixed(1)}/s eta=${(eta/60).toFixed(0)}min`);
    }
  }
  console.log(`\n[1946] DONE. ok=${ok}, no-regn=${noRegn}, err=${errors}`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
