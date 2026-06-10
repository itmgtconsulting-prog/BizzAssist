#!/usr/bin/env node
/**
 * BIZZ-1788: CVR ejerskab backfill v3 — uses pre-built lookup table.
 * 50x faster than v2 (1000/s vs 20/s). No FK constraints.
 *
 * Requires: tmp_enheds_cvr_lookup table (enhedsnummer→cvr).
 * Build it first: see inline SQL or run the lookup builder.
 *
 * Usage:
 *   node scripts/backfill-cvr-ejerskab-v3.mjs
 */
import pg from 'pg';
import { config } from 'dotenv';
config({ path: '.env.local' });

const esAuth = Buffer.from(`${process.env.CVR_ES_USER}:${process.env.CVR_ES_PASS}`).toString('base64');
const client = new pg.Client({ connectionString: process.env.SUPABASE_PROD_DB_URL, statement_timeout: 60000 });
await client.connect();

const INTERVALS = { PROCENT_0_4_99: [0,4.99], PROCENT_5_9_99: [5,9.99], PROCENT_10_14_99: [10,14.99], PROCENT_15_19_99: [15,19.99], PROCENT_20_24_99: [20,24.99], PROCENT_25_33_32: [25,33.32], PROCENT_33_34_49_99: [33.34,49.99], PROCENT_50_66_65: [50,66.65], PROCENT_66_67_89_99: [66.67,89.99], PROCENT_90_100: [90,100], PROCENT_100_100: [100,100] };

let searchAfter = null;
let total = 0, inserted = 0, fkErrors = 0;
const BATCH = 500;
const startTime = Date.now();

console.log('Ejerskab backfill v3 — lookup table, no FK constraints');

while (true) {
  const esBody = { size: BATCH, _source: ['Vrvirksomhed.cvrNummer', 'Vrvirksomhed.deltagerRelation'], query: { match_all: {} }, sort: [{ _id: 'asc' }] };
  if (searchAfter) esBody.search_after = searchAfter;

  let hits;
  try {
    const res = await fetch('http://distribution.virk.dk/cvr-permanent/virksomhed/_search', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Basic ${esAuth}` },
      body: JSON.stringify(esBody), signal: AbortSignal.timeout(30000),
    });
    hits = (await res.json()).hits?.hits || [];
  } catch { await new Promise(r => setTimeout(r, 5000)); continue; }

  if (hits.length === 0) break;
  searchAfter = hits[hits.length - 1].sort;

  const rows = [];
  for (const hit of hits) {
    const vrk = hit._source?.Vrvirksomhed;
    if (!vrk?.cvrNummer) continue;
    const ejetCvr = String(vrk.cvrNummer);

    for (const rel of (vrk.deltagerRelation || [])) {
      const d = rel.deltager;
      if (!d || d.enhedstype !== 'VIRKSOMHED' || !d.enhedsNummer) continue;

      for (const org of (rel.organisationer || [])) {
        if (org.hovedtype !== 'REGISTER') continue;
        const hasEjerReg = (org.attributter || []).some(a => a.type === 'FUNKTION' && (a.vaerdier || []).some(v => v.vaerdi === 'EJERREGISTER' && !v.periode?.gyldigTil));
        if (!hasEjerReg) continue;

        let min = null, max = null, gyldigTil = null;
        const allAttrs = [...(org.attributter || []), ...((org.medlemsData || []).flatMap(md => md.attributter || []))];
        for (const a of allAttrs) {
          if (a.type !== 'EJERANDEL_PROCENT') continue;
          const aktiv = (a.vaerdier || []).find(v => !v.periode?.gyldigTil);
          if (aktiv) {
            const iv = INTERVALS[aktiv.vaerdi];
            if (iv) { min = iv[0]; max = iv[1]; }
            else { const p = parseFloat(aktiv.vaerdi); if (!isNaN(p)) { min = p*100; max = p*100; } }
          } else if ((a.vaerdier || []).length > 0) {
            gyldigTil = (a.vaerdier || []).map(v => v.periode?.gyldigTil).filter(Boolean).sort().pop()?.split('T')[0];
          }
          break;
        }
        rows.push({ ejerEnhed: d.enhedsNummer, ejetCvr, min, max, gyldigTil });
        break;
      }
    }
  }

  if (rows.length > 0) {
    const values = rows.map(r => {
      const minV = r.min !== null ? r.min : 'NULL';
      const maxV = r.max !== null ? r.max : 'NULL';
      const gt = r.gyldigTil ? `'${r.gyldigTil}'::date` : 'NULL';
      return `((SELECT cvr FROM tmp_enheds_cvr_lookup WHERE enhedsnummer = ${r.ejerEnhed}), '${r.ejetCvr}', ${maxV}, ${minV}, ${maxV}, ${gt}, now())`;
    }).join(',');

    try {
      const result = await client.query(`
        INSERT INTO cvr_virksomhed_ejerskab (ejer_cvr, ejet_cvr, ejerandel_pct, ejerandel_min, ejerandel_max, gyldig_til, sidst_opdateret)
        SELECT * FROM (VALUES ${values}) AS v(ejer_cvr, ejet_cvr, ejerandel_pct, ejerandel_min, ejerandel_max, gyldig_til, sidst_opdateret)
        WHERE v.ejer_cvr IS NOT NULL
        ON CONFLICT (ejer_cvr, ejet_cvr) DO UPDATE SET
          ejerandel_pct = EXCLUDED.ejerandel_pct, ejerandel_min = EXCLUDED.ejerandel_min,
          ejerandel_max = EXCLUDED.ejerandel_max, gyldig_til = EXCLUDED.gyldig_til,
          sidst_opdateret = EXCLUDED.sidst_opdateret
      `);
      inserted += result.rowCount;
    } catch (e) {
      fkErrors++;
      if (fkErrors <= 5) console.error('  [ERR]: ' + e.message.substring(0, 80));
    }
  }

  total += hits.length;
  if (total % 10000 === 0) {
    const rate = (total / ((Date.now() - startTime) / 1000)).toFixed(0);
    console.log(`  [${total}] inserted=${inserted} fkErr=${fkErrors} ${rate}/s`);
  }
}

console.log(`\nDone! total=${total} inserted=${inserted} fkErrors=${fkErrors}`);
console.log(`Duration: ${((Date.now() - startTime) / 60000).toFixed(1)} min`);

// Verify JaJR
const r = await client.query("SELECT ejer_cvr FROM cvr_virksomhed_ejerskab WHERE ejet_cvr = '44878704'");
console.log('\nJaJR Holding 2 ejere: ' + r.rows.length);
for (const row of r.rows) console.log('  ' + row.ejer_cvr);

const total2 = await client.query('SELECT count(*) FROM cvr_virksomhed_ejerskab');
console.log('Total ejerskab: ' + total2.rows[0].count);

await client.end();
