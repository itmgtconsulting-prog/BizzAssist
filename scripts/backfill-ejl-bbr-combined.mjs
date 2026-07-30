#!/usr/bin/env node
/**
 * BIZZ-2173 + BIZZ-2176 — Combined national backfill for ALL boligpris-handler.
 *
 * Fills bbr_ejendom_status columns that are ~98% NULL across all property types:
 *   - samlet_boligareal    (from BBR_Enhed enh026/027)
 *   - byg021_anvendelse    (from BBR_Bygning byg021)
 *   - antal_etager         (from BBR_Bygning byg054)
 *   - antal_vaerelser      (from BBR_Enhed enh031)
 *   - opfoerelsesaar       (from BBR_Bygning byg026)
 *
 * Pipeline (same 4-step BBR v2 as backfill-bbr-etager-vaerelser.mjs):
 *   1. BBR_Ejendomsrelation(bfeNummer in [...]) → ejendoms-UUID
 *   2. BBR_Grund(bestemtFastEjendom in [...])   → grund-UUID
 *   3. BBR_Bygning(grund in [...])              → byg021, byg026, byg054
 *   4. BBR_Enhed(bygning in [...])              → enh026, enh027, enh031
 *
 * Resumable: uses sentinel value 0 for "fetched, no data in BBR" so
 * IS NULL candidates shrink as the script runs. Re-running is safe.
 *
 * Usage:
 *   node scripts/backfill-ejl-bbr-combined.mjs --env=prod --limit=50000 [--dry-run]
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ── Args ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
const envTarget = args.find(a => a.startsWith('--env='))?.split('=')[1] ?? 'test';
const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] ?? '5000', 10);
const dryRun = args.includes('--dry-run');

// ── .env.local ─────────────────────────────────────────────────
const envContent = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
const env = {};
for (const line of envContent.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)/);
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
}

const PROJECT_REFS = {
  prod: 'xsyldjqcntiygrtfcszm',
  test: 'rlkjmqjxmkxuclehbrnl',
  dev: 'wkzwxfhyfmvglrqtmebw',
};
const REF = PROJECT_REFS[envTarget];
if (!REF) throw new Error(`Ukendt env: ${envTarget}`);

const BBR_V2 = `https://graphql.datafordeler.dk/BBR/v2?apiKey=${env.DATAFORDELER_API_KEY}`;
if (!env.DATAFORDELER_API_KEY) { console.error('Missing DATAFORDELER_API_KEY'); process.exit(1); }
if (!env.SUPABASE_ACCESS_TOKEN) { console.error('Missing SUPABASE_ACCESS_TOKEN'); process.exit(1); }

const RETIRED = new Set([4, 10, 11]);
const BATCH = 50;

// ── Supabase Management API SQL ────────────────────────────────
async function runSql(sql) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: sql }),
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) {
        const txt = await res.text();
        if (res.status < 500) throw new Error(`Supabase API ${res.status}: ${txt.slice(0, 300)}`);
        throw Object.assign(new Error(`Supabase API ${res.status}`), { transient: true });
      }
      const raw = await res.json();
      return Array.isArray(raw) ? raw : (raw.result ?? raw.rows ?? []);
    } catch (err) {
      const transient = err.transient || err.name === 'TimeoutError' || err.code === 'ECONNRESET';
      if (!transient || attempt === 4) throw err;
      await new Promise(r => setTimeout(r, 3000 * attempt));
    }
  }
}

// ── BBR v2 GraphQL ─────────────────────────────────────────────
async function gql(query) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(BBR_V2, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(30000),
      });
      const json = await res.json();
      if (json.errors) throw new Error(`GraphQL: ${JSON.stringify(json.errors).slice(0, 300)}`);
      return json.data;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
}

/**
 * 4-step BBR v2 lookup for a batch of BFE numbers (NON-ejerlejlighed).
 * For parcelhuse, sommerhuse, rækkehuse etc. where BFE = hele ejendommen:
 * SUM enheder is correct (typically 1 building, 1-2 units).
 * Returns Map<bfe, { boligareal, anvendelse, etager, vaerelser, byggeaar }>.
 * 0 = fetched but no data in BBR (sentinel for resumability).
 */
