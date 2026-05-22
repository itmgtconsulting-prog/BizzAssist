#!/usr/bin/env node
/**
 * BIZZ-1671: Full backfill bfe_adresse_cache via DAWA /bfe endpoint.
 *
 * Resolves BFE → address for all BFEs in bbr_ejendom_status.
 * Primary: DAWA /bfe (free, ~30 req/s). Fallback: VP ES for ejerlejligheder.
 *
 * Uses Management API + cursor pagination for multi-env support.
 *
 * Usage:
 *   node scripts/backfill-bfe-adresse.mjs --env=prod [--from=100000] [--to=200000]
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
const TO_BFE = (() => { const a = args.find(x => x.startsWith('--to=')); return a ? parseInt(a.split('=')[1], 10) : null; })();

const ENV_REFS = { dev: 'wkzwxfhyfmvglrqtmebw', preview: 'rlkjmqjxmkxuclehbrnl', prod: 'xsyldjqcntiygrtfcszm' };
const PROJECT_REF = ENV_REFS[TARGET_ENV];
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

const CONCURRENCY = 20; // DAWA allows ~30 req/s
const BATCH_SIZE = 100;
const DELAY_MS = 100;

if (!ACCESS_TOKEN || !PROJECT_REF) { console.error('Missing credentials'); process.exit(1); }

/**
 * Execute SQL via Management API with retry.
 */
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

