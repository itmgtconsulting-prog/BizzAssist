#!/usr/bin/env node
/**
 * BIZZ-1945: Backfill cvr_deltager.navn for enheder hvor navn er NULL eller
 * "Ukendt ejer (en NNNN)" placeholder. ~230K enheder forekommer i M&A radar MV.
 *
 * Strategi:
 *  - Query CVR ES /cvr-permanent/_search med terms-filter (batch 50 enheder per kald)
 *  - Hver hit kan være Vrdeltagerperson, Vrdeltagervirksomhed eller Vrvirksomhed
 *  - Extract enhedsNummer + navne (gyldigNu) → UPDATE cvr_deltager.navn
 *  - Efter alle batches: REFRESH MATERIALIZED VIEW mv_deltager_beriget (hvis findes)
 *    og mv_virksomhedshandel_kandidater
 *
 * Usage:
 *   node scripts/backfill-1945-deltager-navne.mjs --target=preview [--concurrency=8] [--batch=50] [--limit=N]
 */
import fs from 'fs';
import pg from 'pg';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k,v] = a.replace(/^--/,'').split('='); return [k, v ?? 'true']; }));
const TARGET = args.target || 'preview';
const CONCURRENCY = parseInt(args.concurrency || '8', 10);
const BATCH = parseInt(args.batch || '50', 10);
const LIMIT = parseInt(args.limit || '0', 10) || 999999999;
const SKIP_REFRESH = args['skip-refresh'] === 'true' || args['skip-refresh'] === true;
const ENHEDER_ARG = args.enheder && args.enheder !== 'true' ? args.enheder.split(',') : null;

const env = fs.readFileSync('/root/BizzAssist/.env.local', 'utf8');
const URLS = { prod: env.match(/^SUPABASE_PROD_DB_URL=(.+)$/m)?.[1], preview: env.match(/^SUPABASE_PREVIEW_DB_URL=(.+)$/m)?.[1] };
const DB_URL = URLS[TARGET];
if (!DB_URL) { console.error('Unknown --target:', TARGET); process.exit(1); }
const USER = env.match(/^CVR_ES_USER=(.+)$/m)?.[1];
const PASS = env.match(/^CVR_ES_PASS=(.+)$/m)?.[1];
const esAuth = Buffer.from(`${USER}:${PASS}`).toString('base64');
const pool = new pg.Pool({ connectionString: DB_URL, max: Math.min(CONCURRENCY + 4, 20) });

console.log(`[1945] target=${TARGET}, concurrency=${CONCURRENCY}, batch=${BATCH}`);

function gyldigNu(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.find(x => !x.periode?.gyldigTil) ?? arr[arr.length - 1];
}

/**
 * Query CVR ES /cvr-permanent/_search med terms på enhedsNummer.
 * Returns Map<enhedsNummer, navn>.
 */
