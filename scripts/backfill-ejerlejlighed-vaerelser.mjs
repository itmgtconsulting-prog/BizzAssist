#!/usr/bin/env node
/**
 * BIZZ-2176: Backfill antal_vaerelser i bbr_ejendom_status for ejerlejligheder,
 * så værelses-filteret i boligpris-dashboardet rammer dem.
 *
 * Problem (verificeret 2026-06-18, postnr 2500): etageboliger/ejerlejligheder
 * har systematisk NULL antal_vaerelser. Den eksisterende Grund→Bygning→Enhed-
 * pipeline (backfill-bbr-etager-vaerelser) summerer ALLE bygningens enheder og
 * giver bygnings-totaler (19/24/41), aldrig per-lejlighed-værelser. Og
 * bfe_adresse_cache.dawa_id er korrupt — den peger i praksis på bygnings-UUID'en
 * (404 i DAWA), ikke enhedsadressen (jf. BIZZ-2092-96). Resultatet: et filter
 * som "værelser = 2" returnerer 0 rækker selv hvor der findes 2-værelses-
 * lejligheder, fordi antal_vaerelser er NULL for ~69% af handlerne i postnr'et.
 *
 * Verificeret berigelses-opskrift (end-to-end testet mod live BBR v2):
 *   1. adresse-tekst (vejnavn+husnr) + etage + dør fra bfe_adresse_cache.
 *      IKKE den korrupte dawa_id.
 *   2. Frisk DAWA /adresser-opslag (vejnavn,husnr,postnr,etage,dør) → den
 *      KORREKTE enhedsadresse-UUID (DAR/DAWA). Det er nøglen BBR_Enhed bruger
 *      i adresseIdentificerer-feltet.
 *   3. BBR_Enhed(where: adresseIdentificerer = enhedsadresse-UUID) →
 *      enh031AntalVaerelser for netop den lejlighed (autoritativt, per-enhed).
 *      Eksempel: BFE 173442 (Horsekildevej 32, 1.tv, 2500) → 2 værelser.
 *
 * Resumable: kun BFE'er med antal_vaerelser IS NULL behandles.
 * Efter en kørsel SKAL mv_boligpris_handler refreshes (gøres til sidst medmindre
 * --no-refresh).
 *
 * Brug:
 *   node scripts/backfill-ejerlejlighed-vaerelser.mjs --env=test [--postnr=2500] [--limit=200000] [--concurrency=8] [--dry-run] [--no-refresh]
 *
 * Kræver i .env.local: SUPABASE_ACCESS_TOKEN + DATAFORDELER_API_KEY.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// ── Args ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
const envTarget = args.find((a) => a.startsWith('--env='))?.split('=')[1] ?? 'test';
const postnrArg = args.find((a) => a.startsWith('--postnr='))?.split('=')[1] ?? null;
const limit = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '200000', 10);
const concurrency = parseInt(
  args.find((a) => a.startsWith('--concurrency='))?.split('=')[1] ?? '8',
  10
);
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

const BBR_V2 = `https://graphql.datafordeler.dk/BBR/v2?apiKey=${env.DATAFORDELER_API_KEY}`;
const DAWA = 'https://api.dataforsyningen.dk';
// BBR-status der ikke længere er gældende (udfaset/historisk-fjernet).
const RETIRED_STATUS = new Set(['4', '7', '10', '11']);

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

/** DAWA-opslag (retry). Returnerer enhedsadresse-UUID eller null. */
async function resolveEnhedsadresseId({ vejnavn, husnr, postnr, etage, doer }) {
  const params = new URLSearchParams({ vejnavn, husnr, postnr, struktur: 'mini' });
  if (etage) params.set('etage', etage);
  if (doer) params.set('dør', doer);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${DAWA}/adresser?${params}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) {
        if (res.status < 500) return null;
        throw new Error(`DAWA ${res.status}`);
      }
      const addrs = await res.json();
      if (!Array.isArray(addrs) || addrs.length === 0) return null;
      // Foretræk eksakt etage+dør-match; ellers første træffer.
      const exact = addrs.find(
        (a) =>
          (etage ? String(a.etage ?? '') === String(etage) : true) &&
          (doer ? String(a.dør ?? '') === String(doer) : true)
      );
      return (exact ?? addrs[0]).id ?? null;
    } catch (err) {
      if (attempt === 3) return null;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  return null;
}

