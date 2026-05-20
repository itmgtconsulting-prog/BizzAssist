#!/usr/bin/env node
/**
 * BIZZ-1566: Fuld tinglysning-backfill — adkomst + hæftelser + servitutter.
 *
 * Scanner alle BFE'er via Tinglysning SSL cert-auth og populerer:
 *   - ejendomshandel (adkomst/salgshistorik)
 *   - tinglysning_haeftelse (pant/realkreditlån)
 *   - tinglysning_servitut (servitutter)
 *
 * Ét Tinglysning-kald per BFE giver alle 3 datatyper.
 * Resumable via --offset. Rate limit: 2 req/sec.
 *
 * Usage:
 *   node scripts/backfill-tinglysning-full.mjs --env=prod [--offset=0] [--limit=100000] [--dry-run]
 *
 * Estimeret tid: ~2.5M BFE × 0.5s = ~350 timer for fuld scan.
 * Kør i daglige chunks af 50-100K.
 */
import https from 'node:https';
import fs from 'node:fs';
import { config } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

config({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const pfx = fs.readFileSync(path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', process.env.TINGLYSNING_CERT_PATH));
const passphrase = process.env.TINGLYSNING_CERT_PASSWORD;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const TARGET_ENV = args.find((x) => x.startsWith('--env='))?.split('=')[1] || 'prod';
const OFFSET = (() => { const a = args.find(x => x.startsWith('--offset=')); return a ? parseInt(a.split('=')[1], 10) : 0; })();
const LIMIT = (() => { const a = args.find(x => x.startsWith('--limit=')); return a ? parseInt(a.split('=')[1], 10) : 100000; })();

const ENV_REFS = { dev: 'wkzwxfhyfmvglrqtmebw', preview: 'rlkjmqjxmkxuclehbrnl', prod: 'xsyldjqcntiygrtfcszm' };
const PROJECT_REF = ENV_REFS[TARGET_ENV];
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

if (!ACCESS_TOKEN || !PROJECT_REF) { console.error('Missing credentials'); process.exit(1); }

const CONCURRENCY = 2;
const DELAY_MS = 500;

/**
 * Execute SQL via Supabase Management API.
 *
 * @param sql - SQL query
 * @returns Parsed response
 */
function runSql(sql) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query: sql });
    const timer = setTimeout(() => { req.destroy(); resolve({ message: 'timeout' }); }, 30000);
    const req = https.request({ hostname: 'api.supabase.com', path: `/v1/projects/${PROJECT_REF}/database/query`, method: 'POST', headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(d)); } catch { resolve(d); } }); });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.write(body); req.end();
  });
}

/**
 * Fetch Tinglysning REST endpoint med cert auth.
 *
 * @param tlPath - Path efter /tinglysning/ssl
 * @param accept - Accept header
 * @returns {{ status: number, body: string }}
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
 * Escape string for SQL.
 */
