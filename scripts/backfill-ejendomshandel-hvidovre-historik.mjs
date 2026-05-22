#!/usr/bin/env node
/**
 * Backfill ejendomshandel med ALLE historiske handler for Hvidovre (kommune 167).
 * Ingen årsfilter — henter alt tilgængeligt fra Tinglysning summarisk.
 * Inkluderer ALLE ejendomstyper (ikke kun boliger).
 *
 * Usage:
 *   node scripts/backfill-ejendomshandel-hvidovre-historik.mjs [--env=prod] [--offset=0] [--dry-run]
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

const ENV_REFS = { dev: 'wkzwxfhyfmvglrqtmebw', preview: 'rlkjmqjxmkxuclehbrnl', prod: 'xsyldjqcntiygrtfcszm' };
const PROJECT_REF = ENV_REFS[TARGET_ENV];
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

if (!ACCESS_TOKEN || !PROJECT_REF) { console.error('Missing credentials'); process.exit(1); }

const KOMMUNE_KODE = 167;
const CONCURRENCY = 2;
const DELAY_MS = 500;

/**
 * Execute SQL via Supabase Management API.
 *
 * @param {string} sql - SQL query
 * @returns {Promise<object[]>} Parsed response
 */
async function runSql(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const txt = await res.text();
    return { message: `SQL error (${res.status}): ${txt.slice(0, 200)}` };
  }
  return res.json();
}

/**
 * Fetch Tinglysning REST endpoint med cert auth.
 *
 * @param {string} tlPath - Path efter /tinglysning/ssl
 * @param {string} accept - Accept header
 * @returns {Promise<{status: number, body: string}>}
 */
function tlFetch(tlPath, accept = 'application/json') {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'www.tinglysning.dk',
      path: '/tinglysning/ssl' + tlPath,
      method: 'GET', pfx, passphrase,
      headers: { Accept: accept },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.end();
  });
}

/**
 * Escape SQL string.
 *
 * @param {string} str - Input
 * @returns {string} Escaped
 */
