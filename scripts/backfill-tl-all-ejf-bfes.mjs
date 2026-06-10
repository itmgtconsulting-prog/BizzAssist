#!/usr/bin/env node
/**
 * BIZZ-1881 (udvidet scope): Backfill tinglysning_haeftelse + ejendomshandel for
 * ALLE BFEer i ejf_ejerskab/ejf_administrator der mangler TL data.
 *
 * Sample test viste 100% hit-rate (10/10) på BFEer uden TL data.
 * Estimat: 2.5M BFEer kandidater. Ved concurrency=2, ~8 BFE/sec = ~3-4 dage continuous.
 *
 * Reuse parser-logik fra backfill-tinglysning-summarisk-fix.mjs.
 *
 * Usage:
 *   node scripts/backfill-tl-all-ejf-bfes.mjs [--offset=N] [--limit=N] [--concurrency=N]
 */

import https from 'https';
import fs from 'fs';
import pg from 'pg';

const args = Object.fromEntries(
  process.argv.slice(2).map(a => { const [k,v] = a.replace(/^--/,'').split('='); return [k, v ?? 'true']; })
);
const LIMIT = parseInt(args.limit || '0', 10) || 999999999;
const OFFSET = parseInt(args.offset || '0', 10);
const CONCURRENCY = parseInt(args.concurrency || '2', 10);
const DRY_RUN = args['dry-run'] === 'true';
// BIZZ-1881: tinglysning.dk rate-limiter (HTTP 429). Vi kører bevidst langsomt
// med en adaptiv inter-BFE delay der hæves automatisk hver gang vi rammer 429,
// så scriptet selv finder en bæredygtig rate i stedet for at hamre API'et.
const DELAY_MS = parseInt(args['delay-ms'] || '500', 10); // start-delay mellem BFEer
const MAX_DELAY_MS = parseInt(args['max-delay-ms'] || '8000', 10);
let baseDelayMs = DELAY_MS; // mutérbar — hæves ved 429
let total429 = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const envContent = fs.readFileSync('/root/BizzAssist/.env.local', 'utf8');
const PROD_DB_URL = envContent.match(/^SUPABASE_PROD_DB_URL=(.+)$/m)?.[1];
const CERT_PATH = envContent.match(/^TINGLYSNING_CERT_PATH=(.+)$/m)?.[1] || './certs/nemlogin-prod/BizzAssist.p12';
const CERT_PASS = envContent.match(/^TINGLYSNING_CERT_PASSWORD=(.+)$/m)?.[1] || '';
const pfx = fs.readFileSync(CERT_PATH);
const TL_BASE = envContent.match(/^TINGLYSNING_BASE_URL=(.+)$/m)?.[1] || 'https://www.tinglysning.dk';

// ── XML helpers (samme som backfill-tinglysning-summarisk-fix.mjs) ─
function extractText(xml, tag) {
  const m = xml.match(new RegExp(`${tag}[^>]*>([^<]+)`));
  return m?.[1]?.trim() || null;
}
function extractInt(xml, tag) {
  const m = xml.match(new RegExp(`${tag}[^>]*>([^<]+)`));
  const n = parseInt(m?.[1]?.trim() || '', 10);
  return Number.isFinite(n) ? n : null;
}
function extractDate(xml, tag) {
  const m = xml.match(new RegExp(`${tag}[^>]*>([^<]+)`));
  return m?.[1]?.split(/[+T]/)[0] || null;
}
function extractKreditor(xml) {
  const block = xml.match(/KreditorInformationSamling[^>]*>([\s\S]*?)<\/[^:]*:?KreditorInformationSamling/);
  if (!block) return { navn: null, cvr: null };
  return {
    navn: extractText(block[1], 'LegalUnitName') || extractText(block[1], 'PersonName'),
    cvr: extractText(block[1], 'CVRnumberIdentifier'),
  };
}
function extractKoebere(xml) {
  const samling = xml.match(/AdkomsthaverSamling[^>]*>([\s\S]*?)<\/[^:]*:?AdkomsthaverSamling/);
  if (!samling) return { navne: [], cvrs: [], andelTaeller: null, andelNaevner: null };
  const entries = [...samling[1].matchAll(/(?:^|<[^:]*:?Adkomsthaver[^>]*>)([\s\S]*?)<\/[^:]*:?Adkomsthaver/g)];
  const navne = [], cvrs = [];
  let andelTaeller = null, andelNaevner = null;
  for (const [, e] of entries) {
    const personName = extractText(e, 'PersonName');
    const virkName = extractText(e, 'LegalUnitName');
    const cvr = extractText(e, 'CVRnumberIdentifier');
    if (personName) navne.push(personName);
    else if (virkName) navne.push(virkName);
    if (cvr) cvrs.push(cvr);
    if (andelTaeller === null) {
      const ideel = e.match(/AndelIdeel[^>]*>([\s\S]*?)<\/[^:]*:?AndelIdeel/);
      if (ideel) { andelTaeller = extractInt(ideel[1], 'Taeller'); andelNaevner = extractInt(ideel[1], 'Naevner'); }
    }
  }
  return { navne, cvrs, andelTaeller, andelNaevner };
}

