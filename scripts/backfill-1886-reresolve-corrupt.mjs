#!/usr/bin/env node
/**
 * BIZZ-1886: Invalidate + re-resolve de 3.806 rows i bfe_adresse_cache med
 * kilde='backfill_1831_ejer_addr' som har ~80% mismatch mod live data.
 *
 * Process:
 *   For hver corrupt row:
 *     1. Kør 3-fallback (DAWA /bfe → VP → DAWA jordstykker)
 *     2. Hvis succesfuld: UPDATE row med korrekt data (overwrite kilde)
 *     3. Hvis ikke: UPDATE til kilde='unresolvable' med next_retry_after=+90d
 *
 * Usage:
 *   node scripts/backfill-1886-reresolve-corrupt.mjs [--limit=N] [--concurrency=N] [--dry-run]
 */

import pg from 'pg';
import fs from 'fs';

const args = Object.fromEntries(
  process.argv.slice(2).map(a => { const [k,v] = a.replace(/^--/,'').split('='); return [k, v ?? 'true']; })
);
const LIMIT = parseInt(args.limit || '0', 10) || 999999;
const CONCURRENCY = parseInt(args.concurrency || '10', 10);
const DRY_RUN = args['dry-run'] === 'true';
const DAWA_BASE = 'https://api.dataforsyningen.dk';

const envContent = fs.readFileSync('/root/BizzAssist/.env.local', 'utf8');
const PROD_DB_URL = envContent.match(/^SUPABASE_PROD_DB_URL=(.+)$/m)?.[1];

// 3-fallback (samme som BIZZ-1850/1882)
async function dawaBfe(bfe) {
  try {
    const res = await fetch(`${DAWA_BASE}/bfe/${bfe}`, { signal: AbortSignal.timeout(8000) });
    if (res.status === 404) return { status: 'no_hit' };
    if (!res.ok) return { status: 'error' };
    const json = await res.json();
    const bel = json.beliggenhedsadresse;
    if (!bel?.vejnavn) return { status: 'no_hit' };
    return { status: 'ok', row: {
      adresse: `${bel.vejnavn} ${bel.husnr ?? ''}`.trim(),
      etage: bel.etage || null, doer: bel['dør'] || null,
      postnr: bel.postnr ?? null, postnrnavn: bel.postnrnavn ?? null,
      kommune: bel.kommunenavn ?? null, kommune_kode: bel.kommunekode ?? null,
      dawa_id: bel.id ?? null, ejendomstype: json.ejendomstype ?? null,
      kilde: 'backfill_1886_dawa',
    }};
  } catch { return { status: 'error' }; }
}

