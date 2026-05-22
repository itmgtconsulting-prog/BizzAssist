#!/usr/bin/env node
/**
 * BIZZ-1681: Re-backfill cvr_virksomhed_ejerskab med korrekt temporal filtrering.
 *
 * Fix: gyldig_til var altid NULL fordi scriptet ikke satte den korrekt.
 * Historiske ejerskaber (alle EJERANDEL_PROCENT værdier har gyldigTil)
 * blev fejlagtigt inkluderet som gældende.
 *
 * Denne version:
 *   1. Bruger Management API (multi-env support)
 *   2. Korrekt temporal filtrering på EJERANDEL_PROCENT.gyldigTil
 *   3. Sætter gyldig_til korrekt for historiske ejerskaber
 *   4. TRUNCATE + re-insert (clean slate)
 *
 * Usage:
 *   node scripts/backfill-cvr-ejerskab-v2.mjs --env=prod [--offset=0] [--limit=Infinity]
 */
import https from 'node:https';
import { config } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, '..', '.env.local') });

const args = process.argv.slice(2);
const TARGET_ENV = args.find(x => x.startsWith('--env='))?.split('=')[1] || 'prod';
const OFFSET = (() => { const a = args.find(x => x.startsWith('--offset=')); return a ? parseInt(a.split('=')[1], 10) : 0; })();
const LIMIT = (() => { const a = args.find(x => x.startsWith('--limit=')); return a ? parseInt(a.split('=')[1], 10) : Infinity; })();
const FROM_CVR = args.find(x => x.startsWith('--from='))?.split('=')[1] || null;
const TO_CVR = args.find(x => x.startsWith('--to='))?.split('=')[1] || null;
const SKIP_TRUNCATE = args.includes('--skip-truncate');

const ENV_REFS = { dev: 'wkzwxfhyfmvglrqtmebw', preview: 'rlkjmqjxmkxuclehbrnl', prod: 'xsyldjqcntiygrtfcszm' };
const PROJECT_REF = ENV_REFS[TARGET_ENV];
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const CVR_USER = process.env.CVR_ES_USER;
const CVR_PASS = process.env.CVR_ES_PASS;
const cvrAuth = Buffer.from(`${CVR_USER}:${CVR_PASS}`).toString('base64');

if (!ACCESS_TOKEN || !PROJECT_REF || !CVR_USER || !CVR_PASS) {
  console.error('Missing credentials'); process.exit(1);
}

const BATCH_SIZE = 50;
const DELAY_MS = 500;

/** Ejerandel interval-koder fra CVR ES → procent-interval. */
const INTERVAL_MAP = {
  PROCENT_0_0: { min: 0, max: 0 },
  PROCENT_0_4_99: { min: 0, max: 4.99 },
  PROCENT_5_9_99: { min: 5, max: 9.99 },
  PROCENT_10_14_99: { min: 10, max: 14.99 },
  PROCENT_15_19_99: { min: 15, max: 19.99 },
  PROCENT_20_24_99: { min: 20, max: 24.99 },
  PROCENT_25_33_32: { min: 25, max: 33.32 },
  PROCENT_33_34_49_99: { min: 33.34, max: 49.99 },
  PROCENT_50_66_65: { min: 50, max: 66.65 },
  PROCENT_66_67_89_99: { min: 66.67, max: 89.99 },
  PROCENT_90_100: { min: 90, max: 100 },
  PROCENT_100_100: { min: 100, max: 100 },
};

/**
 * Execute SQL via Management API (single attempt).
 */
function runSqlOnce(sql) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ query: sql });
    const timer = setTimeout(() => { req.destroy(); resolve({ message: 'timeout' }); }, 30000);
    const req = https.request({ hostname: 'api.supabase.com', path: `/v1/projects/${PROJECT_REF}/database/query`, method: 'POST', headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', (e) => { clearTimeout(timer); resolve({ message: e.code || e.message }); });
    req.write(body); req.end();
  });
}

/**
 * Execute SQL with retry on transient errors.
 */
