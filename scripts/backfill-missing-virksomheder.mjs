#!/usr/bin/env node
/**
 * Backfill manglende virksomheder i cvr_virksomhed.
 *
 * Finder CVR-numre fra cvr_virksomhed_ejerskab der ikke har en
 * cvr_virksomhed entry og henter dem fra CVR ES.
 *
 * Usage:
 *   node scripts/backfill-missing-virksomheder.mjs [--limit=500] [--dry-run]
 */
import pg from 'pg';
import { config } from 'dotenv';
config({ path: '/root/BizzAssist/.env.local' });

const args = process.argv.slice(2);
const LIMIT = (() => { const a = args.find(x => x.startsWith('--limit=')); return a ? parseInt(a.split('=')[1], 10) : 10000; })();
const DRY_RUN = args.includes('--dry-run');

const CVR_ES_USER = process.env.CVR_ES_USER;
const CVR_ES_PASS = process.env.CVR_ES_PASS;
if (!CVR_ES_USER || !CVR_ES_PASS) {
  console.error('Missing CVR_ES_USER / CVR_ES_PASS');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.SUPABASE_PROD_DB_URL, statement_timeout: 120000 });
await client.connect();

/**
 * Fetch virksomhed from CVR ES by CVR number.
 *
 * @param {number} cvr - CVR number
 * @returns {object|null} Virksomhed data or null
 */
async function fetchFromCvrEs(cvr) {
  try {
    const res = await fetch('http://distribution.virk.dk/cvr-permanent/virksomhed/_search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(`${CVR_ES_USER}:${CVR_ES_PASS}`).toString('base64'),
      },
      body: JSON.stringify({
        query: { term: { 'Vrvirksomhed.cvrNummer': cvr } },
        _source: true,
        size: 1,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const hit = data.hits?.hits?.[0]?._source?.Vrvirksomhed;
    if (!hit) return null;
    return hit;
  } catch {
    return null;
  }
}

/**
 * Extract virksomhed fields from CVR ES source.
 *
 * @param {object} src - Vrvirksomhed source object
 * @returns {object} Mapped fields for cvr_virksomhed table
 */
function mapFields(src) {
  const latestNavn = src.navne?.sort((a, b) =>
    (b.periode?.gyldigFra || '').localeCompare(a.periode?.gyldigFra || '')
  )[0]?.navn || null;

  const latestBranche = src.hovedbranche?.sort((a, b) =>
    (b.periode?.gyldigFra || '').localeCompare(a.periode?.gyldigFra || '')
  )[0] || {};

  const latestForm = src.virksomhedsform?.sort((a, b) =>
    (b.periode?.gyldigFra || '').localeCompare(a.periode?.gyldigFra || '')
  )[0]?.kortBeskrivelse || null;

  const latestAddr = src.beliggenhedsadresse?.sort((a, b) =>
    (b.periode?.gyldigFra || '').localeCompare(a.periode?.gyldigFra || '')
  )[0] || null;

  const life = src.livsforloeb?.sort((a, b) =>
    (b.periode?.gyldigFra || '').localeCompare(a.periode?.gyldigFra || '')
  )[0] || {};

  const ansatte = src.aarsbeskaeftigelse?.sort((a, b) =>
    (b.aar || 0) - (a.aar || 0)
  )[0] || {};

  return {
    cvr: src.cvrNummer,
    samt_id: src.samtId || null,
    navn: latestNavn,
    branche_kode: latestBranche.branchekode || null,
    branche_tekst: latestBranche.branchetekst || null,
    virksomhedsform: latestForm,
    stiftet: life.periode?.gyldigFra?.substring(0, 10) || null,
    ophoert: life.periode?.gyldigTil?.substring(0, 10) || null,
    ansatte_aar: ansatte.aar || null,
    adresse_json: latestAddr || null,
    raw_source: src,
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

// Find missing CVRs (split into two queries for performance)
const { rows: missing1 } = await client.query(`
  SELECT DISTINCT ej.ejer_cvr AS cvr_num
  FROM cvr_virksomhed_ejerskab ej
  LEFT JOIN cvr_virksomhed v ON ej.ejer_cvr = v.cvr
  WHERE ej.ejer_cvr IS NOT NULL AND v.cvr IS NULL
  LIMIT $1
`, [LIMIT]);
const { rows: missing2 } = await client.query(`
  SELECT DISTINCT ej.ejet_cvr AS cvr_num
  FROM cvr_virksomhed_ejerskab ej
  LEFT JOIN cvr_virksomhed v ON ej.ejet_cvr = v.cvr
  WHERE ej.ejet_cvr IS NOT NULL AND v.cvr IS NULL
  LIMIT $1
`, [LIMIT]);
const seen = new Set();
const missingCvrs = [...missing1, ...missing2].filter(r => {
  if (seen.has(r.cvr_num)) return false;
  seen.add(r.cvr_num);
  return true;
}).slice(0, LIMIT);

console.log(`Found ${missingCvrs.length} missing CVRs`);
if (DRY_RUN) console.log('DRY RUN\n');

let resolved = 0;
let failed = 0;
const startTime = Date.now();

for (let i = 0; i < missingCvrs.length; i++) {
  const cvrNum = missingCvrs[i].cvr_num;
  const src = await fetchFromCvrEs(cvrNum);

  if (src) {
    const fields = mapFields(src);
    if (!DRY_RUN) {
      await client.query(`
        INSERT INTO cvr_virksomhed (cvr, samt_id, navn, branche_kode, branche_tekst, virksomhedsform, stiftet, ophoert, ansatte_aar, adresse_json, raw_source, sidst_indlaest, sidst_hentet_fra_cvr)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
        ON CONFLICT (cvr) DO UPDATE SET
          navn = EXCLUDED.navn,
          branche_kode = EXCLUDED.branche_kode,
          branche_tekst = EXCLUDED.branche_tekst,
          virksomhedsform = EXCLUDED.virksomhedsform,
          stiftet = EXCLUDED.stiftet,
          ophoert = EXCLUDED.ophoert,
          ansatte_aar = EXCLUDED.ansatte_aar,
          adresse_json = EXCLUDED.adresse_json,
          raw_source = EXCLUDED.raw_source,
          sidst_hentet_fra_cvr = NOW()
      `, [fields.cvr, fields.samt_id, fields.navn, fields.branche_kode, fields.branche_tekst,
          fields.virksomhedsform, fields.stiftet, fields.ophoert, fields.ansatte_aar,
          JSON.stringify(fields.adresse_json), JSON.stringify(fields.raw_source)]);
    }
    resolved++;
    if (resolved <= 3) console.log(`  + CVR ${cvrNum}: ${fields.navn}`);
  } else {
    failed++;
  }

  await new Promise(r => setTimeout(r, 100));

  if ((i + 1) % 100 === 0 || i === missingCvrs.length - 1) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`  [${i + 1}/${missingCvrs.length}] resolved=${resolved} failed=${failed} (${elapsed}s)`);
  }
}

console.log(`\nDone! resolved=${resolved} failed=${failed}`);
await client.end();
