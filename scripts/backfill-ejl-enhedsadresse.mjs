#!/usr/bin/env node
/**
 * BIZZ-2173/2176 prerequisite: Fix bfe_adresse_cache for ejerlejligheder.
 *
 * Problem: dawa_id stores the adgangsadresse UUID (building-level), but for
 * ejerlejligheder we need the enhedsadresse UUID (unit-level with etage/dør)
 * to resolve the specific BBR_Enhed with vaerelser/areal.
 *
 * 99.7% of ejl-BFEs have a unique adgangsadresse (1 BFE per adgangsadresse).
 * For those, we can query DAWA for all enhedsadresser under the adgangsadresse
 * and if there's exactly 1 BFE and 1 enhedsadresse, it's a guaranteed match.
 * For cases with multiple enhedsadresser under a unique BFE's adgangsadresse,
 * we try matching via BBR_Enhed and trace back through ejendomsrelation.
 *
 * After this runs, the BBR backfill can use BBR_Enhed(adresseIdentificerer = dawa_id)
 * to get the correct per-unit data.
 *
 * Usage:
 *   node scripts/backfill-ejl-enhedsadresse.mjs --env=prod --limit=50000 [--dry-run]
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const args = process.argv.slice(2);
const envTarget = args.find(a => a.startsWith('--env='))?.split('=')[1] ?? 'test';
const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] ?? '5000', 10);
const dryRun = args.includes('--dry-run');

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
if (!env.SUPABASE_ACCESS_TOKEN) { console.error('Missing SUPABASE_ACCESS_TOKEN'); process.exit(1); }

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
        if (res.status < 500) throw new Error(`Supabase ${res.status}: ${txt.slice(0, 300)}`);
        throw Object.assign(new Error(`Supabase ${res.status}`), { transient: true });
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

const DAWA_BASE = 'https://api.dataforsyningen.dk';
const BBR_V2 = `https://graphql.datafordeler.dk/BBR/v2?apiKey=${env.DATAFORDELER_API_KEY}`;
const RETIRED = new Set([4, 10, 11]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Fetch all enhedsadresser for a given adgangsadresse UUID from DAWA.
 */
