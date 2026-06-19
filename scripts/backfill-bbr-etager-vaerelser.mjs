#!/usr/bin/env node
/**
 * BIZZ-2070: Backfill bbr_ejendom_status.antal_etager + antal_vaerelser
 * fra BBR v2 GraphQL (graphql.datafordeler.dk/BBR/v2).
 *
 * Det gamle BBRPublic REST GraphQL-endpoint (brugt af BIZZ-828 backfill) er
 * dødt (500 for alt), så dette script bruger den verificerede v2 4-step
 * pipeline (samme mønster som BIZZ-907 / refresh-ejendom-status):
 *   1. BBR_Ejendomsrelation(bfeNummer in [...])    → ejendoms-UUID
 *   2. BBR_Grund(bestemtFastEjendom in [...])      → grund-UUID
 *   3. BBR_Bygning(grund in [...])                 → byg054AntalEtager
 *   4. BBR_Enhed(bygning in [...])                 → enh031AntalVaerelser
 *
 * Konsolidering pr. BFE (kun aktive bygninger/enheder, dvs. status ∉ {4,10,11}):
 *   antal_etager    = MAX(byg054AntalEtager)
 *   antal_vaerelser = SUM(enh031AntalVaerelser)
 *   Ingen data fundet → 0 (sentinel for "hentet, intet i BBR" — gør scriptet
 *   resumable via IS NULL-filter; 0 filtrerer identisk med NULL i RPC'en).
 *
 * Kandidater prioriteres efter seneste handel (mv_boligpris_handler), så de
 * rækker brugerne faktisk ser i boligpris-dashboardet backfilles først.
 *
 * Brug:
 *   node scripts/backfill-bbr-etager-vaerelser.mjs --env=test --limit=5000 [--dry-run]
 *
 * Kræver i .env.local: SUPABASE_ACCESS_TOKEN (Management API) + DATAFORDELER_API_KEY.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// ── Args ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
const envTarget = args.find((a) => a.startsWith('--env='))?.split('=')[1] ?? 'test';
const limit = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '1000', 10);
const dryRun = args.includes('--dry-run');

// ── .env.local ─────────────────────────────────────────────────
const envContent = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
const env = {};
for (const line of envContent.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)/);
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
}

// Korrekte project refs (jf. reference_environments-memory — bemærk at ældre
// scripts har forkert mapping; prod er xsyl..., dev er wkzw...)
const PROJECT_REFS = {
  prod: 'xsyldjqcntiygrtfcszm',
  test: 'rlkjmqjxmkxuclehbrnl',
  dev: 'wkzwxfhyfmvglrqtmebw',
};
const REF = PROJECT_REFS[envTarget];
if (!REF) throw new Error(`Ukendt env: ${envTarget}`);

const BBR_V2 = `https://graphql.datafordeler.dk/BBR/v2?apiKey=${env.DATAFORDELER_API_KEY}`;
const RETIRED = new Set([4, 10, 11]);
const BATCH = 50;

/** Kør SQL via Supabase Management API (retry på transiente 5xx/Cloudflare-fejl). */
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
        // 4xx (fx SQL-fejl) er permanente — fail fast. 5xx er transiente.
        if (res.status < 500) throw new Error(`Supabase API ${res.status}: ${txt.slice(0, 300)}`);
        throw Object.assign(new Error(`Supabase API ${res.status}`), { transient: true });
      }
      const raw = await res.json();
      return Array.isArray(raw) ? raw : (raw.result ?? raw.rows ?? []);
    } catch (err) {
      const transient = err.transient || err.name === 'TimeoutError' || err.code === 'ECONNRESET';
      if (!transient || attempt === 4) throw err;
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}

/** BBR v2 GraphQL med retry (ECONNRESET ses jævnligt). */
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
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

/**
 * 4-step v2 lookup for en batch BFE'er.
 * Returnerer Map<bfe, { etager, vaerelser }> (0 = hentet, intet fundet).
 */
