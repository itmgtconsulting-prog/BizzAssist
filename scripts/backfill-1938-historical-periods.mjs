#!/usr/bin/env node
/**
 * BIZZ-1938: Re-backfill cvr_deltagerrelation med ALLE historiske ejerandel-perioder.
 *
 * Tidligere brugte backfill-scriptet gyldigNu() til at vælge KUN den aktuelle ejerandel-periode.
 * Det betød at "Fratraadt" (exit), "Oeget andel" (increase) og "Reduceret" (decrease) signaler
 * var tomme i mv_virksomhedshandel_kandidater fordi LAG() aldrig fandt en prev_ejerandel.
 *
 * Denne fix iterér over ALLE EJERANDEL.vaerdier[] entries og emit'er én register-row per periode
 * med korrekt gyldig_fra/gyldig_til/ejerandel_pct.
 *
 * Strategi per virksomhed:
 *   1. Fetch raw Vrvirksomhed fra CVR ES
 *   2. extractRelations (med nye fix) → rows[]
 *   3. Preserve ejer_cvr fra eksisterende register-rows (CVR ES mangler nogle gange)
 *   4. DELETE eksisterende register-rows for denne virksomhed
 *   5. BATCH INSERT alle nye rows (incl. non-register som non-conflict-update)
 *   6. Commit
 *
 * Usage:
 *   node scripts/backfill-1938-historical-periods.mjs --concurrency=15 [--limit=N] [--cvrs=A,B] [--offset=N]
 */
import fs from 'fs';
import pg from 'pg';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true']; }));
const CONCURRENCY = parseInt(args.concurrency || '15', 10);
const LIMIT = parseInt(args.limit || '0', 10) || 999999999;
const OFFSET = parseInt(args.offset || '0', 10);
const CVRS_ARG = args.cvrs && args.cvrs !== 'true' ? args.cvrs.split(',') : null;
const SINCE = args.since && args.since !== 'true' ? args.since : null;
const UNTIL = args.until && args.until !== 'true' ? args.until : null;

const env = fs.readFileSync('/root/BizzAssist/.env.local', 'utf8');
const USER = env.match(/^CVR_ES_USER=(.+)$/m)?.[1];
const PASS = env.match(/^CVR_ES_PASS=(.+)$/m)?.[1];
const PROD = env.match(/^SUPABASE_PROD_DB_URL=(.+)$/m)?.[1];
const esAuth = Buffer.from(`${USER}:${PASS}`).toString('base64');
const pool = new pg.Pool({ connectionString: PROD, max: Math.min(CONCURRENCY + 4, 25) });

function gyldigNu(arr) { return arr.find(x => !x.periode?.gyldigTil) ?? arr[arr.length - 1]; }

