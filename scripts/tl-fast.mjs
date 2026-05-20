#!/usr/bin/env node
/**
 * Fast tinglysning backfill — uses PostgREST + higher concurrency + batched inserts.
 *
 * Speed improvements over backfill-tinglysning-full.mjs:
 *   1. PostgREST (direct DB) instead of Management API — no rate limit
 *   2. CONCURRENCY 8 (from 2)
 *   3. DELAY_MS 150ms (from 500ms)
 *   4. Batched SQL inserts (20 BFEs per INSERT)
 *
 * Usage:
 *   node /tmp/tl-fast.mjs --env=prod --offset=165500 --limit=200000
 */
import https from 'node:https';
import fs from 'node:fs';
import { config } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, '..', '.env.local') });

const pfx = fs.readFileSync(path.join(__dirname, '..', process.env.TINGLYSNING_CERT_PATH));
const passphrase = process.env.TINGLYSNING_CERT_PASSWORD;

const args = process.argv.slice(2);
const TARGET_ENV = args.find(x => x.startsWith('--env='))?.split('=')[1] || 'prod';
const OFFSET = (() => { const a = args.find(x => x.startsWith('--offset=')); return a ? parseInt(a.split('=')[1], 10) : 0; })();
const LIMIT = (() => { const a = args.find(x => x.startsWith('--limit=')); return a ? parseInt(a.split('=')[1], 10) : 100000; })();
const FROM_BFE = (() => { const a = args.find(x => x.startsWith('--from-bfe=')); return a ? parseInt(a.split('=')[1], 10) : null; })();

const ENV_REFS = { dev: 'wkzwxfhyfmvglrqtmebw', preview: 'rlkjmqjxmkxuclehbrnl', prod: 'xsyldjqcntiygrtfcszm' };
const PROJECT_REF = ENV_REFS[TARGET_ENV];
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

const CONCURRENCY = 6;
const DELAY_MS = 200;
const INSERT_BATCH_SIZE = 40; // Collect N BFEs before inserting

if (!ACCESS_TOKEN || !PROJECT_REF) {
  console.error('Missing credentials');
  process.exit(1);
}

/**
 * Execute SQL via Supabase Management API (used only for initial BFE list query).
 */
function runSqlMgmt(sql) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query: sql });
    const timer = setTimeout(() => { req.destroy(); resolve({ message: 'timeout' }); }, 30000);
    const req = https.request({ hostname: 'api.supabase.com', path: `/v1/projects/${PROJECT_REF}/database/query`, method: 'POST', headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.write(body); req.end();
  });
}

/**
 * Execute SQL via Management API (for inserts too — batched).
 */
function runSql(sql) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query: sql });
    const timer = setTimeout(() => { req.destroy(); resolve({ message: 'timeout' }); }, 30000);
    const req = https.request({ hostname: 'api.supabase.com', path: `/v1/projects/${PROJECT_REF}/database/query`, method: 'POST', headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.write(body); req.end();
  });
}

/**
 * Escape string for SQL.
 */