async function runSql(sql, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await runSqlOnce(sql);
    if (r?.message && (r.message.includes('timeout') || r.message.includes('ECONNRESET') || r.message.includes('Throttler'))) {
      if (attempt < retries) { await new Promise(res => setTimeout(res, 3000 * (attempt + 1))); continue; }
    }
    return r;
  }
  return { message: 'max retries' };
}

function esc(s) { return s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`; }

/**
 * Fetch virksomhed fra CVR ES.
 */
async function fetchCompanyFromES(cvrNummer) {
  try {
    const res = await fetch('http://distribution.virk.dk/cvr-permanent/virksomhed/_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${cvrAuth}` },
      body: JSON.stringify({
        query: { term: { 'Vrvirksomhed.cvrNummer': Number(cvrNummer) } },
        _source: ['Vrvirksomhed.deltagerRelation'],
        size: 1,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.hits?.hits?.[0]?._source?.Vrvirksomhed ?? null;
  } catch { return null; }
}

/**
 * Lookup enhedsNummer → CVR via CVR ES.
 */
async function lookupEnhedsCvr(enhedsNummer) {
  try {
    const res = await fetch('http://distribution.virk.dk/cvr-permanent/virksomhed/_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${cvrAuth}` },
      body: JSON.stringify({
        query: { term: { 'Vrvirksomhed.enhedsNummer': enhedsNummer } },
        _source: ['Vrvirksomhed.cvrNummer'],
        size: 1,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.hits?.hits?.[0]?._source?.Vrvirksomhed?.cvrNummer?.toString() ?? null;
  } catch { return null; }
}

/**
 * Ekstraher ejerskab med KORREKT temporal filtrering.
 *
 * FIX vs. v1:
 *   - Sætter gyldig_til korrekt for historiske ejerskaber
 *   - Inkluderer IKKE rækker hvor ALLE ejerandels-værdier er udløbet
 *     medmindre vi eksplicit vil have historiske rækker (med gyldig_til sat)
 */
function extractOwnership(ejetCvr, vrData, enhedsNummerToCvr) {
  const relations = vrData?.deltagerRelation ?? [];
  const rows = [];

  for (const rel of relations) {
    const deltager = rel?.deltager;
    if (!deltager || deltager.enhedstype !== 'VIRKSOMHED') continue;
    const enhedsNr = deltager.enhedsNummer;
    if (!enhedsNr) continue;

    const deltagerCvr = enhedsNummerToCvr.get(enhedsNr);
    if (!deltagerCvr || deltagerCvr === ejetCvr) continue;

    const organisationer = rel.organisationer ?? [];
    let ejerandelMin = null;
    let ejerandelMax = null;
    let gyldigFra = null;
    let gyldigTil = null;
    let foundOwnership = false;

    for (const org of organisationer) {
      if (org?.hovedtype !== 'REGISTER') continue;

      // Check medlemsperiode
      const medlemsperioder = org?.medlemsperiode ?? [];
      const aktivMedlem = medlemsperioder.find(m => m?.periode?.gyldigTil == null);

      // Check FUNKTION = EJERREGISTER
      const attrs = org?.attributter ?? [];
      const hasEjerReg = attrs.some(a =>
        a?.type === 'FUNKTION' &&
        (a?.vaerdier ?? []).some(v => v?.vaerdi === 'EJERREGISTER' && v?.periode?.gyldigTil == null)
      );
      if (!hasEjerReg) continue;

      // Ejerandel — check alle attribut-kilder
      const allAttrSources = [
        ...(org?.attributter ?? []),
        ...((org?.medlemsData ?? []).flatMap(md => md?.attributter ?? [])),
      ];

      for (const attr of allAttrSources) {
        if (attr?.type !== 'EJERANDEL_PROCENT') continue;
        const vaerdier = attr?.vaerdier ?? [];

        // Find aktiv ejerandel (gyldigTil == null)
        const aktiv = vaerdier.find(v => v?.periode?.gyldigTil == null);
        if (aktiv) {
          const interval = INTERVAL_MAP[aktiv.vaerdi];
          if (interval) {
            ejerandelMin = interval.min;
            ejerandelMax = interval.max;
          } else {
            const pct = parseFloat(aktiv.vaerdi);
            if (!isNaN(pct)) { ejerandelMin = pct * 100; ejerandelMax = pct * 100; }
          }
          foundOwnership = true;
          gyldigTil = null; // Gældende
          break;
        }

        // Alle ejerandele udløbet → historisk ejerskab
        if (vaerdier.length > 0 && vaerdier.every(v => v?.periode?.gyldigTil != null)) {
          // Find seneste gyldigTil som ejerskabets slut-dato
          const seneste = vaerdier
            .map(v => v?.periode?.gyldigTil)
            .filter(Boolean)
            .sort()
            .pop();
          gyldigTil = seneste?.split('T')[0] || seneste;

          // Brug den udløbne ejerandels værdier
          const last = vaerdier.sort((a, b) =>
            (b?.periode?.gyldigTil || '').localeCompare(a?.periode?.gyldigTil || '')
          )[0];
          if (last) {
            const interval = INTERVAL_MAP[last.vaerdi];
            if (interval) { ejerandelMin = interval.min; ejerandelMax = interval.max; }
          }
          foundOwnership = true;
          break;
        }
      }

      // Gyldig fra fra medlemsperiode
      if (aktivMedlem?.periode) {
        gyldigFra = aktivMedlem.periode.gyldigFra?.split('T')[0] || aktivMedlem.periode.gyldigFra;
      } else if (medlemsperioder.length > 0) {
        // Historisk: brug seneste medlemsperiode
        const senesteMedlem = medlemsperioder.sort((a, b) =>
          (b?.periode?.gyldigFra || '').localeCompare(a?.periode?.gyldigFra || '')
        )[0];
        gyldigFra = senesteMedlem?.periode?.gyldigFra?.split('T')[0] || null;
        if (!gyldigTil) {
          gyldigTil = senesteMedlem?.periode?.gyldigTil?.split('T')[0] || null;
        }
      }

      // Ejerskab UDEN ejerandels-data men med aktiv EJERREGISTER
      if (!foundOwnership && aktivMedlem) {
        foundOwnership = true;
        gyldigTil = null; // Gældende (men uden angivet ejerandel)
      }

      break;
    }

    if (foundOwnership) {
      rows.push({
        ejer_cvr: deltagerCvr,
        ejet_cvr: ejetCvr,
        ejerandel_pct: ejerandelMax,
        ejerandel_min: ejerandelMin,
        ejerandel_max: ejerandelMax,
        gyldig_fra: gyldigFra,
        gyldig_til: gyldigTil,
        sidst_opdateret: new Date().toISOString(),
      });
    }
  }

  return rows;
}

async function main() {
  process.on('uncaughtException', (err) => {
    if (err.code === 'ECONNRESET' || err.code === 'EPIPE') { console.error(`  [WARN] ${err.code}`); return; }
    console.error('Fatal:', err); process.exit(1);
  });

  const rangeLabel = FROM_CVR ? `${FROM_CVR}→${TO_CVR || 'end'}` : `offset=${OFFSET}`;
  console.log(`BIZZ-1681: Re-backfill cvr_virksomhed_ejerskab — env=${TARGET_ENV}, range=${rangeLabel}`);

  // Step 1: Truncate if clean start
  if (!SKIP_TRUNCATE && OFFSET === 0 && !FROM_CVR) {
    console.log('  Truncating cvr_virksomhed_ejerskab...');
    await runSql('TRUNCATE cvr_virksomhed_ejerskab');
    console.log('  Truncated.');
  }

  // Step 2: Get estimated CVR count (exact count times out on Management API)
  const countRes = await runSql(`SELECT reltuples::bigint as cnt FROM pg_class WHERE relname = 'cvr_virksomhed'`);
  const totalCvr = countRes?.[0]?.cnt ?? '?';
  console.log(`  ~${totalCvr} virksomheder totalt (range: ${rangeLabel})`);

  const enhedsNummerToCvr = new Map();
  let processed = 0, inserted = 0, errors = 0, skipped = 0;
  let cursorCvr = FROM_CVR || '0';
  const startTime = Date.now();

  while (processed < LIMIT) {
    // Fetch batch of CVRs using cursor-based pagination (no OFFSET)
    const whereClause = TO_CVR ? `WHERE cvr > '${cursorCvr}' AND cvr < '${TO_CVR}'` : `WHERE cvr > '${cursorCvr}'`;
    const batch = await runSql(`SELECT cvr FROM cvr_virksomhed ${whereClause} ORDER BY cvr LIMIT ${BATCH_SIZE}`);
    if (batch?.message) {
      // API error (timeout/throttle) — wait and retry, don't exit
      console.error(`  [WARN] batch fetch failed: ${batch.message} — retrying in 30s`);
      await new Promise(r => setTimeout(r, 30000));
      continue;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    cursorCvr = batch[batch.length - 1].cvr;

    const insertBuf = [];

    for (const { cvr } of batch) {
      if (processed >= LIMIT) break;
      processed++;

      try {
        const vrData = await fetchCompanyFromES(cvr);
        if (!vrData) { skipped++; continue; }

        // Build enhedsNummer→CVR mapping
        const rels = vrData.deltagerRelation ?? [];
        for (const rel of rels) {
          const d = rel?.deltager;
          if (d?.enhedstype === 'VIRKSOMHED' && d?.enhedsNummer && !enhedsNummerToCvr.has(d.enhedsNummer)) {
            const enCvr = await lookupEnhedsCvr(d.enhedsNummer);
            if (enCvr) enhedsNummerToCvr.set(d.enhedsNummer, String(enCvr));
          }
        }

        const rows = extractOwnership(cvr, vrData, enhedsNummerToCvr);
        insertBuf.push(...rows);
      } catch (err) {
        errors++;
        if (errors <= 10) console.error(`  CVR ${cvr}: ${err.message}`);
      }
    }

    // Batch insert
    if (insertBuf.length > 0) {
      const values = insertBuf.map(r =>
        `(${esc(r.ejer_cvr)}, ${esc(r.ejet_cvr)}, ${r.ejerandel_pct ?? 'NULL'}, ${r.ejerandel_min ?? 'NULL'}, ${r.ejerandel_max ?? 'NULL'}, ${r.gyldig_fra ? esc(r.gyldig_fra) : 'NULL'}, ${r.gyldig_til ? esc(r.gyldig_til) : 'NULL'}, now())`
      ).join(',\n');
      const insertSql = `INSERT INTO cvr_virksomhed_ejerskab (ejer_cvr, ejet_cvr, ejerandel_pct, ejerandel_min, ejerandel_max, gyldig_fra, gyldig_til, sidst_opdateret) VALUES ${values} ON CONFLICT (ejer_cvr, ejet_cvr) DO UPDATE SET ejerandel_pct = EXCLUDED.ejerandel_pct, ejerandel_min = EXCLUDED.ejerandel_min, ejerandel_max = EXCLUDED.ejerandel_max, gyldig_fra = EXCLUDED.gyldig_fra, gyldig_til = EXCLUDED.gyldig_til, sidst_opdateret = EXCLUDED.sidst_opdateret`;
      for (let attempt = 0; attempt < 5; attempt++) {
        const result = await runSql(insertSql);
        if (!result?.message) { inserted += insertBuf.length; break; }
        if (result.message.includes('timeout') || result.message.includes('Throttler') || result.message.includes('ECONNRESET')) {
          console.error(`  [INSERT RETRY ${attempt + 1}/5]: ${result.message.substring(0, 80)}`);
          await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
          continue;
        }
        // Real error (FK, syntax etc) — log and move on
        errors++;
        if (errors <= 5) console.error(`  [INSERT ERR]: ${result.message.substring(0, 150)}`);
        break;
      }
    }

    if (processed % 200 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = (processed / elapsed).toFixed(1);
      console.log(`  [${processed}/${totalCvr}] inserted=${inserted} skipped=${skipped} errors=${errors} ${rate} cvr/s cursor=${cursorCvr}`);
    }

    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\nDone! ${elapsed} min, processed=${processed}, inserted=${inserted}, skipped=${skipped}, errors=${errors}`);
  console.log(`Resume with: --from=${cursorCvr} --skip-truncate`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
