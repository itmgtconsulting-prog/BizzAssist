#!/usr/bin/env node
/**
 * BIZZ-1935: Targeted re-backfill af cvr_deltagerrelation hvor gyldig_fra=1900-01-01
 * for rows opdateret i en given periode. Bruger fixet extractRelations-logik.
 *
 * Usage: node scripts/backfill-1935-targeted.mjs --since=2026-04-01 --until=2026-06-01 [--limit=N]
 */

import pg from 'pg';
import fs from 'fs';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k,v] = a.replace(/^--/,'').split('='); return [k, v ?? 'true']; }));
const SINCE = args.since || '2026-04-01';
const UNTIL = args.until || '2026-06-01';
const LIMIT = parseInt(args.limit || '0', 10) || 999999999;
const CONCURRENCY = parseInt(args.concurrency || '5', 10);
const CVRS_ARG = args.cvrs && args.cvrs !== 'true' ? args.cvrs.split(',') : null;

const envContent = fs.readFileSync('/root/BizzAssist/.env.local', 'utf8');
const PROD_DB_URL = envContent.match(/^SUPABASE_PROD_DB_URL=(.+)$/m)?.[1];
const CVR_USER = envContent.match(/^CVR_ES_USER=(.+)$/m)?.[1];
const CVR_PASS = envContent.match(/^CVR_ES_PASS=(.+)$/m)?.[1];

if (!CVR_USER || !CVR_PASS) { console.error('CVR_ES_USER + CVR_ES_PASS required'); process.exit(1); }

const esAuth = Buffer.from(`${CVR_USER}:${CVR_PASS}`).toString('base64');
const pool = new pg.Pool({ connectionString: PROD_DB_URL, max: 10 });

// ── Same fixed extractRelations as in backfill-cvr-virksomhed-deltagere.mjs ──
function gyldigNu(arr) {
  return arr.find(x => !x.periode?.gyldigTil) ?? arr[arr.length - 1];
}