function esc(s) { return s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`; }

/**
 * Hent og parse alle tinglysningsdata for ét BFE.
 *
 * @param bfe - BFE-nummer
 * @returns {{ handler: Array, haeftelser: Array, servitutter: Array }}
 */
async function fetchAllForBfe(bfe) {
  // Step 1: BFE → UUID
  const r1 = await tlFetchRetry(`/ejendom/hovednoteringsnummer?hovednoteringsnummer=${bfe}`);
  if (r1.status !== 200 || !r1.body || r1.body === '{}') return { handler: [], haeftelser: [], servitutter: [] };
  let uuid;
  try { uuid = JSON.parse(r1.body)?.items?.[0]?.uuid; } catch { return { handler: [], haeftelser: [], servitutter: [] }; }
  if (!uuid) return { handler: [], haeftelser: [], servitutter: [] };

  // Step 2: UUID → summarisk XML (indeholder adkomst + hæftelser + servitutter)
  const r2 = await tlFetchRetry(`/ejdsummarisk/${uuid}`, 'application/xml');
  if (r2.status !== 200 || !r2.body) return { handler: [], haeftelser: [], servitutter: [] };
  const xml = r2.body;

  // === Parse ADKOMST (handler) ===
  const handler = [];
  const adkomstEntries = [...xml.matchAll(/AdkomstSummarisk>([\s\S]*?)<\/[^:]*:?AdkomstSummarisk/g)];
  for (const [, e] of adkomstEntries) {
    const dato = e.match(/SkoedeOvertagelsesDato[^>]*>([^<]+)/)?.[1]?.split(/[+T]/)[0] || null;
    const tinglystDato = e.match(/TinglysningsDato[^>]*>([^<]+)/)?.[1]?.split(/[+T]/)[0] || null;
    const koebsaftaleDato = e.match(/KoebsaftaleDato[^>]*>([^<]+)/)?.[1]?.split(/[+T]/)[0] || null;
    const kontantKoebesum = parseInt(e.match(/KontantKoebesum[^>]*>([^<]+)/)?.[1]?.trim() || '', 10) || null;
    const iAltKoebesum = parseInt(e.match(/IAltKoebesum[^>]*>([^<]+)/)?.[1]?.trim() || '', 10) || null;
    const koeber = e.match(/PersonNavn[^>]*>([^<]+)/)?.[1] || e.match(/VirksomhedNavn[^>]*>([^<]+)/)?.[1] || null;
    const koeberCvr = e.match(/VirksomhedCvrNummer[^>]*>([^<]+)/)?.[1] || null;
    const andelTaeller = parseInt(e.match(/AndelTaeller[^>]*>([^<]+)/)?.[1] || '', 10) || null;
    const andelNaevner = parseInt(e.match(/AndelNaevner[^>]*>([^<]+)/)?.[1] || '', 10) || null;
    if (!dato && !kontantKoebesum) continue;
    handler.push({ bfe, dato, tinglystDato, koebsaftaleDato, kontantKoebesum, iAltKoebesum, koeber, koeberCvr, andelTaeller, andelNaevner });
  }

  // === Parse HÆFTELSER ===
  const haeftelser = [];
  const haeftelseEntries = [...xml.matchAll(/HaeftelseSummarisk>([\s\S]*?)<\/[^:]*:?HaeftelseSummarisk/g)];
  let prioritet = 0;
  for (const [, e] of haeftelseEntries) {
    prioritet++;
    const type = e.match(/DokumentType[^>]*>([^<]+)/)?.[1] || e.match(/HaeftelseType[^>]*>([^<]+)/)?.[1] || 'Ukendt';
    const hovedstol = parseInt(e.match(/Hovedstol[^>]*>([^<]+)/)?.[1]?.trim() || '', 10) || null;
    const kreditor = e.match(/KreditorNavn[^>]*>([^<]+)/)?.[1] || e.match(/VirksomhedNavn[^>]*>([^<]+)/)?.[1] || null;
    const kreditorCvr = e.match(/VirksomhedCvrNummer[^>]*>([^<]+)/)?.[1] || null;
    const tinglystDato = e.match(/TinglysningsDato[^>]*>([^<]+)/)?.[1]?.split(/[+T]/)[0] || null;
    const aktNavn = e.match(/AktNavn[^>]*>([^<]+)/)?.[1] || null;
    const status = e.match(/Status[^>]*>([^<]+)/)?.[1]?.toLowerCase() || 'gældende';
    haeftelser.push({ bfe, prioritet, type, hovedstol, kreditor, kreditorCvr, tinglystDato, aktNavn, status });
  }

  // === Parse SERVITUTTER ===
  const servitutter = [];
  const servitutEntries = [...xml.matchAll(/ServitutSummarisk>([\s\S]*?)<\/[^:]*:?ServitutSummarisk/g)];
  let servPrioritet = 0;
  for (const [, e] of servitutEntries) {
    servPrioritet++;
    const tekst = e.match(/ServitutTekst[^>]*>([^<]+)/)?.[1] || e.match(/DokumentType[^>]*>([^<]+)/)?.[1] || 'Ukendt';
    const type = e.match(/ServitutType[^>]*>([^<]+)/)?.[1] || null;
    const tinglystDato = e.match(/TinglysningsDato[^>]*>([^<]+)/)?.[1]?.split(/[+T]/)[0] || null;
    const aktNavn = e.match(/AktNavn[^>]*>([^<]+)/)?.[1] || null;
    const paataleberettiget = e.match(/PaataleBerettiget[^>]*>([^<]+)/)?.[1] || null;
    servitutter.push({ bfe, prioritet: servPrioritet, tekst, type, tinglystDato, aktNavn, paataleberettiget });
  }

  return { handler, haeftelser, servitutter };
}

/**
 * Insert handler for ét BFE i ejendomshandel.
 */
async function insertHandler(handler) {
  if (handler.length === 0) return 0;
  const values = handler.map(h =>
    `(${h.bfe}, ${h.dato ? esc(h.dato) : 'NULL'}, ${h.tinglystDato ? esc(h.tinglystDato) : 'NULL'}, ${h.koebsaftaleDato ? esc(h.koebsaftaleDato) : 'NULL'}, ${h.kontantKoebesum || 'NULL'}, ${h.iAltKoebesum || 'NULL'}, ${h.andelTaeller || 'NULL'}, ${h.andelNaevner || 'NULL'}, ${h.koeber ? `ARRAY[${esc(h.koeber)}]` : 'NULL'}, ${h.koeberCvr ? `ARRAY[${esc(h.koeberCvr)}]` : 'NULL'}, 'tinglysning-summarisk', now())`
  ).join(',\n');
  const sql = `INSERT INTO ejendomshandel (bfe_nummer, dato, tinglyst_dato, koebsaftale_dato, koebesum, samlet_koebesum, andel_taeller, andel_naevner, koeber_navne, koeber_cvrs, kilde, sidst_opdateret) VALUES ${values} ON CONFLICT DO NOTHING`;
  const r = await runSql(sql);
  return r?.message ? 0 : handler.length;
}

/**
 * Insert hæftelser for ét BFE.
 */
async function insertHaeftelser(haeftelser) {
  if (haeftelser.length === 0) return 0;
  const values = haeftelser.map(h =>
    `(${h.bfe}, ${h.prioritet}, ${esc(h.type)}, ${h.hovedstol || 'NULL'}, ${esc(h.kreditor)}, ${esc(h.kreditorCvr)}, ${h.tinglystDato ? esc(h.tinglystDato) : 'NULL'}, ${esc(h.aktNavn)}, ${esc(h.status)}, now())`
  ).join(',\n');
  const sql = `INSERT INTO tinglysning_haeftelse (bfe_nummer, prioritet, type, hovedstol_dkk, kreditor_navn, kreditor_cvr, tinglyst_dato, akt_navn, status, sidst_opdateret) VALUES ${values} ON CONFLICT (bfe_nummer, prioritet, status) DO NOTHING`;
  const r = await runSql(sql);
  return r?.message ? 0 : haeftelser.length;
}

/**
 * Insert servitutter for ét BFE.
 */
async function insertServitutter(servitutter) {
  if (servitutter.length === 0) return 0;
  const values = servitutter.map(s =>
    `(${s.bfe}, ${s.prioritet || 'NULL'}, ${esc(s.tekst)}, ${esc(s.type)}, ${s.tinglystDato ? esc(s.tinglystDato) : 'NULL'}, ${esc(s.aktNavn)}, ${esc(s.paataleberettiget)}, now())`
  ).join(',\n');
  const sql = `INSERT INTO tinglysning_servitut (bfe_nummer, prioritet, tekst, type, tinglyst_dato, akt_navn, paataleberettiget, sidst_opdateret) VALUES ${values} ON CONFLICT DO NOTHING`;
  const r = await runSql(sql);
  return r?.message ? 0 : servitutter.length;
}

/**
 * Wrap tlFetch with retry logic for transient TLS errors (ECONNRESET).
 *
 * @param tlPath - Path efter /tinglysning/ssl
 * @param accept - Accept header
 * @param retries - Number of retries
 * @returns {{ status: number, body: string }}
 */
async function tlFetchRetry(tlPath, accept = 'application/json', retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await tlFetch(tlPath, accept);
    if (res.status !== 0 || attempt === retries) return res;
    await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
  }
  return { status: 0, body: '' };
}

/** Main. */
async function main() {
  // Catch stray TLS socket errors that bypass req.on('error')
  process.on('uncaughtException', (err) => {
    if (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ETIMEDOUT') {
      console.error(`  [WARN] uncaught ${err.code} — ignoring`);
      return;
    }
    console.error('Fatal:', err);
    process.exit(1);
  });
  console.log(`Tinglysning full backfill — env=${TARGET_ENV}, offset=${OFFSET}, limit=${LIMIT}, DRY=${DRY_RUN}`);

  // Hent BFE-batch via cursor-pagination
  const bfes = await runSql(`
    SELECT bfe_nummer FROM bbr_ejendom_status
    ORDER BY bfe_nummer
    OFFSET ${OFFSET} LIMIT ${LIMIT}
  `);

  if (!Array.isArray(bfes) || bfes.length === 0) {
    console.log('Ingen BFE\'er at scanne');
    process.exit(0);
  }
  console.log(`${bfes.length} BFE'er at scanne (offset=${OFFSET})`);

  let processed = 0;
  let handlerTotal = 0, haeftelserTotal = 0, servitutterTotal = 0;
  let errors = 0;
  let noData = 0;

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

        if (!DRY_RUN) {
          handlerTotal += await insertHandler(handler);
          haeftelserTotal += await insertHaeftelser(haeftelser);
          servitutterTotal += await insertServitutter(servitutter);
        } else {
          handlerTotal += handler.length;
          haeftelserTotal += haeftelser.length;
          servitutterTotal += servitutter.length;
        }
      }
    } catch (loopErr) {
      errors++;
      if (errors <= 10) console.error(`  [WARN] batch error at ${processed}: ${loopErr.code || loopErr.message}`);
    }

    if (processed % 100 === 0) {
      console.log(`  [${processed}/${bfes.length}] handler=${handlerTotal} haeftelser=${haeftelserTotal} servitutter=${servitutterTotal} noData=${noData} errors=${errors}`);
    }

    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log(`\nDone! processed=${processed}, handler=${handlerTotal}, haeftelser=${haeftelserTotal}, servitutter=${servitutterTotal}, noData=${noData}, errors=${errors}`);
  console.log(`Resume with: --offset=${OFFSET + processed}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
