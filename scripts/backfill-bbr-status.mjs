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
// BIZZ-903: BBR v2 via API-key + proxy (samme stien som prod-appen).
// Proxy-secret er valgfri (kun nødvendig via Hetzner-proxy).
const DF_API_KEY = process.env.DATAFORDELER_API_KEY;
const DF_PROXY_URL = process.env.DF_PROXY_URL;
const DF_PROXY_SECRET = process.env.DF_PROXY_SECRET;

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
if (!DF_API_KEY) {
  console.error('Missing DATAFORDELER_API_KEY');
  process.exit(1);
}

const args = process.argv.slice(2);
const LIMIT = (() => {
  const a = args.find((x) => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : Infinity;
})();
const DRY_RUN = args.includes('--dry-run');
// BIZZ-904: --bfe-file=path/to/bfes.json bypasser langsom PostgREST-
// paginering af 7.6M ejf_ejerskab rows. Filen er et JSON-array af numbers.
const BFE_FILE = (() => {
  const a = args.find((x) => x.startsWith('--bfe-file='));
  return a ? a.split('=')[1] : null;
})();

// BIZZ-824 iter 2b: Centrale status-koder (mapping-konsistens koordineres
// med BIZZ-825 iter 2c der konsoliderer bbrKoder.ts).
// 4  = Nedrevet/slettet
// 10 = Bygning nedrevet
// 11 = Bygning bortfaldet
const RETIRED_STATUS_CODES = new Set([4, 10, 11]);

// BIZZ-903: BBR v2 endpoint via API-key (+ proxy hvis konfigureret).
// Proxy bruges i cloud (Vercel) hvor IP ikke er whitelistet hos Datafordeler.
const BBR_V2_BASE = 'https://graphql.datafordeler.dk/BBR/v2';

/**
 * Bygger den fulde URL til BBR v2 inkl. API-key og evt. proxy-prefix.
 */
function bbrUrl() {
  const direct = `${BBR_V2_BASE}?apiKey=${DF_API_KEY}`;
  if (!DF_PROXY_URL) return direct;
  // Proxy-format: {proxyUrl}/proxy/{hostname}/{path}?{query}
  const u = new URL(direct);
  return `${DF_PROXY_URL}/proxy/${u.hostname}${u.pathname}${u.search}`;
}

/**
 * Headers til BBR-kald. Tilføjer proxy-secret hvis konfigureret.
 */
function bbrHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (DF_PROXY_SECRET) h['X-Proxy-Secret'] = DF_PROXY_SECRET;
  return h;
}

/**
 * Sender en GraphQL-query til BBR v2 og returnerer nodes fra første data-key.
 */