function extractRelations(targetCvr, deltagerRelations) {
  const rows = [];
  for (const rel of deltagerRelations) {
    const deltager = rel.deltager;
    if (!deltager) continue;
    const enhedsNummer = deltager.enhedsNummer;
    if (!enhedsNummer) continue;
    const isPerson = deltager.enhedstype === 'PERSON';
    let deltagerCvr = null;
    if (!isPerson) deltagerCvr = deltager.cvrNummer ? String(deltager.cvrNummer) : null;
    const navne = Array.isArray(deltager.navne) ? deltager.navne : [];
    const aktivtNavn = gyldigNu(navne);
    const navn = aktivtNavn?.navn ?? '';
    if (!navn) continue;
    const orgs = Array.isArray(rel.organisationer) ? rel.organisationer : [];
    let foundRolle = false;

    for (const org of orgs) {
      const medlemsData = Array.isArray(org.medlemsData) ? org.medlemsData : [];
      let orgEjerandelPct = null;
      let orgEjerandelGyldigFra = null;
      let orgEjerandelGyldigTil = null;
      for (const md of medlemsData) {
        const attrs = Array.isArray(md.attributter) ? md.attributter : [];
        const ejerAttr = attrs.find(a => a.type === 'EJERANDEL' || a.type === 'EJERANDEL_PROCENT');
        if (ejerAttr) {
          const vals = Array.isArray(ejerAttr.vaerdier) ? ejerAttr.vaerdier : [];
          const gyldig = vals.find(v => !v.periode?.gyldigTil) ?? vals[vals.length - 1];
          if (gyldig?.vaerdi) {
            const raw = parseFloat(gyldig.vaerdi);
            orgEjerandelPct = raw <= 1 ? raw * 100 : raw;
            orgEjerandelGyldigFra = gyldig.periode?.gyldigFra?.slice(0, 10) ?? null;
            orgEjerandelGyldigTil = gyldig.periode?.gyldigTil?.slice(0, 10) ?? null;
          }
        }
      }
      for (const md of medlemsData) {
        const attrs = Array.isArray(md.attributter) ? md.attributter : [];
        const funktioner = attrs.filter(a => a.type === 'FUNKTION');
        for (const attr of funktioner) {
          const vaerdier = Array.isArray(attr.vaerdier) ? attr.vaerdier : [];
          for (const v of vaerdier) {
            if (!v.vaerdi) continue;
            const rolle = v.vaerdi.toLowerCase().slice(0, 60);
            const fra = v.periode?.gyldigFra?.slice(0, 10) ?? '1900-01-01';
            const til = v.periode?.gyldigTil?.slice(0, 10) ?? null;
            rows.push({
              virksomhed_cvr: String(targetCvr), deltager_enhedsnummer: enhedsNummer,
              type: rolle, gyldig_fra: fra, gyldig_til: til,
              ejerandel_pct: rolle === 'register' ? orgEjerandelPct : null,
              sidst_opdateret: new Date().toISOString(),
              sidst_hentet_fra_cvr: new Date().toISOString(),
              ejer_cvr: deltagerCvr,
            });
            foundRolle = true;
          }
        }
      }
      if (!foundRolle && org.hovedtype) {
        const fallbackType = org.hovedtype.toLowerCase().slice(0, 60);
        rows.push({
          virksomhed_cvr: String(targetCvr), deltager_enhedsnummer: enhedsNummer,
          type: fallbackType,
          gyldig_fra: orgEjerandelGyldigFra ?? '1900-01-01',
          gyldig_til: orgEjerandelGyldigTil,
          ejerandel_pct: fallbackType === 'register' ? orgEjerandelPct : null,
          sidst_opdateret: new Date().toISOString(),
          sidst_hentet_fra_cvr: new Date().toISOString(),
          ejer_cvr: deltagerCvr,
        });
        foundRolle = true;
      }
    }
  }
  return rows;
}

