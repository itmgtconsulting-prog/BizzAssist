#!/usr/bin/env node
/**
 * BIZZ-1466 — Backfill kommune_kode i bbr_ejendom_status via BBR GraphQL
 *
 * Problem: rækker mangler kommune_kode (lave BFE-numre, aldrig beriget).
 * Løsning: BBR_Grund GraphQL → bestemtFastEjendomBFENr → jordstykke →
 *          kommunekode. Batch 50 BFE'er per GraphQL-kald.
 *
 * Kører manuelt:
 *   node scripts/backfill-bbr-kommune.mjs --env=prod [--limit=1000] [--dry-run] [--offset=0]
 *
 * Supporterer --env=prod|preview|dev (bruger Management API for prod/preview).
 * Idempotent — sætter kun kommune_kode hvor den er NULL.
 */
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
import https from 'node:https';

loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});

// Uses DAWA (api.dataforsyningen.dk) — no API key needed, not IP-restricted.

const args = process.argv.slice(2);
const TARGET_ENV = args.find((x) => x.startsWith('--env='))?.split('=')[1] || 'prod';
const LIMIT = (() => {
  const a = args.find((x) => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : Infinity;
})();
const OFFSET = (() => {
  const a = args.find((x) => x.startsWith('--offset='));
  return a ? parseInt(a.split('=')[1], 10) : 0;
})();
const DRY_RUN = args.includes('--dry-run');

const ENV_REFS = { dev: 'wkzwxfhyfmvglrqtmebw', preview: 'rlkjmqjxmkxuclehbrnl', prod: 'xsyldjqcntiygrtfcszm' };
const PROJECT_REF = ENV_REFS[TARGET_ENV];
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

if (!ACCESS_TOKEN || !PROJECT_REF) {
  console.error('Missing SUPABASE_ACCESS_TOKEN or invalid --env');
  process.exit(1);
}

/**
 * Execute SQL via Supabase Management API.
 *
 * @param {string} sql - SQL query
 * @returns {Promise<object>} Parsed response
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

const BATCH_SIZE = 50; // DAWA has no batch endpoint — 1 request per BFE, parallelise 50
const DELAY_MS = 1500; // 1.5s between batches — only run alone (not alongside tinglysning)
const DAWA_CONCURRENCY = 50;

/**
 * Hent kommunekode for ét BFE via DAWA adgangsadresser.
 *
 * @param {number} bfe - BFE-nummer
 * @returns {Promise<number|null>} kommunekode (4-cifret) eller null
 */
async function fetchKommuneForBfe(bfe) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(
        `https://api.dataforsyningen.dk/adgangsadresser?bfenr=${bfe}&per_side=1`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (res.status === 429) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (!res.ok) return null;
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) return null;
      const kk = parseInt(data[0].kommune?.kode, 10);
      return Number.isFinite(kk) && kk > 0 ? kk : null;
    } catch {
      await sleep(1000 * (attempt + 1));
    }
  }
  return null;
}

/**
 * Hent kommunekode for en batch BFE-numre via DAWA (parallel).
 *
 * @param {number[]} bfeNumre - BFE-numre at slå op
 * @returns {Map<number, number>} BFE → kommunekode
 */
async function fetchKommuneForBatch(bfeNumre) {
  const result = new Map();
  const results = await Promise.allSettled(
    bfeNumre.map(bfe => fetchKommuneForBfe(bfe))
  );
  for (let i = 0; i < bfeNumre.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled' && r.value != null) {
      result.set(bfeNumre[i], r.value);
    }
  }
  return result;
}

/** Sleep utility. */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Escape string for SQL.
 */
function esc(s) { return s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`; }

// ── Main ──
async function main() {
  console.log(`Backfill kommune_kode — env=${TARGET_ENV}, limit=${LIMIT}, offset=${OFFSET}, dryRun=${DRY_RUN}`);

  // Hent alle BFE'er der mangler kommune_kode
  const rows = await runSql(`
    SELECT bfe_nummer FROM bbr_ejendom_status
    WHERE kommune_kode IS NULL AND is_udfaset = false
    ORDER BY bfe_nummer
    OFFSET ${OFFSET}
    ${LIMIT !== Infinity ? `LIMIT ${LIMIT}` : ''}
  `);

  if (!Array.isArray(rows) || rows.length === 0) {
    console.log('No rows with NULL kommune_kode' + (rows?.message ? ': ' + rows.message : ''));
    process.exit(0);
  }
  console.log(`${rows.length} BFE'er at berige med kommune_kode`);

  let processed = 0;
  let updated = 0;
  let notFound = 0;
  let errors = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE).map(r => r.bfe_nummer);

    try {
      const kommuneMap = await fetchKommuneForBatch(batch);

      // Byg bulk UPDATE via CASE
      const updates = [];
      for (const bfe of batch) {
        processed++;
        const kk = kommuneMap.get(bfe);
        if (!kk) { notFound++; continue; }
        updates.push({ bfe, kk });
      }

      if (updates.length > 0 && !DRY_RUN) {
        const cases = updates.map(u => `WHEN ${u.bfe} THEN ${u.kk}`).join(' ');
        const bfeList = updates.map(u => u.bfe).join(',');
        const sql = `UPDATE bbr_ejendom_status SET kommune_kode = CASE bfe_nummer ${cases} END WHERE bfe_nummer IN (${bfeList}) AND kommune_kode IS NULL`;
        const r = await runSql(sql);
        if (r?.message) {
          errors += updates.length;
          if (errors <= 5) console.error(`\n  UPDATE error: ${r.message}`);
        } else {
          updated += updates.length;
        }
      } else if (DRY_RUN) {
        updates.forEach(u => console.log(`  [dry] BFE ${u.bfe} → kommune ${u.kk}`));
        updated += updates.length;
      }
    } catch (err) {
      errors += batch.length;
      processed += batch.length - (processed % BATCH_SIZE || BATCH_SIZE);
      if (errors <= 5) console.error(`\n  Batch error: ${err.message}`);
    }

    if (processed % 500 === 0 || i + BATCH_SIZE >= rows.length) {
      console.log(`  [${processed}/${rows.length}] updated=${updated} notFound=${notFound} errors=${errors}`);
    }

    await sleep(DELAY_MS);
  }

  console.log(`\nDone! processed=${processed} updated=${updated} notFound=${notFound} errors=${errors}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
