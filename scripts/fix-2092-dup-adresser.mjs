#!/usr/bin/env node
/**
 * BIZZ-2092: Re-resolve bfe_adresse_cache rows where multiple BFE'er deler
 * samme dawa_id (kilde='cache_dar' korruption fra backfill 2026-05-20).
 *
 * Per BFE: DAWA /jordstykker?bfenummer={bfe} → /adgangsadresser?ejerlavkode=&matrikelnr=
 *   - Adgangsadresse fundet → opdater række med korrekt pr-BFE adresse (kilde='fix_2092_jordstykke')
 *   - Jordstykke uden adgangsadresser (ubebygget grund) → adresse = "matrikelnr ejerlavnavn",
 *     dawa_id=NULL, kilde='fix_2092_grund' (postnr bevares)
 *   - Intet jordstykke (fx ejerlejlighed) → række springes over
 *
 * Usage:
 *   node scripts/fix-2092-dup-adresser.mjs --env=prod [--bfes=1,2,3] [--limit=N] [--dry-run]
 */
import https from 'node:https';
import { config } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, '..', '.env.local') });

const args = process.argv.slice(2);
const TARGET_ENV = args.find((x) => x.startsWith('--env='))?.split('=')[1] || 'prod';
const BFES = args.find((x) => x.startsWith('--bfes='))?.split('=')[1]?.split(',').map(Number) ?? null;
const LIMIT = parseInt(args.find((x) => x.startsWith('--limit='))?.split('=')[1] ?? '0', 10);
const DRY = args.includes('--dry-run');

const ENV_REFS = { dev: 'wkzwxfhyfmvglrqtmebw', preview: 'rlkjmqjxmkxuclehbrnl', prod: 'xsyldjqcntiygrtfcszm' };
const PROJECT_REF = ENV_REFS[TARGET_ENV];
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const DAWA = 'https://api.dataforsyningen.dk';
const CONCURRENCY = 10;

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
 * Resolve one BFE per-matrikel. Returns:
 *  {kind:'adresse', ...fields} | {kind:'grund', betegnelse} | null (skip)
 */
async function resolveBfe(bfe) {
  const jord = await dawaJson(`${DAWA}/jordstykker?bfenummer=${bfe}&format=json`);
  if (!Array.isArray(jord) || jord.length === 0) return null;
  const j = jord[0];
  const ejerlavKode = j?.ejerlav?.kode;
  const matrikelnr = j?.matrikelnr;
  const ejerlavNavn = j?.ejerlav?.navn;
  if (!ejerlavKode || !matrikelnr) return null;

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
  // Ubebygget grund — gem matrikelbetegnelse i stedet for nabo-adresse
  return { kind: 'grund', betegnelse: `${matrikelnr} ${ejerlavNavn ?? ''}`.trim() };
}

async function main() {
  console.log(`[fix-2092] env=${TARGET_ENV} dry=${DRY} bfes=${BFES ? BFES.length : 'ALL-DUP'} limit=${LIMIT || '∞'}`);

  let rows;
  if (BFES) {
    rows = await runSql(`SELECT bfe_nummer, adresse, dawa_id FROM bfe_adresse_cache WHERE bfe_nummer IN (${BFES.join(',')})`);
  } else {
    rows = await runSql(`
      SELECT b.bfe_nummer, b.adresse, b.dawa_id
      FROM bfe_adresse_cache b
      WHERE b.kilde = 'cache_dar' AND b.dawa_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM bfe_adresse_cache b2
          WHERE b2.dawa_id = b.dawa_id AND b2.bfe_nummer <> b.bfe_nummer AND b2.kilde = 'cache_dar'
        )
      ORDER BY b.bfe_nummer ${LIMIT ? `LIMIT ${LIMIT}` : ''}`);
  }
  if (!Array.isArray(rows)) { console.error('SQL fejl:', JSON.stringify(rows)); process.exit(1); }
  console.log(`[fix-2092] ${rows.length} rækker at re-resolve`);

  let fixedAdr = 0, fixedGrund = 0, skipped = 0, unchanged = 0, errors = 0, processed = 0;
  const updates = [];

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const chunk = rows.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(chunk.map(async (r) => ({ row: r, res: await resolveBfe(r.bfe_nummer) })));
    for (const p of results) {
      processed++;
      if (p.status === 'rejected') { errors++; continue; }
      const { row, res } = p.value;
      if (!res) { skipped++; continue; }
      if (res.kind === 'adresse') {
        if (res.adresse === row.adresse && res.dawa_id === row.dawa_id) { unchanged++; continue; }
        updates.push(
          `UPDATE bfe_adresse_cache SET adresse=${esc(res.adresse)}, postnr=${esc(res.postnr)}, postnrnavn=${esc(res.postnrnavn)}, kommune_kode=${esc(res.kommune_kode)}, dawa_id=${esc(res.dawa_id)}, kilde='fix_2092_jordstykke', sidst_opdateret=now() WHERE bfe_nummer=${row.bfe_nummer}`
        );
        fixedAdr++;
        if (DRY) console.log(`  [DRY] ${row.bfe_nummer}: "${row.adresse}" → "${res.adresse}"`);
      } else {
        updates.push(
          `UPDATE bfe_adresse_cache SET adresse=${esc(res.betegnelse)}, dawa_id=NULL, kilde='fix_2092_grund', sidst_opdateret=now() WHERE bfe_nummer=${row.bfe_nummer}`
        );
        fixedGrund++;
        if (DRY) console.log(`  [DRY] ${row.bfe_nummer}: "${row.adresse}" → GRUND "${res.betegnelse}"`);
      }
    }

    // Flush updates i batches af 100 statements
    if (!DRY && updates.length >= 100) {
      const batch = updates.splice(0, updates.length);
      const r = await runSql(batch.join(';\n'));
      if (r?.message) { console.error(`  [WARN] update-batch fejl: ${r.message}`); errors += batch.length; }
    }
    if (processed % 500 === 0 || processed === rows.length) {
      console.log(`  [${processed}/${rows.length}] adresse=${fixedAdr} grund=${fixedGrund} uændret=${unchanged} skip=${skipped} fejl=${errors}`);
    }
  }

  if (!DRY && updates.length > 0) {
    const r = await runSql(updates.join(';\n'));
    if (r?.message) { console.error(`  [WARN] final update-batch fejl: ${r.message}`); errors += updates.length; }
  }

  console.log(`[fix-2092] DONE — adresse=${fixedAdr} grund=${fixedGrund} uændret=${unchanged} skip=${skipped} fejl=${errors}`);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
