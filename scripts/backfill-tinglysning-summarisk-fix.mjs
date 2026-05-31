#!/usr/bin/env node
/**
 * BIZZ-1797 (udvidelse): Re-parse BÅDE tinglysning_haeftelse OG ejendomshandel
 * med korrekte e-TL XML-tag-navne fra ejdsummarisk endpoint.
 *
 * Forrige script (backfill-tinglysning-haeftelse-fix) håndterede kun haeftelser.
 * Adkomst-parser har samme bug (PersonNavn/VirksomhedNavn → faktisk
 * PersonName/LegalUnitName + AndelTaeller/AndelNaevner → Taeller/Naevner i AndelIdeel).
 *
 * Dette script:
 *  - Henter unique BFEer fra (tinglysning_haeftelse ∪ ejendomshandel hvor kilde=tinglysning-summarisk)
 *  - Henter ejdsummarisk XML ÉN gang per BFE
 *  - Parser BÅDE haeftelser OG adkomst med korrekte tags
 *  - DELETE + INSERT begge tabeller i én transaktion per BFE
 *
 * Usage:
 *   node scripts/backfill-tinglysning-summarisk-fix.mjs [--limit=N] [--offset=N] [--concurrency=N] [--dry-run]
 */

import https from 'https';
import fs from 'fs';
import pg from 'pg';

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  })
);

const LIMIT = parseInt(args.limit || '0', 10) || 999999999;
const OFFSET = parseInt(args.offset || '0', 10);
const CONCURRENCY = parseInt(args.concurrency || '3', 10);
const DRY_RUN = args['dry-run'] === 'true';
// --mode=broken-ejf: kun BFEer hvor ejendomshandel har koebesum > 0 men ingen koeber_navne
//                    (recovery efter rate-limit run)
const MODE = args.mode || 'all';

const envContent = fs.readFileSync('/root/BizzAssist/.env.local', 'utf8');
const PROD_DB_URL = envContent.match(/^SUPABASE_PROD_DB_URL=(.+)$/m)?.[1];
const CERT_PATH = envContent.match(/^TINGLYSNING_CERT_PATH=(.+)$/m)?.[1] || './certs/nemlogin-prod/BizzAssist.p12';
const CERT_PASS = envContent.match(/^TINGLYSNING_CERT_PASSWORD=(.+)$/m)?.[1] || '';
const pfx = fs.readFileSync(CERT_PATH);
const TL_BASE = envContent.match(/^TINGLYSNING_BASE_URL=(.+)$/m)?.[1] || 'https://www.tinglysning.dk';

// ── XML helpers ─────────────────────────────────────────────────────
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

