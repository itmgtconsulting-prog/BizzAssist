#!/usr/bin/env node
/**
 * BIZZ-1856 #2: Match ejf_administrator gældende records uden CVR mod
 * tmp_ejerforening_cvr via vejnavn-baseret name matching.
 *
 * Strategi:
 *   For hver gældende admin med NULL CVR + administrator_type='ukendt':
 *     - Hent BFE'ens adresse fra bfe_adresse_cache
 *     - Søg tmp_ejerforening_cvr efter ejerforening-records hvis navn indeholder
 *       vejnavn (og evt. husnr)
 *     - Hvis EXACTLY 1 match med høj confidence → opdater virksomhed_cvr
 *     - Ellers log som ambigu (manuel review)
 *
 * Patterns testet:
 *   - "Ejerforeningen <vejnavn> <husnr>"
 *   - "E/F <vejnavn> <husnr>"
 *   - "Ejerforeningen <vejnavn>"
 *
 * Usage:
 *   node scripts/backfill-ejf-admin-cvr-match.mjs [--limit=N] [--dry-run]
 */

import pg from 'pg';
import fs from 'fs';

const args = Object.fromEntries(
  process.argv.slice(2).map(a => { const [k,v] = a.replace(/^--/,'').split('='); return [k, v ?? 'true']; })
);
const LIMIT = parseInt(args.limit || '0', 10) || 999999;
const DRY_RUN = args['dry-run'] === 'true';
const envContent = fs.readFileSync('/root/BizzAssist/.env.local', 'utf8');
const PROD_DB_URL = envContent.match(/^SUPABASE_PROD_DB_URL=(.+)$/m)?.[1];

async function main() {
  console.log(`[1856-match] Start (limit=${LIMIT}, dry-run=${DRY_RUN})`);
  const c = new pg.Client({ connectionString: PROD_DB_URL, statement_timeout: 600000 });
  await c.connect();

  // Find candidates: gældende admin, ukendt type, NULL CVR, kendt adresse
  console.log('[1856-match] Henter candidates...');
  const { rows: candidates } = await c.query(`
    SELECT
      a.id_lokal_id,
      a.bfe_nummer,
      ba.adresse,
      ba.postnr,
      -- Trim husnr ud af adresse, fx "J.C. Jacobsens Gade 1" → vejnavn="J.C. Jacobsens Gade", husnr="1"
      regexp_replace(ba.adresse, '\\s+\\d+[a-zA-Z]?$', '') AS vejnavn,
      coalesce((regexp_match(ba.adresse, '\\s+(\\d+[a-zA-Z]?)$'))[1], '') AS husnr
    FROM ejf_administrator a
    JOIN bfe_adresse_cache ba ON ba.bfe_nummer = a.bfe_nummer
    WHERE a.status = 'gældende'
      AND a.administrator_type = 'ukendt'
      AND a.virksomhed_cvr IS NULL
      AND ba.adresse IS NOT NULL
      AND ba.postnr IS NOT NULL
    LIMIT $1
  `, [LIMIT]);
  console.log(`[1856-match] ${candidates.length} candidates med kendt adresse`);

  let processed = 0, matched = 0, ambiguous = 0, noMatch = 0;
  const matchSamples = [];
  const ambiguousSamples = [];

  for (const cand of candidates) {
    processed++;
    const { id_lokal_id, bfe_nummer, vejnavn, husnr, postnr } = cand;

    // Search tmp_ejerforening_cvr for ejerforening matching vejnavn+husnr
    // Patterns (ordered by specificity):
    //  1. "Ejerforeningen <vejnavn> <husnr>" (most specific)
    //  2. "E/F <vejnavn> <husnr>"
    //  3. "Ejerforeningen <vejnavn>" (less specific)
    const escVejnavn = vejnavn.replace(/[%_\\]/g, '\\$&');
    const params = [];
    let query;
    if (husnr) {
      params.push(`%${escVejnavn.toLowerCase()} ${husnr.toLowerCase()}%`);
      query = `SELECT cvr, navn FROM tmp_ejerforening_cvr WHERE navn_lower LIKE $1 LIMIT 10`;
    } else {
      params.push(`%${escVejnavn.toLowerCase()}%`);
      query = `SELECT cvr, navn FROM tmp_ejerforening_cvr WHERE navn_lower LIKE $1 LIMIT 10`;
    }

    let r = await c.query(query, params);

    // Word boundary filter: husnr must be standalone (not "8" matching "80" or "8-10")
    // Match if husnr appears followed by: space, comma, dash, end, or A-Z letter (e.g., "8A")
    if (husnr) {
      const husnrRe = new RegExp(`\\b${husnr.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}([,. ;/-]|$|\\s+(og|m\\.fl|mfl|,))`, 'i');
      r = { rows: r.rows.filter(x => husnrRe.test(x.navn)) };
    }

    if (r.rows.length === 1) {
      matched++;
      if (matchSamples.length < 5) matchSamples.push({ bfe_nummer, adresse: `${vejnavn} ${husnr}`, cvr: r.rows[0].cvr, navn: r.rows[0].navn });
      if (!DRY_RUN) {
        await c.query(
          `UPDATE ejf_administrator SET virksomhed_cvr = $1, administrator_type = 'virksomhed', sidst_opdateret = NOW() WHERE id_lokal_id = $2`,
          [r.rows[0].cvr, id_lokal_id]
        );
      }
    } else if (r.rows.length > 1) {
      ambiguous++;
      if (ambiguousSamples.length < 5) ambiguousSamples.push({ bfe_nummer, adresse: `${vejnavn} ${husnr}`, matches: r.rows.length, navne: r.rows.map(x => x.navn).join(' | ') });
    } else {
      noMatch++;
    }

    if (processed % 1000 === 0 || processed === candidates.length) {
      console.log(`[1856-match] processed=${processed}/${candidates.length}, matched=${matched}, ambiguous=${ambiguous}, no-match=${noMatch}`);
    }
  }

  console.log(`\n[1856-match] DONE — matched=${matched}, ambiguous=${ambiguous}, no-match=${noMatch}`);
  console.log('\nSample matches:');
  console.table(matchSamples);
  console.log('\nSample ambiguous:');
  console.table(ambiguousSamples);

  await c.end();
}

main().catch(err => { console.error(err); process.exit(1); });
