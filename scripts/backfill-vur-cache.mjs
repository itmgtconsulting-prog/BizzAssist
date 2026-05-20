#!/usr/bin/env node
/**
 * Backfill vurdering_cache fra Datafordeler VUR GraphQL.
 *
 * Henter ejendomsvurderinger for BFE-numre fra ejf_ejerskab
 * og gemmer i vurdering_cache (korrekt tabel med separate kolonner).
 *
 * Usage:
 *   node scripts/backfill-vur-cache.mjs [--limit=1000] [--dry-run] [--env=prod|preview|dev]
 *
 * --env: Angiv target Supabase-miljø. Default: bruger .env.local (dev).
 *        prod/preview kræver SUPABASE_ACCESS_TOKEN i .env.local.
 *
 * Forudsætninger:
 *   - DATAFORDELER_USER + DATAFORDELER_PASS i .env.local
 *   - vurdering_cache tabel applied i target-miljø
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

config({ path: '.env.local' });

const DF_CLIENT_ID = process.env.DATAFORDELER_OAUTH_CLIENT_ID;
const DF_CLIENT_SECRET = process.env.DATAFORDELER_OAUTH_CLIENT_SECRET;

if (!DF_CLIENT_ID || !DF_CLIENT_SECRET) {
  console.error('Missing DATAFORDELER_OAUTH_CLIENT_ID / _SECRET in .env.local');
  process.exit(1);
}

const args = process.argv.slice(2);
const LIMIT = args.find((a) => a.startsWith('--limit='))
  ? parseInt(args.find((a) => a.startsWith('--limit=')).split('=')[1], 10)
  : Infinity;
const DRY_RUN = args.includes('--dry-run');
const ENV_ARG = args.find((a) => a.startsWith('--env='))?.split('=')[1] || 'dev';

/** Supabase project refs per environment */
const ENVS = {
  dev: { ref: 'wkzwxfhyfmvglrqtmebw', name: 'DEV' },
  preview: { ref: 'rlkjmqjxmkxuclehbrnl', name: 'PREVIEW' },
  prod: { ref: 'xsyldjqcntiygrtfcszm', name: 'PROD' },
};

/**
 * Resolve Supabase client for the target environment.
 * For dev: use .env.local directly.
 * For prod/preview: fetch service_role key via Supabase Management API.
 */
async function resolveClient() {
  if (ENV_ARG === 'dev') {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) { console.error('Missing Supabase dev credentials'); process.exit(1); }
    return createClient(url, key);
  }

  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  if (!accessToken) { console.error('Missing SUPABASE_ACCESS_TOKEN for non-dev env'); process.exit(1); }

  const { ref } = ENVS[ENV_ARG];
  // Fetch service_role key from Management API
  const keysRes = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const keys = await keysRes.json();
  const serviceKey = keys.find((k) => k.name === 'service_role')?.api_key;
  if (!serviceKey) { console.error(`Could not fetch service_role key for ${ref}`); process.exit(1); }

  return createClient(`https://${ref}.supabase.co`, serviceKey);
}

const BATCH_SIZE = 50;
const DELAY_MS = 200;
const VUR_GRAPHQL = 'https://graphql.datafordeler.dk/VUR/v2';
const DF_TOKEN_URL = process.env.DATAFORDELER_TOKEN_URL || 'https://auth.datafordeler.dk/realms/distribution/protocol/openid-connect/token';
const STALE_DAYS = 30;

/** OAuth token cache */
let _oauthToken = null;
let _oauthExpires = 0;

/** Hent OAuth Bearer token via client_credentials grant. */
async function getOAuthToken() {
  if (_oauthToken && _oauthExpires > Date.now() + 60_000) return _oauthToken;
  const res = await fetch(DF_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: DF_CLIENT_ID,
      client_secret: DF_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`OAuth token failed: ${res.status}`);
  const json = await res.json();
  _oauthToken = json.access_token;
  _oauthExpires = Date.now() + json.expires_in * 1000;
  return _oauthToken;
}

