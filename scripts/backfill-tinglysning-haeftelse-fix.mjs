#!/usr/bin/env node
/**
 * Backfill tinglysning_haeftelse med korrekt hovedstol_dkk + kreditor_navn.
 *
 * Baggrund: Den oprindelige parser brugte forkerte XML-tag-navne:
 *   - "Hovedstol" → korrekt: "BeloebVaerdi" (inde i HaeftelseBeloeb)
 *   - "KreditorNavn" → korrekt: "LegalUnitName" (inde i KreditorInformationSamling)
 *   - "VirksomhedCvrNummer" → korrekt: "CVRnumberIdentifier"
 *
 * Scriptet henter ejdsummarisk XML for hvert BFE og re-parser hæftelser.
 *
 * Usage:
 *   node scripts/backfill-tinglysning-haeftelse-fix.mjs [--limit=N] [--offset=N] [--concurrency=N] [--dry-run]
 */

import https from 'https';
import fs from 'fs';
import pg from 'pg';

// ── Config ──────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  })
);

const LIMIT = parseInt(args.limit || '0', 10) || 999999;
const OFFSET = parseInt(args.offset || '0', 10);
const CONCURRENCY = parseInt(args.concurrency || '3', 10);
const DRY_RUN = args['dry-run'] === 'true';
const DELAY_MS = 350; // ~3 req/s per worker (well within e-TL limits)

const PROD_DB_URL = process.env.SUPABASE_PROD_DB_URL;
if (!PROD_DB_URL) {
  console.error('SUPABASE_PROD_DB_URL not set');
  process.exit(1);
}

// ── mTLS cert ───────────────────────────────────────────────────────
const CERT_PATH = process.env.TINGLYSNING_CERT_PATH || './certs/nemlogin-prod/BizzAssist.p12';
const CERT_PASS = process.env.TINGLYSNING_CERT_PASSWORD || '';
const pfx = fs.readFileSync(CERT_PATH);
const TL_BASE = process.env.TINGLYSNING_BASE_URL || 'https://www.tinglysning.dk';

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
  const kreditorBlock = xml.match(/KreditorInformationSamling[^>]*>([\s\S]*?)<\/[^:]*:?KreditorInformationSamling/);
  if (!kreditorBlock) return { navn: null, cvr: null };
  const block = kreditorBlock[1];
  return {
    navn: extractText(block, 'LegalUnitName') || extractText(block, 'PersonName'),
    cvr: extractText(block, 'CVRnumberIdentifier'),
  };
}

