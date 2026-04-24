#!/usr/bin/env node
/**
 * BIZZ-785 iter 2a — backfill script for bbr_ejendom_status.
 *
 * Henter alle kendte BFE'er fra DAWA-sitemap-agnostiske kilder og
 * spørger BBR for bygning-status per BFE. Konsoliderer til
 * is_udfaset=true hvis ALLE bygninger på ejendommen har status
 * ∈ {Nedrevet/slettet, Bygning nedrevet, Bygning bortfaldet}
 * (samme logik som BIZZ-787 banner-trigger).
 *
 * Kører manuelt:
 *   node scripts/backfill-bbr-status.mjs [--limit=100] [--dry-run]
 *
 * Batch: 50 BFE'er pr. BBR-kald med 500ms delay — respekterer rate-
 * limit hos Datafordeler. ~46k ejendomme → ~8 minutter for fuld run.
 *
 * Idempotent: UPSERT pr. bfe_nummer, opdaterer status_last_checked_at.
 * Kan køres hver nat eller ad hoc.
 *
 * Miljø:
 *   * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (til upsert)
 *   * DATAFORDELER_USER + DATAFORDELER_PASS (til BBR-kald)
 */
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
import { createClient } from '@supabase/supabase-js';

loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
// BIZZ-821: Port fra Basic auth (DATAFORDELER_USER/PASS) til OAuth
// client_credentials flow (DATAFORDELER_OAUTH_CLIENT_ID/SECRET).
// Legacy basic-auth-env-vars understøttes stadig hvis OAuth ikke er sat.
const OAUTH_CLIENT_ID = process.env.DATAFORDELER_OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.DATAFORDELER_OAUTH_CLIENT_SECRET;
const BBR_USER = process.env.DATAFORDELER_USER;
const BBR_PASS = process.env.DATAFORDELER_PASS;
const USE_OAUTH = Boolean(OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET);

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
if (!USE_OAUTH && (!BBR_USER || !BBR_PASS)) {
  console.error(
    'Missing auth: set either DATAFORDELER_OAUTH_CLIENT_ID + _SECRET (preferred) or DATAFORDELER_USER + DATAFORDELER_PASS'
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const LIMIT = (() => {
  const a = args.find((x) => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : Infinity;
})();
const DRY_RUN = args.includes('--dry-run');

// BIZZ-824 iter 2b: Centrale status-koder (mapping-konsistens koordineres
// med BIZZ-825 iter 2c der konsoliderer bbrKoder.ts).
// 4  = Nedrevet/slettet
// 10 = Bygning nedrevet
// 11 = Bygning bortfaldet
const RETIRED_STATUS_CODES = new Set([4, 10, 11]);

// BIZZ-821: OAuth-porten bruger den nye graphql.datafordeler.dk-endpoint
// i stedet for services.datafordeler.dk (sidstnævnte er legacy basic-auth).
const BBR_GQL_ENDPOINT = USE_OAUTH
  ? 'https://graphql.datafordeler.dk/BBR/v2'
  : 'https://services.datafordeler.dk/BBR/BBRPublic/1/rest/GraphQL/ejendom';

const BBR_BASIC_AUTH = USE_OAUTH
  ? null
  : Buffer.from(`${BBR_USER}:${BBR_PASS}`).toString('base64');

// OAuth token cache (per script-run). Genbruger token i 60 min (expires_in
// typisk 3600s) så vi undgår en token-round-trip per batch.
let _oauthToken = null;
let _oauthExpiresAt = 0;
async function getOAuthToken() {
  if (_oauthToken && _oauthExpiresAt > Date.now() + 60_000) return _oauthToken;
  const tokenUrl =
    process.env.DATAFORDELER_TOKEN_URL ||
    'https://auth.datafordeler.dk/realms/distribution/protocol/openid-connect/token';
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`OAuth token request failed: ${res.status}`);
  }
  const json = await res.json();
  _oauthToken = json.access_token;
  _oauthExpiresAt = Date.now() + json.expires_in * 1000;
  return _oauthToken;
}

/**
 * Bygger Authorization-header afhængig af auth-mode. Kaldes per request
 * så OAuth-token auto-refresher når den udløber.
 */
async function authHeader() {
  if (USE_OAUTH) {
    const token = await getOAuthToken();
    return `Bearer ${token}`;
  }
  return `Basic ${BBR_BASIC_AUTH}`;
}

const client = createClient(SUPABASE_URL, SERVICE_ROLE);

/**
 * BIZZ-835 iter 2b: To BFE-kilder for at dække nyudstykninger uden
 * tinglyst ejer:
 *
 * 1. ejf_ejerskab — primær kilde (7.6M rows fra Filudtræk-backfill).
 *    Dækker alle registrerede ejerskaber.
 * 2. bbr_ejendom_status — sekundær kilde. Egen tabel, populeres af
 *    tidligere runs + cron-refresh (BIZZ-826). Inkluderer BFE'er der
 *    er blevet opdaget via DAWA-autocomplete eller andre kilder selv
 *    uden eksplicit ejerskab-record.
 *
 * Unionen minimerer manglende coverage for nye BFE'er der endnu ikke
 * er registreret i ejf_ejerskab (fx nyudstykninger). Dedup via Set.
 */
async function* iterateBfeNumbers(limit) {
  const seen = new Set();
  let returned = 0;
  const pageSize = 1000;

  // Kilde 1: ejf_ejerskab (primaer — 7.6M rows)
  let offset = 0;
  while (returned < limit) {
    const { data, error } = await client
      .from('ejf_ejerskab')
      .select('bfe_nummer')
      .not('bfe_nummer', 'is', null)
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) {
      if (returned >= limit) return;
      const bfe = Number(row.bfe_nummer);
      if (seen.has(bfe)) continue;
      seen.add(bfe);
      yield bfe;
      returned++;
    }
    offset += pageSize;
  }

  // Kilde 2: bbr_ejendom_status (sekundaer — nyudstykninger + tidligere run)
  offset = 0;
  while (returned < limit) {
    const { data, error } = await client
      .from('bbr_ejendom_status')
      .select('bfe_nummer')
      .not('bfe_nummer', 'is', null)
      .range(offset, offset + pageSize - 1);
    if (error) break; // non-fatal — fortsaet uden sekundaer kilde
    if (!data || data.length === 0) break;
    for (const row of data) {
      if (returned >= limit) return;
      const bfe = Number(row.bfe_nummer);
      if (seen.has(bfe)) continue;
      seen.add(bfe);
      yield bfe;
      returned++;
    }
    offset += pageSize;
  }
}

