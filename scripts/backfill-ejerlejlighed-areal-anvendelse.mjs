#!/usr/bin/env node
/**
 * BIZZ-2173: Backfill bbr_ejendom_status for ejerlejligheder, så
 * ejerlejligheds-handler dukker op i boligpris-dashboardet.
 *
 * Problem (verificeret 2026-06-18 på Horsekildevej 34, 2500 Valby):
 * ejerlejligheder har systematisk NULL byg021_anvendelse + NULL
 * samlet_boligareal i bbr_ejendom_status, fordi den eksisterende BBR-berigelse
 * (backfill-bbr-etager-vaerelser / refresh-ejendom-status) bruger en
 * Grund→Bygning→Enhed-pipeline der returnerer TOMT for ejerlejligheder (de
 * sidder ikke på egen grund), og fordi deres bfe_adresse_cache.dawa_id er
 * korrupt (resolver til intet i DAWA — jf. BIZZ-2092-96). Resultatet er at
 * ~75% af handlerne i et postnr (5.212 BFE'er / 13.944 handler alene i 2500)
 * er usynlige under alle boligtype-/areal-filtre.
 *
 * Verificeret berigelses-opskrift (end-to-end testet mod live boligpris-API):
 *   1. samlet_boligareal = MAT_Ejerlejlighed.samletAreal  (autoritativt,
 *      tinglyst areal — batchbart pr. BFE, uafhængigt af den korrupte
 *      adresse-cache). En BFE der returnerer en MAT_Ejerlejlighed-node ER en
 *      tinglyst ejerlejlighed → kun de berigtes (SFE/bygninger springes over).
 *   2. byg021_anvendelse = 140 (Etagebolig). Approksimation: langt de fleste
 *      ejerlejligheder er beboelseslejligheder; erhvervs-ejerlejligheder
 *      (minoritet) kan ikke skelnes via MAT alene og klassificeres også som
 *      140. Dokumenteret afvigelse — en evt. enh020-baseret residential-signal
 *      kræver den dyre per-BFE BBR_Enhed-resolution (parkeret).
 *   3. kommune_kode korrigeres til postnummerets dominerende kommune fra
 *      bfe_adresse_cache (mange ejerlejligheds-rækker har forkert/NULL
 *      kommune_kode — fx 461/Odense på Valby-adresser — hvilket ellers
 *      sorterer dem fra i RPC'ens kommune-prefilter).
 *
 * antal_vaerelser efterlades NULL (kræver BBR_Enhed-fan-out — parkeret til en
 * separat, dyrere kørsel; værelses-filteret matcher dem derfor endnu ikke).
 *
 * Efter en kørsel SKAL mv_boligpris_handler refreshes (gøres af scriptet til
 * sidst medmindre --no-refresh).
 *
 * Resumable: kun BFE'er med byg021_anvendelse IS NULL behandles.
 *
 * Brug:
 *   node scripts/backfill-ejerlejlighed-areal-anvendelse.mjs --env=test [--postnr=2500] [--limit=20000] [--dry-run] [--no-refresh]
 *
 * Kræver i .env.local: SUPABASE_ACCESS_TOKEN + DATAFORDELER_API_KEY.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// ── Args ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
const envTarget = args.find((a) => a.startsWith('--env='))?.split('=')[1] ?? 'test';
const postnrArg = args.find((a) => a.startsWith('--postnr='))?.split('=')[1] ?? null;
const limit = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '20000', 10);
const dryRun = args.includes('--dry-run');
const noRefresh = args.includes('--no-refresh');

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

const MAT_V2 = `https://graphql.datafordeler.dk/MAT/v2?apiKey=${env.DATAFORDELER_API_KEY}`;
const MAT_CHUNK = 100; // DAF-GQL-0016: 'in'-lister maks 100 elementer
const nowTs = new Date().toISOString();

/** Kør SQL via Supabase Management API (retry på transiente 5xx). */
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
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}

/** MAT v2 GraphQL med retry. Returnerer Map BFE → samletAreal (kun Gældende, areal>0). */
async function fetchMatAreal(bfes) {
  const result = new Map();
  for (let i = 0; i < bfes.length; i += MAT_CHUNK) {
    const chunk = bfes.slice(i, i + MAT_CHUNK);
    const query = `{
      MAT_Ejerlejlighed(first: ${chunk.length * 2}, virkningstid: "${nowTs}", registreringstid: "${nowTs}", where: { BFEnummer: { in: [${chunk.join(',')}] } }) {
        nodes { BFEnummer samletAreal status }
      }
    }`;
    let data = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(MAT_V2, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
          signal: AbortSignal.timeout(30000),
        });
        const json = await res.json();
        if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 300));
        data = json.data;
        break;
      } catch (err) {
        if (attempt === 3) throw err;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    for (const n of data?.MAT_Ejerlejlighed?.nodes ?? []) {
      if (n.status !== 'Gældende' || !n.BFEnummer) continue;
      const areal = typeof n.samletAreal === 'number' && n.samletAreal > 0 ? n.samletAreal : null;
      if (areal) result.set(Number(n.BFEnummer), areal);
    }
  }
  return result;
}