// ── TL fetch with mTLS ──────────────────────────────────────────────
function tlGet(urlPath, accept = 'application/json') {
  return new Promise((resolve, reject) => {
    const url = new URL(TL_BASE + '/tinglysning/ssl' + urlPath);
    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: 'GET',
      pfx,
      passphrase: CERT_PASS,
      rejectUnauthorized: false,
      timeout: 30000,
      headers: { Accept: accept },
    }, (res) => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ── Process one BFE ─────────────────────────────────────────────────
async function processBfe(bfe, db) {
  // Step 1: BFE -> UUID
  const r1 = await tlGet(`/ejendom/hovednoteringsnummer?hovednoteringsnummer=${bfe}`);
  if (r1.status !== 200 || !r1.body || r1.body === '{}') return { bfe, status: 'no-uuid' };

  let uuid;
  try {
    const parsed = JSON.parse(r1.body);
    uuid = parsed?.items?.[0]?.uuid;
  } catch { return { bfe, status: 'parse-error' }; }
  if (!uuid) return { bfe, status: 'no-uuid' };

  // Step 2: UUID -> summarisk XML
  const r2 = await tlGet(`/ejdsummarisk/${uuid}`, 'application/xml');
  if (r2.status !== 200 || !r2.body) return { bfe, status: `http-${r2.status}` };

  const xml = r2.body;

  // Parse haeftelser
  const entries = [...xml.matchAll(/HaeftelseSummarisk>([\s\S]*?)<\/[^:]*:?HaeftelseSummarisk/g)];
  if (entries.length === 0) return { bfe, status: 'no-haeftelser' };

  const rows = [];
  let prioritet = 0;
  for (const [, e] of entries) {
    prioritet++;
    const kreditor = extractKreditor(e);
    rows.push({
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
    return { bfe, status: 'dry-run', haeftelser: rows.length, sample: rows[0] };
  }

  // Delete + insert (full replace per BFE, idempotent)
  await db.query('BEGIN');
  try {
    await db.query('DELETE FROM tinglysning_haeftelse WHERE bfe_nummer = $1', [bfe]);
    for (const r of rows) {
      await db.query(
        `INSERT INTO tinglysning_haeftelse
         (bfe_nummer, prioritet, type, hovedstol_dkk, kreditor_navn, kreditor_cvr,
          tinglyst_dato, akt_navn, status, sidst_opdateret)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
        [r.bfe_nummer, r.prioritet, r.type, r.hovedstol_dkk, r.kreditor_navn,
         r.kreditor_cvr, r.tinglyst_dato, r.akt_navn, r.status]
      );
    }
    await db.query('COMMIT');
    return { bfe, status: 'ok', haeftelser: rows.length };
  } catch (err) {
    await db.query('ROLLBACK');
    return { bfe, status: 'db-error', error: err.message };
  }
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  const pool = new pg.Pool({ connectionString: PROD_DB_URL, max: CONCURRENCY + 1 });

  // Get distinct BFEs that have haeftelser
  const { rows: bfeRows } = await pool.query(
    `SELECT DISTINCT bfe_nummer FROM tinglysning_haeftelse
     ORDER BY bfe_nummer
     OFFSET $1 LIMIT $2`,
    [OFFSET, LIMIT]
  );
  const bfes = bfeRows.map(r => r.bfe_nummer);
  console.log(`[backfill] ${bfes.length} BFEs to process (offset=${OFFSET}, limit=${LIMIT}, concurrency=${CONCURRENCY}, dry-run=${DRY_RUN})`);

  let processed = 0;
  let ok = 0;
  let errors = 0;

  // Process in batches with concurrency — each gets its own DB client from pool
  for (let i = 0; i < bfes.length; i += CONCURRENCY) {
    const batch = bfes.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async bfe => {
      const client = await pool.connect();
      try {
        return await processBfe(bfe, client);
      } catch (err) {
        return { bfe, status: 'exception', error: err.message };
      } finally {
        client.release();
      }
    }));

    for (const r of results) {
      processed++;
      if (r.status === 'ok' || r.status === 'dry-run') {
        ok++;
      } else if (r.status === 'db-error' || r.status === 'exception') {
        errors++;
        console.warn(`  [error] BFE ${r.bfe}: ${r.error || r.status}`);
      }
    }

    if (processed % 500 === 0 || processed === bfes.length) {
      console.log(`[backfill] processed=${processed}/${bfes.length}, ok=${ok}, errors=${errors}`);
    }

    // Rate limit between batches
    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  // Final stats
  if (!DRY_RUN) {
    const stats = await pool.query(`
      SELECT
        count(*) AS total,
        count(hovedstol_dkk) AS with_hovedstol,
        count(kreditor_navn) AS with_kreditor
      FROM tinglysning_haeftelse
    `);
    const s = stats.rows[0];
    console.log(`\n[backfill] DONE — total=${s.total}, hovedstol=${s.with_hovedstol} (${(s.with_hovedstol/s.total*100).toFixed(1)}%), kreditor=${s.with_kreditor} (${(s.with_kreditor/s.total*100).toFixed(1)}%)`);
  }

  await pool.end();
  console.log('[backfill] Finished.');
}

main().catch(err => { console.error(err); process.exit(1); });