/**
 * BIZZ-824 iter 2b: Live BBR-opslag for en liste af BFE'er. Erstatter
 * iter 2a scaffold (no-op). Returnerer map
 *   bfe_nummer → { is_udfaset, adgangsadresse_id, bbr_status_code, kommune_kode }
 *
 * Strategi: BBR_Grund.bestemtFastEjendomBFENr matcher alle BFE-typer
 * (SFE, bygning på fremmed grund, ejerlejlighed). Via bygningPaaGrund
 * joiner vi til BBR_Bygning med status + anvendelse. Konsolidering:
 *   is_udfaset = true hvis ALLE bygninger har status ∈ {4,10,11}
 *   bbr_status_code = primær bygnings status (størst-areal)
 *
 * Batch-størrelse 50 pr. kald. Rate-limit safety: 500ms mellem batches
 * (kontrolleret af caller).
 *
 * @param {number[]} bfeNumre - Batch af BFE-numre
 * @returns {Promise<Map<number, {is_udfaset, adgangsadresse_id, bbr_status_code, kommune_kode}>>}
 */
async function fetchBbrStatusForBfeBatch(bfeNumre) {
  if (bfeNumre.length === 0) return new Map();

  // BIZZ-821: Udvidet med byg039 (boligareal), byg026 (opførelsesår),
  // byg021 (anvendelse) til filter-berigelse. Energimærke er ikke i BBR
  // (kræver EMO-integration) — kolonnen NULLes indtil videre.
  const query = `query($vt: DafDateTime!, $bfes: [Int!]!) {
    BBR_Grund(first: 500, virkningstid: $vt, where: { bestemtFastEjendomBFENr: { in: $bfes } }) {
      nodes {
        bestemtFastEjendomBFENr
        kommunekode
        husnummer { id_lokalId }
        bygningPaaGrund {
          bygning {
            nodes {
              id_lokalId
              status
              byg038SamletBygningsareal
              byg039BygningensSamledeBoligAreal
              byg026Opfoerelsesaar
              byg021BygningensAnvendelse
            }
          }
        }
      }
    }
  }`;

  const vt = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';

  let res;
  try {
    const authorization = await authHeader();
    res = await fetch(BBR_GQL_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables: { vt, bfes: bfeNumre } }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    console.error(`[bbr] network error på batch ${bfeNumre.slice(0, 3)}...:`, err?.message ?? err);
    return new Map();
  }

  if (!res.ok) {
    console.error(`[bbr] HTTP ${res.status} for batch ${bfeNumre.slice(0, 3)}...`);
    return new Map();
  }

  let json;
  try {
    json = await res.json();
  } catch {
    console.error(`[bbr] JSON parse error for batch ${bfeNumre.slice(0, 3)}...`);
    return new Map();
  }

  if (json.errors) {
    console.error('[bbr] GraphQL errors:', JSON.stringify(json.errors).slice(0, 300));
    return new Map();
  }

  const grunde = json.data?.BBR_Grund?.nodes ?? [];

  // Aggregér pr BFE — samme BFE kan have flere grunde (jordstykker)
  const byBfe = new Map();
  for (const g of grunde) {
    const bfe = Number(g.bestemtFastEjendomBFENr);
    if (!Number.isFinite(bfe)) continue;

    const kommuneKode = g.kommunekode != null ? parseInt(String(g.kommunekode), 10) : null;
    const adgangsId = g.husnummer?.id_lokalId ?? null;

    const bygninger = (g.bygningPaaGrund ?? [])
      .flatMap((bp) => bp?.bygning?.nodes ?? [])
      .filter((b) => b != null);

    if (!byBfe.has(bfe)) {
      byBfe.set(bfe, { bygninger: [], adgangsadresse_id: null, kommune_kode: null });
    }
    const entry = byBfe.get(bfe);
    entry.bygninger.push(...bygninger);
    if (!entry.adgangsadresse_id && adgangsId) entry.adgangsadresse_id = adgangsId;
    if (!entry.kommune_kode && kommuneKode != null && Number.isFinite(kommuneKode)) {
      entry.kommune_kode = kommuneKode;
    }
  }

  // Konsolider til status-outputs
  const result = new Map();
  for (const [bfe, entry] of byBfe) {
    const bygs = entry.bygninger;
    if (bygs.length === 0) {
      // Ingen bygninger fundet — ejendommen er registreret uden bygninger
      // (ren grund). Marker som ikke-udfaset.
      result.set(bfe, {
        is_udfaset: false,
        adgangsadresse_id: entry.adgangsadresse_id,
        bbr_status_code: null,
        kommune_kode: entry.kommune_kode,
        samlet_boligareal: null,
        opfoerelsesaar: null,
        byg021_anvendelse: null,
      });
      continue;
    }

    // is_udfaset hvis ALLE bygninger er retired
    const allRetired = bygs.every((b) => {
      const s = Number(b.status);
      return RETIRED_STATUS_CODES.has(s);
    });

    // Primær status + anvendelse = størst-areal-bygningens værdier
    let primaryStatus = null;
    let primaryAnvendelse = null;
    let maxArea = -1;
    // BIZZ-821: Aggregér boligareal (sum) og opførelsesår (ældste)
    let sumBoligareal = 0;
    let hasBoligareal = false;
    let minOpfoerelsesaar = Infinity;
    let hasOpfoerelsesaar = false;
    for (const b of bygs) {
      const area = Number(b.byg038SamletBygningsareal) || 0;
      const s = Number(b.status);
      if (Number.isFinite(s) && area > maxArea) {
        maxArea = area;
        primaryStatus = s;
        // Primær anvendelse følger størst-areal-bygning
        const anvKode = b.byg021BygningensAnvendelse != null
          ? parseInt(String(b.byg021BygningensAnvendelse), 10)
          : null;
        if (anvKode != null && Number.isFinite(anvKode)) {
          primaryAnvendelse = anvKode;
        }
      }
      // Sum boligareal fra alle aktive bygninger
      const bolig = Number(b.byg039BygningensSamledeBoligAreal);
      if (Number.isFinite(bolig) && bolig > 0) {
        sumBoligareal += bolig;
        hasBoligareal = true;
      }
      // Ældste opførelsesår
      const aar = Number(b.byg026Opfoerelsesaar);
      if (Number.isFinite(aar) && aar > 0 && aar < minOpfoerelsesaar) {
        minOpfoerelsesaar = aar;
        hasOpfoerelsesaar = true;
      }
    }

    result.set(bfe, {
      is_udfaset: allRetired,
      adgangsadresse_id: entry.adgangsadresse_id,
      bbr_status_code: primaryStatus,
      kommune_kode: entry.kommune_kode,
      samlet_boligareal: hasBoligareal ? sumBoligareal : null,
      opfoerelsesaar: hasOpfoerelsesaar ? minOpfoerelsesaar : null,
      byg021_anvendelse: primaryAnvendelse,
    });
  }

  return result;
}