/**
 * BBR_Enhed by enhedsadresse-UUID (retry). Returnerer { vaerelser, bygningId }
 * for netop den lejlighed — enh031AntalVaerelser + bygnings-UUID (til etager).
 */
async function fetchEnhedData(enhedsadresseId) {
  const vt = new Date().toISOString().replace('Z', '+01:00');
  const query = `query($vt: DafDateTime!, $id: String!) {
    BBR_Enhed(first: 50, virkningstid: $vt, where: { adresseIdentificerer: { eq: $id } }) {
      nodes { enh031AntalVaerelser bygning status }
    }
  }`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(BBR_V2, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { vt, id: enhedsadresseId } }),
        signal: AbortSignal.timeout(20000),
      });
      const json = await res.json();
      if (json.errors) {
        if (attempt === 3) return null;
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        continue;
      }
      const nodes = json.data?.BBR_Enhed?.nodes ?? [];
      let best = null;
      let bygningId = null;
      for (const n of nodes) {
        if (RETIRED_STATUS.has(String(n.status ?? ''))) continue;
        const v = Number(n.enh031AntalVaerelser ?? 0);
        if (v > 0 && (best === null || v > best)) best = v;
        if (!bygningId && n.bygning && UUID_RE.test(n.bygning)) bygningId = n.bygning;
      }
      return { vaerelser: best, bygningId };
    } catch (err) {
      if (attempt === 3) return null;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  return null;
}

/**
 * BBR_Bygning.byg054AntalEtager pr. bygnings-UUID (batch, retry).
 * Returnerer Map bygningId → antal_etager. Bruges til ejerlejlighedens
 * antal_etager (= bygningens etager, samme konvention som eksisterende kolonne).
 */