async function fetchBatchStandard(bfeNumre) {
  const vt = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
  const out = new Map();
  for (const bfe of bfeNumre) out.set(bfe, { boligareal: 0, anvendelse: 0, etager: 0, vaerelser: 0, byggeaar: 0 });

  // 1) BFE → ejendoms-UUID
  const ejData = await gql(
    `{ BBR_Ejendomsrelation(first: 500, virkningstid: "${vt}", where: { bfeNummer: { in: [${bfeNumre.join(',')}] } }) { nodes { bfeNummer id_lokalId } } }`
  );
  const bfeToEjd = new Map();
  for (const e of ejData?.BBR_Ejendomsrelation?.nodes ?? []) {
    const b = Number(e.bfeNummer);
    if (Number.isFinite(b) && !bfeToEjd.has(b)) bfeToEjd.set(b, e.id_lokalId);
  }
  if (bfeToEjd.size === 0) return out;

  // 2) Ejendoms-UUID → grunde
  const ejdIds = [...new Set(bfeToEjd.values())];
  const grundData = await gql(
    `{ BBR_Grund(first: 500, virkningstid: "${vt}", where: { bestemtFastEjendom: { in: [${ejdIds.map(i => `"${i}"`).join(',')}] } }) { nodes { id_lokalId bestemtFastEjendom } } }`
  );
  const ejdToGrunde = new Map();
  for (const g of grundData?.BBR_Grund?.nodes ?? []) {
    if (!g.bestemtFastEjendom || !g.id_lokalId) continue;
    if (!ejdToGrunde.has(g.bestemtFastEjendom)) ejdToGrunde.set(g.bestemtFastEjendom, new Set());
    ejdToGrunde.get(g.bestemtFastEjendom).add(g.id_lokalId);
  }
  const allGrundIds = [...new Set([...ejdToGrunde.values()].flatMap(s => [...s]))];
  if (allGrundIds.length === 0) return out;

  // 3) Grund → bygninger
  const seenByg = new Set();
  const grundToByg = new Map();
  const aktiveBygIds = [];
  for (let i = 0; i < allGrundIds.length; i += 100) {
    const chunk = allGrundIds.slice(i, i + 100);
    const bygData = await gql(
      `{ BBR_Bygning(first: 1000, virkningstid: "${vt}", where: { grund: { in: [${chunk.map(i2 => `"${i2}"`).join(',')}] } }) { nodes { id_lokalId status grund byg021BygningensAnvendelse byg026Opfoerelsesaar byg054AntalEtager byg039BygningensSamledeBoligAreal } } }`
    );
    for (const b of bygData?.BBR_Bygning?.nodes ?? []) {
      if (!b.id_lokalId || seenByg.has(b.id_lokalId)) continue;
      seenByg.add(b.id_lokalId);
      if (RETIRED.has(Number(b.status))) continue;
      if (!grundToByg.has(b.grund)) grundToByg.set(b.grund, []);
      grundToByg.get(b.grund).push(b);
      aktiveBygIds.push(b.id_lokalId);
    }
  }

  // 4) Bygning → enheder — SUM all (correct for non-ejerlejlighed)
  const bygToEnheder = new Map();
  for (let i = 0; i < aktiveBygIds.length; i += 100) {
    const chunk = aktiveBygIds.slice(i, i + 100);
    const enhData = await gql(
      `{ BBR_Enhed(first: 1000, virkningstid: "${vt}", where: { bygning: { in: [${chunk.map(i2 => `"${i2}"`).join(',')}] } }) { nodes { id_lokalId status bygning enh026EnhedensSamledeAreal enh027ArealTilBeboelse enh031AntalVaerelser } } }`
    );
    const seenEnh = new Set();
    for (const e of enhData?.BBR_Enhed?.nodes ?? []) {
      if (!e.id_lokalId || seenEnh.has(e.id_lokalId)) continue;
      seenEnh.add(e.id_lokalId);
      if (RETIRED.has(Number(e.status))) continue;
      if (!bygToEnheder.has(e.bygning)) bygToEnheder.set(e.bygning, []);
      bygToEnheder.get(e.bygning).push(e);
    }
  }

  // Consolidate per BFE — SUM all enheder (correct for parcelhus/sommerhus/rækkehus)
  for (const [bfe, ejdId] of bfeToEjd) {
    const grunde = ejdToGrunde.get(ejdId);
    if (!grunde) continue;

    let maxEtager = 0, sumVaerelser = 0, sumBoligareal = 0;
    let anvendelse = 0, byggeaar = 0, largestBygAreal = 0;

    for (const gid of grunde) {
      for (const byg of grundToByg.get(gid) ?? []) {
        const et = Number(byg.byg054AntalEtager);
        if (Number.isFinite(et) && et > maxEtager) maxEtager = et;
        const yr = Number(byg.byg026Opfoerelsesaar);
        if (Number.isFinite(yr) && yr > 0 && (byggeaar === 0 || yr < byggeaar)) byggeaar = yr;
        const bygAreal = Number(byg.byg039BygningensSamledeBoligAreal) || 0;
        const anv = Number(byg.byg021BygningensAnvendelse);
        if (bygAreal > largestBygAreal && Number.isFinite(anv) && anv > 0) {
          largestBygAreal = bygAreal; anvendelse = anv;
        }
        for (const enh of bygToEnheder.get(byg.id_lokalId) ?? []) {
          const vr = Number(enh.enh031AntalVaerelser);
          if (Number.isFinite(vr) && vr > 0) sumVaerelser += vr;
          const ba = Number(enh.enh027ArealTilBeboelse) || Number(enh.enh026EnhedensSamledeAreal) || 0;
          if (ba > 0) sumBoligareal += ba;
        }
      }
    }
    out.set(bfe, { boligareal: sumBoligareal, anvendelse, etager: maxEtager, vaerelser: sumVaerelser, byggeaar });
  }
  return out;
}

