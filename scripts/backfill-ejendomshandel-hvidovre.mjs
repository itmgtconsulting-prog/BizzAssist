#!/usr/bin/env node
/**
 * BIZZ-1566 Backfill 4 (delvist): Populér ejendomshandel med salgspriser
 * for boligejendomme i Hvidovre kommune (0167) fra 2026.
 *
 * Bruger Tinglysning SSL API med NemLogin prod-certifikat.
 *
 * Usage:
 *   node scripts/backfill-ejendomshandel-hvidovre.mjs [--env=prod] [--dry-run] [--limit=5000]
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
const LIMIT = (() => { const a = args.find(x => x.startsWith('--limit=')); return a ? parseInt(a.split('=')[1], 10) : 5000; })();

const ENV_REFS = { dev: 'wkzwxfhyfmvglrqtmebw', preview: 'rlkjmqjxmkxuclehbrnl', prod: 'xsyldjqcntiygrtfcszm' };
const PROJECT_REF = ENV_REFS[TARGET_ENV];
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

if (!ACCESS_TOKEN || !PROJECT_REF) { console.error('Missing credentials'); process.exit(1); }

const KOMMUNE_KODE = 167; // Hvidovre
const CONCURRENCY = 2; // Max 2 parallel Tinglysning requests
const DELAY_MS = 500; // 2 req/sec rate limit

/**
 * Execute SQL via Management API.
 */
async function runSql(sql) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query: sql });
    const timer = setTimeout(() => { req.destroy(); resolve([]); }, 30000);
    const req = https.request({ hostname: 'api.supabase.com', path: `/v1/projects/${PROJECT_REF}/database/query`, method: 'POST', headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(d)); } catch { resolve([]); } }); });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.write(body); req.end();
  });
}

/**
 * Fetch Tinglysning REST endpoint med cert auth.
 *
 * @param tlPath - Path efter /tinglysning/ssl
 * @param accept - Accept header
 * @returns Response body
 */
function tlFetch(tlPath, accept = 'application/json') {
  return new Promise((resolve, reject) => {
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
 * Hent alle salgshistorik-rækker for ét BFE fra Tinglysning summarisk.
 *
 * @param bfe - BFE-nummer
 * @returns Array af handler
 */
async function fetchHandlerForBfe(bfe) {
  // Step 1: BFE → UUID
  const r1 = await tlFetch(`/ejendom/hovednoteringsnummer?hovednoteringsnummer=${bfe}`);
  if (r1.status !== 200 || !r1.body || r1.body === '{}') return [];
  let uuid;
  try { uuid = JSON.parse(r1.body)?.items?.[0]?.uuid; } catch { return []; }
  if (!uuid) return [];

  // Step 2: UUID → summarisk XML
  const r2 = await tlFetch(`/ejdsummarisk/${uuid}`, 'application/xml');
  if (r2.status !== 200) return [];
  const xml = r2.body;

  // Parse adkomst entries
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

    // Only include trades with a date
    if (!dato) continue;

    handler.push({
      bfe_nummer: bfe,
      dato,
      tinglyst_dato: tinglystDato,
      koebsaftale_dato: koebsaftaleDato,
      koebesum: kontantKoebesum,
      samlet_koebesum: iAltKoebesum,
      koeber_navne: koeber ? [koeber] : null,
      koeber_cvrs: koeberCvr ? [koeberCvr] : null,
      kilde: 'tinglysning-summarisk',
      sidst_opdateret: new Date().toISOString(),
    });
  }
  return handler;
}

/** Main. */
async function main() {
  console.log(`Ejendomshandel Hvidovre 2026 — env=${TARGET_ENV}, limit=${LIMIT}, DRY=${DRY_RUN}`);

  // Hent alle bolig-BFE'er i Hvidovre
  const bfes = await runSql(`
    SELECT bfe_nummer FROM bbr_ejendom_status
    WHERE kommune_kode = ${KOMMUNE_KODE}
    AND byg021_anvendelse IN (120, 130, 131, 132, 140)
    ORDER BY bfe_nummer
    LIMIT ${LIMIT}
  `);

  if (!Array.isArray(bfes) || bfes.length === 0) {
    console.log('Ingen Hvidovre boliger fundet');
    process.exit(0);
  }
  console.log(`${bfes.length} bolig-BFE'er i Hvidovre at scanne`);

  let processed = 0;
  let inserted = 0;
  let found2026 = 0;
  let errors = 0;

  for (let i = 0; i < bfes.length; i += CONCURRENCY) {
    const batch = bfes.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(b => fetchHandlerForBfe(b.bfe_nummer)));

    for (const result of results) {
      processed++;
      if (result.status === 'rejected') { errors++; continue; }
      const handler = result.value;
      // Filter til 2026
      const handler2026 = handler.filter(h => h.dato && h.dato.startsWith('2026'));
      if (handler2026.length === 0) continue;
      found2026 += handler2026.length;

      if (!DRY_RUN) {
        // Insert via Management API SQL
        for (const h of handler2026) {
          const sql = `
            INSERT INTO ejendomshandel (bfe_nummer, dato, tinglyst_dato, koebsaftale_dato, koebesum, samlet_koebesum, koeber_navne, koeber_cvrs, kilde, sidst_opdateret)
            VALUES (${h.bfe_nummer}, ${h.dato ? `'${h.dato}'` : 'NULL'}, ${h.tinglyst_dato ? `'${h.tinglyst_dato}'` : 'NULL'}, ${h.koebsaftale_dato ? `'${h.koebsaftale_dato}'` : 'NULL'}, ${h.koebesum || 'NULL'}, ${h.samlet_koebesum || 'NULL'}, ${h.koeber_navne ? `ARRAY['${h.koeber_navne[0].replace(/'/g, "''")}']` : 'NULL'}, ${h.koeber_cvrs ? `ARRAY['${h.koeber_cvrs[0]}']` : 'NULL'}, 'tinglysning-summarisk', now())
            ON CONFLICT DO NOTHING
          `;
          const r = await runSql(sql);
          if (r?.message) { errors++; if (errors <= 5) console.error('  SQL:', r.message.slice(0, 100)); }
          else { inserted++; }
        }
      } else {
        inserted += handler2026.length;
        for (const h of handler2026) {
          console.log(`  DRY: BFE ${h.bfe_nummer} — ${h.dato} — ${h.koebesum?.toLocaleString('da-DK') || '?'} kr`);
        }
      }
    }

    if (processed % 50 === 0) {
      console.log(`  processed=${processed}/${bfes.length}, found2026=${found2026}, inserted=${inserted}, errors=${errors}`);
    }

    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log(`\nDone! processed=${processed}, found2026=${found2026}, inserted=${inserted}, errors=${errors}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