// ── TL fetch with mTLS + retry ──────────────────────────────────────
function tlGetRaw(urlPath, accept = 'application/json') {
  return new Promise((resolve, reject) => {
    const url = new URL(TL_BASE + '/tinglysning/ssl' + urlPath);
    const req = https.request({
      hostname: url.hostname, port: 443, path: url.pathname + url.search,
      method: 'GET', pfx, passphrase: CERT_PASS,
      rejectUnauthorized: false, timeout: 45000,
      headers: { Accept: accept },
    }, (res) => { let body = ''; res.on('data', d => body += d); res.on('end', () => resolve({ status: res.statusCode, body })); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

async function tlGet(urlPath, accept) {
  // Retry: 1st try + 2nd try with 2s delay (recover transient failures)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await tlGetRaw(urlPath, accept);
      if (r.status === 200 || r.status === 404) return r;
      if (attempt === 0) await new Promise(res => setTimeout(res, 2000));
    } catch (err) {
      if (attempt === 0) await new Promise(res => setTimeout(res, 2000));
      else throw err;
    }
  }
  return { status: 0, body: '' };
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

  // ─ Parse ADKOMST ─
  const handler = [];
  const adkomstEntries = [...xml.matchAll(/AdkomstSummarisk>([\s\S]*?)<\/[^:]*:?AdkomstSummarisk/g)];
  for (const [, e] of adkomstEntries) {
    const dato = extractDate(e, 'SkoedeOvertagelsesDato');
    const koebesum = extractInt(e, 'KontantKoebesum');
    if (!dato && !koebesum) continue;
    const k = extractKoebere(e);
    handler.push({
      bfe_nummer: bfe,
      dato,
      tinglyst_dato: extractDate(e, 'TinglysningsDato'),
      koebesum,
      samlet_koebesum: extractInt(e, 'IAltKoebesum'),
      andel_taeller: k.andelTaeller,
      andel_naevner: k.andelNaevner,
      koeber_navne: k.navne.length > 0 ? k.navne : null,
      koeber_cvrs: k.cvrs.length > 0 ? k.cvrs : null,
    });
  }

  // ─ Parse HAEFTELSER ─
  const haeftelser = [];
  const hEntries = [...xml.matchAll(/HaeftelseSummarisk>([\s\S]*?)<\/[^:]*:?HaeftelseSummarisk/g)];
  let prioritet = 0;
  for (const [, e] of hEntries) {
    prioritet++;
    const kreditor = extractKreditor(e);
    haeftelser.push({
      bfe_nummer: bfe,
      prioritet,
      type: extractText(e, 'DokumentType') || extractText(e, 'HaeftelseType') || 'Ukendt',
      hovedstol_dkk: extractInt(e, 'BeloebVaerdi'),
      kreditor_navn: kreditor.navn,
      kreditor_cvr: kreditor.cvr,
      tinglyst_dato: extractDate(e, 'TinglysningsDato'),
      akt_navn: extractText(e, 'DokumentAliasIdentifikator'),
      status: extractText(e, 'Status')?.toLowerCase() || 'gaeldende',
    });
  }

  if (DRY_RUN) {
    return { bfe, status: 'dry-run', handler: handler.length, haeftelser: haeftelser.length, sampleHandler: handler[0], sampleH: haeftelser[0] };
  }

  // ─ Atomic update: DELETE + INSERT begge tabeller ─
  await db.query('BEGIN');
  try {
    // Ejendomshandel
    await db.query('DELETE FROM ejendomshandel WHERE bfe_nummer = $1 AND kilde = $2', [bfe, 'tinglysning-summarisk']);
    for (const h of handler) {
      await db.query(
        `INSERT INTO ejendomshandel
         (bfe_nummer, dato, tinglyst_dato, koebesum, samlet_koebesum, andel_taeller, andel_naevner, koeber_navne, koeber_cvrs, kilde, sidst_opdateret)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'tinglysning-summarisk',NOW())`,
        [h.bfe_nummer, h.dato, h.tinglyst_dato, h.koebesum, h.samlet_koebesum, h.andel_taeller, h.andel_naevner, h.koeber_navne, h.koeber_cvrs]
      );
    }
    // Haeftelser
    await db.query('DELETE FROM tinglysning_haeftelse WHERE bfe_nummer = $1', [bfe]);
    for (const r of haeftelser) {
      await db.query(
        `INSERT INTO tinglysning_haeftelse
         (bfe_nummer, prioritet, type, hovedstol_dkk, kreditor_navn, kreditor_cvr, tinglyst_dato, akt_navn, status, sidst_opdateret)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
        [r.bfe_nummer, r.prioritet, r.type, r.hovedstol_dkk, r.kreditor_navn, r.kreditor_cvr, r.tinglyst_dato, r.akt_navn, r.status]
      );
    }
    await db.query('COMMIT');
    return { bfe, status: 'ok', handler: handler.length, haeftelser: haeftelser.length };
  } catch (err) {
    await db.query('ROLLBACK');
    return { bfe, status: 'db-error', error: err.message };
  }
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  const pool = new pg.Pool({ connectionString: PROD_DB_URL, max: CONCURRENCY + 1 });

  // Query BFEs depending on mode
  let queryRows;
  if (MODE === 'broken-ejf') {
    // Recovery mode: kun BFEer med broken ejendomshandel (koebesum>0 men koeber_navne=null)
    queryRows = (await pool.query(
      `SELECT DISTINCT bfe_nummer FROM ejendomshandel
       WHERE kilde = 'tinglysning-summarisk' AND koeber_navne IS NULL AND koebesum > 0
       ORDER BY bfe_nummer OFFSET $1 LIMIT $2`,
      [OFFSET, LIMIT]
    )).rows;
  } else {
    queryRows = (await pool.query(
      `SELECT DISTINCT bfe_nummer FROM (
         SELECT bfe_nummer FROM tinglysning_haeftelse
         UNION
         SELECT bfe_nummer FROM ejendomshandel WHERE kilde = 'tinglysning-summarisk'
       ) t ORDER BY bfe_nummer OFFSET $1 LIMIT $2`,
      [OFFSET, LIMIT]
    )).rows;
  }
  const { rows } = { rows: queryRows };
  const bfes = rows.map(r => Number(r.bfe_nummer));
  console.log(`[tl-fix] ${bfes.length} unique BFEs (offset=${OFFSET}, concurrency=${CONCURRENCY}, dry-run=${DRY_RUN})`);

  let processed = 0, ok = 0, noUuid = 0, errors = 0;
  let totalHandler = 0, totalHaeftelser = 0;

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
      if (r.status === 'ok' || r.status === 'dry-run') {
        ok++;
        totalHandler += r.handler || 0;
        totalHaeftelser += r.haeftelser || 0;
      } else if (r.status === 'no-uuid') noUuid++;
      else if (r.status !== 'no-haeftelser') errors++;
    }

    if (processed % 500 === 0 || processed === bfes.length) {
      console.log(`[tl-fix] processed=${processed}/${bfes.length}, ok=${ok}, no-uuid=${noUuid}, errors=${errors}, handler=${totalHandler}, haeftelser=${totalHaeftelser}`);
    }
  }

  console.log(`\n[tl-fix] DONE — processed=${processed}, ok=${ok}, no-uuid=${noUuid}, errors=${errors}`);

  if (!DRY_RUN) {
    const stats = await pool.query(`
      SELECT
        (SELECT count(*) FROM tinglysning_haeftelse) AS h_total,
        (SELECT count(hovedstol_dkk) FROM tinglysning_haeftelse) AS h_hovedstol,
        (SELECT count(*) FROM ejendomshandel WHERE kilde = 'tinglysning-summarisk') AS e_total,
        (SELECT count(koeber_navne) FROM ejendomshandel WHERE kilde = 'tinglysning-summarisk') AS e_navne
    `);
    const s = stats.rows[0];
    console.log(`[tl-fix] tinglysning_haeftelse: ${s.h_hovedstol}/${s.h_total} (${(s.h_hovedstol/s.h_total*100).toFixed(1)}%) har hovedstol`);
    console.log(`[tl-fix] ejendomshandel: ${s.e_navne}/${s.e_total} (${(s.e_navne/s.e_total*100).toFixed(1)}%) har koeber_navne`);
  }
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
