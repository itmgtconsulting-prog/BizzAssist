#!/usr/bin/env node
/**
 * Tinglysning SPREAD backfill — scanner BFE'er spredt over ALLE kommuner.
 *
 * I stedet for sekventiel scanning (giver kun 1 kommune ad gangen),
 * henter vi N BFE'er per kommune for bred dækning.
 *
 * Usage:
 *   node scripts/tl-spread.mjs --env=prod [--per-kommune=500] [--dry-run]
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
const PER_KOMMUNE = (() => { const a = args.find(x => x.startsWith('--per-kommune=')); return a ? parseInt(a.split('=')[1], 10) : 500; })();
const DRY_RUN = args.includes('--dry-run');

const ENV_REFS = { dev: 'wkzwxfhyfmvglrqtmebw', preview: 'rlkjmqjxmkxuclehbrnl', prod: 'xsyldjqcntiygrtfcszm' };
const PROJECT_REF = ENV_REFS[TARGET_ENV];
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

const CONCURRENCY = 6;
const DELAY_MS = 200;
const INSERT_BATCH_SIZE = 40;

if (!ACCESS_TOKEN || !PROJECT_REF) { console.error('Missing credentials'); process.exit(1); }

/**
 * Execute SQL via Supabase Management API.
 */
function runSql(sql) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query: sql });
    const timer = setTimeout(() => { req.destroy(); resolve({ message: 'timeout' }); }, 60000);
    const req = https.request({ hostname: 'api.supabase.com', path: `/v1/projects/${PROJECT_REF}/database/query`, method: 'POST', headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.write(body); req.end();
  });
}

