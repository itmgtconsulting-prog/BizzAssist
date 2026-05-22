#!/usr/bin/env node
/**
 * BIZZ-1566 Backfill 1: Populér dim_kommune fra DAWA kommuner-API.
 *
 * Henter alle 98 danske kommuner med navn, region, landsdel,
 * indbyggertal og areal fra Danmarks Adressers Web API.
 *
 * Usage:
 *   node scripts/backfill-dim-kommune.mjs [--env=prod|preview|dev] [--dry-run]
 *
 * Idempotent: UPSERT pr. kode.
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

config({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const TARGET_ENV = args.find((x) => x.startsWith('--env='))?.split('=')[1] || 'local';

const ENV_REFS = {
  local: 'wkzwxfhyfmvglrqtmebw',
  dev: 'wkzwxfhyfmvglrqtmebw',
  preview: 'rlkjmqjxmkxuclehbrnl',
  prod: 'xsyldjqcntiygrtfcszm',
};

/**
 * Resolve Supabase client for target env.
 *
 * @returns {Promise<import('@supabase/supabase-js').SupabaseClient>}
 */
async function resolveClient() {
  if (TARGET_ENV === 'local' || TARGET_ENV === 'dev') {
    return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  const ref = ENV_REFS[TARGET_ENV];
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!ref || !token) { console.error('Missing env ref or SUPABASE_ACCESS_TOKEN'); process.exit(1); }
  const keysRes = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const keys = await keysRes.json();
  const sk = keys.find((k) => k.name === 'service_role')?.api_key;
  if (!sk) { console.error('service_role key not found'); process.exit(1); }
  return createClient(`https://${ref}.supabase.co`, sk);
}

/**
 * Hent alle kommuner fra DAWA.
 *
 * @returns Array af kommune-objekter
 */
async function fetchKommuner() {
  const res = await fetch('https://api.dataforsyningen.dk/kommuner', {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`DAWA kommuner: ${res.status}`);
  return res.json();
}

/**
 * Map DAWA regionskode til regionsnavn.
 *
 * @param kode - Regionskode fx '1084'
 * @returns Regionsnavn
 */
function regionNavn(kode) {
  const map = {
    '1081': 'Nordjylland',
    '1082': 'Midtjylland',
    '1083': 'Syddanmark',
    '1084': 'Hovedstaden',
    '1085': 'Sjælland',
  };
  return map[kode] || null;
}

/**
 * Hent landsdel for en kommune fra DAWA.
 * DAWA's /landsdele endpoint har info om hvilke kommuner der hører til.
 *
 * @returns Map<kommunekode, landsdelNavn>
 */
async function fetchLandsdele() {
  const res = await fetch('https://api.dataforsyningen.dk/landsdele', {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return new Map();
  const data = await res.json();
  const map = new Map();
  for (const ld of data) {
    // Hent kommuner i denne landsdel
    const komRes = await fetch(
      `https://api.dataforsyningen.dk/kommuner?landsdel=${ld.nuts3}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!komRes.ok) continue;
    const kommuner = await komRes.json();
    for (const k of kommuner) {
      map.set(k.kode, ld.navn);
    }
  }
  return map;
}

/**
 * Hent indbyggertal fra Danmarks Statistik FOLK1A (seneste kvartal).
 * Fallback: returnér tom map.
 *
 * @returns Map<kommunekode, indbyggertal>
 */
async function fetchIndbyggertal() {
  try {
    const res = await fetch(
      'https://api.statbank.dk/v1/data/FOLK1A/JSONSTAT?valuePresentation=Value&delimiter=Tab&lang=da&Tid=*&OMRÅDE=*',
      { signal: AbortSignal.timeout(30000) }
    );
    if (!res.ok) return new Map();
    const data = await res.json();
    const map = new Map();
    // JSONStat format — extract latest period per kommune
    const dims = data.dataset?.dimension;
    const values = data.dataset?.value;
    if (!dims || !values) return map;

    const omraadeIdx = dims.OMRÅDE?.category?.index || {};
    const tidIdx = dims.Tid?.category?.index || {};
    const tidLabels = Object.keys(tidIdx);
    const latestTid = tidLabels[tidLabels.length - 1];
    const latestTidPos = tidIdx[latestTid];
    const omraadeSize = Object.keys(omraadeIdx).length;

    for (const [kode, pos] of Object.entries(omraadeIdx)) {
      // Only 3-4 digit kommune codes (not regions)
      if (kode.length > 4 || kode.length < 3) continue;
      const paddedKode = kode.padStart(4, '0');
      const valueIdx = pos + latestTidPos * omraadeSize;
      if (values[valueIdx] != null) {
        map.set(paddedKode, values[valueIdx]);
      }
    }
    return map;
  } catch {
    console.log('  Kunne ikke hente indbyggertal fra DST — fortsætter uden');
    return new Map();
  }
}

/** Main. */
async function main() {
  console.log(`dim_kommune backfill — env=${TARGET_ENV}, DRY=${DRY_RUN}`);

  const [kommuner, landsdelMap, indbyg] = await Promise.all([
    fetchKommuner(),
    fetchLandsdele(),
    fetchIndbyggertal(),
  ]);

  console.log(`  ${kommuner.length} kommuner fra DAWA, ${landsdelMap.size} landsdel-mappings, ${indbyg.size} indbyggertal`);

  const rows = kommuner.map((k) => ({
    kode: k.kode,
    navn: k.navn,
    region_kode: k.regionskode || null,
    region_navn: regionNavn(k.regionskode),
    landsdel_navn: landsdelMap.get(k.kode) || null,
    indbyggertal_seneste: indbyg.get(k.kode) || null,
    areal_km2: null, // DAWA doesn't provide area directly
    refreshed_at: new Date().toISOString(),
  }));

  if (DRY_RUN) {
    console.log(`  DRY RUN: would upsert ${rows.length} rows`);
    console.log('  Sample:', JSON.stringify(rows[0], null, 2));
    return;
  }

  const client = await resolveClient();

  // Upsert in batches of 25
  let upserted = 0;
  for (let i = 0; i < rows.length; i += 25) {
    const batch = rows.slice(i, i + 25);
    const { error } = await client.from('dim_kommune').upsert(batch, { onConflict: 'kode' });
    if (error) {
      console.error(`  Upsert error batch ${i}:`, error.message);
    } else {
      upserted += batch.length;
    }
  }

  console.log(`  Done! Upserted ${upserted} / ${rows.length} kommuner`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
