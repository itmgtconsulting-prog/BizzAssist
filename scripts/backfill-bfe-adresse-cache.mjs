#!/usr/bin/env node
/**
 * Backfill bfe_adresse_cache — finder BFE'er i ejf_ejerskab uden adresse
 * og prøver at resolve dem via DAWA /bfe + VP + DAWA datavask.
 *
 * BIZZ-1670: Løser problemet med ældre ejerlejligheder hvor DAWA /bfe
 * returnerer 404 men adressen eksisterer i andre kilder.
 *
 * Brug:
 *   node scripts/backfill-bfe-adresse-cache.mjs [--limit 500] [--dry-run]
 *
 * Kræver: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY i .env.local
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env.local
const envPath = resolve(process.cwd(), '.env.local');
const envContent = readFileSync(envPath, 'utf8');
const env = {};
for (const line of envContent.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.+)/);
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
}

const supabase = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY
);

const DAWA = 'https://api.dataforsyningen.dk';
const VP = 'https://api-fs.vurderingsportalen.dk/preliminaryproperties/_search';
const limit = parseInt(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '500');
const dryRun = process.argv.includes('--dry-run');

console.log(`Backfill bfe_adresse_cache — limit=${limit}, dryRun=${dryRun}`);

/**
 * Find BFE'er i ejf_ejerskab der ikke har match i bfe_adresse_cache.
 */
async function findMissingBfes() {
  const { data, error } = await supabase.rpc('exec_sql', {
    query: `
      SELECT DISTINCT e.bfe_nummer
      FROM ejf_ejerskab e
      LEFT JOIN bfe_adresse_cache c ON c.bfe_nummer = e.bfe_nummer
      WHERE e.status = 'gældende'
        AND c.bfe_nummer IS NULL
      ORDER BY e.bfe_nummer
      LIMIT ${limit}
    `,
  });

  // Fallback: direct query if RPC doesn't exist
  if (error) {
    const { data: bfes } = await supabase
      .from('ejf_ejerskab')
      .select('bfe_nummer')
      .eq('status', 'gældende')
      .limit(limit * 2);

    const { data: cached } = await supabase
      .from('bfe_adresse_cache')
      .select('bfe_nummer');

    const cachedSet = new Set((cached ?? []).map((r) => r.bfe_nummer));
    const unique = [...new Set((bfes ?? []).map((r) => r.bfe_nummer))].filter(
      (b) => !cachedSet.has(b)
    );
    return unique.slice(0, limit);
  }

  return (data ?? []).map((r) => r.bfe_nummer);
}

/**
 * Try to resolve BFE → address via DAWA /bfe endpoint.
 */
async function resolveDawa(bfe) {
  try {
    const res = await fetch(`${DAWA}/bfe/${bfe}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const bel = json.beliggenhedsadresse;
    if (!bel?.vejnavn) return null;
    return {
      adresse: `${bel.vejnavn} ${bel.husnr ?? ''}`.trim(),
      etage: bel.etage ?? null,
      doer: bel.dør ?? null,
      postnr: bel.postnr ?? null,
      postnrnavn: bel.postnrnavn ?? null,
      kommune: bel.kommunenavn ?? null,
      kommune_kode: bel.kommunekode ?? null,
      dawa_id: bel.id ?? null,
      ejendomstype: json.ejendomstype ?? null,
      kilde: 'dawa_bfe',
    };
  } catch {
    return null;
  }
}

/**
 * Try VP Elasticsearch BFE term query.
 */
async function resolveVP(bfe) {
  try {
    const res = await fetch(VP, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: JSON.stringify({
        query: { term: { bfeNumbers: bfe } },
        size: 1,
        _source: ['address', 'roadName', 'houseNumber', 'zipcode', 'postDistrict', 'floor', 'door', 'adgangsAdresseID'],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const src = data.hits?.hits?.[0]?._source;
    if (!src?.address) return null;
    const adresse = src.roadName && src.houseNumber
      ? `${src.roadName} ${src.houseNumber}`.trim()
      : src.address.split(',')[0]?.trim();
    return {
      adresse,
      etage: src.floor ?? null,
      doer: src.door ?? null,
      postnr: src.zipcode ?? null,
      postnrnavn: src.postDistrict ?? null,
      kommune: null,
      kommune_kode: null,
      dawa_id: src.adgangsAdresseID ?? null,
      ejendomstype: null,
      kilde: 'vp',
    };
  } catch {
    return null;
  }
}

async function main() {
  const missing = await findMissingBfes();
  console.log(`Found ${missing.length} BFEs without cached address`);

  let resolved = 0;
  let failed = 0;
  const BATCH = 5;

  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (bfe) => {
        // Try DAWA first, then VP
        let result = await resolveDawa(bfe);
        if (!result) result = await resolveVP(bfe);
        return { bfe, result };
      })
    );

    for (const { bfe, result } of results) {
      if (result && !dryRun) {
        const { error } = await supabase.from('bfe_adresse_cache').upsert(
          {
            bfe_nummer: bfe,
            ...result,
            sidst_opdateret: new Date().toISOString(),
          },
          { onConflict: 'bfe_nummer' }
        );
        if (error) {
          console.error(`  BFE ${bfe}: upsert error — ${error.message}`);
          failed++;
        } else {
          console.log(`  BFE ${bfe}: ${result.adresse}, ${result.postnr} (${result.kilde})`);
          resolved++;
        }
      } else if (result && dryRun) {
        console.log(`  [DRY] BFE ${bfe}: ${result.adresse}, ${result.postnr} (${result.kilde})`);
        resolved++;
      } else {
        failed++;
      }
    }

    // Rate limit — 100ms between batches
    if (i + BATCH < missing.length) await new Promise((r) => setTimeout(r, 100));
  }

  console.log(`\nDone: ${resolved} resolved, ${failed} unresolvable`);
}

main().catch(console.error);