function esc(str) {
  return str.replace(/'/g, "''");
}

/**
 * Hent ALLE historiske handler for ét BFE.
 *
 * @param {number} bfe - BFE-nummer
 * @returns {Promise<object[]>} Array af handler (alle år)
 */
async function fetchHandlerForBfe(bfe) {
  const r1 = await tlFetch(`/ejendom/hovednoteringsnummer?hovednoteringsnummer=${bfe}`);
  if (r1.status !== 200 || !r1.body || r1.body === '{}') return [];
  let uuid;
  try { uuid = JSON.parse(r1.body)?.items?.[0]?.uuid; } catch { return []; }
  if (!uuid) return [];

  const r2 = await tlFetch(`/ejdsummarisk/${uuid}`, 'application/xml');
  if (r2.status !== 200) return [];
  const xml = r2.body;

  const entries = [...xml.matchAll(/AdkomstSummarisk>([\s\S]*?)<\/[^:]*:?AdkomstSummarisk/g)];
  const handler = [];
  for (const [, e] of entries) {
    const dato = e.match(/SkoedeOvertagelsesDato[^>]*>([^<]+)/)?.[1]?.split(/[+T]/)[0] || null;
    const tinglystDato = e.match(/TinglysningsDato[^>]*>([^<]+)/)?.[1]?.split(/[+T]/)[0] || null;
    const koebsaftaleDato = e.match(/KoebsaftaleDato[^>]*>([^<]+)/)?.[1]?.split(/[+T]/)[0] || null;
    const kontantKoebesum = parseInt(e.match(/KontantKoebesum[^>]*>([^<]+)/)?.[1]?.trim() || '', 10) || null;
    const iAltKoebesum = parseInt(e.match(/IAltKoebesum[^>]*>([^<]+)/)?.[1]?.trim() || '', 10) || null;
    const koeber = e.match(/PersonNavn[^>]*>([^<]+)/)?.[1] || e.match(/VirksomhedNavn[^>]*>([^<]+)/)?.[1] || null;
    const koeberCvr = e.match(/VirksomhedCvrNummer[^>]*>([^<]+)/)?.[1] || null;
    const andelTaeller = parseInt(e.match(/AndelTaeller[^>]*>([^<]+)/)?.[1] || '', 10) || null;
    const andelNaevner = parseInt(e.match(/AndelNaevner[^>]*>([^<]+)/)?.[1] || '', 10) || null;

    if (!dato) continue;

    handler.push({
      bfe_nummer: bfe, dato, tinglyst_dato: tinglystDato, koebsaftale_dato: koebsaftaleDato,
      koebesum: kontantKoebesum, samlet_koebesum: iAltKoebesum,
      koeber_navne: koeber ? [koeber] : null, koeber_cvrs: koeberCvr ? [koeberCvr] : null,
      andel_taeller: andelTaeller, andel_naevner: andelNaevner,
    });
  }
  return handler;
}

/**
 * Batch-insert handler via Management API SQL.
 *
 * @param {object[]} handler - Handler to insert
 * @returns {Promise<{inserted: number, errors: number}>}
 */
async function insertHandler(handler) {
  if (handler.length === 0) return { inserted: 0, errors: 0 };

  const values = handler.map(h => {
    const navne = h.koeber_navne ? `ARRAY['${esc(h.koeber_navne[0])}']` : 'NULL';
    const cvrs = h.koeber_cvrs ? `ARRAY['${h.koeber_cvrs[0]}']` : 'NULL';
    return `(${h.bfe_nummer}, ${h.dato ? `'${h.dato}'` : 'NULL'}, ${h.tinglyst_dato ? `'${h.tinglyst_dato}'` : 'NULL'}, ${h.koebsaftale_dato ? `'${h.koebsaftale_dato}'` : 'NULL'}, ${h.koebesum || 'NULL'}, ${h.samlet_koebesum || 'NULL'}, ${navne}, ${cvrs}, ${h.andel_taeller || 'NULL'}, ${h.andel_naevner || 'NULL'}, 'tinglysning-summarisk', now())`;
  }).join(',\n');

  const sql = `
    INSERT INTO public.ejendomshandel (bfe_nummer, dato, tinglyst_dato, koebsaftale_dato, koebesum, samlet_koebesum, koeber_navne, koeber_cvrs, andel_taeller, andel_naevner, kilde, sidst_opdateret)
    VALUES ${values}
    ON CONFLICT DO NOTHING;
  `;

  const result = await runSql(sql);
  if (result?.message) {
    return { inserted: 0, errors: handler.length };
  }
  return { inserted: handler.length, errors: 0 };
}

/** Main. */
async function main() {
  console.log(`Ejendomshandel Hvidovre HISTORIK — env=${TARGET_ENV}, offset=${OFFSET}, DRY=${DRY_RUN}`);

  const bfes = await runSql(`
    SELECT bfe_nummer FROM bbr_ejendom_status
    WHERE kommune_kode = ${KOMMUNE_KODE}
    ORDER BY bfe_nummer
    OFFSET ${OFFSET}
  `);

  if (!Array.isArray(bfes) || bfes.length === 0) {
    console.log('Ingen BFE fundet');
    process.exit(0);
  }
  console.log(`${bfes.length} BFE'er at scanne (offset=${OFFSET})`);

  let processed = 0;
  let totalInserted = 0;
  let totalFound = 0;
  let totalErrors = 0;
  let noData = 0;

  for (let i = 0; i < bfes.length; i += CONCURRENCY) {
    const batch = bfes.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(b => fetchHandlerForBfe(b.bfe_nummer)));

    for (const result of results) {
      processed++;
      if (result.status === 'rejected') { totalErrors++; continue; }
      const handler = result.value;

      if (handler.length === 0) { noData++; continue; }
      totalFound += handler.length;

      if (!DRY_RUN) {
        const { inserted, errors } = await insertHandler(handler);
        totalInserted += inserted;
        totalErrors += errors;
      } else {
        totalInserted += handler.length;
      }
    }

    if (processed % 100 === 0) {
      console.log(`  [${processed}/${bfes.length}] found=${totalFound} inserted=${totalInserted} noData=${noData} errors=${totalErrors}`);
    }

    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log(`\nDone! processed=${processed}, found=${totalFound}, inserted=${totalInserted}, noData=${noData}, errors=${totalErrors}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