async function fetchNamesBatch(enheder) {
  const enhederInts = enheder.map(e => parseInt(e, 10)).filter(Number.isFinite);
  // Brug bool/should med terms over flere felter — ES OR'er på tværs
  const body = {
    _source: [
      'Vrdeltagerperson.enhedsNummer', 'Vrdeltagerperson.navne',
      'Vrdeltagervirksomhed.enhedsNummer', 'Vrdeltagervirksomhed.navne',
      'Vrvirksomhed.enhedsNummer', 'Vrvirksomhed.navne',
    ],
    query: {
      bool: {
        should: [
          { terms: { 'Vrdeltagerperson.enhedsNummer': enhederInts } },
          { terms: { 'Vrdeltagervirksomhed.enhedsNummer': enhederInts } },
          { terms: { 'Vrvirksomhed.enhedsNummer': enhederInts } },
        ],
        minimum_should_match: 1,
      }
    },
    size: enhederInts.length,
  };
  const r = await fetch('http://distribution.virk.dk/cvr-permanent/_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip', Authorization: `Basic ${esAuth}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`ES ${r.status}`);
  const data = await r.json();
  const out = new Map();
  for (const hit of (data.hits?.hits || [])) {
    const src = hit._source || {};
    const root = src.Vrdeltagerperson || src.Vrdeltagervirksomhed || src.Vrvirksomhed;
    if (!root) continue;
    const enhed = String(root.enhedsNummer ?? '');
    const navne = Array.isArray(root.navne) ? root.navne : [];
    const akt = gyldigNu(navne);
    const navn = akt?.navn?.trim();
    if (enhed && navn) out.set(enhed, navn);
  }
  return out;
}

async function processBatch(enheder) {
  let names;
  try { names = await fetchNamesBatch(enheder); }
  catch (e) { return { tried: enheder.length, updated: 0, err: e.message }; }
  if (names.size === 0) return { tried: enheder.length, updated: 0 };

  // Batch UPDATE: build CASE WHEN ... THEN ... END
  const client = await pool.connect();
  try {
    // INSERT ... ON CONFLICT DO UPDATE: handles both "missing row" og "row with placeholder"
    const placeholders = [];
    const params = [];
    let p = 1;
    for (const [enhed, navn] of names) {
      placeholders.push(`($${p++}::bigint, $${p++})`);
      params.push(enhed, navn);
    }
    const sql = `
      INSERT INTO cvr_deltager (enhedsnummer, navn)
      VALUES ${placeholders.join(',')}
      ON CONFLICT (enhedsnummer) DO UPDATE
        SET navn = EXCLUDED.navn, sidst_opdateret = now()
        WHERE cvr_deltager.navn IS NULL
           OR cvr_deltager.navn = ''
           OR cvr_deltager.navn LIKE 'Ukendt ejer%'
    `;
    const r = await client.query(sql, params);
    return { tried: enheder.length, updated: r.rowCount };
  } catch (e) {
    return { tried: enheder.length, updated: 0, err: e.message };
  } finally {
    client.release();
  }
}

async function main() {
  let enheder;
  if (ENHEDER_ARG) {
    enheder = ENHEDER_ARG;
    console.log(`[1945] using --enheder: ${enheder.length}`);
  } else {
    console.time('[1945] cvr enheder list');
    // Distinct enheder fra MV der har placeholder/NULL navn.
    // INSERT ON CONFLICT håndterer både "missing row" og "row with placeholder".
    const { rows } = await pool.query(`
      SELECT DISTINCT m.deltager_enhedsnummer FROM mv_virksomhedshandel_kandidater m
      WHERE m.deltager_navn IS NULL OR m.deltager_navn LIKE 'Ukendt ejer%'
      ORDER BY m.deltager_enhedsnummer LIMIT $1
    `, [LIMIT]);
    enheder = rows.map(r => r.deltager_enhedsnummer);
    console.timeEnd('[1945] cvr enheder list');
  }
  console.log(`[1945] ${enheder.length} distinct enheder at backfille`);

  let processed = 0, updated = 0, errors = 0;
  const start = Date.now();
  // Build batches
  const batches = [];
  for (let i = 0; i < enheder.length; i += BATCH) batches.push(enheder.slice(i, i + BATCH));

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const chunk = batches.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(processBatch));
    for (const r of results) {
      processed += r.tried;
      updated += r.updated;
      if (r.err) { errors++; if (errors <= 5) console.warn('  ERR:', r.err); }
    }
    if (processed % 5000 === 0 || processed >= enheder.length) {
      const el = (Date.now() - start) / 1000;
      const rate = processed / el;
      const eta = (enheder.length - processed) / rate;
      console.log(`[1945] ${processed}/${enheder.length} (${(processed/enheder.length*100).toFixed(1)}%) updated=${updated} err=${errors} rate=${rate.toFixed(0)}/s eta=${(eta/60).toFixed(0)}min`);
    }
  }
  console.log(`\n[1945] backfill done. processed=${processed}, updated=${updated}, errors=${errors}`);

  if (!SKIP_REFRESH) {
    for (const mv of ['mv_deltager_beriget', 'mv_virksomhedshandel_kandidater']) {
      console.time(`[1945] REFRESH ${mv}`);
      try {
        try { await pool.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${mv}`); console.log(' CONCURRENTLY ok'); }
        catch (e) { console.log(' CONCURRENT fail:', e.message, '— retry'); await pool.query(`REFRESH MATERIALIZED VIEW ${mv}`); console.log(' refreshed'); }
      } catch (e) { console.log(' refresh failed:', e.message); }
      console.timeEnd(`[1945] REFRESH ${mv}`);
    }
  }
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
