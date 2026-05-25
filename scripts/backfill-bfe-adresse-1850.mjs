#!/usr/bin/env node
/**
 * BIZZ-1850: Backfill bfe_adresse_cache for missing BFE'er fra
 *   ejf_ejerskab (gældende + historisk) + ejf_administrator.
 *
 * Mirrors fallback-logik fra app/api/cron/sync-bfe-adresse/route.ts (commit a95e6ae4):
 *   1. DAWA /bfe/{bfe}     → beliggenhedsadresse (lejligheder)
 *   2. VP _search          → fallback for BFEer DAWA ikke kender
 *   3. DAWA /jordstykker   → matrikel → /adresser (SFE-fallback)
 *
 * Usage:
 *   node scripts/backfill-bfe-adresse-1850.mjs [--limit=N] [--offset=N] [--concurrency=N] [--dry-run]
 */

import pg from 'pg';
import fs from 'fs';

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  })
);

const LIMIT = parseInt(args.limit || '0', 10) || 999999999;
const OFFSET = parseInt(args.offset || '0', 10);
const CONCURRENCY = parseInt(args.concurrency || '20', 10);
const DRY_RUN = args['dry-run'] === 'true';
const DAWA_BASE = 'https://api.dataforsyningen.dk';

// Read PROD_DB_URL from .env.local (avoid sourcing the whole file)
const envContent = fs.readFileSync('/root/BizzAssist/.env.local', 'utf8');
const PROD_DB_URL = envContent.match(/^SUPABASE_PROD_DB_URL=(.+)$/m)?.[1];
if (!PROD_DB_URL) { console.error('SUPABASE_PROD_DB_URL not found'); process.exit(1); }

// Resultat-typer:
//   { status: 'ok', row }     — resolved
//   { status: 'no_hit' }      — API svarede 200 men ingen data → unresolvable
//   { status: 'error', code } — HTTP-fejl/timeout/rate-limit → retry senere
//
// Vi marker kun BFE'er som unresolvable hvis ALLE 3 fallbacks gav 'no_hit'.
// Hvis nogen returnerede 'error' lader vi BFE'en være → cron prøver igen.

// ── Fallback 1: DAWA /bfe ────────────────────────────────────────────
async function dawaBfe(bfe) {
  try {
    const res = await fetch(`${DAWA_BASE}/bfe/${bfe}`, { signal: AbortSignal.timeout(8000) });
    if (res.status === 404) return { status: 'no_hit' };
    if (!res.ok) return { status: 'error', code: res.status };
    const json = await res.json();
    const bel = json.beliggenhedsadresse;
    if (!bel?.vejnavn) return { status: 'no_hit' };
    return {
      status: 'ok',
      row: {
        bfe_nummer: bfe,
        adresse: `${bel.vejnavn} ${bel.husnr ?? ''}`.trim(),
        etage: bel.etage ?? null,
        doer: bel['dør'] ?? null,
        postnr: bel.postnr ?? null,
        postnrnavn: bel.postnrnavn ?? null,
        kommune: bel.kommunenavn ?? null,
        kommune_kode: bel.kommunekode ?? null,
        dawa_id: bel.id ?? null,
        ejendomstype: json.ejendomstype ?? null,
        kilde: 'backfill_1850_dawa',
      },
    };
  } catch (err) {
    return { status: 'error', code: err.name || 'exception' };
  }
}

