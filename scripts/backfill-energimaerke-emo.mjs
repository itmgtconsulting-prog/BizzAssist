#!/usr/bin/env node
/**
 * BIZZ-1798: Backfill bbr_ejendom_status.energimaerke fra Energistyrelsens
 * EMOData-service.
 *
 * Problem (verificeret 2026-09-12 mod PROD): energimaerke er 100% NULL i alle
 * 2,56M rækker. EMO-integrationen i app/api/energimaerke/route.ts er kun on-demand
 * (UI-visning) — der er aldrig kørt en backfill. EMO-servicen ER reachable fra
 * Hetzner (HTTP 200, ~100ms) og har energimærke for ~83% af typede beboelses-BFE'er.
 *
 * Datakilde: GET https://emoweb.dk/EMOData/EMOData.svc/SearchEnergyLabelBFE/{bfe}
 *   HTTP Basic Auth via EMO_USERNAME / EMO_PASSWORD i .env.local.
 *   Svar: { EnergyLabels: [ { EnergyLabelClassification, LabelStatus,
 *          LabelStatusCode, ValidFrom (dd-mm-yyyy), ValidTo, ... } ], ResponseStatus }
 *
 * Berigelses-opskrift pr. BFE:
 *   1. Vælg GÆLDENDE label: LabelStatusCode === 1 (VALID). Hvis flere: nyeste
 *      ValidFrom. Hvis ingen VALID: nyeste label uanset status (så et udløbet
 *      mærke stadig giver en klasse).
 *   2. energimaerke      = EnergyLabelClassification (A2020/A2015/A/B/…/G)
 *   3. energimaerke_dato = ValidFrom (dd-mm-yyyy → date)
 *   4. energimaerke_data = det valgte label-objekt (jsonb) til detaljeret visning.
 *
 * Resumability: kun BFE'er med energimaerke IS NULL AND energimaerke_data IS NULL
 * behandles. BFE'er UDEN energimærke (RESULT_EMPTY) markeres med
 * energimaerke_data = {"emo_probed": true, "empty": true} (energimaerke forbliver
 * NULL) så de falder ud af kandidat-sættet og ikke re-probes ved genstart.
 *
 * Kun typede ejendomme (ejendomstype_norm IS NOT NULL) probes — utypede BFE'er
 * (jordstykker/tekniske) har aldrig et energimærke (jf. BIZZ-1800).
 *
 * Skriver via direkte Postgres (SUPABASE_<ENV>_DB_URL) — ikke Management API,
 * som throttler ved mange skrive-batches (lært i BIZZ-2173).
 *
 * Brug:
 *   node scripts/backfill-energimaerke-emo.mjs --env=prod [--limit=1000000] \
 *        [--concurrency=5] [--dry-run]
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import pg from 'pg';

// ── Args ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
const envTarget = args.find((a) => a.startsWith('--env='))?.split('=')[1] ?? 'test';
const limit = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '1000000', 10);
const concurrency = parseInt(args.find((a) => a.startsWith('--concurrency='))?.split('=')[1] ?? '5', 10);
const dryRun = args.includes('--dry-run');

// ── .env.local ─────────────────────────────────────────────────
const envContent = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
const env = {};
for (const line of envContent.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)/);
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
}

const PG_URL = env[`SUPABASE_${envTarget.toUpperCase()}_DB_URL`];
if (!PG_URL) throw new Error(`Mangler SUPABASE_${envTarget.toUpperCase()}_DB_URL i .env.local`);
if (!env.EMO_USERNAME || !env.EMO_PASSWORD) throw new Error('Mangler EMO_USERNAME/EMO_PASSWORD i .env.local');

const EMO_BASE = 'https://emoweb.dk/EMOData/EMOData.svc';
const EMO_AUTH = `Basic ${Buffer.from(`${env.EMO_USERNAME}:${env.EMO_PASSWORD}`).toString('base64')}`;
const EMO_TIMEOUT_MS = 20000;
const WRITE_BATCH = 500;

/**
 * Parser en EMO-dato "dd-mm-yyyy" til ISO "yyyy-mm-dd" (eller null).
 * @param s - Dato-streng fra EMO (fx "26-08-2022")
 * @returns ISO-dato eller null
 */