/**
 * Hent vurderinger for ét BFE-nummer via VUR GraphQL.
 */
async function fetchVur(bfe) {
  // Step 1: BFEKrydsreference → vurderings-IDs
  const krydsQuery = `{ VUR_BFEKrydsreference(first: 500, where: { BFEnummer: { eq: ${bfe} } }) { nodes { fkEjendomsvurderingID } } }`;
  const token = await getOAuthToken();
  const krydsRes = await fetch(VUR_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: krydsQuery }),
    signal: AbortSignal.timeout(30000),
  });
  if (!krydsRes.ok) return null;
  const krydsData = await krydsRes.json();
  if (krydsData.errors) return null;
  const vurIds = (krydsData.data?.VUR_BFEKrydsreference?.nodes || [])
    .map((n) => n.fkEjendomsvurderingID)
    .filter(Boolean);
  if (vurIds.length === 0) return { bfe, vurderinger: [], nyeste: null };

  // Step 2: Hent vurderinger — prøv udvidet query, fald tilbage til basis ved fejl
  const inClause = vurIds.join(', ');
  const udvidetQuery = `{
    VUR_Ejendomsvurdering(first: 500, where: { id: { in: [${inClause}] } }) {
      nodes {
        id aar
        ejendomvaerdiBeloeb grundvaerdiBeloeb
        ejendomvaerdiAfgiftspligtigBeloeb grundvaerdiAfgiftspligtigBeloeb
        vurderetAreal benyttelseKode
        juridiskKategoriTekst juridiskKategoriKode aendringDato aendringKode
      }
    }
  }`;
  const basisQuery = `{
    VUR_Ejendomsvurdering(first: 500, where: { id: { in: [${inClause}] } }) {
      nodes {
        id aar
        ejendomvaerdiBeloeb grundvaerdiBeloeb
        vurderetAreal benyttelseKode
        juridiskKategoriTekst juridiskKategoriKode aendringDato aendringKode
      }
    }
  }`;

  let vurRes = await fetch(VUR_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: udvidetQuery }),
    signal: AbortSignal.timeout(30000),
  });
  let vurData = vurRes.ok ? await vurRes.json() : null;

  // Fallback til basis-query uden afgiftspligtige felter
  if (!vurData || vurData.errors) {
    vurRes = await fetch(VUR_GRAPHQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: basisQuery }),
      signal: AbortSignal.timeout(30000),
    });
    if (!vurRes.ok) return null;
    vurData = await vurRes.json();
    if (vurData.errors) return null;
  }

  const nodes = vurData.data?.VUR_Ejendomsvurdering?.nodes || [];
  const sorted = [...nodes].sort(
    (a, b) => (b.aar ?? 0) - (a.aar ?? 0) || (b.ejendomvaerdiBeloeb ?? 0) - (a.ejendomvaerdiBeloeb ?? 0)
  );

  const mapped = sorted.map((n) => ({
    bfeNummer: bfe,
    ejendomsvaerdi: n.ejendomvaerdiBeloeb ?? null,
    grundvaerdi: n.grundvaerdiBeloeb ?? null,
    afgiftspligtigEjendomsvaerdi: n.ejendomvaerdiAfgiftspligtigBeloeb ?? null,
    afgiftspligtigGrundvaerdi: n.grundvaerdiAfgiftspligtigBeloeb ?? null,
    aar: n.aar ?? null,
    vurderetAreal: n.vurderetAreal ?? null,
    benyttelseskode: n.benyttelseKode ?? null,
    juridiskKategori: n.juridiskKategoriTekst ?? null,
    juridiskKategoriKode: n.juridiskKategoriKode ?? null,
    erNytSystem: !!n.juridiskKategoriKode && n.juridiskKategoriKode !== '0',
    aendringDato: n.aendringDato ?? null,
    aendringKode: n.aendringKode ?? null,
  }));

  const nyeste = mapped.length > 0 ? mapped[0] : null;
  return { bfe, vurderinger: mapped, nyeste };
}