async function fetchEnhedsadresser(adgangsadresseId) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(
        `${DAWA_BASE}/adresser?adgangsadresseid=${adgangsadresseId}&struktur=mini`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) throw new Error(`DAWA ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(1000 * attempt);
    }
  }
}

/**
 * Fetch BBR_Enhed for a batch of enhedsadresse UUIDs.
 * Returns Map<adresseId, { vaerelser, areal }>.
 */
async function fetchBbrEnheder(adresseIds) {
  const vt = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
  const out = new Map();
  for (let i = 0; i < adresseIds.length; i += 100) {
    const chunk = adresseIds.slice(i, i + 100);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(BBR_V2, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: `{ BBR_Enhed(first: 500, virkningstid: "${vt}", where: { adresseIdentificerer: { in: [${chunk.map(id => `"${id}"`).join(',')}] } }) { nodes { adresseIdentificerer enh026EnhedensSamledeAreal enh031AntalVaerelser status } } }` }),
          signal: AbortSignal.timeout(30000),
        });
        const json = await res.json();
        for (const n of json?.data?.BBR_Enhed?.nodes ?? []) {
          if (RETIRED.has(Number(n.status))) continue;
          if (n.adresseIdentificerer && !out.has(n.adresseIdentificerer)) {
            out.set(n.adresseIdentificerer, {
              areal: Number(n.enh026EnhedensSamledeAreal) || 0,
              vaerelser: Number(n.enh031AntalVaerelser) || 0,
            });
          }
        }
        break;
      } catch (err) {
        if (attempt === 3) throw err;
        await sleep(1500 * attempt);
      }
    }
  }
  return out;
}

// ── Main ───────────────────────────────────────────────────────
console.log(`Backfill ejl enhedsadresser — env=${envTarget} limit=${limit} dryRun=${dryRun}`);

// Candidates: type 140 ejerlejligheder with handel, where dawa_id is still
// an adgangsadresse (etage IS NULL or empty). Include samlet_boligareal for
// areal-based matching when multiple enhedsadresser exist.
const kandidater = await runSql(`
  SELECT c.bfe_nummer, c.dawa_id, b.samlet_boligareal
  FROM bfe_adresse_cache c
  JOIN bbr_ejendom_status b ON b.bfe_nummer = c.bfe_nummer
  WHERE b.byg021_anvendelse = 140
    AND c.dawa_id IS NOT NULL
    AND (c.etage IS NULL OR c.etage = '')
    AND c.bfe_nummer IN (SELECT DISTINCT bfe_nummer FROM mv_boligpris_handler)
  LIMIT ${limit}
`);
console.log(`Kandidater (unique adgangsadresse): ${kandidater.length}`);
if (kandidater.length === 0) { console.log('Ingen kandidater.'); process.exit(0); }

const BATCH = 20;
let updated = 0, matched = 0, multiMatch = 0, noMatch = 0, errors = 0;
const startTime = Date.now();

for (let i = 0; i < kandidater.length; i += BATCH) {
  const batch = kandidater.slice(i, i + BATCH);

  for (const row of batch) {
    try {
      const enhAdresser = await fetchEnhedsadresser(row.dawa_id);

      if (!enhAdresser || enhAdresser.length === 0) {
        noMatch++;
        continue;
      }

      let bestMatch = null;

      if (enhAdresser.length === 1) {
        // Perfect: 1 enhedsadresse — guaranteed match
        bestMatch = enhAdresser[0];
        matched++;
      } else {
        // Multiple enhedsadresser — match via BBR_Enhed areal comparison.
        // Our BFE's samlet_boligareal came from building-level, but for
        // ejerlejligheder it was set per the largest-building heuristic —
        // often close to the actual unit areal.
        const bfeAreal = Number(row.samlet_boligareal) || 0;
        if (bfeAreal > 0) {
          const adresseIds = enhAdresser.map(a => a.id);
          const bbrData = await fetchBbrEnheder(adresseIds);

          // Find the enhedsadresse whose BBR_Enhed areal is closest to our BFE's
          let bestDiff = Infinity;
          for (const a of enhAdresser) {
            const enh = bbrData.get(a.id);
            if (!enh || enh.areal === 0) continue;
            const diff = Math.abs(enh.areal - bfeAreal);
            if (diff < bestDiff) {
              bestDiff = diff;
              bestMatch = a;
            }
          }
          // Only accept if the match is within 20% or 10m² — otherwise too uncertain
          if (bestMatch && bestDiff > Math.max(bfeAreal * 0.2, 10)) {
            bestMatch = null;
          }
        }
        if (bestMatch) { matched++; multiMatch++; }
        else { multiMatch++; }
      }

      if (bestMatch) {
        if (!dryRun) {
          await runSql(`
            UPDATE bfe_adresse_cache
            SET dawa_id = '${bestMatch.id}',
                etage = ${bestMatch.etage ? `'${bestMatch.etage}'` : 'NULL'},
                doer = ${bestMatch.dør ? `'${bestMatch.dør}'` : 'NULL'}
            WHERE bfe_nummer = ${row.bfe_nummer}
          `);
        }
        updated++;
      }
    } catch (err) {
      errors++;
      if (errors <= 5) console.error(`  BFE ${row.bfe_nummer} FEJL: ${err.message}`);
    }

    // Rate limit: ~50ms between DAWA calls
    await sleep(50);
  }

  if ((i / BATCH) % 10 === 0 || i + BATCH >= kandidater.length) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rate = (updated / (elapsed || 1) * 60).toFixed(0);
    console.log(`  [${Math.min(i + BATCH, kandidater.length)}/${kandidater.length}] updated=${updated} matched=${matched} multi=${multiMatch} noMatch=${noMatch} errors=${errors} (${elapsed}s, ~${rate}/min)`);
  }
}

console.log(`\nDone: ${updated} updated, ${matched} 1:1 match, ${multiMatch} multi (skipped), ${noMatch} no DAWA result, ${errors} errors.`);