async function main() {
  console.log(`[backfill] Starting — limit=${LIMIT === Infinity ? 'ALL' : LIMIT}, dry-run=${DRY_RUN}`);
  const unique = new Set();
  for await (const bfe of iterateBfeNumbers(LIMIT)) {
    unique.add(bfe);
  }
  console.log(`[backfill] ${unique.size} unike BFE-numre at process.`);

  const all = Array.from(unique);
  let processed = 0;
  let upserted = 0;
  const BATCH = 50;
  for (let i = 0; i < all.length; i += BATCH) {
    const chunk = all.slice(i, i + BATCH);
    const statusMap = await fetchBbrStatusForBfeBatch(chunk);
    const rows = [];
    for (const bfe of chunk) {
      const entry = statusMap.get(bfe);
      if (!entry) continue;
      rows.push({
        bfe_nummer: bfe,
        adgangsadresse_id: entry.adgangsadresse_id ?? null,
        is_udfaset: entry.is_udfaset,
        bbr_status_code: entry.bbr_status_code ?? null,
        kommune_kode: entry.kommune_kode ?? null,
        status_last_checked_at: new Date().toISOString(),
        // BIZZ-821: berigelsesfelter for filter-phase-2
        samlet_boligareal: entry.samlet_boligareal ?? null,
        opfoerelsesaar: entry.opfoerelsesaar ?? null,
        byg021_anvendelse: entry.byg021_anvendelse ?? null,
        berigelse_sidst: new Date().toISOString(),
      });
    }
    if (!DRY_RUN && rows.length > 0) {
      const { error } = await client
        .from('bbr_ejendom_status')
        .upsert(rows, { onConflict: 'bfe_nummer' });
      if (error) {
        console.error(`[backfill] upsert error på batch ${i}:`, error.message);
      } else {
        upserted += rows.length;
      }
    }
    processed += chunk.length;
    if (processed % 500 === 0) {
      console.log(`[backfill] processed=${processed}, upserted=${upserted}`);
    }
    // Rate-limit hensyn — 500ms mellem batches
    if (i + BATCH < all.length) await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`[backfill] Done. processed=${processed}, upserted=${upserted}`);
}

main().catch((err) => {
  console.error('[backfill] Fatal:', err);
  process.exit(1);
});