async function main() {
  const envInfo = ENVS[ENV_ARG];
  console.log(`VUR Cache Backfill → ${envInfo.name} (LIMIT=${LIMIT === Infinity ? 'all' : LIMIT}, DRY=${DRY_RUN})`);

  const client = await resolveClient();

  let processed = 0;
  let cached = 0;
  let skipped = 0;
  let errors = 0;
  let offset = 0;

  while (processed < LIMIT) {
    // Hent BFE-numre fra ejf_ejerskab der ikke allerede er i vurdering_cache
    let bfeList;
    {
      // Hent distinct BFE fra ejf_ejerskab minus eksisterende cache.
      // Alle BFE-numre inkluderes — test viste at BFE < 200000 (ejerlejligheder)
      // også har vurderinger i VUR registret (3-5 per BFE).
      const { data: rawBfes } = await client
        .from('ejf_ejerskab')
        .select('bfe_nummer')
        .eq('status', 'gældende')
        .order('bfe_nummer')
        .range(offset, offset + BATCH_SIZE - 1);

      if (!rawBfes || rawBfes.length === 0) break;

      // Filter ud allerede cached
      const bfeNums = [...new Set(rawBfes.map((r) => r.bfe_nummer))];
      const { data: existing } = await client
        .from('vurdering_cache')
        .select('bfe_nummer')
        .in('bfe_nummer', bfeNums);
      const existingSet = new Set((existing || []).map((r) => r.bfe_nummer));
      bfeList = bfeNums.filter((b) => !existingSet.has(b));
      if (bfeList.length === 0) {
        offset += BATCH_SIZE;
        skipped += BATCH_SIZE;
        if (skipped > 50000) break; // Safety: stop after 50k skipped
        continue;
      }
    }

    for (const bfe of bfeList) {
      if (processed >= LIMIT) break;
      try {
        const data = await fetchVur(bfe);
        if (DRY_RUN) {
          console.log(`  DRY: BFE ${bfe} → ${(data?.vurderinger || []).length} vurderinger`);
          processed++;
          continue;
        }

        if (data) {
          const now = new Date().toISOString();
          const staleAfter = new Date(Date.now() + STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();

          const row = {
            bfe_nummer: bfe,
            vurderinger: data.vurderinger,
            grundvaerdispec: [],
            fordeling: [],
            loft: [],
            fritagelser: [],
            fradrag: null,
            foreloebig: null,
            skatteberegning: null,
            fetched_at: now,
            stale_after: staleAfter,
            ejendomsvaerdi: data.nyeste?.ejendomsvaerdi ?? null,
            grundvaerdi: data.nyeste?.grundvaerdi ?? null,
            vurderingsaar: data.nyeste?.aar ?? null,
            benyttelseskode: data.nyeste?.benyttelseskode ?? null,
            grundskyldspromille: null,
            bebyggelsesprocent: null,
          };

          const { error } = await client
            .from('vurdering_cache')
            .upsert(row, { onConflict: 'bfe_nummer' });

          if (error) {
            if (processed < 10) console.error(`  ERR BFE ${bfe}:`, error.message);
            errors++;
          } else {
            cached++;
          }
        }
        processed++;
      } catch (err) {
        if (processed < 10) console.error(`  CATCH BFE ${bfe}:`, err.message);
        errors++;
        processed++;
      }

      if (processed % 100 === 0) {
        console.log(`  processed=${processed}, cached=${cached}, errors=${errors}, skipped=${skipped}`);
      }
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
    offset += BATCH_SIZE;
  }

  console.log(`\nDone. processed=${processed}, cached=${cached}, errors=${errors}, skipped=${skipped}`);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
