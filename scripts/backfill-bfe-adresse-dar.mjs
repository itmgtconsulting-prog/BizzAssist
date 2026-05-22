#!/usr/bin/env node
/**
 * BIZZ-1671: Backfill bfe_adresse_cache for BFEs that have adgangsadresse_id
 * but aren't in cache_dar. Fetches from DAWA /adgangsadresser/{uuid}.
 *
 * Usage:
 *   node scripts/backfill-bfe-adresse-dar.mjs --env=prod [--from=0]
 */
import https from 'node:https';
import { config } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, '..', '.env.local') });

const args = process.argv.slice(2);
const TARGET_ENV = args.find(x => x.startsWith('--env='))?.split('=')[1] || 'prod';
const FROM_BFE = (() => { const a = args.find(x => x.startsWith('--from=')); return a ? parseInt(a.split('=')[1], 10) : 0; })();

const ENV_REFS = { dev: 'wkzwxfhyfmvglrqtmebw', preview: 'rlkjmqjxmkxuclehbrnl', prod: 'xsyldjqcntiygrtfcszm' };
const PROJECT_REF = ENV_REFS[TARGET_ENV];
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

const CONCURRENCY = 25;
const BATCH_SIZE = 100;

function runSqlOnce(sql) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ query: sql });
    const timer = setTimeout(() => { req.destroy(); resolve({ message: 'timeout' }); }, 30000);
    const req = https.request({ hostname: 'api.supabase.com', path: `/v1/projects/${PROJECT_REF}/database/query`, method: 'POST', headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', (e) => { clearTimeout(timer); resolve({ message: e.code || e.message }); });
    req.write(body); req.end();
  });
}

async function runSql(sql, retries = 5) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await runSqlOnce(sql);
    if (r?.message && (r.message.includes('timeout') || r.message.includes('ECONNRESET') || r.message.includes('Throttler'))) {
      if (attempt < retries) { await new Promise(res => setTimeout(res, 5000 * (attempt + 1))); continue; }
    }
    return r;
  }
  return { message: 'max retries' };
}

function esc(s) { return s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`; }

async function fetchDawaAdresse(uuid) {
  try {
    const res = await fetch(`https://api.dataforsyningen.dk/adgangsadresser/${uuid}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    return {
      adresse: [d.vejnavn, d.husnr].filter(Boolean).join(' '),
      postnr: d.postnr?.nr || d.postnr || null,
      postnrnavn: d.postnr?.navn || d.postnrnavn || null,
      kommune: d.kommune?.navn || null,
      kommune_kode: d.kommune?.kode || d.kommunekode || null,
      dawa_id: uuid,
    };
  } catch { return null; }
}

async function main() {
  process.on('uncaughtException', (err) => {
    if (err.code === 'ECONNRESET' || err.code === 'EPIPE') return;
    console.error('Fatal:', err); process.exit(1);
  });

  console.log(`BIZZ-1671: Backfill bfe_adresse via DAWA /adgangsadresser — env=${TARGET_ENV}`);

  let processed = 0, inserted = 0, noData = 0, errors = 0;
  let cursorBfe = FROM_BFE;
  let insertBuf = [];
  const startTime = Date.now();

  while (true) {
    const batch = await runSql(`
      SELECT b.bfe_nummer, b.adgangsadresse_id FROM bbr_ejendom_status b
      WHERE b.bfe_nummer > ${cursorBfe} AND b.is_udfaset = false
        AND b.adgangsadresse_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM bfe_adresse_cache c WHERE c.bfe_nummer = b.bfe_nummer)
        AND NOT EXISTS (SELECT 1 FROM cache_dar d WHERE d.adresse_id = b.adgangsadresse_id)
      ORDER BY b.bfe_nummer LIMIT ${BATCH_SIZE}
    `);

    if (batch?.message) {
      console.error(`  [WARN] fetch failed: ${batch.message} — retrying in 30s`);
      await new Promise(r => setTimeout(r, 30000));
      continue;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    cursorBfe = batch[batch.length - 1].bfe_nummer;

    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      const chunk = batch.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        chunk.map(async (row) => {
          const adr = await fetchDawaAdresse(row.adgangsadresse_id);
          return adr ? { bfe_nummer: row.bfe_nummer, ...adr } : null;
        })
      );

      for (const r of results) {
        processed++;
        if (r.status === 'rejected' || !r.value) { noData++; continue; }
        insertBuf.push(r.value);
      }
    }

    if (insertBuf.length >= 50) {
      const values = insertBuf.map(r =>
        `(${r.bfe_nummer}, ${esc(r.adresse)}, NULL, NULL, ${esc(r.postnr)}, ${esc(r.postnrnavn)}, ${esc(r.kommune)}, ${esc(r.kommune_kode)}, ${esc(r.dawa_id)}, NULL, 'dawa-adgangsadresse', now())`
      ).join(',\n');

      for (let attempt = 0; attempt < 5; attempt++) {
        const result = await runSql(`INSERT INTO bfe_adresse_cache (bfe_nummer, adresse, etage, doer, postnr, postnrnavn, kommune, kommune_kode, dawa_id, ejendomstype, kilde, sidst_opdateret) VALUES ${values} ON CONFLICT (bfe_nummer) DO NOTHING`);
        if (!result?.message) { inserted += insertBuf.length; break; }
        if (result.message.includes('timeout') || result.message.includes('Throttler')) {
          await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
          continue;
        }
        errors++;
        break;
      }
      insertBuf = [];
    }

    if (processed % 500 === 0) {
      const rate = (processed / ((Date.now() - startTime) / 1000)).toFixed(1);
      console.log(`  [${processed}] inserted=${inserted} noData=${noData} errors=${errors} ${rate}/s cursor=${cursorBfe}`);
    }

    await new Promise(r => setTimeout(r, 50));
  }

  if (insertBuf.length > 0) {
    const values = insertBuf.map(r =>
      `(${r.bfe_nummer}, ${esc(r.adresse)}, NULL, NULL, ${esc(r.postnr)}, ${esc(r.postnrnavn)}, ${esc(r.kommune)}, ${esc(r.kommune_kode)}, ${esc(r.dawa_id)}, NULL, 'dawa-adgangsadresse', now())`
    ).join(',\n');
    const result = await runSql(`INSERT INTO bfe_adresse_cache (bfe_nummer, adresse, etage, doer, postnr, postnrnavn, kommune, kommune_kode, dawa_id, ejendomstype, kilde, sidst_opdateret) VALUES ${values} ON CONFLICT (bfe_nummer) DO NOTHING`);
    if (!result?.message) inserted += insertBuf.length;
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\nDone! ${elapsed} min, processed=${processed}, inserted=${inserted}, noData=${noData}, errors=${errors}`);
  console.log(`Resume with: --from=${cursorBfe}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
