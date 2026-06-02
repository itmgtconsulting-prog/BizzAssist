#!/usr/bin/env node
/**
 * BIZZ-1882: Force-retry alle BFEer i bfe_adresse_cache med kilde='unresolvable'
 * uden at vente på next_retry_after. Mange blev markeret unresolvable under VP
 * rate-limit i BIZZ-1850 — kan nu være recoverable.
 *
 * Strategy:
 *   For hver kilde='unresolvable' BFE:
 *     - Kør 3-fallback (DAWA /bfe → VP → DAWA jordstykker)
 *     - Hvis succesfuld: UPDATE row med ny data + ny kilde
 *     - Hvis stadig fejler: ingen ændring (behold unresolvable status)
 *
 * Usage:
 *   node scripts/backfill-bfe-unresolvable-retry.mjs [--limit=N] [--offset=N] [--concurrency=N] [--dry-run]
 */

import pg from 'pg';
import fs from 'fs';

const args = Object.fromEntries(
  process.argv.slice(2).map(a => { const [k,v] = a.replace(/^--/,'').split('='); return [k, v ?? 'true']; })
);
const LIMIT = parseInt(args.limit || '0', 10) || 999999999;
const OFFSET = parseInt(args.offset || '0', 10);
const CONCURRENCY = parseInt(args.concurrency || '10', 10);
const DRY_RUN = args['dry-run'] === 'true';
const DAWA_BASE = 'https://api.dataforsyningen.dk';

const envContent = fs.readFileSync('/root/BizzAssist/.env.local', 'utf8');
const PROD_DB_URL = envContent.match(/^SUPABASE_PROD_DB_URL=(.+)$/m)?.[1];

// ── 3-fallback resolve (samme som BIZZ-1850) ────────────────────────
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
      kilde: 'backfill_1882_dawa',
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
      kilde: 'backfill_1882_vp',
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
      kilde: 'backfill_1882_jordstykke',
    }};
  } catch { return { status: 'error' }; }
}

async function resolveBfe(bfe) {
  const r1 = await dawaBfe(bfe);
  if (r1.status === 'ok') return r1.row;
  const r2 = await vpSearch(bfe);
  if (r2.status === 'ok') return r2.row;
  const r3 = await dawaJordstykke(bfe);
  if (r3.status === 'ok') return r3.row;
  return null;
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log(`[1882-retry] Start (limit=${LIMIT}, offset=${OFFSET}, concurrency=${CONCURRENCY}, dry-run=${DRY_RUN})`);
  const pool = new pg.Pool({ connectionString: PROD_DB_URL, max: CONCURRENCY + 2, statement_timeout: 300000 });

  const { rows } = await pool.query(
    `SELECT bfe_nummer FROM bfe_adresse_cache WHERE kilde = 'unresolvable' ORDER BY bfe_nummer OFFSET $1 LIMIT $2`,
    [OFFSET, LIMIT]
  );
  const bfes = rows.map(r => Number(r.bfe_nummer));
  console.log(`[1882-retry] ${bfes.length} unresolvable BFEer at retry`);

  let processed = 0, recovered = 0, stillFailing = 0;
  const bySource = { backfill_1882_dawa: 0, backfill_1882_vp: 0, backfill_1882_jordstykke: 0 };

  for (let i = 0; i < bfes.length; i += CONCURRENCY) {
    const batch = bfes.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async b => {
      const row = await resolveBfe(b).catch(() => null);
      return { bfe: b, row };
    }));

    const toUpsert = results.filter(r => r.row).map(r => ({ ...r.row, bfe_nummer: r.bfe }));
    processed += batch.length;
    recovered += toUpsert.length;
    stillFailing += (batch.length - toUpsert.length);
    for (const r of toUpsert) bySource[r.kilde] = (bySource[r.kilde] || 0) + 1;

    if (!DRY_RUN && toUpsert.length > 0) {
      const ph = []; const par = []; let p = 1;
      for (const r of toUpsert) {
        ph.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},NOW(),NULL)`);
        par.push(r.bfe_nummer, r.adresse, r.etage, r.doer, r.postnr, r.postnrnavn, r.kommune, r.kommune_kode, r.dawa_id, r.ejendomstype, r.kilde);
      }
      await pool.query(
        `INSERT INTO bfe_adresse_cache
         (bfe_nummer, adresse, etage, doer, postnr, postnrnavn, kommune, kommune_kode, dawa_id, ejendomstype, kilde, sidst_opdateret, next_retry_after)
         VALUES ${ph.join(',')}
         ON CONFLICT (bfe_nummer) DO UPDATE SET
           adresse = EXCLUDED.adresse,
           etage = EXCLUDED.etage,
           doer = EXCLUDED.doer,
           postnr = EXCLUDED.postnr,
           postnrnavn = EXCLUDED.postnrnavn,
           kommune = EXCLUDED.kommune,
           kommune_kode = EXCLUDED.kommune_kode,
           dawa_id = EXCLUDED.dawa_id,
           ejendomstype = EXCLUDED.ejendomstype,
           kilde = EXCLUDED.kilde,
           sidst_opdateret = NOW(),
           next_retry_after = NULL
         WHERE bfe_adresse_cache.kilde = 'unresolvable'`,
        par
      );
    }

    if (processed % 5000 === 0 || processed === bfes.length) {
      console.log(`[1882-retry] processed=${processed}/${bfes.length}, recovered=${recovered} (dawa=${bySource.backfill_1882_dawa}, vp=${bySource.backfill_1882_vp}, jord=${bySource.backfill_1882_jordstykke})`);
    }
  }

  console.log(`\n[1882-retry] DONE — recovered=${recovered} af ${processed} (${(recovered/processed*100).toFixed(1)}%), still-failing=${stillFailing}`);
  console.log('By source:', bySource);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