async function fetchEtagerForBygninger(bygningIds) {
  const vt = new Date().toISOString().replace('Z', '+01:00');
  const out = new Map();
  const CHUNK = 100; // DAF-GQL-0016: 'in'-lister maks 100 elementer
  for (let i = 0; i < bygningIds.length; i += CHUNK) {
    const chunk = bygningIds.slice(i, i + CHUNK);
    const query = `query($vt: DafDateTime!, $ids: [String!]) {
      BBR_Bygning(first: 500, virkningstid: $vt, where: { id_lokalId: { in: $ids } }) {
        nodes { id_lokalId byg054AntalEtager status }
      }
    }`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(BBR_V2, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables: { vt, ids: chunk } }),
          signal: AbortSignal.timeout(25000),
        });
        const json = await res.json();
        if (json.errors) {
          if (attempt === 3) break;
          await new Promise((r) => setTimeout(r, 1500 * attempt));
          continue;
        }
        for (const n of json.data?.BBR_Bygning?.nodes ?? []) {
          if (RETIRED_STATUS.has(String(n.status ?? ''))) continue;
          const e = Number(n.byg054AntalEtager ?? 0);
          if (e > 0 && n.id_lokalId) {
            const cur = out.get(n.id_lokalId);
            if (cur == null || e > cur) out.set(n.id_lokalId, e);
          }
        }
        break;
      } catch (err) {
        if (attempt === 3) break;
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse "Vejnavn 32B" → { vejnavn, husnr }. */
function parseAddr(adresse) {
  const m = String(adresse ?? '')
    .split(',')[0]
    .trim()
    .match(/^(.+?)\s+(\d+\w*)$/);
  if (!m) return null;
  return { vejnavn: m[1], husnr: m[2] };
}

// ── 1) Kandidater: etageboliger m/ handel + NULL antal_vaerelser ──
const postnrFilter = postnrArg ? `AND a.postnr = '${String(postnrArg).padStart(4, '0')}'` : '';
const candidates = await runSql(`
  SELECT DISTINCT b.bfe_nummer, a.adresse, a.etage, a.doer, a.postnr
  FROM bbr_ejendom_status b
  JOIN v_ejerskifte_handel h
    ON h.bfe_nummer = b.bfe_nummer AND h.samlet_koebesum > 0 AND h.overtagelsesdato IS NOT NULL
  JOIN bfe_adresse_cache a ON a.bfe_nummer = b.bfe_nummer
  WHERE b.antal_vaerelser IS NULL
    AND b.byg021_anvendelse = 140
    AND a.etage IS NOT NULL
    AND a.adresse IS NOT NULL
    ${postnrFilter}
  ORDER BY b.bfe_nummer
  LIMIT ${limit};
`);
console.log(
  `[${envTarget}] ${candidates.length} kandidat-BFE'er (etagebolig, NULL antal_vaerelser, har handel${postnrArg ? `, postnr ${postnrArg}` : ''})`
);
if (candidates.length === 0) process.exit(0);

// ── 2) Resolve værelser + bygnings-UUID pr. BFE (concurrency-pool) ──
const resolvedRows = []; // { bfe, vaerelser, bygningId }
let processed = 0;
let idx = 0;
async function worker() {
  while (idx < candidates.length) {
    const c = candidates[idx++];
    const parsed = parseAddr(c.adresse);
    processed++;
    if (parsed && c.postnr) {
      const enhedsadresseId = await resolveEnhedsadresseId({
        vejnavn: parsed.vejnavn,
        husnr: parsed.husnr,
        postnr: String(c.postnr),
        etage: c.etage,
        doer: c.doer,
      });
      if (enhedsadresseId) {
        const data = await fetchEnhedData(enhedsadresseId);
        if (data && data.vaerelser != null && data.vaerelser > 0) {
          resolvedRows.push({
            bfe: Number(c.bfe_nummer),
            vaerelser: data.vaerelser,
            bygningId: data.bygningId,
          });
        }
      }
    }
    if (processed % 250 === 0) {
      console.log(
        `  behandlet ${processed}/${candidates.length}, løst værelser: ${resolvedRows.length}`
      );
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, () => worker()));
console.log(`Løste antal_vaerelser for ${resolvedRows.length}/${candidates.length} BFE'er.`);

// ── 3) Resolve antal_etager (byg054) for de involverede bygninger ──
const uniqueBygninger = [...new Set(resolvedRows.map((r) => r.bygningId).filter(Boolean))];
console.log(`Henter byg054AntalEtager for ${uniqueBygninger.length} bygninger …`);
const etagerByByg = await fetchEtagerForBygninger(uniqueBygninger);

const updates = resolvedRows.map((r) => ({
  bfe: r.bfe,
  vaerelser: r.vaerelser,
  etager: r.bygningId ? (etagerByByg.get(r.bygningId) ?? null) : null,
}));
const medEtager = updates.filter((u) => u.etager != null).length;
console.log(`Heraf ${medEtager} med antal_etager.`);

if (dryRun) {
  console.log('DRY-RUN — ingen skrivning. Eksempel:', updates.slice(0, 10));
  process.exit(0);
}

// ── 4) Skriv i batches via VALUES-join ──
const WRITE_BATCH = 500;
let written = 0;
for (let i = 0; i < updates.length; i += WRITE_BATCH) {
  const batch = updates.slice(i, i + WRITE_BATCH);
  const values = batch
    .map((u) => `(${u.bfe}, ${u.vaerelser}, ${u.etager === null ? 'NULL' : u.etager})`)
    .join(',');
  await runSql(`
    UPDATE bbr_ejendom_status b
    SET antal_vaerelser = v.vaerelser,
        antal_etager = COALESCE(b.antal_etager, v.etager)
    FROM (VALUES ${values}) AS v(bfe, vaerelser, etager)
    WHERE b.bfe_nummer = v.bfe AND b.antal_vaerelser IS NULL;
  `);
  written += batch.length;
  console.log(`  skrev ${written}/${updates.length}`);
}

// ── 4) Refresh MV ──
if (!noRefresh) {
  console.log('Refresher mv_boligpris_handler …');
  await runSql('REFRESH MATERIALIZED VIEW public.mv_boligpris_handler;');
}
console.log('Færdig.');
