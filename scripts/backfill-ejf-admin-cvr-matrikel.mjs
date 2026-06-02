#!/usr/bin/env node
/**
 * BIZZ-1880: Match ejf_administrator gældende records uden CVR via matrikel-baseret
 * lookup mod cvr_virksomhed ejerforeninger.
 *
 * Strategi:
 *   For hver gældende admin med NULL CVR + administrator_type='ukendt':
 *     - Hent BFE'ens matrikel via DAWA /jordstykker?bfenummer=X
 *     - Søg cvr_virksomhed efter ejerforeninger hvis navn indeholder matrikel-id
 *       (især Carlsberg Byen-style: "Ejerforeningen Carlsberg Byen 20a")
 *     - Hvis EXACTLY 1 match → opdater virksomhed_cvr
 *
 * Word-boundary regex for at undgå false positives (matrikel "20a" matcher ikke "2000a").
 *
 * Usage:
 *   node scripts/backfill-ejf-admin-cvr-matrikel.mjs [--limit=N] [--concurrency=N] [--dry-run]
 */

import pg from 'pg';
import fs from 'fs';

const args = Object.fromEntries(
  process.argv.slice(2).map(a => { const [k,v] = a.replace(/^--/,'').split('='); return [k, v ?? 'true']; })
);
const LIMIT = parseInt(args.limit || '0', 10) || 999999;
const CONCURRENCY = parseInt(args.concurrency || '8', 10);
const DRY_RUN = args['dry-run'] === 'true';
const envContent = fs.readFileSync('/root/BizzAssist/.env.local', 'utf8');
const PROD_DB_URL = envContent.match(/^SUPABASE_PROD_DB_URL=(.+)$/m)?.[1];

const DAWA_BASE = 'https://api.dataforsyningen.dk';

async function getMatrikelForBfe(bfe, dawaId) {
  // Strategy 1: DAWA /jordstykker?bfenummer (works for SFE-BFEer)
  try {
    const r = await fetch(`${DAWA_BASE}/jordstykker?bfenummer=${bfe}&format=json`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const arr = await r.json();
      const j = arr[0];
      if (j?.matrikelnr) return { matrikel: j.matrikelnr, source: 'bfe' };
    }
  } catch {}
  // Strategy 2: DAWA /adgangsadresser/{dawa_id} (works for ejerlejlighed-BFEer)
  if (dawaId) {
    try {
      const r = await fetch(`${DAWA_BASE}/adgangsadresser/${dawaId}`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const a = await r.json();
        if (a.jordstykke?.matrikelnr) return { matrikel: a.jordstykke.matrikelnr, source: 'dawa_id' };
      }
    } catch {}
  }
  return null;
}

async function findEjerforeningByMatrikel(client, matrikel) {
  // Strict patterns to avoid address-letter false positives:
  // 1. "carlsberg byen <matrikel>" (Carlsberg Byen development specific)
  // 2. "matr.nr. <matrikel>" or "matrikel <matrikel>" (explicit matrikel reference)
  // 3. "ejerforeningen matr. <matrikel>" (legal name with matr. prefix)
  const m = matrikel.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const result = await client.query(
    `SELECT cvr, navn FROM tmp_ejerforening_cvr
     WHERE navn_lower ~* $1 OR navn_lower ~* $2 OR navn_lower ~* $3
     LIMIT 5`,
    [
      `carlsberg byen ${m}\\M`,
      `matr\\.?(\\s*nr\\.?)?\\s+(numemr\\s+)?${m}\\M`,
      `matrikel(\\s*nr\\.?)?\\s+(numemr\\s+)?${m}\\M`,
    ]
  );
  return result.rows;
}

async function main() {
  console.log(`[1880-matrikel] Start (limit=${LIMIT}, concurrency=${CONCURRENCY}, dry-run=${DRY_RUN})`);
  const pool = new pg.Pool({ connectionString: PROD_DB_URL, max: CONCURRENCY + 2, statement_timeout: 300000 });

  // Find candidates med JOIN på bfe_adresse_cache for at få dawa_id
  console.log('[1880-matrikel] Henter candidates...');
  const { rows: candidates } = await pool.query(`
    SELECT a.id_lokal_id, a.bfe_nummer, ba.dawa_id
    FROM ejf_administrator a
    JOIN bfe_adresse_cache ba ON ba.bfe_nummer = a.bfe_nummer
    WHERE a.status = 'gældende'
      AND a.administrator_type = 'ukendt'
      AND a.virksomhed_cvr IS NULL
      AND ba.dawa_id IS NOT NULL
    ORDER BY a.bfe_nummer
    LIMIT $1
  `, [LIMIT]);
  console.log(`[1880-matrikel] ${candidates.length} candidates`);

  let processed = 0, matched = 0, ambiguous = 0, noMatrikel = 0, noMatch = 0;
  const matchSamples = [];

  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async cand => {
      const matrInfo = await getMatrikelForBfe(cand.bfe_nummer, cand.dawa_id);
      if (!matrInfo) return { ...cand, status: 'no-matrikel' };
      const client = await pool.connect();
      try {
        const matches = await findEjerforeningByMatrikel(client, matrInfo.matrikel);
        if (matches.length === 0) return { ...cand, status: 'no-match', matrikel: matrInfo.matrikel };
        if (matches.length > 1) return { ...cand, status: 'ambiguous', matrikel: matrInfo.matrikel, count: matches.length, navne: matches.map(m=>m.navn).join(' | ') };
        // Exactly 1 match
        if (!DRY_RUN) {
          await client.query(
            `UPDATE ejf_administrator SET virksomhed_cvr=$1, administrator_type='virksomhed', sidst_opdateret=NOW() WHERE id_lokal_id=$2`,
            [matches[0].cvr, cand.id_lokal_id]
          );
        }
        return { ...cand, status: 'matched', matrikel: matrInfo.matrikel, cvr: matches[0].cvr, navn: matches[0].navn };
      } finally { client.release(); }
    }));

    for (const r of results) {
      processed++;
      if (r.status === 'matched') {
        matched++;
        if (matchSamples.length < 10) matchSamples.push({ bfe: r.bfe_nummer, matrikel: r.matrikel, cvr: r.cvr, navn: r.navn });
      } else if (r.status === 'ambiguous') ambiguous++;
      else if (r.status === 'no-matrikel') noMatrikel++;
      else noMatch++;
    }

    if (processed % 500 === 0 || processed === candidates.length) {
      console.log(`[1880-matrikel] processed=${processed}/${candidates.length}, matched=${matched}, ambiguous=${ambiguous}, no-matrikel=${noMatrikel}, no-match=${noMatch}`);
    }
  }

  console.log(`\n[1880-matrikel] DONE — matched=${matched}, ambiguous=${ambiguous}, no-matrikel=${noMatrikel}, no-match=${noMatch}`);
  if (matchSamples.length > 0) {
    console.log('\nSample matches:');
    console.table(matchSamples);
  }
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