// ── TL fetch ────────────────────────────────────────────────────────
function tlGetRaw(urlPath, accept = 'application/json') {
  return new Promise((resolve, reject) => {
    const url = new URL(TL_BASE + '/tinglysning/ssl' + urlPath);
    const req = https.request({
      hostname: url.hostname, port: 443, path: url.pathname + url.search,
      method: 'GET', pfx, passphrase: CERT_PASS,
      rejectUnauthorized: false, timeout: 60000,
      headers: { Accept: accept },
    }, (res) => { let body = ''; res.on('data', d => body += d); res.on('end', () => resolve({ status: res.statusCode, body, retryAfter: res.headers['retry-after'] })); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

async function tlGet(urlPath, accept) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const r = await tlGetRaw(urlPath, accept);
      if (r.status === 200 || r.status === 404) return r;
      if (r.status === 429) {
        // Rate-limit ramt: hæv den globale delay permanent (adaptiv throttle)
        // og vent eksponentielt (respektér Retry-After hvis sat) før retry.
        total429++;
        baseDelayMs = Math.min(baseDelayMs + 250, MAX_DELAY_MS);
        const ra = parseInt(r.retryAfter || '', 10);
        const wait = Number.isFinite(ra) ? ra * 1000 : Math.min(2000 * 2 ** attempt, 60000);
        await sleep(wait);
        continue;
      }
      await sleep(1000 * (attempt + 1)); // andre fejl: kort backoff
    } catch (err) {
      if (attempt >= 4) throw err;
      await sleep(1000 * (attempt + 1));
    }
  }
  return { status: 429, body: '' }; // gav op efter vedvarende 429
}

// ── Process one BFE ─────────────────────────────────────────────────
async function processBfe(bfe, db) {
  const r1 = await tlGet(`/ejendom/hovednoteringsnummer?hovednoteringsnummer=${bfe}`);
  if (r1.status !== 200 || !r1.body || r1.body === '{}') return { bfe, status: 'no-uuid' };
  let uuid;
  try { uuid = JSON.parse(r1.body)?.items?.[0]?.uuid; }
  catch { return { bfe, status: 'parse-error' }; }
  if (!uuid) return { bfe, status: 'no-uuid' };

  const r2 = await tlGet(`/ejdsummarisk/${uuid}`, 'application/xml');
  if (r2.status !== 200 || !r2.body) return { bfe, status: `http-${r2.status}` };
  const xml = r2.body;

  // Parse adkomst
  const handler = [];
  for (const [, e] of xml.matchAll(/AdkomstSummarisk>([\s\S]*?)<\/[^:]*:?AdkomstSummarisk/g)) {
    const dato = extractDate(e, 'SkoedeOvertagelsesDato');
    const koebesum = extractInt(e, 'KontantKoebesum');
    if (!dato && !koebesum) continue;
    const k = extractKoebere(e);
    handler.push({
      bfe_nummer: bfe, dato,
      tinglyst_dato: extractDate(e, 'TinglysningsDato'),
      koebesum, samlet_koebesum: extractInt(e, 'IAltKoebesum'),
      andel_taeller: k.andelTaeller, andel_naevner: k.andelNaevner,
      koeber_navne: k.navne.length > 0 ? k.navne : null,
      koeber_cvrs: k.cvrs.length > 0 ? k.cvrs : null,
    });
  }

  // Parse haeftelser
  const haeftelser = [];
  let prioritet = 0;
  for (const [, e] of xml.matchAll(/HaeftelseSummarisk>([\s\S]*?)<\/[^:]*:?HaeftelseSummarisk/g)) {
    prioritet++;
    const kreditor = extractKreditor(e);
    haeftelser.push({
      bfe_nummer: bfe, prioritet,
      type: extractText(e, 'DokumentType') || extractText(e, 'HaeftelseType') || 'Ukendt',
      hovedstol_dkk: extractInt(e, 'BeloebVaerdi'),
      kreditor_navn: kreditor.navn, kreditor_cvr: kreditor.cvr,
      tinglyst_dato: extractDate(e, 'TinglysningsDato'),
      akt_navn: extractText(e, 'DokumentAliasIdentifikator'),
      status: extractText(e, 'Status')?.toLowerCase() || 'gaeldende',
    });
  }

  if (handler.length === 0 && haeftelser.length === 0) return { bfe, status: 'no-tl-data' };
  if (DRY_RUN) return { bfe, status: 'dry-run', handler: handler.length, haeftelser: haeftelser.length };

  // BIZZ-1918: Build minimal payload for tinglysning_summarisk_cache fallback
  // Format matches what /api/tinglysning/summarisk route returns
  const ejere = handler.flatMap(h =>
    (h.koeber_navne || []).map((navn, i) => ({
      navn, cvr: (h.koeber_cvrs || [])[i] || null,
      type: (h.koeber_cvrs || [])[i] ? 'selskab' : 'person',
      adkomstType: 'skoede',
      andel: h.andel_taeller && h.andel_naevner ? `${Math.round((h.andel_taeller/h.andel_naevner)*100)}%` : null,
      andelTaeller: h.andel_taeller, andelNaevner: h.andel_naevner,
      overtagelsesdato: h.dato, tinglysningsdato: h.tinglyst_dato,
      koebesum: h.koebesum, koebsaftaledato: null,
      kontantKoebesum: h.koebesum, iAltKoebesum: h.samlet_koebesum,
      tinglysningsafgift: null, anmelderNavn: null, anmelderEmail: null,
      anmelderCvr: null, skoedeTekst: null, ejendomKategori: null,
      handelKode: null, adresse: null, kommunekode: null,
      dokumentId: null, dokumentAlias: null, dato: h.tinglyst_dato,
    }))
  );
  const cachePayload = {
    ejere,
    haeftelser: haeftelser.map(h => ({
      prioritet: h.prioritet, type: h.type, hovedstol: h.hovedstol_dkk,
      kreditor: h.kreditor_navn, kreditorCvr: h.kreditor_cvr,
      tinglysningsdato: h.tinglyst_dato, dokumentAlias: h.akt_navn,
      status: h.status,
    })),
    servitutter: [], bilagRefs: [], indskannedeAkterNavne: [],
    tingbogsattest: null, fejl: null,
  };

  await db.query('BEGIN');
  try {
    if (handler.length > 0) {
      await db.query("DELETE FROM ejendomshandel WHERE bfe_nummer=$1 AND kilde='tinglysning-summarisk'", [bfe]);
      for (const h of handler) {
        await db.query(
          `INSERT INTO ejendomshandel
           (bfe_nummer, dato, tinglyst_dato, koebesum, samlet_koebesum, andel_taeller, andel_naevner, koeber_navne, koeber_cvrs, kilde, sidst_opdateret)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'tinglysning-summarisk',NOW())`,
          [h.bfe_nummer, h.dato, h.tinglyst_dato, h.koebesum, h.samlet_koebesum, h.andel_taeller, h.andel_naevner, h.koeber_navne, h.koeber_cvrs]
        );
      }
    }
    if (haeftelser.length > 0) {
      await db.query('DELETE FROM tinglysning_haeftelse WHERE bfe_nummer = $1', [bfe]);
      for (const r of haeftelser) {
        await db.query(
          `INSERT INTO tinglysning_haeftelse
           (bfe_nummer, prioritet, type, hovedstol_dkk, kreditor_navn, kreditor_cvr, tinglyst_dato, akt_navn, status, sidst_opdateret)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
          [r.bfe_nummer, r.prioritet, r.type, r.hovedstol_dkk, r.kreditor_navn, r.kreditor_cvr, r.tinglyst_dato, r.akt_navn, r.status]
        );
      }
    }
    // BIZZ-1918: Write to tinglysning_summarisk_cache
    await db.query(
      `INSERT INTO tinglysning_summarisk_cache (uuid, bfe_nummer, payload, fetched_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (uuid) DO UPDATE SET
         bfe_nummer = EXCLUDED.bfe_nummer,
         payload = EXCLUDED.payload,
         fetched_at = NOW()`,
      [uuid, bfe, JSON.stringify(cachePayload)]
    );
    await db.query('COMMIT');
    return { bfe, status: 'ok', handler: handler.length, haeftelser: haeftelser.length };
  } catch (err) { await db.query('ROLLBACK'); return { bfe, status: 'db-error', error: err.message }; }
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log(`[1881-all-ejf] Start (offset=${OFFSET}, limit=${LIMIT}, concurrency=${CONCURRENCY}, dry-run=${DRY_RUN})`);
  const pool = new pg.Pool({ connectionString: PROD_DB_URL, max: CONCURRENCY + 2, statement_timeout: 600000 });

  console.log('[1881-all-ejf] Henter candidates (kan tage 1-2 min)...');
  console.time('query');
  const { rows } = await pool.query(`
    WITH ejf_bfes AS (
      SELECT DISTINCT bfe_nummer FROM ejf_ejerskab WHERE status='gældende'
    ),
    missing AS (
      SELECT e.bfe_nummer FROM ejf_bfes e
      LEFT JOIN tinglysning_haeftelse h ON h.bfe_nummer = e.bfe_nummer
      LEFT JOIN ejendomshandel d ON d.bfe_nummer = e.bfe_nummer AND d.kilde = 'tinglysning-summarisk'
      WHERE h.bfe_nummer IS NULL AND d.bfe_nummer IS NULL
    )
    SELECT bfe_nummer FROM missing
    ORDER BY bfe_nummer
    OFFSET $1 LIMIT $2
  `, [OFFSET, LIMIT]);
  console.timeEnd('query');
  const bfes = rows.map(r => Number(r.bfe_nummer));
  console.log(`[1881-all-ejf] ${bfes.length} BFEer at processere`);

  let processed = 0, ok = 0, noUuid = 0, noTlData = 0, errors = 0, totalHandler = 0, totalHaeftelser = 0;

  for (let i = 0; i < bfes.length; i += CONCURRENCY) {
    const batch = bfes.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async b => {
      const c = await pool.connect();
      try { return await processBfe(b, c); }
      catch (err) { return { bfe: b, status: 'exception', error: err.message }; }
      finally { c.release(); }
    }));
    for (const r of results) {
      processed++;
      if (r.status === 'ok' || r.status === 'dry-run') { ok++; totalHandler += r.handler || 0; totalHaeftelser += r.haeftelser || 0; }
      else if (r.status === 'no-uuid') noUuid++;
      else if (r.status === 'no-tl-data') noTlData++;
      else errors++;
    }
    if (processed % 100 === 0 || processed === bfes.length) {
      console.log(`[1881-all-ejf] processed=${processed}/${bfes.length}, ok=${ok}, no-uuid=${noUuid}, no-tl=${noTlData}, errors=${errors}, handler=${totalHandler}, haeftelser=${totalHaeftelser}, delay=${baseDelayMs}ms, 429s=${total429}`);
    }
    // Adaptiv throttle: pause mellem hver BFE-batch så vi holder os under rate-limit
    if (baseDelayMs > 0) await sleep(baseDelayMs);
  }

  console.log(`\n[1881-all-ejf] DONE — ok=${ok}, no-uuid=${noUuid}, no-tl=${noTlData}, errors=${errors}`);
  await pool.end();
}
main().catch(err => { console.error(err); process.exit(1); });