async function fetchVirksomhed(cvr) {
  const res = await fetch('http://distribution.virk.dk/cvr-permanent/virksomhed/_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${esAuth}` },
    body: JSON.stringify({
      _source: ['Vrvirksomhed.cvrNummer', 'Vrvirksomhed.deltagerRelation'],
      query: { term: { 'Vrvirksomhed.cvrNummer': cvr } },
      size: 1,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.hits?.hits?.[0]?._source?.Vrvirksomhed;
}

async function processCvr(cvr) {
  const vrv = await fetchVirksomhed(cvr);
  if (!vrv) return { cvr, status: 'not-found' };
  const rels = extractRelations(vrv.cvrNummer, vrv.deltagerRelation ?? []);
  if (rels.length === 0) return { cvr, status: 'no-relations' };

  // Dedup by PK
  const seen = new Set();
  const clean = [];
  for (const r of rels) {
    const key = `${r.virksomhed_cvr}|${r.deltager_enhedsnummer}|${r.type}|${r.gyldig_fra}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(r);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // BIZZ-1935: gem eksisterende ejer_cvr per deltager_enhedsnummer FØR delete
    // så vi kan preserve det hvis CVR ES API ikke returnerer det
    const existing = await client.query(
      "SELECT deltager_enhedsnummer, ejer_cvr FROM cvr_deltagerrelation WHERE virksomhed_cvr=$1 AND ejer_cvr IS NOT NULL",
      [String(cvr)]
    );
    const ejerCvrMap = new Map();
    for (const row of existing.rows) ejerCvrMap.set(row.deltager_enhedsnummer, row.ejer_cvr);
    // Berig nye rows med preserved ejer_cvr hvis det mangler
    for (const r of clean) {
      if (!r.ejer_cvr && ejerCvrMap.has(r.deltager_enhedsnummer)) {
        r.ejer_cvr = ejerCvrMap.get(r.deltager_enhedsnummer);
      }
    }
    // DELETE existing broken rows (gyldig_fra=1900-01-01)
    await client.query(
      "DELETE FROM cvr_deltagerrelation WHERE virksomhed_cvr=$1 AND gyldig_fra='1900-01-01'",
      [String(cvr)]
    );
    // BATCH UPSERT alle rows i ÉN query (10x hurtigere end per-row)
    if (clean.length > 0) {
      const placeholders = [];
      const params = [];
      let p = 1;
      for (const r of clean) {
        placeholders.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
        params.push(r.virksomhed_cvr, r.deltager_enhedsnummer, r.type, r.gyldig_fra, r.gyldig_til, r.ejerandel_pct, r.sidst_opdateret, r.sidst_hentet_fra_cvr, r.ejer_cvr);
      }
      await client.query(
        `INSERT INTO cvr_deltagerrelation
          (virksomhed_cvr, deltager_enhedsnummer, type, gyldig_fra, gyldig_til, ejerandel_pct, sidst_opdateret, sidst_hentet_fra_cvr, ejer_cvr)
         VALUES ${placeholders.join(',')}
         ON CONFLICT (virksomhed_cvr, deltager_enhedsnummer, type, gyldig_fra) DO UPDATE SET
           gyldig_til = EXCLUDED.gyldig_til,
           ejerandel_pct = COALESCE(EXCLUDED.ejerandel_pct, cvr_deltagerrelation.ejerandel_pct),
           sidst_opdateret = EXCLUDED.sidst_opdateret,
           sidst_hentet_fra_cvr = EXCLUDED.sidst_hentet_fra_cvr,
           ejer_cvr = COALESCE(EXCLUDED.ejer_cvr, cvr_deltagerrelation.ejer_cvr)`,
        params
      );
    }
    await client.query('COMMIT');
    return { cvr, status: 'ok', rels: clean.length };
  } catch (err) {
    await client.query('ROLLBACK');
    return { cvr, status: 'upsert-error', error: err.message };
  } finally {
    client.release();
  }
}

async function main() {
  console.log(`[1935] Start (since=${SINCE}, until=${UNTIL}, limit=${LIMIT}, concurrency=${CONCURRENCY})`);

  let rows;
  if (CVRS_ARG) {
    console.log('[1935] Using explicit --cvrs list:', CVRS_ARG.length);
    rows = CVRS_ARG.map(c => ({ virksomhed_cvr: c }));
  } else {
    console.time('[1935] query candidate cvrs');
    const r = await pool.query(`
      SELECT DISTINCT virksomhed_cvr FROM cvr_deltagerrelation
      WHERE gyldig_fra = '1900-01-01'
        AND ejerandel_pct IS NOT NULL
        AND sidst_opdateret BETWEEN $1 AND $2
      ORDER BY virksomhed_cvr
      LIMIT $3
    `, [SINCE, UNTIL, LIMIT]);
    rows = r.rows;
    console.timeEnd('[1935] query candidate cvrs');
  }

  const cvrs = rows.map(r => r.virksomhed_cvr);
  console.log(`[1935] ${cvrs.length} unique CVRs at re-process`);

  let processed = 0, ok = 0, notFound = 0, errors = 0, totalRels = 0;
  for (let i = 0; i < cvrs.length; i += CONCURRENCY) {
    const batch = cvrs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(c => processCvr(c).catch(e => ({ cvr: c, status: 'exception', error: e.message }))));
    for (const r of results) {
      processed++;
      if (r.status === 'ok') { ok++; totalRels += r.rels; }
      else if (r.status === 'not-found') notFound++;
      else errors++;
    }
    if (processed % 500 === 0 || processed === cvrs.length) {
      console.log(`[1935] processed=${processed}/${cvrs.length}, ok=${ok}, not-found=${notFound}, errors=${errors}, total-rels=${totalRels}`);
    }
  }
  console.log(`\n[1935] DONE`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