async function fetchBatch(bfeNumre) {
  const vt = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
  const out = new Map();
  for (const bfe of bfeNumre) out.set(bfe, { etager: 0, vaerelser: 0 });

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
    `{ BBR_Grund(first: 500, virkningstid: "${vt}", where: { bestemtFastEjendom: { in: [${ejdIds.map((i) => `"${i}"`).join(',')}] } }) { nodes { id_lokalId bestemtFastEjendom } } }`
  );
  const ejdToGrunde = new Map();
  for (const g of grundData?.BBR_Grund?.nodes ?? []) {
    if (!g.bestemtFastEjendom || !g.id_lokalId) continue;
    if (!ejdToGrunde.has(g.bestemtFastEjendom)) ejdToGrunde.set(g.bestemtFastEjendom, new Set());
    ejdToGrunde.get(g.bestemtFastEjendom).add(g.id_lokalId);
  }
  const allGrundIds = [...new Set([...ejdToGrunde.values()].flatMap((s) => [...s]))];
  if (allGrundIds.length === 0) return out;

  // 3) Grund → bygninger (dedup på id_lokalId — BIZZ-575: v2 dublerer).
  //    DAF-GQL-0016: 'in'-lister må max have 100 elementer → chunk.
  const seenByg = new Set();
  const grundToByg = new Map();
  const aktiveBygIds = [];
  for (let i = 0; i < allGrundIds.length; i += 100) {
    const gChunk = allGrundIds.slice(i, i + 100);
    const bygData = await gql(
      `{ BBR_Bygning(first: 1000, virkningstid: "${vt}", where: { grund: { in: [${gChunk.map((i2) => `"${i2}"`).join(',')}] } }) { nodes { id_lokalId status grund byg054AntalEtager } } }`
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

  // 4) Bygning → enheder (værelser). DAF-GQL-0016: max 100 pr. 'in'-liste.
  const bygToVaerelser = new Map();
  for (let i = 0; i < aktiveBygIds.length; i += 100) {
    const chunk = aktiveBygIds.slice(i, i + 100);
    const enhData = await gql(
      `{ BBR_Enhed(first: 1000, virkningstid: "${vt}", where: { bygning: { in: [${chunk.map((i2) => `"${i2}"`).join(',')}] } }) { nodes { id_lokalId status bygning enh031AntalVaerelser } } }`
    );
    const seenEnh = new Set();
    for (const e of enhData?.BBR_Enhed?.nodes ?? []) {
      if (!e.id_lokalId || seenEnh.has(e.id_lokalId)) continue;
      seenEnh.add(e.id_lokalId);
      if (RETIRED.has(Number(e.status))) continue;
      const v = Number(e.enh031AntalVaerelser);
      if (!Number.isFinite(v) || v <= 0) continue;
      bygToVaerelser.set(e.bygning, (bygToVaerelser.get(e.bygning) ?? 0) + v);
    }
  }

  // Konsolidér pr. BFE
  for (const [bfe, ejdId] of bfeToEjd) {
    const grunde = ejdToGrunde.get(ejdId);
    if (!grunde) continue;
    let maxEtager = 0;
    let sumVaerelser = 0;
    for (const gid of grunde) {
      for (const byg of grundToByg.get(gid) ?? []) {
        const et = Number(byg.byg054AntalEtager);
        if (Number.isFinite(et) && et > maxEtager) maxEtager = et;
        sumVaerelser += bygToVaerelser.get(byg.id_lokalId) ?? 0;
      }
    }
    out.set(bfe, { etager: maxEtager, vaerelser: sumVaerelser });
  }
  return out;
}

// ── Main ───────────────────────────────────────────────────────
console.log(`BIZZ-2070 backfill etager/værelser — env=${envTarget} limit=${limit} dryRun=${dryRun}`);

// Kandidater: BFE'er med handler, nyeste handel først, kun u-backfillede.
const kandidater = await runSql(`
  SELECT m.bfe_nummer, MAX(m.overtagelsesdato) AS seneste
  FROM mv_boligpris_handler m
  JOIN bbr_ejendom_status b ON b.bfe_nummer = m.bfe_nummer
  WHERE b.antal_etager IS NULL AND b.antal_vaerelser IS NULL
  GROUP BY m.bfe_nummer
  ORDER BY seneste DESC
  LIMIT ${limit}
`);
console.log(`Kandidater: ${kandidater.length}`);

let updated = 0;
let withData = 0;
for (let i = 0; i < kandidater.length; i += BATCH) {
  const batch = kandidater.slice(i, i + BATCH).map((r) => Number(r.bfe_nummer));
  let resultMap;
  try {
    resultMap = await fetchBatch(batch);
  } catch (err) {
    console.error(`  batch ${i}-${i + batch.length} FEJL: ${err.message} — springer over`);
    continue;
  }

  const values = [...resultMap.entries()].map(
    ([bfe, r]) => `(${bfe},${r.etager},${r.vaerelser})`
  );
  for (const [, r] of resultMap) if (r.etager > 0 || r.vaerelser > 0) withData++;

  if (!dryRun && values.length > 0) {
    await runSql(`
      UPDATE bbr_ejendom_status b
      SET antal_etager = v.etager, antal_vaerelser = v.vaerelser
      FROM (VALUES ${values.join(',')}) AS v(bfe, etager, vaerelser)
      WHERE b.bfe_nummer = v.bfe
    `);
  }
  updated += values.length;
  if ((i / BATCH) % 10 === 0 || i + BATCH >= kandidater.length) {
    console.log(`  ${Math.min(i + BATCH, kandidater.length)}/${kandidater.length} — opdateret=${updated}, med data=${withData}`);
  }
  await new Promise((r) => setTimeout(r, 300));
}

console.log(`\nFærdig: ${updated} rækker opdateret, ${withData} med etager/værelser-data.`);
if (!dryRun && updated > 0) {
  console.log('Husk: SELECT refresh_materialized_view(\'mv_boligpris_handler\');');
}