function parseEmoDate(s) {
  const m = typeof s === 'string' && s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/**
 * Henter og udvælger det gældende energimærke for én BFE fra EMO.
 * @param bfe - BFE-nummer
 * @returns {klasse, dato, data} ved fund, eller null hvis intet mærke findes
 */
async function fetchEmo(bfe) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${EMO_BASE}/SearchEnergyLabelBFE/${encodeURIComponent(bfe)}`, {
        headers: { Authorization: EMO_AUTH, Accept: 'application/json' },
        signal: AbortSignal.timeout(EMO_TIMEOUT_MS),
      });
      if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`EMO ${res.status}`), { transient: true });
      if (!res.ok) throw new Error(`EMO ${res.status}`);
      const json = await res.json();
      const labels = Array.isArray(json.EnergyLabels) ? json.EnergyLabels : [];
      if (labels.length === 0) return null; // RESULT_EMPTY → intet mærke
      // Foretræk VALID (LabelStatusCode===1); fald tilbage til nyeste ValidFrom.
      const byNewest = [...labels].sort((a, b) => {
        const da = parseEmoDate(a.ValidFrom) ?? '';
        const db = parseEmoDate(b.ValidFrom) ?? '';
        return db.localeCompare(da);
      });
      const chosen = byNewest.find((l) => Number(l.LabelStatusCode) === 1) ?? byNewest[0];
      const klasse = chosen.EnergyLabelClassification ? String(chosen.EnergyLabelClassification) : null;
      if (!klasse) return null;
      return { klasse, dato: parseEmoDate(chosen.ValidFrom), data: chosen };
    } catch (err) {
      if (!err.transient || attempt === 3) {
        if (err.transient) throw err; // lad kalderen tælle som fejl (ikke markér probed)
        // permanent fejl på denne BFE → behandl som "intet mærke" men ikke probed
        throw err;
      }
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

const pgClient = new pg.Client({ connectionString: PG_URL, statement_timeout: 120000 });
await pgClient.connect();

// ── 1) Kandidater: typede ejendomme uden energimærke, endnu ikke probet ──
const { rows: candidates } = await pgClient.query(`
  SELECT bfe_nummer
  FROM bbr_ejendom_status
  WHERE energimaerke IS NULL
    AND energimaerke_data IS NULL
    AND ejendomstype_norm IS NOT NULL
  ORDER BY bfe_nummer
  LIMIT $1
`, [limit]);
console.log(`[${envTarget}] ${candidates.length} kandidat-BFE'er (typede, energimaerke NULL, ikke probet)`);
if (candidates.length === 0) { await pgClient.end(); process.exit(0); }

// ── 2) Probe EMO med concurrency-pool, buffer resultater, skriv i batches ──
const emptyMarker = JSON.stringify({ emo_probed: true, empty: true });
let hits = 0, empties = 0, errors = 0, processed = 0;
let hitBuf = [];   // {bfe, klasse, dato, data}
let emptyBuf = []; // bfe

/** Flush hit-buffer: sæt energimaerke + dato + data for fundne mærker. */
async function flushHits() {
  if (hitBuf.length === 0) return;
  const batch = hitBuf; hitBuf = [];
  await pgClient.query(`
    UPDATE bbr_ejendom_status b
    SET energimaerke = v.klasse, energimaerke_dato = v.dato, energimaerke_data = v.data
    FROM (SELECT * FROM unnest($1::bigint[], $2::text[], $3::date[], $4::jsonb[])
          AS t(bfe, klasse, dato, data)) v
    WHERE b.bfe_nummer = v.bfe AND b.energimaerke IS NULL
  `, [
    batch.map((u) => u.bfe),
    batch.map((u) => u.klasse),
    batch.map((u) => u.dato),
    batch.map((u) => JSON.stringify(u.data)),
  ]);
}

/** Flush empty-buffer: markér BFE'er uden mærke som probet (energimaerke forbliver NULL). */
async function flushEmpties() {
  if (emptyBuf.length === 0) return;
  const batch = emptyBuf; emptyBuf = [];
  await pgClient.query(`
    UPDATE bbr_ejendom_status b
    SET energimaerke_data = $2::jsonb
    FROM unnest($1::bigint[]) AS t(bfe)
    WHERE b.bfe_nummer = t.bfe AND b.energimaerke IS NULL AND b.energimaerke_data IS NULL
  `, [batch, emptyMarker]);
}

/** Behandl ét EMO-resultat: buffer + flush ved fuld batch. */
async function handle(bfe) {
  try {
    const r = await fetchEmo(bfe);
    if (r) { hitBuf.push({ bfe, ...r }); hits++; }
    else { emptyBuf.push(bfe); empties++; }
  } catch {
    errors++; // transient/permanent fejl → markér IKKE probet, retry ved næste kørsel
  }
  processed++;
  if (!dryRun && hitBuf.length >= WRITE_BATCH) await flushHits();
  if (!dryRun && emptyBuf.length >= WRITE_BATCH) await flushEmpties();
  if (processed % 2000 === 0) {
    console.log(`  processed ${processed}/${candidates.length} — hits=${hits} empties=${empties} errors=${errors}`);
  }
}

if (dryRun) {
  const sample = candidates.slice(0, 10).map((c) => Number(c.bfe_nummer));
  for (const bfe of sample) {
    const r = await fetchEmo(bfe).catch(() => 'FEJL');
    console.log(bfe, '=>', r === null ? 'intet mærke' : r === 'FEJL' ? 'FEJL' : `${r.klasse} (${r.dato})`);
  }
  console.log('DRY-RUN — ingen skrivning.');
  await pgClient.end();
  process.exit(0);
}

// Simpel concurrency-pool
const queue = candidates.map((c) => Number(c.bfe_nummer));
let idx = 0;
async function worker() {
  while (idx < queue.length) {
    const bfe = queue[idx++];
    await handle(bfe);
  }
}
await Promise.all(Array.from({ length: concurrency }, () => worker()));

// Flush rester
await flushHits();
await flushEmpties();

console.log(`Færdig. processed=${processed} hits=${hits} empties=${empties} errors=${errors}`);
await pgClient.end();