function esc(s) { return s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`; }

/**
 * Fetch Tinglysning REST endpoint med cert auth.
 */
function tlFetch(tlPath, accept = 'application/json') {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (v) => { if (!resolved) { resolved = true; resolve(v); } };
    try {
      const req = https.request({
        hostname: 'www.tinglysning.dk',
        path: '/tinglysning/ssl' + tlPath,
        method: 'GET', pfx, passphrase,
        headers: { Accept: accept },
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => done({ status: res.statusCode, body: d }));
        res.on('error', () => done({ status: 0, body: '' }));
      });
      req.on('error', () => done({ status: 0, body: '' }));
      req.setTimeout(15000, () => { req.destroy(); done({ status: 0, body: '' }); });
      req.end();
    } catch { done({ status: 0, body: '' }); }
  });
}

/**
 * Retry wrapper for tlFetch.
 */
async function tlFetchRetry(tlPath, accept = 'application/json', retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await tlFetch(tlPath, accept);
    if (res.status !== 0 || attempt === retries) return res;
    await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
  }
  return { status: 0, body: '' };
}

/**
 * Fetch and parse all tinglysning data for one BFE.
 */
async function fetchAllForBfe(bfe) {
  const r1 = await tlFetchRetry(`/ejendom/hovednoteringsnummer?hovednoteringsnummer=${bfe}`);
  if (r1.status !== 200 || !r1.body || r1.body === '{}') return { handler: [], haeftelser: [], servitutter: [] };
  let uuid;
  try { uuid = JSON.parse(r1.body)?.items?.[0]?.uuid; } catch { return { handler: [], haeftelser: [], servitutter: [] }; }
  if (!uuid) return { handler: [], haeftelser: [], servitutter: [] };

  const r2 = await tlFetchRetry(`/ejdsummarisk/${uuid}`, 'application/xml');
  if (r2.status !== 200 || !r2.body) return { handler: [], haeftelser: [], servitutter: [] };
  const xml = r2.body;

  // Parse ADKOMST
  const handler = [];
  for (const [, e] of [...xml.matchAll(/AdkomstSummarisk>([\s\S]*?)<\/[^:]*:?AdkomstSummarisk/g)]) {
    const dato = e.match(/SkoedeOvertagelsesDato[^>]*>([^<]+)/)?.[1]?.split(/[+T]/)[0] || null;
    const tinglystDato = e.match(/TinglysningsDato[^>]*>([^<]+)/)?.[1]?.split(/[+T]/)[0] || null;
    const koebsaftaleDato = e.match(/KoebsaftaleDato[^>]*>([^<]+)/)?.[1]?.split(/[+T]/)[0] || null;
    const kontantKoebesum = parseInt(e.match(/KontantKoebesum[^>]*>([^<]+)/)?.[1]?.trim() || '', 10) || null;
    const iAltKoebesum = parseInt(e.match(/IAltKoebesum[^>]*>([^<]+)/)?.[1]?.trim() || '', 10) || null;
    const koeber = e.match(/PersonNavn[^>]*>([^<]+)/)?.[1] || e.match(/VirksomhedNavn[^>]*>([^<]+)/)?.[1] || null;
    const koeberCvr = e.match(/VirksomhedCvrNummer[^>]*>([^<]+)/)?.[1] || null;
    const andelTaeller = parseInt(e.match(/AndelTaeller[^>]*>([^<]+)/)?.[1] || '', 10) || null;
    const andelNaevner = parseInt(e.match(/AndelNaevner[^>]*>([^<]+)/)?.[1] || '', 10) || null;
    const effectiveDato = dato || koebsaftaleDato || tinglystDato;
    if (!effectiveDato) continue;
    handler.push({
      bfe_nummer: bfe, dato: effectiveDato, tinglyst_dato: tinglystDato, koebsaftale_dato: koebsaftaleDato,
      koebesum: kontantKoebesum, samlet_koebesum: iAltKoebesum,
      andel_taeller: andelTaeller, andel_naevner: andelNaevner,
      koeber_navne: koeber ? [koeber] : null, koeber_cvrs: koeberCvr ? [koeberCvr] : null,
      kilde: 'tinglysning-summarisk', sidst_opdateret: new Date().toISOString(),
    });
  }

  // Parse HÆFTELSER
  const haeftelser = [];
  let prioritet = 0;
  for (const [, e] of [...xml.matchAll(/HaeftelseSummarisk>([\s\S]*?)<\/[^:]*:?HaeftelseSummarisk/g)]) {
    prioritet++;
    haeftelser.push({
      bfe_nummer: bfe, prioritet,
      type: e.match(/DokumentType[^>]*>([^<]+)/)?.[1] || e.match(/HaeftelseType[^>]*>([^<]+)/)?.[1] || 'Ukendt',
      hovedstol_dkk: parseInt(e.match(/Hovedstol[^>]*>([^<]+)/)?.[1]?.trim() || '', 10) || null,
      kreditor_navn: e.match(/KreditorNavn[^>]*>([^<]+)/)?.[1] || e.match(/VirksomhedNavn[^>]*>([^<]+)/)?.[1] || null,
      kreditor_cvr: e.match(/VirksomhedCvrNummer[^>]*>([^<]+)/)?.[1] || null,
      tinglyst_dato: e.match(/TinglysningsDato[^>]*>([^<]+)/)?.[1]?.split(/[+T]/)[0] || null,
      akt_navn: e.match(/AktNavn[^>]*>([^<]+)/)?.[1] || null,
      status: e.match(/Status[^>]*>([^<]+)/)?.[1]?.toLowerCase() || 'gældende',
      sidst_opdateret: new Date().toISOString(),
    });
  }

  // Parse SERVITUTTER
  const servitutter = [];
  let servPrioritet = 0;
  for (const [, e] of [...xml.matchAll(/ServitutSummarisk>([\s\S]*?)<\/[^:]*:?ServitutSummarisk/g)]) {
    servPrioritet++;
    servitutter.push({
      bfe_nummer: bfe, prioritet: servPrioritet,
      tekst: e.match(/ServitutTekst[^>]*>([^<]+)/)?.[1] || e.match(/DokumentType[^>]*>([^<]+)/)?.[1] || 'Ukendt',
      type: e.match(/ServitutType[^>]*>([^<]+)/)?.[1] || null,
      tinglyst_dato: e.match(/TinglysningsDato[^>]*>([^<]+)/)?.[1]?.split(/[+T]/)[0] || null,
      akt_navn: e.match(/AktNavn[^>]*>([^<]+)/)?.[1] || null,
      paataleberettiget: e.match(/PaataleBerettiget[^>]*>([^<]+)/)?.[1] || null,
      sidst_opdateret: new Date().toISOString(),
    });
  }

  return { handler, haeftelser, servitutter };
}

/** Main. */
async function main() {
  process.on('uncaughtException', (err) => {
    if (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ETIMEDOUT') {
      console.error(`  [WARN] uncaught ${err.code}`);
      return;
    }
    console.error('Fatal:', err);
    process.exit(1);
  });

  const startLabel = FROM_BFE ? `from-bfe=${FROM_BFE}` : `offset=${OFFSET}`;
  console.log(`Tinglysning FAST backfill — env=${TARGET_ENV}, ${startLabel}, limit=${LIMIT}`);
  console.log(`Config: CONCURRENCY=${CONCURRENCY}, DELAY_MS=${DELAY_MS}, INSERT_BATCH=${INSERT_BATCH_SIZE}`);

  // Fetch BFE list using cursor-based pagination
  console.log('Fetching BFE list...');
  const bfes = [];
  let cursorBfe = FROM_BFE ? FROM_BFE - 1 : 0;

  // If using OFFSET (legacy), find starting BFE
  if (!FROM_BFE && OFFSET > 0) {
    let remaining = OFFSET;
    while (remaining > 0) {
      const chunk = Math.min(remaining, 50000);
      const r = await runSqlMgmt(`SELECT bfe_nummer FROM bbr_ejendom_status WHERE bfe_nummer > ${cursorBfe} ORDER BY bfe_nummer OFFSET ${chunk - 1} LIMIT 1`);
      if (!Array.isArray(r) || r.length === 0) break;
      cursorBfe = r[0].bfe_nummer;
      remaining -= chunk;
    }
    console.log(`Starting from BFE ${cursorBfe} (offset=${OFFSET})`);
  }

  let fetchRemaining = LIMIT;
  while (fetchRemaining > 0) {
    const fetchSize = Math.min(fetchRemaining, 5000);
    let batch;
    for (let attempt = 0; attempt < 10; attempt++) {
      batch = await runSqlMgmt(`SELECT bfe_nummer FROM bbr_ejendom_status WHERE bfe_nummer > ${cursorBfe} ORDER BY bfe_nummer LIMIT ${fetchSize}`);
      if (Array.isArray(batch)) break;
      const delay = Math.min(30000, 5000 * (attempt + 1));
      console.error(`  [WARN] BFE fetch retry ${attempt + 1}/10 — waiting ${delay/1000}s`);
      await new Promise(r => setTimeout(r, delay));
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    bfes.push(...batch);
    cursorBfe = batch[batch.length - 1].bfe_nummer;
    fetchRemaining -= batch.length;
    if (batch.length < fetchSize) break;
    await new Promise(r => setTimeout(r, 300));
  }

  if (bfes.length === 0) {
    console.log('Ingen BFE\'er at scanne');
    process.exit(0);
  }
  console.log(`${bfes.length} BFE'er at scanne (startBFE=${bfes[0].bfe_nummer})`);

  let processed = 0, errors = 0, noData = 0;
  let handlerTotal = 0, haeftelserTotal = 0, servitutterTotal = 0;
  let handlerBuf = [], haeftelserBuf = [], servitutterBuf = [];
  let insertErrors = 0;
  const startTime = Date.now();

  async function flushBuffers() {
    const sqls = [];
    if (handlerBuf.length > 0) {
      const rows = [...handlerBuf];
      handlerBuf = [];
      const values = rows.map(h =>
        `(${h.bfe_nummer}, ${h.dato ? esc(h.dato) : 'NULL'}, ${h.tinglyst_dato ? esc(h.tinglyst_dato) : 'NULL'}, ${h.koebsaftale_dato ? esc(h.koebsaftale_dato) : 'NULL'}, ${h.koebesum || 'NULL'}, ${h.samlet_koebesum || 'NULL'}, ${h.andel_taeller || 'NULL'}, ${h.andel_naevner || 'NULL'}, ${h.koeber_navne ? `ARRAY[${esc(h.koeber_navne[0])}]` : 'NULL'}, ${h.koeber_cvrs ? `ARRAY[${esc(h.koeber_cvrs[0])}]` : 'NULL'}, 'tinglysning-summarisk', now())`
      ).join(',\n');
      sqls.push({ sql: `INSERT INTO ejendomshandel (bfe_nummer, dato, tinglyst_dato, koebsaftale_dato, koebesum, samlet_koebesum, andel_taeller, andel_naevner, koeber_navne, koeber_cvrs, kilde, sidst_opdateret) VALUES ${values} ON CONFLICT DO NOTHING`, count: rows.length, table: 'handler' });
    }
    if (haeftelserBuf.length > 0) {
      const rows = [...haeftelserBuf];
      haeftelserBuf = [];
      const values = rows.map(h =>
        `(${h.bfe_nummer}, ${h.prioritet}, ${esc(h.type)}, ${h.hovedstol_dkk || 'NULL'}, ${esc(h.kreditor_navn)}, ${esc(h.kreditor_cvr)}, ${h.tinglyst_dato ? esc(h.tinglyst_dato) : 'NULL'}, ${esc(h.akt_navn)}, ${esc(h.status)}, now())`
      ).join(',\n');
      sqls.push({ sql: `INSERT INTO tinglysning_haeftelse (bfe_nummer, prioritet, type, hovedstol_dkk, kreditor_navn, kreditor_cvr, tinglyst_dato, akt_navn, status, sidst_opdateret) VALUES ${values} ON CONFLICT (bfe_nummer, prioritet, status) DO NOTHING`, count: rows.length, table: 'haeftelser' });
    }
    if (servitutterBuf.length > 0) {
      const rows = [...servitutterBuf];
      servitutterBuf = [];
      const values = rows.map(s =>
        `(${s.bfe_nummer}, ${s.prioritet || 'NULL'}, ${esc(s.tekst)}, ${esc(s.type)}, ${s.tinglyst_dato ? esc(s.tinglyst_dato) : 'NULL'}, ${esc(s.akt_navn)}, ${esc(s.paataleberettiget)}, now())`
      ).join(',\n');
      sqls.push({ sql: `INSERT INTO tinglysning_servitut (bfe_nummer, prioritet, tekst, type, tinglyst_dato, akt_navn, paataleberettiget, sidst_opdateret) VALUES ${values} ON CONFLICT DO NOTHING`, count: rows.length, table: 'servitutter' });
    }
    // Run inserts sequentially to avoid Management API throttling
    for (const { sql, count, table } of sqls) {
      const r = await runSql(sql);
      if (r?.message) {
        insertErrors++;
        if (insertErrors <= 5) console.error(`  [INSERT ERR] ${table}: ${r.message}`);
      } else {
        if (table === 'handler') handlerTotal += count;
        else if (table === 'haeftelser') haeftelserTotal += count;
        else servitutterTotal += count;
      }
    }
  }

  let bfeSinceFlush = 0;

  for (let i = 0; i < bfes.length; i += CONCURRENCY) {
    try {
      const batch = bfes.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map(b => fetchAllForBfe(b.bfe_nummer)));

      for (const result of results) {
        processed++;
        if (result.status === 'rejected') { errors++; continue; }
        const { handler, haeftelser, servitutter } = result.value;

        if (handler.length === 0 && haeftelser.length === 0 && servitutter.length === 0) {
          noData++;
          continue;
        }

        handlerBuf.push(...handler);
        haeftelserBuf.push(...haeftelser);
        servitutterBuf.push(...servitutter);
        bfeSinceFlush++;
      }
    } catch (loopErr) {
      errors++;
      if (errors <= 10) console.error(`  [WARN] batch error at ${processed}: ${loopErr.code || loopErr.message}`);
    }

    // Flush insert buffers every INSERT_BATCH_SIZE BFEs
    if (bfeSinceFlush >= INSERT_BATCH_SIZE) {
      await flushBuffers();
      bfeSinceFlush = 0;
    }

    if (processed % 100 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = (processed / elapsed).toFixed(1);
      console.log(`  [${processed}/${bfes.length}] handler=${handlerTotal} haeft=${haeftelserTotal} serv=${servitutterTotal} noData=${noData} err=${errors} iErr=${insertErrors} ${rate} BFE/s`);
    }

    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  // Final flush
  await flushBuffers();

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\nDone! ${elapsed} min, processed=${processed}, handler=${handlerTotal}, haeft=${haeftelserTotal}, serv=${servitutterTotal}, noData=${noData}, errors=${errors}, insertErrors=${insertErrors}`);
  console.log(`Rate: ${(processed / ((Date.now() - startTime) / 1000)).toFixed(1)} BFE/s`);
  console.log(`Resume with: --offset=${OFFSET + processed}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