function esc(s) { return s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`; }

function tlFetch(tlPath, accept = 'application/json') {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (v) => { if (!resolved) { resolved = true; resolve(v); } };
    try {
      const req = https.request({ hostname: 'www.tinglysning.dk', path: '/tinglysning/ssl' + tlPath, method: 'GET', pfx, passphrase, headers: { Accept: accept } }, (res) => {
        let d = ''; res.on('data', c => d += c); res.on('end', () => done({ status: res.statusCode, body: d })); res.on('error', () => done({ status: 0, body: '' }));
      });
      req.on('error', () => done({ status: 0, body: '' }));
      req.setTimeout(15000, () => { req.destroy(); done({ status: 0, body: '' }); });
      req.end();
    } catch { done({ status: 0, body: '' }); }
  });
}

async function tlFetchRetry(tlPath, accept = 'application/json', retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await tlFetch(tlPath, accept);
    if (res.status !== 0 || attempt === retries) return res;
    await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
  }
  return { status: 0, body: '' };
}

async function fetchAllForBfe(bfe) {
  const r1 = await tlFetchRetry(`/ejendom/hovednoteringsnummer?hovednoteringsnummer=${bfe}`);
  if (r1.status !== 200 || !r1.body || r1.body === '{}') return { handler: [], haeftelser: [], servitutter: [] };
  let uuid;
  try { uuid = JSON.parse(r1.body)?.items?.[0]?.uuid; } catch { return { handler: [], haeftelser: [], servitutter: [] }; }
  if (!uuid) return { handler: [], haeftelser: [], servitutter: [] };

  const r2 = await tlFetchRetry(`/ejdsummarisk/${uuid}`, 'application/xml');
  if (r2.status !== 200 || !r2.body) return { handler: [], haeftelser: [], servitutter: [] };
  const xml = r2.body;

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
    handler.push({ bfe, dato: effectiveDato, tinglystDato, koebsaftaleDato, kontantKoebesum, iAltKoebesum, koeber, koeberCvr, andelTaeller, andelNaevner });
  }

  const haeftelser = [];
  let prioritet = 0;
  for (const [, e] of [...xml.matchAll(/HaeftelseSummarisk>([\s\S]*?)<\/[^:]*:?HaeftelseSummarisk/g)]) {
    prioritet++;
    haeftelser.push({ bfe, prioritet, type: e.match(/DokumentType[^>]*>([^<]+)/)?.[1] || 'Ukendt', hovedstol: parseInt(e.match(/Hovedstol[^>]*>([^<]+)/)?.[1]?.trim() || '', 10) || null, kreditor: e.match(/KreditorNavn[^>]*>([^<]+)/)?.[1] || null, kreditorCvr: e.match(/VirksomhedCvrNummer[^>]*>([^<]+)/)?.[1] || null, tinglystDato: e.match(/TinglysningsDato[^>]*>([^<]+)/)?.[1]?.split(/[+T]/)[0] || null, aktNavn: e.match(/AktNavn[^>]*>([^<]+)/)?.[1] || null, status: e.match(/Status[^>]*>([^<]+)/)?.[1]?.toLowerCase() || 'gældende' });
  }

  const servitutter = [];
  let servPrioritet = 0;
  for (const [, e] of [...xml.matchAll(/ServitutSummarisk>([\s\S]*?)<\/[^:]*:?ServitutSummarisk/g)]) {
    servPrioritet++;
    servitutter.push({ bfe, prioritet: servPrioritet, tekst: e.match(/ServitutTekst[^>]*>([^<]+)/)?.[1] || 'Ukendt', type: e.match(/ServitutType[^>]*>([^<]+)/)?.[1] || null, tinglystDato: e.match(/TinglysningsDato[^>]*>([^<]+)/)?.[1]?.split(/[+T]/)[0] || null, aktNavn: e.match(/AktNavn[^>]*>([^<]+)/)?.[1] || null, paataleberettiget: e.match(/PaataleBerettiget[^>]*>([^<]+)/)?.[1] || null });
  }

  return { handler, haeftelser, servitutter };
}

async function main() {
  process.on('uncaughtException', (err) => {
    if (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ETIMEDOUT') { console.error(`  [WARN] uncaught ${err.code}`); return; }
    console.error('Fatal:', err); process.exit(1);
  });

  console.log(`Tinglysning SPREAD backfill — env=${TARGET_ENV}, per_kommune=${PER_KOMMUNE}, DRY=${DRY_RUN}`);

  // Step 1: Get all kommuner and pick N random BFEs from each
  console.log('Henter kommuner og BFE-sample...');
  const kommuner = await runSql(`
    SELECT kommune_kode, count(*) as total
    FROM bbr_ejendom_status
    WHERE kommune_kode IS NOT NULL AND is_udfaset = false
    GROUP BY kommune_kode
    ORDER BY kommune_kode
  `);

  if (!Array.isArray(kommuner) || kommuner.length === 0) {
    console.log('Ingen kommuner fundet'); process.exit(0);
  }
  console.log(`${kommuner.length} kommuner fundet`);

  // Step 2: For each kommune, get N random BFEs not already in ejendomshandel
  const allBfes = [];
  for (const k of kommuner) {
    const limit = Math.min(PER_KOMMUNE, k.total);
    const bfes = await runSql(`
      SELECT b.bfe_nummer FROM bbr_ejendom_status b
      WHERE b.kommune_kode = ${k.kommune_kode} AND b.is_udfaset = false
        AND NOT EXISTS (SELECT 1 FROM ejendomshandel e WHERE e.bfe_nummer = b.bfe_nummer)
      ORDER BY random()
      LIMIT ${limit}
    `);
    if (Array.isArray(bfes)) {
      for (const b of bfes) allBfes.push(b.bfe_nummer);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`${allBfes.length} BFE'er at scanne (${kommuner.length} kommuner × ~${PER_KOMMUNE})`);

  if (DRY_RUN) { console.log('DRY RUN — stopper her'); process.exit(0); }

  // Step 3: Scan BFEs (same logic as tl-fast.mjs)
  let processed = 0, errors = 0, noData = 0;
  let handlerTotal = 0, haeftelserTotal = 0, servitutterTotal = 0;
  let handlerBuf = [], haeftelserBuf = [], servitutterBuf = [];
  let insertErrors = 0, bfeSinceFlush = 0;
  const startTime = Date.now();

  async function flushBuffers() {
    const sqls = [];
    if (handlerBuf.length > 0) {
      const rows = [...handlerBuf]; handlerBuf = [];
      const values = rows.map(h => `(${h.bfe}, ${esc(h.dato)}, ${h.tinglystDato ? esc(h.tinglystDato) : 'NULL'}, ${h.koebsaftaleDato ? esc(h.koebsaftaleDato) : 'NULL'}, ${h.kontantKoebesum || 'NULL'}, ${h.iAltKoebesum || 'NULL'}, ${h.andelTaeller || 'NULL'}, ${h.andelNaevner || 'NULL'}, ${h.koeber ? `ARRAY[${esc(h.koeber)}]` : 'NULL'}, ${h.koeberCvr ? `ARRAY[${esc(h.koeberCvr)}]` : 'NULL'}, 'tinglysning-summarisk', now())`).join(',\n');
      sqls.push({ sql: `INSERT INTO ejendomshandel (bfe_nummer, dato, tinglyst_dato, koebsaftale_dato, koebesum, samlet_koebesum, andel_taeller, andel_naevner, koeber_navne, koeber_cvrs, kilde, sidst_opdateret) VALUES ${values} ON CONFLICT DO NOTHING`, count: rows.length, table: 'handler' });
    }
    if (haeftelserBuf.length > 0) {
      const rows = [...haeftelserBuf]; haeftelserBuf = [];
      const values = rows.map(h => `(${h.bfe}, ${h.prioritet}, ${esc(h.type)}, ${h.hovedstol || 'NULL'}, ${esc(h.kreditor)}, ${esc(h.kreditorCvr)}, ${h.tinglystDato ? esc(h.tinglystDato) : 'NULL'}, ${esc(h.aktNavn)}, ${esc(h.status)}, now())`).join(',\n');
      sqls.push({ sql: `INSERT INTO tinglysning_haeftelse (bfe_nummer, prioritet, type, hovedstol_dkk, kreditor_navn, kreditor_cvr, tinglyst_dato, akt_navn, status, sidst_opdateret) VALUES ${values} ON CONFLICT (bfe_nummer, prioritet, status) DO NOTHING`, count: rows.length, table: 'haeftelser' });
    }
    if (servitutterBuf.length > 0) {
      const rows = [...servitutterBuf]; servitutterBuf = [];
      const values = rows.map(s => `(${s.bfe}, ${s.prioritet || 'NULL'}, ${esc(s.tekst)}, ${esc(s.type)}, ${s.tinglystDato ? esc(s.tinglystDato) : 'NULL'}, ${esc(s.aktNavn)}, ${esc(s.paataleberettiget)}, now())`).join(',\n');
      sqls.push({ sql: `INSERT INTO tinglysning_servitut (bfe_nummer, prioritet, tekst, type, tinglyst_dato, akt_navn, paataleberettiget, sidst_opdateret) VALUES ${values} ON CONFLICT DO NOTHING`, count: rows.length, table: 'servitutter' });
    }
    for (const { sql, count, table } of sqls) {
      const r = await runSql(sql);
      if (r?.message) { insertErrors++; if (insertErrors <= 5) console.error(`  [INSERT ERR] ${table}: ${r.message}`); }
      else { if (table === 'handler') handlerTotal += count; else if (table === 'haeftelser') haeftelserTotal += count; else servitutterTotal += count; }
    }
  }

  for (let i = 0; i < allBfes.length; i += CONCURRENCY) {
    try {
      const batch = allBfes.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map(bfe => fetchAllForBfe(bfe)));
      for (const result of results) {
        processed++;
        if (result.status === 'rejected') { errors++; continue; }
        const { handler, haeftelser, servitutter } = result.value;
        if (handler.length === 0 && haeftelser.length === 0 && servitutter.length === 0) { noData++; continue; }
        handlerBuf.push(...handler); haeftelserBuf.push(...haeftelser); servitutterBuf.push(...servitutter);
        bfeSinceFlush++;
      }
    } catch (loopErr) {
      errors++;
      if (errors <= 10) console.error(`  [WARN] batch error: ${loopErr.code || loopErr.message}`);
    }
    if (bfeSinceFlush >= INSERT_BATCH_SIZE) { await flushBuffers(); bfeSinceFlush = 0; }
    if (processed % 300 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      console.log(`  [${processed}/${allBfes.length}] handler=${handlerTotal} haeft=${haeftelserTotal} serv=${servitutterTotal} noData=${noData} err=${errors} iErr=${insertErrors} ${(processed/elapsed).toFixed(1)} BFE/s`);
    }
    await new Promise(r => setTimeout(r, DELAY_MS));
  }
  await flushBuffers();

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\nDone! ${elapsed} min, processed=${processed}, handler=${handlerTotal}, haeft=${haeftelserTotal}, serv=${servitutterTotal}, noData=${noData}, errors=${errors}, iErr=${insertErrors}`);

  // Step 4: Sync prices to ejerskifte_historik
  console.log('\nSyncing prices to ejerskifte_historik...');
  const sync = await runSql(`
    UPDATE ejerskifte_historik h
    SET kontant_koebesum = sub.koebesum::bigint, i_alt_koebesum = sub.samlet_koebesum::bigint
    FROM (
      SELECT DISTINCT ON (e.bfe_nummer, e.dato) e.bfe_nummer, e.dato, e.koebesum, e.samlet_koebesum, h2.id as hist_id
      FROM ejendomshandel e JOIN ejerskifte_historik h2 ON h2.bfe_nummer = e.bfe_nummer AND ABS(h2.overtagelsesdato - e.dato) <= 365
      WHERE e.koebesum IS NOT NULL AND h2.kontant_koebesum IS NULL
      ORDER BY e.bfe_nummer, e.dato, ABS(h2.overtagelsesdato - e.dato)
    ) sub WHERE h.id = sub.hist_id
  `);
  console.log('Price sync done:', JSON.stringify(sync)?.substring(0, 100));
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
