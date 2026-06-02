#!/usr/bin/env node
/**
 * BIZZ-1936: Backfill regnskab_cache for alle aktive CVR'er.
 *
 * Direct-DB approach (ikke via auth-gated /api/regnskab/xbrl):
 *   1. CVR ES offentliggoerelser/_search → liste over regnskaber
 *   2. Parallel-fetch XBRL fra regnskaber.virk.dk
 *   3. parseXbrl (ported fra app/api/regnskab/xbrl/route.ts)
 *   4. dedup + normaliserAlleAar → years[]
 *   5. UPSERT regnskab_cache med es_timestamp matching route.ts format
 *      ({latestOffentliggjort}_v7), så route.ts cache-hit virker
 *
 * Per default backfilles SENESTE 5 år per CVR for at holde XBRL-bandwidth nede.
 * Route.ts vil lazy-fylde ældre år på UI-detail-page access.
 *
 * Usage:
 *   node scripts/backfill-1936-regnskab-cache.mjs --concurrency=10 --max-years=5 [--limit=N] [--skip-cached] [--cvrs=A,B,C]
 */
import fs from 'fs';
import pg from 'pg';
import { parseXbrl, normaliserAlleAar, deduplicateYears, PARSER_VERSION } from './lib/regnskab-xbrl-parser.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true']; }));
const CONCURRENCY = parseInt(args.concurrency || '10', 10);
const MAX_YEARS = parseInt(args['max-years'] || '5', 10);
const LIMIT = parseInt(args.limit || '0', 10) || 999999999;
const SKIP_CACHED = args['skip-cached'] === 'true' || args['skip-cached'] === true;
const CVRS_ARG = args.cvrs && args.cvrs !== 'true' ? args.cvrs.split(',') : null;
const PROGRESS_EVERY = parseInt(args['progress-every'] || '200', 10);

const env = fs.readFileSync('/root/BizzAssist/.env.local', 'utf8');
const USER = env.match(/^CVR_ES_USER=(.+)$/m)?.[1];
const PASS = env.match(/^CVR_ES_PASS=(.+)$/m)?.[1];
const PROD = env.match(/^SUPABASE_PROD_DB_URL=(.+)$/m)?.[1];
if (!USER || !PASS || !PROD) { console.error('Missing CVR_ES_USER/PASS or PROD URL'); process.exit(1); }
const esAuth = Buffer.from(`${USER}:${PASS}`).toString('base64');

const pool = new pg.Pool({ connectionString: PROD, max: Math.min(CONCURRENCY + 2, 20) });

/** Fetch list of CVRs to process: prefer active + has regnskab activity */
async function getCvrList() {
  if (CVRS_ARG) {
    console.log(`[1936] Using explicit --cvrs list: ${CVRS_ARG.length} entries`);
    return CVRS_ARG.map(c => String(c).padStart(8, '0'));
  }
  console.log('[1936] Querying candidate CVRs (regnskabspligtige virksomhedsformer, aktive)...');
  // Filter til reelle regnskabspligtige virksomhedsformer (matches cvr_virksomhed.virksomhedsform codes)
  const sql = `
    SELECT cvr FROM cvr_virksomhed
    WHERE status NOT IN ('OPHØRT', 'TVANGSOPLOEST', 'OPLOEST_EFTER_FUSION', 'OPLOEST_EFTER_SPALTNING')
      AND status IS NOT NULL
      AND virksomhedsform IN ('APS','A/S','IVS','P/S','K/S','I/S','AMBA','FON','EFO','SMA','ABA','FMA','KAS','SE','SCE','FFO','UDL','FOR','ØVR','PMV','ANS')
      ${SKIP_CACHED ? `AND cvr NOT IN (SELECT cvr FROM regnskab_cache WHERE es_timestamp LIKE '%_${PARSER_VERSION}')` : ''}
    ORDER BY cvr
    LIMIT $1
  `;
  console.time('[1936] cvr list query');
  const { rows } = await pool.query(sql, [LIMIT]);
  console.timeEnd('[1936] cvr list query');
  return rows.map(r => String(r.cvr).padStart(8, '0'));
}

/** Query ES offentliggoerelser for a single CVR. Returns up to 100 regnskaber sorted by date desc. */
async function fetchRegnskaber(cvr) {
  const esQuery = {
    query: { bool: { must: [{ term: { cvrNummer: parseInt(cvr, 10) } }, { term: { offentliggoerelsestype: 'regnskab' } }] } },
    sort: [{ offentliggoerelsesTidspunkt: { order: 'desc' } }],
    size: 100,
  };
  const res = await fetch('http://distribution.virk.dk/offentliggoerelser/_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip', Authorization: `Basic ${esAuth}` },
    body: JSON.stringify(esQuery),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`ES ${res.status}`);
  const data = await res.json();
  const hits = data.hits?.hits ?? [];
  return hits.map(h => {
    const src = h._source;
    const periode = src.regnskab?.regnskabsperiode;
    const dokumenter = (src.dokumenter || []).filter(d => d.dokumentMimeType?.includes('xml') || d.dokumentMimeType?.includes('xhtml'));
    return {
      offentliggjort: src.offentliggoerelsesTidspunkt,
      periodeStart: periode?.startDato,
      periodeSlut: periode?.slutDato,
      dokumenter,
    };
  }).filter(r => r.periodeStart && r.periodeSlut && r.dokumenter.length > 0);
}