// ── 1) Kandidater: ejerlejligheds-BFE'er med handel + NULL anvendelse ──
const postnrFilter = postnrArg
  ? `AND a.postnr = '${String(postnrArg).padStart(4, '0')}'`
  : '';
const candidates = await runSql(`
  SELECT DISTINCT b.bfe_nummer, a.postnr
  FROM bbr_ejendom_status b
  JOIN v_ejerskifte_handel h
    ON h.bfe_nummer = b.bfe_nummer AND h.samlet_koebesum > 0 AND h.overtagelsesdato IS NOT NULL
  JOIN bfe_adresse_cache a ON a.bfe_nummer = b.bfe_nummer
  WHERE b.byg021_anvendelse IS NULL
    ${postnrFilter}
  ORDER BY b.bfe_nummer
  LIMIT ${limit};
`);
console.log(`[${envTarget}] ${candidates.length} kandidat-BFE'er (NULL anvendelse, har handel${postnrArg ? `, postnr ${postnrArg}` : ''})`);
if (candidates.length === 0) process.exit(0);

// ── 2) Dominerende kommune pr. postnr (til kommune_kode-korrektion) ──
const postnumre = [...new Set(candidates.map((c) => c.postnr).filter(Boolean))];
const kommuneRows = await runSql(`
  SELECT postnr, kommune_kode, count(*) AS n
  FROM bfe_adresse_cache
  WHERE postnr = ANY(ARRAY[${postnumre.map((p) => `'${p}'`).join(',')}]::text[])
    AND kommune_kode IS NOT NULL
  GROUP BY postnr, kommune_kode;
`);
const postnrKommune = new Map(); // postnr → dominant kommune_kode
for (const r of kommuneRows) {
  const cur = postnrKommune.get(r.postnr);
  if (!cur || Number(r.n) > cur.n) postnrKommune.set(r.postnr, { kk: Number(r.kommune_kode), n: Number(r.n) });
}

// ── 3) MAT-areal for alle kandidater ──
const allBfes = candidates.map((c) => Number(c.bfe_nummer));
console.log(`Henter MAT_Ejerlejlighed-areal for ${allBfes.length} BFE'er …`);
const matAreal = await fetchMatAreal(allBfes);
console.log(`MAT returnerede areal for ${matAreal.size} ejerlejligheder (resten er ikke tinglyste ejerlejligheder → springes over)`);

// ── 4) Byg UPDATE-rækker: kun BFE'er med MAT-areal ──
const updates = [];
for (const c of candidates) {
  const bfe = Number(c.bfe_nummer);
  const areal = matAreal.get(bfe);
  if (!areal) continue; // ikke en ejerlejlighed (eller intet tinglyst areal)
  const kk = postnrKommune.get(c.postnr)?.kk ?? null;
  updates.push({ bfe, areal, kk });
}
console.log(`${updates.length} ejerlejligheder berigtes (anvendelse=140, areal, kommune_kode).`);

if (dryRun) {
  console.log('DRY-RUN — ingen skrivning. Eksempel:', updates.slice(0, 5));
  process.exit(0);
}

// ── 5) Skriv i batches via VALUES-join ──
const WRITE_BATCH = 500;
let written = 0;
for (let i = 0; i < updates.length; i += WRITE_BATCH) {
  const batch = updates.slice(i, i + WRITE_BATCH);
  const values = batch
    .map((u) => `(${u.bfe}, ${u.areal}, ${u.kk === null ? 'NULL' : u.kk})`)
    .join(',');
  await runSql(`
    UPDATE bbr_ejendom_status b
    SET byg021_anvendelse = 140,
        samlet_boligareal = v.areal,
        kommune_kode = COALESCE(v.kk, b.kommune_kode)
    FROM (VALUES ${values}) AS v(bfe, areal, kk)
    WHERE b.bfe_nummer = v.bfe AND b.byg021_anvendelse IS NULL;
  `);
  written += batch.length;
  console.log(`  skrev ${written}/${updates.length}`);
}

// ── 6) Refresh MV ──
if (!noRefresh) {
  console.log('Refresher mv_boligpris_handler …');
  await runSql('REFRESH MATERIALIZED VIEW public.mv_boligpris_handler;');
}
console.log('Færdig.');