async function vpSearch(bfe) {
  try {
    const res = await fetch('https://api-fs.vurderingsportalen.dk/preliminaryproperties/_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      body: JSON.stringify({ query: { term: { bfeNumbers: bfe } }, size: 1, _source: ['roadName','houseNumber','zipcode','postDistrict','floor','door','adgangsAdresseID'] }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { status: 'error' };
    const data = await res.json();
    const src = data.hits?.hits?.[0]?._source;
    if (!src?.roadName) return { status: 'no_hit' };
    return { status: 'ok', row: {
      adresse: `${src.roadName} ${src.houseNumber ?? ''}`.trim(),
      etage: src.floor || null, doer: src.door || null,
      postnr: src.zipcode ?? null, postnrnavn: src.postDistrict ?? null,
      kommune: null, kommune_kode: null,
      dawa_id: src.adgangsAdresseID ?? null, ejendomstype: null,
      kilde: 'backfill_1886_vp',
    }};
  } catch { return { status: 'error' }; }
}

async function dawaJordstykke(bfe) {
  try {
    const r1 = await fetch(`${DAWA_BASE}/jordstykker?bfenummer=${bfe}&format=json`, { signal: AbortSignal.timeout(8000) });
    if (!r1.ok) return { status: 'error' };
    const arr = await r1.json();
    const ejerlav = arr[0]?.ejerlav?.kode;
    const matr = arr[0]?.matrikelnr;
    if (!ejerlav || !matr) return { status: 'no_hit' };
    const r2 = await fetch(`${DAWA_BASE}/adresser?ejerlavkode=${ejerlav}&matrikelnr=${encodeURIComponent(matr)}&format=json&struktur=mini&per_side=1`, { signal: AbortSignal.timeout(8000) });
    if (!r2.ok) return { status: 'error' };
    const adresser = await r2.json();
    const a = adresser[0];
    if (!a?.vejnavn || !a?.postnr) return { status: 'no_hit' };
    return { status: 'ok', row: {
      adresse: a.vejnavn, etage: null, doer: null,
      postnr: a.postnr, postnrnavn: a.postnrnavn ?? null,
      kommune: null, kommune_kode: null,
      dawa_id: a.id ?? null, ejendomstype: null,
      kilde: 'backfill_1886_jordstykke',
    }};
  } catch { return { status: 'error' }; }
}

async function resolveBfe(bfe) {
  const r1 = await dawaBfe(bfe);
  if (r1.status === 'ok') return { row: r1.row, status: 'resolved' };
  const r2 = await vpSearch(bfe);
  if (r2.status === 'ok') return { row: r2.row, status: 'resolved' };
  const r3 = await dawaJordstykke(bfe);
  if (r3.status === 'ok') return { row: r3.row, status: 'resolved' };
  // Hvis NOGEN gav error: ikke marker unresolvable (transient)
  if (r1.status === 'error' || r2.status === 'error' || r3.status === 'error') return { status: 'transient_error' };
  return { status: 'unresolvable' };
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log(`[1886] Start (limit=${LIMIT}, concurrency=${CONCURRENCY}, dry-run=${DRY_RUN})`);
  const pool = new pg.Pool({ connectionString: PROD_DB_URL, max: CONCURRENCY + 2, statement_timeout: 300000 });

  const { rows } = await pool.query(
    `SELECT bfe_nummer, adresse, postnr FROM bfe_adresse_cache WHERE kilde = 'backfill_1831_ejer_addr' ORDER BY bfe_nummer LIMIT $1`,
    [LIMIT]
  );
  const candidates = rows.map(r => ({ bfe: Number(r.bfe_nummer), oldAdresse: r.adresse, oldPostnr: r.postnr }));
  console.log(`[1886] ${candidates.length} corrupt rows at re-resolve`);

  let processed = 0, resolved = 0, unresolvable = 0, transient = 0, sameAddress = 0;
  const bySource = { backfill_1886_dawa: 0, backfill_1886_vp: 0, backfill_1886_jordstykke: 0 };
  const RETRY_DELAY = 90 * 24 * 3600 * 1000;

  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async c => {
      const r = await resolveBfe(c.bfe).catch(() => ({ status: 'transient_error' }));
      return { ...c, ...r };
    }));

    const toResolve = results.filter(r => r.status === 'resolved');
    const toUnresolvable = results.filter(r => r.status === 'unresolvable');
    const transientErrs = results.filter(r => r.status === 'transient_error');

    processed += batch.length;
    resolved += toResolve.length;
    unresolvable += toUnresolvable.length;
    transient += transientErrs.length;

    // Track if new adresse matches old (probably wasn't actually corrupt)
    for (const r of toResolve) {
      if (r.row.adresse?.startsWith(r.oldAdresse?.split(' ')[0] || '')) sameAddress++;
      bySource[r.row.kilde] = (bySource[r.row.kilde] || 0) + 1;
    }

    if (!DRY_RUN) {
      // UPDATE resolved
      if (toResolve.length > 0) {
        const ph = []; const par = []; let p = 1;
        for (const r of toResolve) {
          ph.push(`($${p++}::bigint,$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
          par.push(r.bfe, r.row.adresse, r.row.etage, r.row.doer, r.row.postnr, r.row.postnrnavn, r.row.kommune, r.row.kommune_kode, r.row.dawa_id, r.row.ejendomstype, r.row.kilde);
        }
        await pool.query(
          `UPDATE bfe_adresse_cache c SET
             adresse = v.adresse, etage = v.etage, doer = v.doer,
             postnr = v.postnr, postnrnavn = v.postnrnavn,
             kommune = v.kommune, kommune_kode = v.kommune_kode,
             dawa_id = v.dawa_id, ejendomstype = v.ejendomstype,
             kilde = v.kilde, sidst_opdateret = NOW(), next_retry_after = NULL
           FROM (VALUES ${ph.join(',')}) AS v(bfe_nummer, adresse, etage, doer, postnr, postnrnavn, kommune, kommune_kode, dawa_id, ejendomstype, kilde)
           WHERE c.bfe_nummer = v.bfe_nummer`,
          par
        );
      }
      // UPDATE unresolvable
      if (toUnresolvable.length > 0) {
        const retryAfter = new Date(Date.now() + RETRY_DELAY).toISOString();
        await pool.query(
          `UPDATE bfe_adresse_cache SET
             adresse = NULL, etage = NULL, doer = NULL, postnr = NULL, postnrnavn = NULL,
             kommune = NULL, kommune_kode = NULL, dawa_id = NULL, ejendomstype = NULL,
             kilde = 'unresolvable', sidst_opdateret = NOW(), next_retry_after = $1
           WHERE bfe_nummer = ANY($2::bigint[])`,
          [retryAfter, toUnresolvable.map(r => r.bfe)]
        );
      }
    }

    if (processed % 200 === 0 || processed === candidates.length) {
      console.log(`[1886] processed=${processed}/${candidates.length}, resolved=${resolved}, unresolvable=${unresolvable}, transient=${transient}, same-addr=${sameAddress}`);
    }
  }

  console.log(`\n[1886] DONE — resolved=${resolved}, unresolvable=${unresolvable}, transient=${transient}, same-address=${sameAddress}`);
  console.log('By source:', bySource);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
