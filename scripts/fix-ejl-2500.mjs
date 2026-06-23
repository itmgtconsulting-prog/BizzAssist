#!/usr/bin/env node
/**
 * Quick fix for postnr 2500 ejerlejligheder — resolves enhedsadresse and
 * fills antal_vaerelser/antal_etager from the correct BBR_Enhed.
 *
 * Pipeline per BFE:
 *   1. bfe_adresse_cache.dawa_id (adgangsadresse) → DAWA enhedsadresser
 *   2. Each enhedsadresse → BBR_Enhed(adresseIdentificerer) → vaerelser, areal
 *   3. Match: if 1 enhedsadresse → guaranteed. If N: match by areal.
 *   4. Update bfe_adresse_cache (dawa_id, etage, doer) + bbr_ejendom_status (vaerelser, etager)
 *
 * Usage: node scripts/fix-ejl-2500.mjs [--dry-run]
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const dryRun = process.argv.includes('--dry-run');
const envContent = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
const env = {};
for (const line of envContent.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)/);
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
}

const REF = 'xsyldjqcntiygrtfcszm'; // prod
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

// ── Main ───────────────────────────────────────────────────────
console.log(`Fix ejl 2500 — dryRun=${dryRun}`);

const kandidater = await runSql(`
  SELECT c.bfe_nummer, c.dawa_id, b.samlet_boligareal
  FROM bfe_adresse_cache c
  JOIN bbr_ejendom_status b ON b.bfe_nummer = c.bfe_nummer
  WHERE b.byg021_anvendelse = 140
    AND c.postnr = '2500'
    AND c.dawa_id IS NOT NULL
    AND b.antal_vaerelser IS NULL
`);
console.log(`Kandidater: ${kandidater.length}`);

const vt = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
let fixed = 0, oneToOne = 0, arealMatch = 0, skipped = 0, errors = 0;

for (let i = 0; i < kandidater.length; i++) {
  const row = kandidater[i];
  try {
    // 1. Get enhedsadresser from DAWA
    const dawaRes = await fetch(
      `https://api.dataforsyningen.dk/adresser?adgangsadresseid=${row.dawa_id}&struktur=mini`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!dawaRes.ok) { skipped++; continue; }
    const enhAddr = await dawaRes.json();
    if (!enhAddr?.length) { skipped++; continue; }

    // 2. Get BBR_Enhed for each enhedsadresse
    const ids = enhAddr.map(a => a.id);
    const enhData = await gql(
      `{ BBR_Enhed(first: 200, virkningstid: "${vt}", where: { adresseIdentificerer: { in: [${ids.map(id => `"${id}"`).join(',')}] } }) { nodes { adresseIdentificerer enh026EnhedensSamledeAreal enh031AntalVaerelser status bygning } } }`
    );

    // Deduplicate (BBR v2 returns dupes) and filter retired
    const seenEnh = new Map();
    for (const n of enhData?.BBR_Enhed?.nodes ?? []) {
      if (RETIRED.has(Number(n.status))) continue;
      if (n.adresseIdentificerer && !seenEnh.has(n.adresseIdentificerer)) {
        seenEnh.set(n.adresseIdentificerer, n);
      }
    }

    let bestAddr = null;
    let bestEnhed = null;

    if (seenEnh.size === 1) {
      // 1:1 match
      const [addrId, enh] = [...seenEnh.entries()][0];
      bestAddr = enhAddr.find(a => a.id === addrId);
      bestEnhed = enh;
      oneToOne++;
    } else if (seenEnh.size > 1 && Number(row.samlet_boligareal) > 0 && Number(row.samlet_boligareal) <= 300) {
      // Areal match: find enhed closest to our known areal
      const targetAreal = Number(row.samlet_boligareal);
      let bestDiff = Infinity;
      for (const [addrId, enh] of seenEnh) {
        const enhAreal = Number(enh.enh026EnhedensSamledeAreal) || 0;
        if (enhAreal === 0) continue;
        const diff = Math.abs(enhAreal - targetAreal);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestAddr = enhAddr.find(a => a.id === addrId);
          bestEnhed = enh;
        }
      }
      // Only accept if within 20% or 15m²
      if (bestDiff > Math.max(targetAreal * 0.2, 15)) {
        bestAddr = null;
        bestEnhed = null;
      } else {
        arealMatch++;
      }
    }

    if (bestAddr && bestEnhed) {
      const vaerelser = Number(bestEnhed.enh031AntalVaerelser) || 0;
      const areal = Number(bestEnhed.enh026EnhedensSamledeAreal) || 0;
      const bygId = bestEnhed.bygning;

      // Get parent bygning for etager
      let etager = 0;
      if (bygId) {
        const bygData = await gql(
          `{ BBR_Bygning(first: 1, virkningstid: "${vt}", where: { id_lokalId: { eq: "${bygId}" } }) { nodes { byg054AntalEtager } } }`
        );
        etager = Number(bygData?.BBR_Bygning?.nodes?.[0]?.byg054AntalEtager) || 0;
      }

      if (!dryRun) {
        // Update bfe_adresse_cache with correct enhedsadresse
        await runSql(`
          UPDATE bfe_adresse_cache
          SET dawa_id = '${bestAddr.id}',
              etage = ${bestAddr.etage ? `'${bestAddr.etage}'` : 'NULL'},
              doer = ${bestAddr.dør ? `'${bestAddr.dør}'` : 'NULL'}
          WHERE bfe_nummer = ${row.bfe_nummer}
        `);

        // Update bbr_ejendom_status with correct unit-level data
        await runSql(`
          UPDATE bbr_ejendom_status
          SET antal_vaerelser = ${vaerelser || 'NULL'},
              antal_etager = ${etager || 'NULL'},
              samlet_boligareal = COALESCE(
                CASE WHEN samlet_boligareal > 300 THEN NULL ELSE samlet_boligareal END,
                ${areal || 'NULL'}
              )
          WHERE bfe_nummer = ${row.bfe_nummer}
        `);
      }
      fixed++;
    } else {
      skipped++;
    }
  } catch (err) {
    errors++;
    if (errors <= 5) console.error(`  BFE ${row.bfe_nummer}: ${err.message.slice(0, 100)}`);
  }

  if ((i + 1) % 50 === 0 || i === kandidater.length - 1) {
    console.log(`  [${i + 1}/${kandidater.length}] fixed=${fixed} (1:1=${oneToOne} areal=${arealMatch}) skipped=${skipped} errors=${errors}`);
  }
  await sleep(100); // Rate limit DAWA + BBR
}

console.log(`\nDone: ${fixed} fixed (${oneToOne} 1:1, ${arealMatch} areal-match), ${skipped} skipped, ${errors} errors`);