/**
 * Ejerlejlighed-specific lookup: BFE → specific BBR_Enhed via dawa_id.
 * Each ejerlejlighed-BFE maps to ONE unit in a building, not the whole building.
 * Uses adresseIdentificerer to find the correct enhed, then gets the parent
 * bygning for etager/anvendelse/byggeaar.
 *
 * @param {Array<{bfe: number, dawa_id: string}>} items - BFE + dawa_id pairs
 * @returns {Promise<Map<number, {boligareal, anvendelse, etager, vaerelser, byggeaar}>>}
 */
async function fetchBatchEjl(items) {
  const vt = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
  const out = new Map();
  for (const { bfe } of items) out.set(bfe, { boligareal: 0, anvendelse: 0, etager: 0, vaerelser: 0, byggeaar: 0 });

  // Lookup enheder by adresseIdentificerer (dawa_id) — one per ejerlejlighed
  const dawaIds = items.filter(i => i.dawa_id).map(i => i.dawa_id);
  if (dawaIds.length === 0) return out;

  // BBR_Enhed by adresseIdentificerer — chunk to max 100
  const allEnheder = [];
  for (let i = 0; i < dawaIds.length; i += 100) {
    const chunk = dawaIds.slice(i, i + 100);
    const enhData = await gql(
      `{ BBR_Enhed(first: 500, virkningstid: "${vt}", where: { adresseIdentificerer: { in: [${chunk.map(id => `"${id}"`).join(',')}] } }) { nodes { id_lokalId status bygning adresseIdentificerer enh026EnhedensSamledeAreal enh027ArealTilBeboelse enh031AntalVaerelser } } }`
    );
    for (const e of enhData?.BBR_Enhed?.nodes ?? []) {
      if (!RETIRED.has(Number(e.status))) allEnheder.push(e);
    }
  }

  // Map dawa_id → enhed (first active match)
  const dawaToEnhed = new Map();
  for (const e of allEnheder) {
    if (e.adresseIdentificerer && !dawaToEnhed.has(e.adresseIdentificerer)) {
      dawaToEnhed.set(e.adresseIdentificerer, e);
    }
  }

  // Get parent bygninger for etager/anvendelse/byggeaar
  const bygIds = [...new Set(allEnheder.map(e => e.bygning).filter(Boolean))];
  const bygMap = new Map();
  for (let i = 0; i < bygIds.length; i += 100) {
    const chunk = bygIds.slice(i, i + 100);
    const bygData = await gql(
      `{ BBR_Bygning(first: 500, virkningstid: "${vt}", where: { id_lokalId: { in: [${chunk.map(id => `"${id}"`).join(',')}] } }) { nodes { id_lokalId status byg021BygningensAnvendelse byg026Opfoerelsesaar byg054AntalEtager } } }`
    );
    for (const b of bygData?.BBR_Bygning?.nodes ?? []) {
      if (!RETIRED.has(Number(b.status))) bygMap.set(b.id_lokalId, b);
    }
  }

  // Consolidate: each BFE gets its own enhed's data + parent bygning's data
  for (const { bfe, dawa_id } of items) {
    if (!dawa_id) continue;
    const enh = dawaToEnhed.get(dawa_id);
    if (!enh) continue;

    const vaerelser = Number(enh.enh031AntalVaerelser) || 0;
    const boligareal = Number(enh.enh027ArealTilBeboelse) || Number(enh.enh026EnhedensSamledeAreal) || 0;

    const byg = bygMap.get(enh.bygning);
    const etager = Number(byg?.byg054AntalEtager) || 0;
    const anvendelse = Number(byg?.byg021BygningensAnvendelse) || 0;
    const byggeaar = Number(byg?.byg026Opfoerelsesaar) || 0;

    out.set(bfe, { boligareal, anvendelse, etager, vaerelser, byggeaar });
  }
  return out;
}

// ── Main ───────────────────────────────────────────────────────
console.log(`BIZZ-2173+2176 combined ejl backfill — env=${envTarget} limit=${limit} dryRun=${dryRun}`);

