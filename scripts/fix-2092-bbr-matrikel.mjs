#!/usr/bin/env node
/**
 * BIZZ-2092 (runde 2): Re-resolve bfe_adresse_cache-rækker hvor kilde=
 * 'bbr_beliggenhed' / 'cron_bbr_beliggenhed' har skrevet en SFE-gruppes DELTE
 * hovedadresse til flere BFE'er på FORSKELLIGE matrikler (konflikt med BIZZ-2159).
 *
 * Eksempel (BELVEDERE, CVR 24301117): BFE 5322350/5322351/5322352/5322356 fik
 * alle "Gefionsvej 47A" (adgangsadresse på matr 65bp) selvom 5322350=65bi,
 * 5322351=65bk, 5322352=65bl. Kun 5322356 (matr 65bp) hører reelt til adressen.
 *
 * Logik pr. BFE (spejler app/lib/bfeAdresse.ts#resolveLive efter fixet):
 *   1. jordstykke(bfe) → BFE'ens egen matr + ejerlavkode. Intet jordstykke →
 *      skip (ejerlejlighed; VP-adressen røres ikke).
 *   2. Slå rækkens nuværende dawa_id (BBR-beliggenhedsadressen) op i fuld
 *      struktur → adressens eget jordstykke-matr + ejerlavkode.
 *   3. Matcher de BFE'ens egen matr → behold (legitim BIZZ-2159, fx 5322356).
 *   4. Ellers re-resolve pr. BFE via jordstykke→adgangsadresser:
 *        - adgangsadresse fundet → adresse (kilde='fix_2092_jordstykke')
 *        - ubebygget grund → matrikelbetegnelse, dawa_id=NULL (kilde='fix_2092_grund')
 *
 * Usage:
 *   node scripts/fix-2092-bbr-matrikel.mjs --env=preview [--bfes=1,2,3] [--limit=N] [--dry-run]
 */
import https from 'node:https';
import { config } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, '..', '.env.local') });

const args = process.argv.slice(2);
const TARGET_ENV = args.find((x) => x.startsWith('--env='))?.split('=')[1] || 'preview';
const BFES = args.find((x) => x.startsWith('--bfes='))?.split('=')[1]?.split(',').map(Number) ?? null;
const LIMIT = parseInt(args.find((x) => x.startsWith('--limit='))?.split('=')[1] ?? '0', 10);
const DRY = args.includes('--dry-run');

const ENV_REFS = { dev: 'wkzwxfhyfmvglrqtmebw', preview: 'rlkjmqjxmkxuclehbrnl', prod: 'xsyldjqcntiygrtfcszm' };
const PROJECT_REF = ENV_REFS[TARGET_ENV];
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const DAWA = 'https://api.dataforsyningen.dk';
const CONCURRENCY = 8;

/** Run SQL via Supabase Management API with retry on throttling/timeout. */
async function runSql(sql, retries = 5) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await new Promise((resolve) => {
      const body = JSON.stringify({ query: sql });
      const timer = setTimeout(() => { req.destroy(); resolve({ message: 'timeout' }); }, 60000);
      const req = https.request(
        { hostname: 'api.supabase.com', path: `/v1/projects/${PROJECT_REF}/database/query`, method: 'POST', headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' } },
        (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(d)); } catch { resolve(d); } }); }
      );
      req.on('error', (e) => { clearTimeout(timer); resolve({ message: e.code || e.message }); });
      req.write(body); req.end();
    });
    if (r?.message && /timeout|ECONNRESET|Throttler|rate/i.test(r.message) && attempt < retries) {
      await new Promise((res) => setTimeout(res, 5000 * (attempt + 1)));
      continue;
    }
    return r;
  }
  return { message: 'max retries' };
}

