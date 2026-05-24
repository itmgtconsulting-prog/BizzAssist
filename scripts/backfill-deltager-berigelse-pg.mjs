#!/usr/bin/env node
/**
 * Fast deltager berigelse via direct PG (avoids Supabase API timeouts).
 *
 * Enriches cvr_deltager with is_aktiv, aktive_roller_json, role_typer etc.
 * by aggregating from cvr_deltagerrelation.
 *
 * Usage:
 *   node scripts/backfill-deltager-berigelse-pg.mjs [--limit=50000] [--batch=1000]
 */
import pg from 'pg';
import { config } from 'dotenv';
config({ path: '/root/BizzAssist/.env.local' });

const args = process.argv.slice(2);
const LIMIT = (() => { const a = args.find(x => x.startsWith('--limit=')); return a ? parseInt(a.split('=')[1], 10) : 200000; })();
const BATCH = (() => { const a = args.find(x => x.startsWith('--batch=')); return a ? parseInt(a.split('=')[1], 10) : 500; })();

const client = new pg.Client({ connectionString: process.env.SUPABASE_PROD_DB_URL, statement_timeout: 300000 });
await client.connect();

// Get unenriched deltager enhedsnumre in batches
let offset = 0;
let totalProcessed = 0;
let totalUpdated = 0;
const startTime = Date.now();

console.log(`Starting berigelse (LIMIT=${LIMIT}, BATCH=${BATCH})`);

while (totalProcessed < LIMIT) {
  const { rows: batch } = await client.query(`
    SELECT enhedsnummer FROM cvr_deltager
    WHERE berigelse_sidst IS NULL
    ORDER BY enhedsnummer
    LIMIT $1
  `, [BATCH]);

  if (batch.length === 0) {
    console.log('No more unenriched records');
    break;
  }

  const enNums = batch.map(r => r.enhedsnummer);

  // Get all relations for this batch
  const { rows: relations } = await client.query(`
    SELECT deltager_enhedsnummer, virksomhed_cvr, type, gyldig_fra, gyldig_til
    FROM cvr_deltagerrelation
    WHERE deltager_enhedsnummer = ANY($1)
  `, [enNums]);

  // Group by enhedsnummer
  const relMap = new Map();
  for (const r of relations) {
    if (!relMap.has(r.deltager_enhedsnummer)) relMap.set(r.deltager_enhedsnummer, []);
    relMap.get(r.deltager_enhedsnummer).push(r);
  }

  // Compute enrichment for each
  for (const en of enNums) {
    const rels = relMap.get(en) || [];
    const now = new Date();

    const activeRels = rels.filter(r => !r.gyldig_til || new Date(r.gyldig_til) > now);
    const activeCvrs = new Set(activeRels.map(r => r.virksomhed_cvr));
    const roleTypes = [...new Set(rels.map(r => r.type))];
    const latestStart = rels.reduce((max, r) => {
      const d = r.gyldig_fra ? new Date(r.gyldig_fra) : null;
      return d && (!max || d > max) ? d : max;
    }, null);

    const enrichment = {
      is_aktiv: activeRels.length > 0,
      aktive_roller_json: activeRels.map(r => ({
        cvr: r.virksomhed_cvr,
        type: r.type,
        fra: r.gyldig_fra,
      })),
      antal_aktive_selskaber: activeCvrs.size,
      senest_indtraadt_dato: latestStart?.toISOString()?.substring(0, 10) || null,
      role_typer: roleTypes,
    };

    await client.query(`
      UPDATE cvr_deltager SET
        is_aktiv = $2,
        aktive_roller_json = $3,
        antal_aktive_selskaber = $4,
        senest_indtraadt_dato = $5,
        role_typer = $6,
        berigelse_sidst = NOW()
      WHERE enhedsnummer = $1
    `, [
      en,
      enrichment.is_aktiv,
      JSON.stringify(enrichment.aktive_roller_json),
      enrichment.antal_aktive_selskaber,
      enrichment.senest_indtraadt_dato,
      `{${enrichment.role_typer.map(t => `"${t}"`).join(',')}}`,
    ]);
    totalUpdated++;
  }

  totalProcessed += batch.length;

  if (totalProcessed % 5000 === 0 || batch.length < BATCH) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rate = (totalProcessed / (elapsed || 1)).toFixed(1);
    console.log(`  processed=${totalProcessed}, updated=${totalUpdated} ${rate}/s (${elapsed}s)`);
  }
}

console.log(`\nDone! processed=${totalProcessed}, updated=${totalUpdated}`);

const { rows: remaining } = await client.query("SELECT count(*) FROM cvr_deltager WHERE berigelse_sidst IS NULL");
console.log(`Remaining unenriched: ${remaining[0].count}`);

await client.end();