// ── Fallback 2: VP search ────────────────────────────────────────────
async function vpSearch(bfe) {
  try {
    const res = await fetch('https://api-fs.vurderingsportalen.dk/preliminaryproperties/_search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: JSON.stringify({
        query: { term: { bfeNumbers: bfe } },
        size: 1,
        _source: ['roadName', 'houseNumber', 'zipcode', 'postDistrict', 'floor', 'door', 'adgangsAdresseID'],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { status: 'error', code: res.status };
    const data = await res.json();
    const src = data.hits?.hits?.[0]?._source;
    if (!src?.roadName) return { status: 'no_hit' };
    return {
      status: 'ok',
      row: {
        bfe_nummer: bfe,
        adresse: `${src.roadName} ${src.houseNumber ?? ''}`.trim(),
        etage: src.floor ?? null,
        doer: src.door ?? null,
        postnr: src.zipcode ?? null,
        postnrnavn: src.postDistrict ?? null,
        kommune: null,
        kommune_kode: null,
        dawa_id: src.adgangsAdresseID ?? null,
        ejendomstype: null,
        kilde: 'backfill_1850_vp',
      },
    };
  } catch (err) {
    return { status: 'error', code: err.name || 'exception' };
  }
}

// ── Fallback 3: DAWA jordstykke → matrikel → adresser ───────────────
async function dawaJordstykke(bfe) {
  try {
    const r1 = await fetch(`${DAWA_BASE}/jordstykker?bfenummer=${bfe}&format=json`, { signal: AbortSignal.timeout(8000) });
    if (!r1.ok) return { status: 'error', code: r1.status };
    const jordstykker = await r1.json();
    const ejerlav = jordstykker[0]?.ejerlav?.kode;
    const matr = jordstykker[0]?.matrikelnr;
    if (!ejerlav || !matr) return { status: 'no_hit' };

    const r2 = await fetch(
      `${DAWA_BASE}/adresser?ejerlavkode=${ejerlav}&matrikelnr=${encodeURIComponent(matr)}&format=json&struktur=mini&per_side=1`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!r2.ok) return { status: 'error', code: r2.status };
    const adresser = await r2.json();
    const a = adresser[0];
    if (!a?.vejnavn || !a?.postnr) return { status: 'no_hit' };
    return {
      status: 'ok',
      row: {
        bfe_nummer: bfe,
        adresse: a.vejnavn,
        etage: null,
        doer: null,
        postnr: a.postnr,
        postnrnavn: a.postnrnavn ?? null,
        kommune: null,
        kommune_kode: null,
        dawa_id: a.id ?? null,
        ejendomstype: null,
        kilde: 'backfill_1850_jordstykke',
      },
    };
  } catch (err) {
    return { status: 'error', code: err.name || 'exception' };
  }
}

// ── Resolve one BFE through all fallbacks ───────────────────────────
// Returnerer:
//   { row }                    — resolved
//   { unresolvable: true }     — alle 3 svarede 'no_hit'
//   { error: true }            — mindst én fallback gav error → retry senere
async function resolveBfe(bfe) {
  const r1 = await dawaBfe(bfe);
  if (r1.status === 'ok') return { row: r1.row };
  const r2 = await vpSearch(bfe);
  if (r2.status === 'ok') return { row: r2.row };
  const r3 = await dawaJordstykke(bfe);
  if (r3.status === 'ok') return { row: r3.row };

  // Hvis NOGEN fallback gav error → ikke marker som unresolvable
  if (r1.status === 'error' || r2.status === 'error' || r3.status === 'error') {
    return { error: true };
  }
  // Alle 3 svarede 'no_hit' → permanent unresolvable
  return { unresolvable: true };
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log(`[1850] Start (limit=${LIMIT}, offset=${OFFSET}, concurrency=${CONCURRENCY}, dry-run=${DRY_RUN})`);
  const pool = new pg.Pool({ connectionString: PROD_DB_URL, max: 5, statement_timeout: 600000 });

  console.log('[1850] Henter missing BFEer …');
  console.time('[1850] missing query');
  // Union: ejf_ejerskab (gældende+historisk) + ejf_administrator, minus dem der findes i cache
  const { rows } = await pool.query(
    `
    WITH targets AS (
      SELECT DISTINCT bfe_nummer FROM ejf_ejerskab WHERE status IN ('gældende','historisk')
      UNION
      SELECT DISTINCT bfe_nummer FROM ejf_administrator WHERE virksomhed_cvr IS NOT NULL
    )
    SELECT t.bfe_nummer
    FROM targets t
    LEFT JOIN bfe_adresse_cache c ON c.bfe_nummer = t.bfe_nummer
    WHERE c.bfe_nummer IS NULL
    ORDER BY t.bfe_nummer
    OFFSET $1 LIMIT $2
    `,
    [OFFSET, LIMIT]
  );
  console.timeEnd('[1850] missing query');
  const bfes = rows.map(r => Number(r.bfe_nummer));
  console.log(`[1850] ${bfes.length} BFEer skal processeres`);

  let processed = 0;
  let resolved = 0;
  let markedUnresolvable = 0;
  let transientErrors = 0;
  let bySource = { backfill_1850_dawa: 0, backfill_1850_vp: 0, backfill_1850_jordstykke: 0 };
  // BIZZ-1850: Skub retry 90 dage frem for unresolvable BFE'er
  const RETRY_DELAY_DAYS = 90;
  // Auto-pause: hvis >50% af de sidste 200 forsøg er transient errors → vent 30s (VP rate-limit)
  const RECENT_WINDOW = 200;
  const recent = [];

  // Process in batches with concurrency
  for (let i = 0; i < bfes.length; i += CONCURRENCY) {
    const batch = bfes.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async b => {
      const res = await resolveBfe(b).catch(() => ({ error: true }));
      return { bfe: b, ...res };
    }));

    // Collect resolved rows + unresolvable markers + transient errors
    const toUpsert = results.filter(r => r.row).map(r => r.row);
    const unresolvableBfes = results.filter(r => r.unresolvable).map(r => r.bfe);
    const errorBfes = results.filter(r => r.error).map(r => r.bfe);
    processed += batch.length;
    resolved += toUpsert.length;
    markedUnresolvable += unresolvableBfes.length;
    transientErrors += errorBfes.length;
    for (const r of toUpsert) bySource[r.kilde] = (bySource[r.kilde] || 0) + 1;

    // Track recent errors for auto-backoff
    for (const r of results) recent.push(r.error ? 1 : 0);
    while (recent.length > RECENT_WINDOW) recent.shift();
    const errorRate = recent.reduce((a, b) => a + b, 0) / Math.max(recent.length, 1);
    if (recent.length >= RECENT_WINDOW && errorRate > 0.5) {
      console.log(`[1850] Error rate ${(errorRate * 100).toFixed(0)}% → pause 30s (VP rate-limit)`);
      await new Promise(r => setTimeout(r, 30000));
      recent.length = 0;
    }

    if (!DRY_RUN && toUpsert.length > 0) {
      // Batch upsert via VALUES list
      const placeholders = [];
      const params = [];
      let p = 1;
      for (const r of toUpsert) {
        placeholders.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},NOW())`);
        params.push(
          r.bfe_nummer, r.adresse, r.etage, r.doer,
          r.postnr, r.postnrnavn, r.kommune, r.kommune_kode,
          r.dawa_id, r.ejendomstype, r.kilde
        );
      }
      await pool.query(
        `INSERT INTO bfe_adresse_cache
         (bfe_nummer, adresse, etage, doer, postnr, postnrnavn, kommune, kommune_kode, dawa_id, ejendomstype, kilde, sidst_opdateret)
         VALUES ${placeholders.join(',')}
         ON CONFLICT (bfe_nummer) DO UPDATE SET
           adresse = EXCLUDED.adresse,
           etage = COALESCE(EXCLUDED.etage, bfe_adresse_cache.etage),
           doer = COALESCE(EXCLUDED.doer, bfe_adresse_cache.doer),
           postnr = EXCLUDED.postnr,
           postnrnavn = EXCLUDED.postnrnavn,
           kommune = COALESCE(EXCLUDED.kommune, bfe_adresse_cache.kommune),
           kommune_kode = COALESCE(EXCLUDED.kommune_kode, bfe_adresse_cache.kommune_kode),
           dawa_id = COALESCE(EXCLUDED.dawa_id, bfe_adresse_cache.dawa_id),
           kilde = EXCLUDED.kilde,
           sidst_opdateret = NOW()
         WHERE bfe_adresse_cache.postnr IS NULL OR bfe_adresse_cache.postnr = ''`,
        params
      );
    }

    // BIZZ-1850: Marker unresolvable BFE'er — alle 3 fallbacks svarede 'no_hit'
    if (!DRY_RUN && unresolvableBfes.length > 0) {
      const retryAfter = new Date(Date.now() + RETRY_DELAY_DAYS * 24 * 3600 * 1000).toISOString();
      const ph = [];
      const par = [];
      let p = 1;
      for (const bfe of unresolvableBfes) {
        ph.push(`($${p++},'unresolvable',$${p++},NOW())`);
        par.push(bfe, retryAfter);
      }
      await pool.query(
        `INSERT INTO bfe_adresse_cache (bfe_nummer, kilde, next_retry_after, sidst_opdateret)
         VALUES ${ph.join(',')}
         ON CONFLICT (bfe_nummer) DO NOTHING`,
        par
      );
    }

    if (processed % 1000 === 0 || processed === bfes.length) {
      console.log(`[1850] processed=${processed}/${bfes.length}, resolved=${resolved}, unresolvable=${markedUnresolvable}, errors=${transientErrors} (dawa=${bySource.backfill_1850_dawa}, vp=${bySource.backfill_1850_vp}, jord=${bySource.backfill_1850_jordstykke})`);
    }
  }

  console.log('[1850] DONE');
  console.log('[1850] Resolved:', resolved, '/ Unresolvable:', markedUnresolvable, '/ Errors:', transientErrors, '/ Processed:', processed);
  console.log('[1850] By source:', bySource);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