/** Identical to scripts/backfill-cvr-virksomhed-deltagere.mjs extractRelations (post-BIZZ-1938 fix). */
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

      // Collect ALL ejerandel periods
      const ejerandelPerioder = [];
      for (const md of medlemsData) {
        const attrs = Array.isArray(md.attributter) ? md.attributter : [];
        const ejerAttr = attrs.find(a => a.type === 'EJERANDEL' || a.type === 'EJERANDEL_PROCENT');
        if (ejerAttr) {
          const vals = Array.isArray(ejerAttr.vaerdier) ? ejerAttr.vaerdier : [];
          for (const v of vals) {
            if (!v.vaerdi) continue;
            const raw = parseFloat(v.vaerdi);
            const pct = raw <= 1 ? raw * 100 : raw;
            ejerandelPerioder.push({
              pct,
              gyldigFra: v.periode?.gyldigFra?.slice(0, 10) ?? '1900-01-01',
              gyldigTil: v.periode?.gyldigTil?.slice(0, 10) ?? null,
              // BIZZ-1966: CVR's pr-værdi sidstOpdateret = reel registrerings-/
              // offentliggørelsesdato. Bevares så INDRAPPORTERET viser ægte dato.
              sidstOpdateret: v.sidstOpdateret ?? null,
            });
          }
        }
      }
      let orgEjerandelPct = null, orgEjerandelGyldigFra = null, orgEjerandelGyldigTil = null;
      if (ejerandelPerioder.length > 0) {
        const latest = ejerandelPerioder.find(p => !p.gyldigTil) ?? ejerandelPerioder[ejerandelPerioder.length - 1];
        orgEjerandelPct = latest.pct;
        orgEjerandelGyldigFra = latest.gyldigFra;
        orgEjerandelGyldigTil = latest.gyldigTil;
      }

      // Non-register FUNKTION rolles
      for (const md of medlemsData) {
        const attrs = Array.isArray(md.attributter) ? md.attributter : [];
        const funktioner = attrs.filter(a => a.type === 'FUNKTION');
        for (const attr of funktioner) {
          const vaerdier = Array.isArray(attr.vaerdier) ? attr.vaerdier : [];
          for (const v of vaerdier) {
            if (!v.vaerdi) continue;
            const rolle = v.vaerdi.toLowerCase().slice(0, 60);
            if (rolle === 'register' && ejerandelPerioder.length > 0) continue;
            const fra = v.periode?.gyldigFra?.slice(0, 10) ?? '1900-01-01';
            const til = v.periode?.gyldigTil?.slice(0, 10) ?? null;
            rows.push({
              virksomhed_cvr: String(targetCvr), deltager_enhedsnummer: enhedsNummer,
              type: rolle, gyldig_fra: fra, gyldig_til: til,
              ejerandel_pct: rolle === 'register' ? orgEjerandelPct : null,
              // BIZZ-1966: reel CVR-offentliggørelsesdato pr. FUNKTION-værdi.
              sidst_opdateret: v.sidstOpdateret ?? null,
              sidst_hentet_fra_cvr: new Date().toISOString(),
              ejer_cvr: deltagerCvr,
            });
            foundRolle = true;
          }
        }
      }
      // Register rows per ejerandel-periode (BIZZ-1938)
      for (const per of ejerandelPerioder) {
        rows.push({
          virksomhed_cvr: String(targetCvr), deltager_enhedsnummer: enhedsNummer,
          type: 'register', gyldig_fra: per.gyldigFra, gyldig_til: per.gyldigTil,
          ejerandel_pct: per.pct,
          // BIZZ-1966: reel CVR-offentliggørelsesdato pr. ejerandel-periode
          // (≥ gyldig_fra), ikke backfill-kørslens tidsstempel.
          sidst_opdateret: per.sidstOpdateret ?? null,
          sidst_hentet_fra_cvr: new Date().toISOString(),
          ejer_cvr: deltagerCvr,
        });
        foundRolle = true;
      }
      // Fallback hovedtype
      if (!foundRolle && org.hovedtype) {
        const fallbackType = org.hovedtype.toLowerCase().slice(0, 60);
        rows.push({
          virksomhed_cvr: String(targetCvr), deltager_enhedsnummer: enhedsNummer,
          type: fallbackType,
          gyldig_fra: orgEjerandelGyldigFra ?? '1900-01-01',
          gyldig_til: orgEjerandelGyldigTil,
          ejerandel_pct: fallbackType === 'register' ? orgEjerandelPct : null,
          // BIZZ-1966: fallback-rolle uden pr-værdi-periode har ingen reel
          // offentliggørelsesdato i kilden → null (vises som '—', ikke vildledende).
          sidst_opdateret: null,
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
      query: { term: { 'Vrvirksomhed.cvrNummer': parseInt(cvr, 10) } },
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
    // Preserve ejer_cvr per deltager_enhedsnummer fra eksisterende rows
    const existing = await client.query(
      "SELECT deltager_enhedsnummer, ejer_cvr FROM cvr_deltagerrelation WHERE virksomhed_cvr=$1 AND ejer_cvr IS NOT NULL",
      [String(cvr)]
    );
    const ejerCvrMap = new Map();
    for (const row of existing.rows) ejerCvrMap.set(row.deltager_enhedsnummer, row.ejer_cvr);
    for (const r of clean) {
      if (!r.ejer_cvr && ejerCvrMap.has(r.deltager_enhedsnummer)) {
        r.ejer_cvr = ejerCvrMap.get(r.deltager_enhedsnummer);
      }
    }

    // DELETE ALL register-rows for this CVR (vil blive genskabt med historiske perioder)
    await client.query(
      "DELETE FROM cvr_deltagerrelation WHERE virksomhed_cvr=$1 AND type='register'",
      [String(cvr)]
    );

    // BATCH INSERT alle nye rows
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
    const registerCount = clean.filter(r => r.type === 'register').length;
    return { cvr, status: 'ok', rels: clean.length, registers: registerCount };
  } catch (err) {
    await client.query('ROLLBACK');
    return { cvr, status: 'upsert-error', error: err.message };
  } finally {
    client.release();
  }
}

async function main() {
  console.log(`[1938] Start (concurrency=${CONCURRENCY}, limit=${LIMIT}, offset=${OFFSET})`);

  let cvrs;
  if (CVRS_ARG) {
    console.log('[1938] Using explicit --cvrs list:', CVRS_ARG.length);
    cvrs = CVRS_ARG.map(c => String(c));
  } else if (SINCE || UNTIL) {
    console.log(`[1938] Filtering by sidst_opdateret window: ${SINCE} → ${UNTIL}`);
    console.time('[1938] query candidate cvrs');
    const r = await pool.query(`
      SELECT DISTINCT virksomhed_cvr FROM cvr_deltagerrelation
      WHERE sidst_opdateret BETWEEN $1 AND $2
      ORDER BY virksomhed_cvr
      OFFSET $3 LIMIT $4
    `, [SINCE || '1900-01-01', UNTIL || '2100-01-01', OFFSET, LIMIT]);
    cvrs = r.rows.map(x => x.virksomhed_cvr);
    console.timeEnd('[1938] query candidate cvrs');
  } else {
    console.time('[1938] query candidate cvrs');
    // Alle distinct virksomhed_cvr i cvr_deltagerrelation — disse er kandidater til historisk-shifts
    const r = await pool.query(`
      SELECT DISTINCT virksomhed_cvr FROM cvr_deltagerrelation
      ORDER BY virksomhed_cvr
      OFFSET $1 LIMIT $2
    `, [OFFSET, LIMIT]);
    cvrs = r.rows.map(x => x.virksomhed_cvr);
    console.timeEnd('[1938] query candidate cvrs');
  }
  console.log(`[1938] ${cvrs.length} unique CVRs to re-process`);

  let processed = 0, ok = 0, notFound = 0, errors = 0, totalRels = 0, totalRegisters = 0;
  const start = Date.now();
  for (let i = 0; i < cvrs.length; i += CONCURRENCY) {
    const batch = cvrs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(c => processCvr(c).catch(e => ({ cvr: c, status: 'exception', error: e.message }))));
    for (const r of results) {
      processed++;
      if (r.status === 'ok') { ok++; totalRels += r.rels; totalRegisters += r.registers; }
      else if (r.status === 'not-found' || r.status === 'no-relations') notFound++;
      else { errors++; if (errors <= 5) console.warn(' ERR', r.cvr, r.status, r.error); }
    }
    if (processed % 1000 === 0 || processed === cvrs.length) {
      const el = (Date.now() - start) / 1000;
      const rate = processed / el;
      const eta = (cvrs.length - processed) / rate;
      console.log(`[1938] processed=${processed}/${cvrs.length} (${(processed/cvrs.length*100).toFixed(1)}%) ok=${ok} not-found=${notFound} errors=${errors} total-rels=${totalRels} total-register=${totalRegisters} rate=${rate.toFixed(1)}/s eta=${(eta/60).toFixed(0)}min`);
    }
  }
  console.log(`\n[1938] DONE: ok=${ok}, not-found=${notFound}, errors=${errors}, total-rels=${totalRels}, total-register=${totalRegisters}`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