async function runSql(sql, retries = 3) {
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

/**
 * Fetch address from DAWA /bfe endpoint.
 */
async function fetchDawa(bfe) {
  try {
    const res = await fetch(`https://api.dataforsyningen.dk/bfe/${bfe}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const data = await res.json();
    const adr = data?.beliggenhedsadresse;
    if (!adr) return null;
    return {
      bfe_nummer: bfe,
      adresse: [adr.vejnavn, adr.husnr].filter(Boolean).join(' '),
      etage: adr.etage || null,
      doer: adr.dør || adr.doer || null,
      postnr: adr.postnr || null,
      postnrnavn: adr.postnrnavn || null,
      kommune: adr.kommunenavn || null,
      kommune_kode: adr.kommunekode || null,
      dawa_id: adr.id || null,
      ejendomstype: data.type || null,
      kilde: 'dawa',
    };
  } catch { return null; }
}

async function main() {
  process.on('uncaughtException', (err) => {
    if (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ETIMEDOUT') {
      console.error(`  [WARN] uncaught ${err.code}`);
      return;
    }
    console.error('Fatal:', err); process.exit(1);
  });

  const rangeLabel = `${FROM_BFE}→${TO_BFE || 'end'}`;
  console.log(`BIZZ-1671: Backfill bfe_adresse_cache — env=${TARGET_ENV}, range=${rangeLabel}`);
  console.log(`Config: CONCURRENCY=${CONCURRENCY}, BATCH_SIZE=${BATCH_SIZE}`);

  let processed = 0, inserted = 0, noData = 0, errors = 0;
  let cursorBfe = FROM_BFE;
  let insertBuf = [];
  const startTime = Date.now();

  while (true) {
    // Fetch batch of BFEs not yet in cache using cursor
    const toClause = TO_BFE ? `AND b.bfe_nummer < ${TO_BFE}` : '';
    const batch = await runSql(`
      SELECT b.bfe_nummer FROM bbr_ejendom_status b
      LEFT JOIN bfe_adresse_cache c ON c.bfe_nummer = b.bfe_nummer
      WHERE b.bfe_nummer > ${cursorBfe} ${toClause}
        AND b.is_udfaset = false
        AND c.bfe_nummer IS NULL
      ORDER BY b.bfe_nummer
      LIMIT ${BATCH_SIZE}
    `);

    if (batch?.message) {
      console.error(`  [WARN] batch fetch failed: ${batch.message} — retrying in 30s`);
      await new Promise(r => setTimeout(r, 30000));
      continue;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    cursorBfe = batch[batch.length - 1].bfe_nummer;

    // Fetch addresses in parallel
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      const chunk = batch.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(chunk.map(b => fetchDawa(b.bfe_nummer)));

      for (const result of results) {
        processed++;
        if (result.status === 'rejected') { errors++; continue; }
        if (!result.value) { noData++; continue; }
        insertBuf.push(result.value);
      }

      await new Promise(r => setTimeout(r, DELAY_MS));
    }

    // Flush insert buffer
    if (insertBuf.length >= 50) {
      const values = insertBuf.map(r =>
        `(${r.bfe_nummer}, ${esc(r.adresse)}, ${esc(r.etage)}, ${esc(r.doer)}, ${esc(r.postnr)}, ${esc(r.postnrnavn)}, ${esc(r.kommune)}, ${esc(r.kommune_kode)}, ${esc(r.dawa_id)}, ${esc(r.ejendomstype)}, ${esc(r.kilde)}, now())`
      ).join(',\n');

      for (let attempt = 0; attempt < 5; attempt++) {
        const result = await runSql(`INSERT INTO bfe_adresse_cache (bfe_nummer, adresse, etage, doer, postnr, postnrnavn, kommune, kommune_kode, dawa_id, ejendomstype, kilde, sidst_opdateret) VALUES ${values} ON CONFLICT (bfe_nummer) DO UPDATE SET adresse = EXCLUDED.adresse, etage = EXCLUDED.etage, doer = EXCLUDED.doer, postnr = EXCLUDED.postnr, postnrnavn = EXCLUDED.postnrnavn, kommune = EXCLUDED.kommune, kommune_kode = EXCLUDED.kommune_kode, dawa_id = EXCLUDED.dawa_id, ejendomstype = EXCLUDED.ejendomstype, kilde = EXCLUDED.kilde, sidst_opdateret = EXCLUDED.sidst_opdateret`);
        if (!result?.message) { inserted += insertBuf.length; break; }
        if (result.message.includes('timeout') || result.message.includes('Throttler')) {
          console.error(`  [INSERT RETRY ${attempt + 1}/5]`);
          await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
          continue;
        }
        errors++;
        if (errors <= 5) console.error(`  [INSERT ERR]: ${result.message.substring(0, 150)}`);
        break;
      }
      insertBuf = [];
    }

    if (processed % 500 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = (processed / elapsed).toFixed(1);
      console.log(`  [${processed}] inserted=${inserted} noData=${noData} errors=${errors} ${rate} BFE/s cursor=${cursorBfe}`);
    }
  }

  // Final flush
  if (insertBuf.length > 0) {
    const values = insertBuf.map(r =>
      `(${r.bfe_nummer}, ${esc(r.adresse)}, ${esc(r.etage)}, ${esc(r.doer)}, ${esc(r.postnr)}, ${esc(r.postnrnavn)}, ${esc(r.kommune)}, ${esc(r.kommune_kode)}, ${esc(r.dawa_id)}, ${esc(r.ejendomstype)}, ${esc(r.kilde)}, now())`
    ).join(',\n');
    const result = await runSql(`INSERT INTO bfe_adresse_cache (bfe_nummer, adresse, etage, doer, postnr, postnrnavn, kommune, kommune_kode, dawa_id, ejendomstype, kilde, sidst_opdateret) VALUES ${values} ON CONFLICT (bfe_nummer) DO UPDATE SET adresse = EXCLUDED.adresse, etage = EXCLUDED.etage, doer = EXCLUDED.doer, postnr = EXCLUDED.postnr, postnrnavn = EXCLUDED.postnrnavn, kommune = EXCLUDED.kommune, kommune_kode = EXCLUDED.kommune_kode, dawa_id = EXCLUDED.dawa_id, ejendomstype = EXCLUDED.ejendomstype, kilde = EXCLUDED.kilde, sidst_opdateret = EXCLUDED.sidst_opdateret`);
    if (!result?.message) inserted += insertBuf.length;
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\nDone! ${elapsed} min, processed=${processed}, inserted=${inserted}, noData=${noData}, errors=${errors}`);
  console.log(`Resume with: --from=${cursorBfe}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
