#!/usr/bin/env node
/**
 * BIZZ-1856 #1: Backfill bfe_adresse_cache siblings via VP adgangsAdresseID.
 *
 * For hver distinct dawa_id i cache, query VP _search og find alle BFEer
 * der deler samme adgangsAdresseID. For hver sibling BFE der IKKE er i cache:
 * backfill via 3-fallback (DAWA /bfe → VP _search → DAWA jordstykke).
 *
 * Eksempel: J.C. Jacobsens Gade 13 (BFE 100435317) har adgangsAdresseID
 * fd1ec250 — VP knytter 376 BFEer hertil men cache har kun 188 for området.
 *
 * Usage:
 *   node scripts/backfill-bfe-adresse-siblings.mjs [--limit=N] [--offset=N] [--concurrency=N] [--postnr=1799] [--min-cached=2] [--max-cached=50] [--dry-run]
 */

import pg from 'pg';
import fs from 'fs';

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  })
);

const LIMIT = parseInt(args.limit || '0', 10) || 999999;
const OFFSET = parseInt(args.offset || '0', 10);
const CONCURRENCY = parseInt(args.concurrency || '10', 10);
const POSTNR = args.postnr && args.postnr !== 'true' ? args.postnr : null;
const MIN_CACHED = parseInt(args['min-cached'] || '2', 10);
const MAX_CACHED = parseInt(args['max-cached'] || '300', 10);
const DRY_RUN = args['dry-run'] === 'true';
const DAWA_BASE = 'https://api.dataforsyningen.dk';

const envContent = fs.readFileSync('/root/BizzAssist/.env.local', 'utf8');
const PROD_DB_URL = envContent.match(/^SUPABASE_PROD_DB_URL=(.+)$/m)?.[1];

// ── Resolve BFE via 3 fallbacks (same logic as backfill-bfe-adresse-1850) ───
async function resolveBfe(bfe) {
  // 1. DAWA /bfe
  try {
    const r = await fetch(`${DAWA_BASE}/bfe/${bfe}`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const json = await r.json();
      const bel = json.beliggenhedsadresse;
      if (bel?.vejnavn) {
        return {
          bfe_nummer: bfe,
          adresse: `${bel.vejnavn} ${bel.husnr ?? ''}`.trim(),
          etage: bel.etage || null,
          doer: bel['dør'] || null,
          postnr: bel.postnr ?? null,
          postnrnavn: bel.postnrnavn ?? null,
          kommune: bel.kommunenavn ?? null,
          kommune_kode: bel.kommunekode ?? null,
          dawa_id: bel.id ?? null,
          ejendomstype: json.ejendomstype ?? null,
          kilde: 'backfill_1856_dawa',
        };
      }
    }
  } catch {}
  // 2. VP _search
  try {
    const r = await fetch('https://api-fs.vurderingsportalen.dk/preliminaryproperties/_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      body: JSON.stringify({ query: { term: { bfeNumbers: bfe } }, size: 1, _source: ['roadName','houseNumber','zipcode','postDistrict','floor','door','adgangsAdresseID'] }),
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const data = await r.json();
      const src = data.hits?.hits?.[0]?._source;
      if (src?.roadName) {
        return {
          bfe_nummer: bfe,
          adresse: `${src.roadName} ${src.houseNumber ?? ''}`.trim(),
          etage: src.floor || null,
          doer: src.door || null,
          postnr: src.zipcode ?? null,
          postnrnavn: src.postDistrict ?? null,
          kommune: null,
          kommune_kode: null,
          dawa_id: src.adgangsAdresseID ?? null,
          ejendomstype: null,
          kilde: 'backfill_1856_vp',
        };
      }
    }
  } catch {}
  // 3. DAWA jordstykke
  try {
    const r1 = await fetch(`${DAWA_BASE}/jordstykker?bfenummer=${bfe}&format=json`, { signal: AbortSignal.timeout(8000) });
    if (r1.ok) {
      const jordstykker = await r1.json();
      const ejerlav = jordstykker[0]?.ejerlav?.kode;
      const matr = jordstykker[0]?.matrikelnr;
      if (ejerlav && matr) {
        const r2 = await fetch(`${DAWA_BASE}/adresser?ejerlavkode=${ejerlav}&matrikelnr=${encodeURIComponent(matr)}&format=json&struktur=mini&per_side=1`, { signal: AbortSignal.timeout(8000) });
        if (r2.ok) {
          const adresser = await r2.json();
          const a = adresser[0];
          if (a?.vejnavn && a?.postnr) {
            return {
              bfe_nummer: bfe,
              adresse: a.vejnavn,
              etage: null, doer: null,
              postnr: a.postnr,
              postnrnavn: a.postnrnavn ?? null,
              kommune: null, kommune_kode: null,
              dawa_id: a.id ?? null,
              ejendomstype: null,
              kilde: 'backfill_1856_jordstykke',
            };
          }
        }
      }
    }
  } catch {}
  return null;
}