/** Fetch and parse XBRL for a single regnskab. */
async function fetchAndParse(r) {
  const doc = r.dokumenter.find(d => d.dokumentMimeType?.includes('xhtml')) ?? r.dokumenter[0];
  try {
    const xmlRes = await fetch(doc.dokumentUrl, {
      signal: AbortSignal.timeout(45000),
      headers: { 'Accept-Encoding': 'gzip, deflate' },
    });
    if (!xmlRes.ok) return null;
    const xml = await xmlRes.text();
    return parseXbrl(xml, r.periodeStart, r.periodeSlut);
  } catch {
    return null;
  }
}

/** Process one CVR end-to-end: ES → XBRL → parse → upsert. */
async function processCvr(cvr) {
  let regnskaber;
  try {
    regnskaber = await fetchRegnskaber(cvr);
  } catch (e) {
    return { cvr, status: 'es-error', error: e.message };
  }
  if (regnskaber.length === 0) return { cvr, status: 'no-regnskaber' };

  // Limit to MAX_YEARS for backfill speed
  const limited = regnskaber.slice(0, MAX_YEARS);
  const latestOffentliggjort = regnskaber[0].offentliggjort;
  const esTimestamp = `${latestOffentliggjort}_${PARSER_VERSION}`;

  // Parallel-fetch all XBRL for this CVR
  const parsed = (await Promise.all(limited.map(fetchAndParse))).filter(y => y != null);
  if (parsed.length === 0) return { cvr, status: 'parse-failed' };

  const unique = normaliserAlleAar(deduplicateYears(parsed));

  // Upsert into regnskab_cache
  try {
    await pool.query(
      `INSERT INTO regnskab_cache (cvr, years, es_timestamp, fetched_at)
       VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (cvr) DO UPDATE SET
         years = EXCLUDED.years,
         es_timestamp = EXCLUDED.es_timestamp,
         fetched_at = EXCLUDED.fetched_at
       WHERE regnskab_cache.es_timestamp IS DISTINCT FROM EXCLUDED.es_timestamp
          OR jsonb_array_length(regnskab_cache.years) < jsonb_array_length(EXCLUDED.years)`,
      [cvr, JSON.stringify(unique), esTimestamp]
    );
    return { cvr, status: 'ok', years: unique.length };
  } catch (e) {
    return { cvr, status: 'db-error', error: e.message };
  }
}

async function main() {
  console.log(`[1936] Start (concurrency=${CONCURRENCY}, max-years=${MAX_YEARS}, limit=${LIMIT}, skip-cached=${SKIP_CACHED}, parser=${PARSER_VERSION})`);
  const cvrs = await getCvrList();
  console.log(`[1936] ${cvrs.length} candidate CVRs`);

  let processed = 0, ok = 0, noRegn = 0, parseErr = 0, esErr = 0, dbErr = 0, totalYears = 0;
  const start = Date.now();
  for (let i = 0; i < cvrs.length; i += CONCURRENCY) {
    const batch = cvrs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(c => processCvr(c).catch(e => ({ cvr: c, status: 'exception', error: e.message }))));
    for (const r of results) {
      processed++;
      if (r.status === 'ok') { ok++; totalYears += r.years; }
      else if (r.status === 'no-regnskaber') noRegn++;
      else if (r.status === 'parse-failed') parseErr++;
      else if (r.status === 'es-error') esErr++;
      else if (r.status === 'db-error') dbErr++;
      else parseErr++;
    }
    if (processed % PROGRESS_EVERY === 0 || processed === cvrs.length) {
      const elapsed = (Date.now() - start) / 1000;
      const rate = processed / elapsed;
      const eta = (cvrs.length - processed) / rate;
      console.log(`[1936] processed=${processed}/${cvrs.length} (${(processed/cvrs.length*100).toFixed(1)}%) ok=${ok} no-regn=${noRegn} parse-err=${parseErr} es-err=${esErr} db-err=${dbErr} total-years=${totalYears} rate=${rate.toFixed(1)}/s eta=${(eta/60).toFixed(0)}min`);
    }
  }

  console.log(`\n[1936] DONE: ok=${ok}, no-regnskaber=${noRegn}, parse-err=${parseErr}, es-err=${esErr}, db-err=${dbErr}, total-years=${totalYears}`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