async function queryBBR(query, variables = {}) {
  const res = await fetch(bbrUrl(), {
    method: 'POST',
    headers: bbrHeaders(),
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`BBR HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`BBR GQL: ${JSON.stringify(json.errors).slice(0, 300)}`);
  }
  const firstKey = Object.keys(json.data ?? {})[0];
  return json.data?.[firstKey]?.nodes ?? [];
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
 * BIZZ-903: BBR v2 3-step lookup for en batch af BFE'er.
 *
 * v2-schema er anderledes end v1:
 *   1. BBR_Ejendomsrelation(bfeNummer) → ejendoms-UUID + ejendomstype
 *   2. BBR_Grund(bestemtFastEjendom) → grund-UUID + kommunekode + husnummer
 *   3. BBR_Bygning(grund) → status + areal + opførelsesår + anvendelse
 *
 * BBR v2 returnerer duplikater (BIZZ-575) — dedup på id_lokalId.
 *
 * @param {number[]} bfeNumre - Batch af BFE-numre (max ~30 anbefalet)
 * @returns {Promise<Map<number, object>>}
 */
async function fetchBbrStatusForBfeBatch(bfeNumre) {
  if (bfeNumre.length === 0) return new Map();
  const vt = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';

  // ─── Step 1: BFE → Ejendomsrelation (UUID + type) ───────────────
  // Inline BFE-numre i queryen i stedet for GraphQL-variabler fordi
  // v2-schema bruger Long-type for bfeNummer (ikke Int).
  let ejNodes;
  try {
    const bfeList = bfeNumre.join(',');
    ejNodes = await queryBBR(
      `{ BBR_Ejendomsrelation(first: 500, virkningstid: "${vt}", where: { bfeNummer: { in: [${bfeList}] } }) {
          nodes { bfeNummer ejendomstype id_lokalId }
      } }`
    );
  } catch (err) {
    console.error(`[bbr] step 1 error for batch ${bfeNumre.slice(0, 3)}...:`, err?.message ?? err);
    return new Map();
  }

  // Dedup ejendomsrelationer per BFE (v2 returnerer duplikater)
  const bfeToEjd = new Map();
  for (const e of ejNodes) {
    const bfe = Number(e.bfeNummer);
    if (!Number.isFinite(bfe) || bfeToEjd.has(bfe)) continue;
    bfeToEjd.set(bfe, e.id_lokalId);
  }

  if (bfeToEjd.size === 0) return new Map();

  // ─── Step 2: Ejendoms-UUID → Grund (kommunekode + husnummer) ────
  const ejdIds = [...new Set(bfeToEjd.values())];
  let grundNodes;
  try {
    const idList = ejdIds.map((id) => `"${id}"`).join(',');
    grundNodes = await queryBBR(
      `{ BBR_Grund(first: 500, virkningstid: "${vt}", where: { bestemtFastEjendom: { in: [${idList}] } }) {
          nodes { id_lokalId kommunekode bestemtFastEjendom husnummer }
      } }`
    );
  } catch (err) {
    console.error(`[bbr] step 2 error:`, err?.message ?? err);
    return new Map();
  }

  // Map ejendoms-UUID → { grundIds[], kommunekode, husnummer }
  const ejdToGrund = new Map();
  for (const g of grundNodes) {
    const ejdId = g.bestemtFastEjendom;
    if (!ejdId) continue;
    if (!ejdToGrund.has(ejdId)) {
      ejdToGrund.set(ejdId, { grundIds: [], kommune_kode: null, adgangsadresse_id: null });
    }
    const entry = ejdToGrund.get(ejdId);
    if (g.id_lokalId && !entry.grundIds.includes(g.id_lokalId)) {
      entry.grundIds.push(g.id_lokalId);
    }
    if (!entry.kommune_kode && g.kommunekode != null) {
      entry.kommune_kode = parseInt(String(g.kommunekode), 10) || null;
    }
    if (!entry.adgangsadresse_id && g.husnummer) {
      entry.adgangsadresse_id = g.husnummer;
    }
  }

  // ─── Step 3: Grund-UUID → Bygninger (status + areal + aar + anvend) ──
  const allGrundIds = [...new Set([...ejdToGrund.values()].flatMap((e) => e.grundIds))];
  let bygNodes = [];
  if (allGrundIds.length > 0) {
    try {
      const gidList = allGrundIds.map((id) => `"${id}"`).join(',');
      bygNodes = await queryBBR(
        `{ BBR_Bygning(first: 500, virkningstid: "${vt}", where: { grund: { in: [${gidList}] } }) {
            nodes {
              id_lokalId status grund
              byg038SamletBygningsareal
              byg039BygningensSamledeBoligAreal
              byg026Opfoerelsesaar
              byg021BygningensAnvendelse
            }
        } }`
      );
    } catch (err) {
      console.error(`[bbr] step 3 error:`, err?.message ?? err);
      // Fortsæt med tomme bygninger → BFE'er gemmes som "ingen bygninger"
    }
  }

  // Dedup bygninger (BIZZ-575: v2 returnerer duplikater)
  const seenByg = new Set();
  const uniqueByg = [];
  for (const b of bygNodes) {
    if (b.id_lokalId && seenByg.has(b.id_lokalId)) continue;
    if (b.id_lokalId) seenByg.add(b.id_lokalId);
    uniqueByg.push(b);
  }

  // Grupper bygninger per grund-UUID
  const grundToBygninger = new Map();
  for (const b of uniqueByg) {
    const gid = b.grund;
    if (!gid) continue;
    if (!grundToBygninger.has(gid)) grundToBygninger.set(gid, []);
    grundToBygninger.get(gid).push(b);
  }

  // ─── Konsolider til per-BFE output ──────────────────────────────
  const result = new Map();
  for (const [bfe, ejdId] of bfeToEjd) {
    const grundInfo = ejdToGrund.get(ejdId);
    const bygninger = (grundInfo?.grundIds ?? []).flatMap(
      (gid) => grundToBygninger.get(gid) ?? []
    );

    if (bygninger.length === 0) {
      result.set(bfe, {
        is_udfaset: false,
        adgangsadresse_id: grundInfo?.adgangsadresse_id ?? null,
        bbr_status_code: null,
        kommune_kode: grundInfo?.kommune_kode ?? null,
        samlet_boligareal: null,
        opfoerelsesaar: null,
        byg021_anvendelse: null,
      });
      continue;
    }

    // is_udfaset hvis ALLE bygninger er retired
    const allRetired = bygninger.every((b) => RETIRED_STATUS_CODES.has(Number(b.status)));

    // Primær status + anvendelse = størst-areal-bygning
    let primaryStatus = null;
    let primaryAnvendelse = null;
    let maxArea = -1;
    let sumBoligareal = 0;
    let hasBoligareal = false;
    let minOpfoerelsesaar = Infinity;
    let hasOpfoerelsesaar = false;

    for (const b of bygninger) {
      const area = Number(b.byg038SamletBygningsareal) || 0;
      const s = Number(b.status);
      if (Number.isFinite(s) && area > maxArea) {
        maxArea = area;
        primaryStatus = s;
        const anvKode = b.byg021BygningensAnvendelse != null
          ? parseInt(String(b.byg021BygningensAnvendelse), 10)
          : null;
        if (anvKode != null && Number.isFinite(anvKode)) primaryAnvendelse = anvKode;
      }
      const bolig = Number(b.byg039BygningensSamledeBoligAreal);
      if (Number.isFinite(bolig) && bolig > 0) {
        sumBoligareal += bolig;
        hasBoligareal = true;
      }
      const aar = Number(b.byg026Opfoerelsesaar);
      if (Number.isFinite(aar) && aar > 0 && aar < minOpfoerelsesaar) {
        minOpfoerelsesaar = aar;
        hasOpfoerelsesaar = true;
      }
    }

    result.set(bfe, {
      is_udfaset: allRetired,
      adgangsadresse_id: grundInfo?.adgangsadresse_id ?? null,
      bbr_status_code: primaryStatus,
      kommune_kode: grundInfo?.kommune_kode ?? null,
      samlet_boligareal: hasBoligareal ? sumBoligareal : null,
      opfoerelsesaar: hasOpfoerelsesaar && minOpfoerelsesaar > 1000 ? minOpfoerelsesaar : null,
      byg021_anvendelse: primaryAnvendelse,
    });
  }

  return result;
}

async function main() {
  console.log(`[backfill] Starting — limit=${LIMIT === Infinity ? 'ALL' : LIMIT}, dry-run=${DRY_RUN}, bfe-file=${BFE_FILE ?? 'none'}`);

  let all;
  if (BFE_FILE) {
    // BIZZ-904: Læs pre-genereret BFE-liste (fra Management API SQL)
    const fs = await import('node:fs');
    const raw = fs.readFileSync(BFE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    all = Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
    if (LIMIT < all.length) all = all.slice(0, LIMIT);
    console.log(`[backfill] Loaded ${all.length} BFE-numre fra ${BFE_FILE}`);
  } else {
    const unique = new Set();
    for await (const bfe of iterateBfeNumbers(LIMIT)) {
      unique.add(bfe);
    }
    all = Array.from(unique);
    console.log(`[backfill] ${all.length} unike BFE-numre fra DB.`);
  }
  let processed = 0;
  let upserted = 0;
  // BIZZ-903: Reduceret fra 50 til 30 fordi v2 kræver 3 queries per
  // batch (Ejendomsrelation → Grund → Bygning) vs. v1's 1 query.
  const BATCH = 30;
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