// ── Get siblings from VP for an adgangsAdresseID ────────────────────
async function getSiblingBfes(adgangsAdresseID) {
  try {
    const r = await fetch('https://api-fs.vurderingsportalen.dk/preliminaryproperties/_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      body: JSON.stringify({
        query: { term: { 'adgangsAdresseID.keyword': adgangsAdresseID } },
        size: 500,
        _source: ['bfeNumbers']
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const bfes = new Set();
    for (const h of data.hits?.hits || []) {
      const b = h._source?.bfeNumbers;
      if (b == null) continue;
      const n = Number(typeof b === 'string' ? b : (Array.isArray(b) ? b[0] : b));
      if (Number.isFinite(n) && n > 0) bfes.add(n);
    }
    return bfes;
  } catch { return null; }
}

// ── Process one adgangsadresse ──────────────────────────────────────
async function processAdgangsadresse(dawaId, cachedBfes, pool) {
  const vpBfes = await getSiblingBfes(dawaId);
  if (!vpBfes) return { dawaId, status: 'vp-error', resolved: 0 };

  const missing = [...vpBfes].filter(b => !cachedBfes.has(b));
  if (missing.length === 0) return { dawaId, status: 'no-gap', resolved: 0 };

  // Resolve missing siblings
  let resolved = 0;
  const toUpsert = [];
  for (const bfe of missing) {
    const row = await resolveBfe(bfe);
    if (row) { toUpsert.push(row); resolved++; }
  }

  if (!DRY_RUN && toUpsert.length > 0) {
    const placeholders = [];
    const params = [];
    let p = 1;
    for (const r of toUpsert) {
      placeholders.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},NOW())`);
      params.push(r.bfe_nummer, r.adresse, r.etage, r.doer, r.postnr, r.postnrnavn, r.kommune, r.kommune_kode, r.dawa_id, r.ejendomstype, r.kilde);
    }
    await pool.query(
      `INSERT INTO bfe_adresse_cache
       (bfe_nummer, adresse, etage, doer, postnr, postnrnavn, kommune, kommune_kode, dawa_id, ejendomstype, kilde, sidst_opdateret)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (bfe_nummer) DO NOTHING`,
      params
    );
  }
  return { dawaId, status: 'ok', vp: vpBfes.size, cached: cachedBfes.size, missing: missing.length, resolved };
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log(`[1856-siblings] Start (limit=${LIMIT}, offset=${OFFSET}, concurrency=${CONCURRENCY}, postnr=${POSTNR}, min-cached=${MIN_CACHED}, max-cached=${MAX_CACHED}, dry-run=${DRY_RUN})`);
  const pool = new pg.Pool({ connectionString: PROD_DB_URL, max: CONCURRENCY + 2, statement_timeout: 600000 });

  // Get distinct dawa_ids with 2-300 cached BFEs (multi-unit buildings, likely with gaps)
  console.time('[1856-siblings] dawa_id query');
  const params = [];
  const where = ['dawa_id IS NOT NULL'];
  if (POSTNR) { params.push(POSTNR); where.push(`postnr = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT dawa_id, count(*) AS n
     FROM bfe_adresse_cache
     WHERE ${where.join(' AND ')}
     GROUP BY dawa_id
     HAVING count(*) BETWEEN ${MIN_CACHED} AND ${MAX_CACHED}
     ORDER BY count(*) DESC
     OFFSET ${OFFSET} LIMIT ${LIMIT}`,
    params
  );
  console.timeEnd('[1856-siblings] dawa_id query');
  console.log(`[1856-siblings] ${rows.length} adgangsadresser at tjekke`);

  let processed = 0, resolved = 0, errors = 0, noGap = 0;
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);

    // Pre-fetch cached BFEs for batch
    const dawaIds = batch.map(r => r.dawa_id);
    const cached = await pool.query(
      'SELECT dawa_id, array_agg(bfe_nummer) AS bfes FROM bfe_adresse_cache WHERE dawa_id = ANY($1) GROUP BY dawa_id',
      [dawaIds]
    );
    const cachedMap = new Map(cached.rows.map(r => [r.dawa_id, new Set(r.bfes.map(Number))]));

    const results = await Promise.all(batch.map(async r => {
      try {
        return await processAdgangsadresse(r.dawa_id, cachedMap.get(r.dawa_id) || new Set(), pool);
      } catch (err) {
        return { dawaId: r.dawa_id, status: 'exception', error: err.message };
      }
    }));

    for (const r of results) {
      processed++;
      if (r.status === 'ok') resolved += r.resolved;
      else if (r.status === 'no-gap') noGap++;
      else errors++;
    }

    if (processed % 100 === 0 || processed === rows.length) {
      console.log(`[1856-siblings] processed=${processed}/${rows.length}, resolved=${resolved}, no-gap=${noGap}, errors=${errors}`);
    }
  }

  console.log(`\n[1856-siblings] DONE — processed=${processed}, resolved=${resolved}, no-gap=${noGap}, errors=${errors}`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