// Candidates: ALL properties with handel that are missing ANY target field.
// Includes dawa_id + ejendomstype for routing to the correct pipeline.
// Ejerlejligheder use per-unit address lookup; others use building-level SUM.
const kandidater = await runSql(`
  SELECT m.bfe_nummer, MAX(m.overtagelsesdato) AS seneste,
         c.dawa_id, b.byg021_anvendelse AS anv
  FROM mv_boligpris_handler m
  JOIN bbr_ejendom_status b ON b.bfe_nummer = m.bfe_nummer
  LEFT JOIN bfe_adresse_cache c ON c.bfe_nummer = m.bfe_nummer
  WHERE b.antal_vaerelser IS NULL
     OR b.antal_etager IS NULL
     OR b.samlet_boligareal IS NULL
  GROUP BY m.bfe_nummer, c.dawa_id, b.byg021_anvendelse
  ORDER BY seneste DESC
  LIMIT ${limit}
`);
console.log(`Kandidater: ${kandidater.length}`);
if (kandidater.length === 0) { console.log('Ingen kandidater — done.'); process.exit(0); }

// Separate ejerlejligheder (type 140) from standard properties
const ejlKandidater = kandidater.filter(r => Number(r.anv) === 140);
const stdKandidater = kandidater.filter(r => Number(r.anv) !== 140);
console.log(`  Ejerlejligheder (140, adresse-lookup): ${ejlKandidater.length}`);
console.log(`  Standard (bygning-SUM): ${stdKandidater.length}`);

let updated = 0;
let withData = 0;
let errors = 0;
const startTime = Date.now();

// Merge both lists back, keeping type info for routing
const allKandidater = [...kandidater];

for (let i = 0; i < allKandidater.length; i += BATCH) {
  const batchRows = allKandidater.slice(i, i + BATCH);

  // Split batch into ejl vs standard
  const ejlRows = batchRows.filter(r => Number(r.anv) === 140);
  const stdRows = batchRows.filter(r => Number(r.anv) !== 140);

  let resultMap = new Map();
  try {
    // Fetch standard properties (building-level SUM)
    if (stdRows.length > 0) {
      const stdResult = await fetchBatchStandard(stdRows.map(r => Number(r.bfe_nummer)));
      for (const [k, v] of stdResult) resultMap.set(k, v);
    }
    // Fetch ejerlejligheder (per-unit address lookup)
    if (ejlRows.length > 0) {
      const ejlResult = await fetchBatchEjl(ejlRows.map(r => ({ bfe: Number(r.bfe_nummer), dawa_id: r.dawa_id })));
      for (const [k, v] of ejlResult) resultMap.set(k, v);
    }
  } catch (err) {
    errors++;
    console.error(`  batch ${i}-${i + batchRows.length} FEJL: ${err.message} — springer over`);
    continue;
  }

  // Build UPDATE values — only update fields that are currently NULL
  // (don't overwrite previously filled values from other sources)
  const values = [...resultMap.entries()].map(
    ([bfe, r]) => `(${bfe},${r.boligareal},${r.anvendelse},${r.etager},${r.vaerelser},${r.byggeaar})`
  );
  for (const [, r] of resultMap) {
    if (r.boligareal > 0 || r.vaerelser > 0 || r.etager > 0) withData++;
  }

  if (!dryRun && values.length > 0) {
    await runSql(`
      UPDATE bbr_ejendom_status b
      SET
        samlet_boligareal = COALESCE(b.samlet_boligareal, NULLIF(v.boligareal, 0)),
        byg021_anvendelse = COALESCE(b.byg021_anvendelse, NULLIF(v.anvendelse, 0)),
        antal_etager      = COALESCE(b.antal_etager,      NULLIF(v.etager, 0)),
        antal_vaerelser   = COALESCE(b.antal_vaerelser,   NULLIF(v.vaerelser, 0)),
        opfoerelsesaar    = COALESCE(b.opfoerelsesaar,    NULLIF(v.byggeaar, 0)),
        berigelse_sidst   = NOW()
      FROM (VALUES ${values.join(',')}) AS v(bfe, boligareal, anvendelse, etager, vaerelser, byggeaar)
      WHERE b.bfe_nummer = v.bfe
        AND (b.samlet_boligareal IS NULL
          OR b.antal_etager IS NULL
          OR b.antal_vaerelser IS NULL)
    `);
  }
  updated += values.length;

  if ((i / BATCH) % 5 === 0 || i + BATCH >= kandidater.length) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rate = (updated / (elapsed || 1) * 60).toFixed(0);
    console.log(`  [${Math.min(i + BATCH, kandidater.length)}/${kandidater.length}] updated=${updated} withData=${withData} errors=${errors} (${elapsed}s, ~${rate}/min)`);
  }
  await new Promise(r => setTimeout(r, 300));
}

console.log(`\nDone: ${updated} rows processed, ${withData} with BBR data, ${errors} batch errors.`);
if (!dryRun && updated > 0) {
  console.log('Refreshing mv_boligpris_handler...');
  await runSql("SELECT refresh_materialized_view('mv_boligpris_handler')");
  console.log('MV refreshed.');
}