function esc(s) { return s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`; }

/** Fetch JSON from DAWA with timeout; null on any failure. */
async function dawaJson(u) {
  try {
    const res = await fetch(u, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/**
 * Re-resolve én poisoned bbr_beliggenhed-række. Returnerer:
 *  {kind:'keep'} | {kind:'adresse', ...} | {kind:'grund', betegnelse} | null (skip)
 */
async function resolveBfe(bfe, currentDawaId) {
  const jord = await dawaJson(`${DAWA}/jordstykker?bfenummer=${bfe}&format=json`);
  if (!Array.isArray(jord) || jord.length === 0) return null; // ejerlejlighed → skip
  const j = jord[0];
  const ejerlavKode = j?.ejerlav?.kode;
  const matrikelnr = j?.matrikelnr;
  const ejerlavNavn = j?.ejerlav?.navn;
  if (!ejerlavKode || !matrikelnr) return null;

  // Ligger den nuværende BBR-adresse på BFE'ens egen matrikel? → behold (legitim).
  if (currentDawaId) {
    const cur = await dawaJson(`${DAWA}/adgangsadresser/${encodeURIComponent(currentDawaId)}`);
    const curMatr = cur?.jordstykke?.matrikelnr;
    const curEjerlav = cur?.jordstykke?.ejerlav?.kode;
    if (curMatr === matrikelnr && curEjerlav === ejerlavKode) return { kind: 'keep' };
  }

  // Ellers re-resolve pr. BFE via jordstykke.
  const adr = await dawaJson(
    `${DAWA}/adgangsadresser?ejerlavkode=${ejerlavKode}&matrikelnr=${encodeURIComponent(matrikelnr)}&format=json&struktur=mini&per_side=1`
  );
  const a = Array.isArray(adr) ? adr[0] : null;
  if (a?.vejnavn && a?.postnr) {
    return {
      kind: 'adresse',
      adresse: [a.vejnavn, a.husnr].filter(Boolean).join(' '),
      postnr: String(a.postnr),
      postnrnavn: a.postnrnavn ?? null,
      kommune_kode: a.kommunekode ?? null,
      dawa_id: a.id ?? null,
    };
  }
  return { kind: 'grund', betegnelse: `${matrikelnr} ${ejerlavNavn ?? ''}`.trim() };
}

async function main() {
  console.log(`[fix-2092-bbr] env=${TARGET_ENV} dry=${DRY} bfes=${BFES ? BFES.length : 'ALL-DUP'} limit=${LIMIT || '∞'}`);

  let rows;
  if (BFES) {
    rows = await runSql(`SELECT bfe_nummer, adresse, dawa_id FROM bfe_adresse_cache WHERE bfe_nummer IN (${BFES.join(',')})`);
  } else {
    // bbr_beliggenhed-rækker hvor 2+ BFE'er deler samme dawa_id (delt SFE-hovedadresse).
    rows = await runSql(`
      SELECT b.bfe_nummer, b.adresse, b.dawa_id
      FROM bfe_adresse_cache b
      WHERE b.kilde IN ('bbr_beliggenhed','cron_bbr_beliggenhed') AND b.dawa_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM bfe_adresse_cache b2
          WHERE b2.dawa_id = b.dawa_id AND b2.bfe_nummer <> b.bfe_nummer
            AND b2.kilde IN ('bbr_beliggenhed','cron_bbr_beliggenhed')
        )
      ORDER BY b.bfe_nummer ${LIMIT ? `LIMIT ${LIMIT}` : ''}`);
  }
  if (!Array.isArray(rows)) { console.error('SQL fejl:', JSON.stringify(rows)); process.exit(1); }
  console.log(`[fix-2092-bbr] ${rows.length} rækker at undersøge`);

  let fixedAdr = 0, fixedGrund = 0, kept = 0, skipped = 0, errors = 0, processed = 0;
  const updates = [];

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const chunk = rows.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(chunk.map(async (r) => ({ row: r, res: await resolveBfe(r.bfe_nummer, r.dawa_id) })));
    for (const p of results) {
      processed++;
      if (p.status === 'rejected') { errors++; continue; }
      const { row, res } = p.value;
      if (!res) { skipped++; continue; }
      if (res.kind === 'keep') { kept++; continue; }
      if (res.kind === 'adresse') {
        updates.push(
          `UPDATE bfe_adresse_cache SET adresse=${esc(res.adresse)}, postnr=${esc(res.postnr)}, postnrnavn=${esc(res.postnrnavn)}, kommune_kode=${esc(res.kommune_kode)}, dawa_id=${esc(res.dawa_id)}, kilde='fix_2092_jordstykke', sidst_opdateret=now() WHERE bfe_nummer=${row.bfe_nummer}`
        );
        fixedAdr++;
        if (DRY) console.log(`  [DRY] ${row.bfe_nummer}: "${row.adresse}" → "${res.adresse}"`);
      } else {
        updates.push(
          `UPDATE bfe_adresse_cache SET adresse=${esc(res.betegnelse)}, postnr=NULL, postnrnavn=NULL, dawa_id=NULL, kilde='fix_2092_grund', sidst_opdateret=now() WHERE bfe_nummer=${row.bfe_nummer}`
        );
        fixedGrund++;
        if (DRY) console.log(`  [DRY] ${row.bfe_nummer}: "${row.adresse}" → GRUND "${res.betegnelse}"`);
      }
    }
    if (!DRY && updates.length >= 100) {
      const batch = updates.splice(0, updates.length);
      const r = await runSql(batch.join(';\n'));
      if (r?.message) { console.error(`  [WARN] update-batch fejl: ${r.message}`); errors += batch.length; }
    }
    if (processed % 500 === 0 || processed === rows.length) {
      console.log(`  [${processed}/${rows.length}] adresse=${fixedAdr} grund=${fixedGrund} behold=${kept} skip=${skipped} fejl=${errors}`);
    }
  }

  if (!DRY && updates.length > 0) {
    const r = await runSql(updates.join(';\n'));
    if (r?.message) { console.error(`  [WARN] final update-batch fejl: ${r.message}`); errors += updates.length; }
  }

  console.log(`[fix-2092-bbr] DONE — adresse=${fixedAdr} grund=${fixedGrund} behold=${kept} skip=${skipped} fejl=${errors}`);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
