#!/usr/bin/env node
/**
 * BIZZ-2173/2176: National ejerlejlighed backfill — antal_vaerelser + antal_etager.
 *
 * For each ejerlejlighed BFE (byg021=140):
 *   1. Get adgangsadresse from bfe_adresse_cache
 *   2. DAWA: get all enhedsadresser under that adgangsadresse
 *   3. BBR_Enhed(adresseIdentificerer in [...]) for batch of enhedsadresser
 *   4. Pick the enhed with vaerelser data (for 1-BFE addresses, any match is valid)
 *   5. Get parent bygning's etager
 *   6. Update bbr_ejendom_status + bfe_adresse_cache
 *
 * ~63k unique-address BFEs, ~95% BBR hit rate → ~60k fixable.
 *
 * Usage:
 *   node scripts/backfill-ejl-vaerelser-national.mjs --env=prod --limit=70000 [--dry-run]
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const args = process.argv.slice(2);
const envTarget = args.find(a => a.startsWith('--env='))?.split('=')[1] ?? 'test';
const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] ?? '70000', 10);
const dryRun = args.includes('--dry-run');

const envContent = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
const env = {};
for (const line of envContent.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)/);
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
}

const PROJECT_REFS = { prod: 'xsyldjqcntiygrtfcszm', test: 'rlkjmqjxmkxuclehbrnl', dev: 'wkzwxfhyfmvglrqtmebw' };
const REF = PROJECT_REFS[envTarget];
if (!REF) throw new Error(`Ukendt env: ${envTarget}`);
if (!env.SUPABASE_ACCESS_TOKEN) { console.error('Missing SUPABASE_ACCESS_TOKEN'); process.exit(1); }
if (!env.DATAFORDELER_API_KEY) { console.error('Missing DATAFORDELER_API_KEY'); process.exit(1); }

const BBR_V2 = `https://graphql.datafordeler.dk/BBR/v2?apiKey=${env.DATAFORDELER_API_KEY}`;
const RETIRED = new Set([4, 10, 11]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runSql(sql) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: sql }),
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) {
        const txt = await res.text();
        if (res.status < 500) throw new Error(`SQL ${res.status}: ${txt.slice(0, 200)}`);
        throw Object.assign(new Error(`SQL ${res.status}`), { transient: true });
      }
      const raw = await res.json();
      return Array.isArray(raw) ? raw : (raw.result ?? raw.rows ?? []);
    } catch (err) {
      if (!err.transient && err.name !== 'TimeoutError' || attempt === 4) throw err;
      await sleep(3000 * attempt);
    }
  }
}

async function gql(query) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(BBR_V2, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }), signal: AbortSignal.timeout(30000),
      });
      const json = await r.json();
      if (json.errors) throw new Error(`GQL: ${json.errors[0]?.message?.slice(0, 200)}`);
      return json.data;
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(1500 * attempt);
    }
  }
}

async function fetchDawaEnheder(adgangsadresseId) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(
        `https://api.dataforsyningen.dk/adresser?adgangsadresseid=${adgangsadresseId}&struktur=mini`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (!r.ok) throw new Error(`DAWA ${r.status}`);
      return await r.json();
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(1000 * attempt);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────
console.log(`BIZZ-2176 ejl national backfill — env=${envTarget} limit=${limit} dryRun=${dryRun}`);

const kandidater = await runSql(`
  SELECT c.bfe_nummer, c.dawa_id
  FROM bfe_adresse_cache c
  JOIN bbr_ejendom_status b ON b.bfe_nummer = c.bfe_nummer
  WHERE b.byg021_anvendelse = 140
    AND b.antal_vaerelser IS NULL
    AND c.dawa_id IS NOT NULL
  LIMIT ${limit}
`);
console.log(`Kandidater: ${kandidater.length}`);
if (kandidater.length === 0) { console.log('Done.'); process.exit(0); }

const vt = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
let fixed = 0, noDawa = 0, noBbr = 0, errors = 0;
const startTime = Date.now();

for (let i = 0; i < kandidater.length; i++) {
  const row = kandidater[i];
  try {
    // 1. Get enhedsadresser from DAWA
    const enhAddr = await fetchDawaEnheder(row.dawa_id);
    if (!enhAddr?.length) { noDawa++; continue; }

    // 2. Query BBR_Enhed for all enhedsadresser (max 100 per query)
    const ids = enhAddr.map(a => a.id).slice(0, 100);
    const enhData = await gql(
      `{ BBR_Enhed(first: 200, virkningstid: "${vt}", where: { adresseIdentificerer: { in: [${ids.map(id => `"${id}"`).join(',')}] } }) { nodes { adresseIdentificerer enh026EnhedensSamledeAreal enh031AntalVaerelser status bygning } } }`
    );

    // Deduplicate and find best match (enhed with vaerelser data)
    const seenEnh = new Map();
    for (const n of enhData?.BBR_Enhed?.nodes ?? []) {
      if (RETIRED.has(Number(n.status))) continue;
      if (n.adresseIdentificerer && !seenEnh.has(n.adresseIdentificerer)) {
        seenEnh.set(n.adresseIdentificerer, n);
      }
    }

    // Pick the enhed that has vaerelser data
    let bestEnhed = null;
    let bestAddr = null;
    for (const [addrId, enh] of seenEnh) {
      if (Number(enh.enh031AntalVaerelser) > 0) {
        bestEnhed = enh;
        bestAddr = enhAddr.find(a => a.id === addrId);
        break;
      }
    }
    // Fallback: pick any enhed with areal
    if (!bestEnhed) {
      for (const [addrId, enh] of seenEnh) {
        if (Number(enh.enh026EnhedensSamledeAreal) > 0) {
          bestEnhed = enh;
          bestAddr = enhAddr.find(a => a.id === addrId);
          break;
        }
      }
    }

    if (!bestEnhed) { noBbr++; continue; }

    const vaerelser = Number(bestEnhed.enh031AntalVaerelser) || null;
    const areal = Number(bestEnhed.enh026EnhedensSamledeAreal) || null;

    // 3. Get parent bygning for etager
    let etager = null;
    if (bestEnhed.bygning) {
      try {
        const bygData = await gql(
          `{ BBR_Bygning(first: 1, virkningstid: "${vt}", where: { id_lokalId: { eq: "${bestEnhed.bygning}" } }) { nodes { byg054AntalEtager } } }`
        );
        const e = Number(bygData?.BBR_Bygning?.nodes?.[0]?.byg054AntalEtager);
        if (e > 0) etager = e;
      } catch { /* non-fatal */ }
    }

    // 4. Update DB
    if (!dryRun) {
      // Update bbr_ejendom_status
      const sets = [];
      if (vaerelser) sets.push(`antal_vaerelser = ${vaerelser}`);
      if (etager) sets.push(`antal_etager = ${etager}`);
      if (areal && areal <= 500) sets.push(`samlet_boligareal = CASE WHEN samlet_boligareal IS NULL OR samlet_boligareal > 500 THEN ${areal} ELSE samlet_boligareal END`);
      if (sets.length > 0) {
        await runSql(`UPDATE bbr_ejendom_status SET ${sets.join(', ')} WHERE bfe_nummer = ${row.bfe_nummer}`);
      }

      // Update bfe_adresse_cache with enhedsadresse
      if (bestAddr) {
        await runSql(`
          UPDATE bfe_adresse_cache
          SET dawa_id = '${bestAddr.id}',
              etage = ${bestAddr.etage ? `'${bestAddr.etage}'` : 'NULL'},
              doer = ${bestAddr.dør ? `'${String(bestAddr.dør).replace(/'/g, "''")}'` : 'NULL'}
          WHERE bfe_nummer = ${row.bfe_nummer}
        `);
      }
    }
    fixed++;
  } catch (err) {
    errors++;
    if (errors <= 10) console.error(`  BFE ${row.bfe_nummer}: ${err.message.slice(0, 100)}`);
  }

  if ((i + 1) % 100 === 0 || i === kandidater.length - 1) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rate = (fixed / (elapsed || 1) * 60).toFixed(0);
    console.log(`  [${i + 1}/${kandidater.length}] fixed=${fixed} noDawa=${noDawa} noBbr=${noBbr} errors=${errors} (${elapsed}s, ~${rate}/min)`);
  }
  await sleep(80); // Rate limit DAWA + BBR
}

console.log(`\nDone: ${fixed} fixed, ${noDawa} no DAWA, ${noBbr} no BBR data, ${errors} errors`);
if (!dryRun && fixed > 0) {
  console.log('Refreshing mv_boligpris_handler...');
  await runSql("SELECT refresh_materialized_view('mv_boligpris_handler')");
  console.log('MV refreshed.');
}
