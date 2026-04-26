#!/usr/bin/env node
/**
 * BIZZ-828 — backfill script for bbr_ejendom_status berigelse-felter
 * (areal, opførelsesår, anvendelse). Populerer:
 *   - samlet_boligareal, samlet_erhvervsareal, bebygget_areal
 *   - opfoerelsesaar, ombygningsaar
 *   - byg021_anvendelse (primær anvendelseskode — største bygnings)
 *
 * Energimærke populeres IKKE i denne backfill — kræver separat EMO-
 * integration (Energistyrelsen API). ADR-beslutning afventer.
 *
 * Grundareal populeres IKKE her — kræver BBR_Grund-opslag på BFE.
 * Opfølgning i iter 2b når BBR_Grund-helper er udrullet.
 *
 * Kilde til BFE-numre: bbr_ejendom_status.bfe_nummer (alle kendte
 * ikke-udfasede ejendomme fra iter 2a backfill).
 *
 * Kører manuelt:
 *   node scripts/backfill-bbr-ejendom.mjs [--limit=100] [--dry-run] [--only-missing]
 *
 * Batch: 50 BFE'er pr. BBR-kald med 500ms delay. Idempotent UPSERT
 * pr. bfe_nummer, opdaterer berigelse_sidst.
 *
 * Miljø:
 *   * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *   * DATAFORDELER_USER + DATAFORDELER_PASS
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
const BBR_USER = process.env.DATAFORDELER_USER;
const BBR_PASS = process.env.DATAFORDELER_PASS;

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
if (!BBR_USER || !BBR_PASS) {
  console.error('Missing DATAFORDELER_USER / DATAFORDELER_PASS');
  process.exit(1);
}

const args = process.argv.slice(2);
const LIMIT = (() => {
  const a = args.find((x) => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : Infinity;
})();
const DRY_RUN = args.includes('--dry-run');
const ONLY_MISSING = args.includes('--only-missing');

const client = createClient(SUPABASE_URL, SERVICE_ROLE);

const BBR_GQL_ENDPOINT =
  'https://services.datafordeler.dk/BBR/BBRPublic/1/rest/GraphQL/ejendom';

const BBR_AUTH = Buffer.from(`${BBR_USER}:${BBR_PASS}`).toString('base64');

/**
 * Hent aktive bygninger for en batch af BFE-numre via BBR_Grund →
 * BBR_Bygning-join. Returnerer Map<bfe_nummer, bygning[]>.
 *
 * BBR_Grund.bestemtFastEjendomBFENr er join-key der matcher alle
 * BFE-typer (SFE, bygning på fremmed grund, ejerlejlighed).
 * Aktive bygninger = status NOT IN {4,10,11} (nedrevet/slettet/bortfaldet).
 */
async function fetchBygningerForBfeBatch(bfeNumre) {
  const query = `query($vt: DafDateTime!, $bfes: [Int!]!) {
    BBR_Grund(first: 500, virkningstid: $vt, where: { bestemtFastEjendomBFENr: { in: $bfes } }) {
      nodes {
        bestemtFastEjendomBFENr
        bygningPaaGrund {
          bygning {
            nodes {
              id_lokalId
              status
              byg021BygningensAnvendelse
              byg026Opfoerelsesaar
              byg027OmTilbygningsaar
              byg038SamletBygningsareal
              byg039BygningensSamledeBoligAreal
              byg040BygningensSamledeErhvervsAreal
              byg041BebyggetAreal
            }
          }
        }
      }
    }
  }`;

  const vt = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
  const res = await fetch(BBR_GQL_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${BBR_AUTH}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query, variables: { vt, bfes: bfeNumre } }),
  });

  if (!res.ok) {
    console.error(`[bbr] HTTP ${res.status} for batch ${bfeNumre.slice(0, 3)}...`);
    return new Map();
  }

  const json = await res.json();
  if (json.errors) {
    console.error('[bbr] GraphQL errors:', JSON.stringify(json.errors).slice(0, 300));
    return new Map();
  }

  const grunde = json.data?.BBR_Grund?.nodes ?? [];
  const byBfe = new Map();
  for (const g of grunde) {
    const bfe = Number(g.bestemtFastEjendomBFENr);
    if (!Number.isFinite(bfe)) continue;
    const bygninger = (g.bygningPaaGrund ?? [])
      .flatMap((bp) => bp?.bygning?.nodes ?? [])
      .filter((b) => b != null);
    if (!byBfe.has(bfe)) byBfe.set(bfe, []);
    byBfe.get(bfe).push(...bygninger);
  }
  return byBfe;
}

/**
 * Konsolidér byg-nodes til berigelse-row for én ejendom. Filter først
 * aktive (status NOT IN nedrevet-koder), så:
 *   - samlet_*: sum af byg039/040/041 på aktive bygninger
 *   - opfoerelsesaar: min (ældste)
 *   - ombygningsaar: max (nyeste ombygning)
 *   - byg021_anvendelse: primær = størst-areal-bygningens kode
 */
const RETIRED = new Set([4, 10, 11]);

function consolidateBygninger(bygninger) {
  const active = bygninger.filter((b) => {
    const s = Number(b.status);
    return !RETIRED.has(s);
  });
  if (active.length === 0) return null;

  const sumNum = (key) =>
    active.reduce((acc, b) => {
      const v = Number(b[key]);
      return Number.isFinite(v) ? acc + v : acc;
    }, 0);

  const years = active.map((b) => Number(b.byg026Opfoerelsesaar)).filter((n) => n >= 1500 && n <= 2100);
  const omYears = active.map((b) => Number(b.byg027OmTilbygningsaar)).filter((n) => n >= 1500 && n <= 2100);

  // Primær anvendelse = bygning med største samlet_bygningsareal
  let primaryAnvendelse = null;
  let maxArea = -1;
  for (const b of active) {
    const area = Number(b.byg038SamletBygningsareal) || 0;
    const anv = parseInt(String(b.byg021BygningensAnvendelse ?? ''), 10);
    if (Number.isFinite(anv) && area > maxArea) {
      maxArea = area;
      primaryAnvendelse = anv;
    }
  }

  const samletBolig = sumNum('byg039BygningensSamledeBoligAreal');
  const samletErhverv = sumNum('byg040BygningensSamledeErhvervsAreal');
  const bebygget = sumNum('byg041BebyggetAreal');

  return {
    samlet_boligareal: samletBolig > 0 ? Math.round(samletBolig) : null,
    samlet_erhvervsareal: samletErhverv > 0 ? Math.round(samletErhverv) : null,
    bebygget_areal: bebygget > 0 ? Math.round(bebygget) : null,
    opfoerelsesaar: years.length > 0 ? Math.min(...years) : null,
    ombygningsaar: omYears.length > 0 ? Math.max(...omYears) : null,
    byg021_anvendelse: primaryAnvendelse,
  };
}

/**
 * Kilde: bbr_ejendom_status.bfe_nummer (iter 2a backfillede hele
 * populationen). Hvis --only-missing: spring rows over der allerede
 * har samlet_boligareal sat.
 */
async function* iterateBfeNumbers(limit) {
  let offset = 0;
  const pageSize = 1000;
  let returned = 0;
  while (returned < limit) {
    const q = client
      .from('bbr_ejendom_status')
      .select('bfe_nummer, samlet_boligareal')
      .order('bfe_nummer', { ascending: true })
      .range(offset, offset + pageSize - 1);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) return;
    for (const row of data) {
      if (returned >= limit) return;
      if (ONLY_MISSING && row.samlet_boligareal != null) continue;
      yield Number(row.bfe_nummer);
      returned++;
    }
    offset += pageSize;
  }
}

async function main() {
  console.log(
    `[backfill-ejendom] Starting — limit=${LIMIT === Infinity ? 'ALL' : LIMIT}, dry-run=${DRY_RUN}, only-missing=${ONLY_MISSING}`
  );

  const all = [];
  for await (const bfe of iterateBfeNumbers(LIMIT)) all.push(bfe);
  console.log(`[backfill-ejendom] ${all.length} BFE-numre at process.`);

  let processed = 0;
  let upserted = 0;
  let failed = 0;
  const BATCH = 50;
  for (let i = 0; i < all.length; i += BATCH) {
    const chunk = all.slice(i, i + BATCH);
    let bygMap;
    try {
      bygMap = await fetchBygningerForBfeBatch(chunk);
    } catch (err) {
      failed += chunk.length;
      console.error(`[bbr] Batch ${i}-${i + chunk.length} fejlede:`, err?.message ?? err);
      processed += chunk.length;
      if (i + BATCH < all.length) await new Promise((r) => setTimeout(r, 500));
      continue;
    }

    const rows = [];
    for (const bfe of chunk) {
      const bygninger = bygMap.get(bfe) ?? [];
      if (bygninger.length === 0) continue;
      const consolidated = consolidateBygninger(bygninger);
      if (!consolidated) continue;
      rows.push({
        bfe_nummer: bfe,
        ...consolidated,
        berigelse_sidst: new Date().toISOString(),
      });
    }

    if (!DRY_RUN && rows.length > 0) {
      const { error } = await client
        .from('bbr_ejendom_status')
        .upsert(rows, { onConflict: 'bfe_nummer' });
      if (error) {
        console.error(`[backfill-ejendom] upsert fejl på batch ${i}:`, error.message);
      } else {
        upserted += rows.length;
      }
    }

    processed += chunk.length;
    if (processed % 500 === 0) {
      console.log(
        `[backfill-ejendom] processed=${processed}, upserted=${upserted}, failed=${failed}`
      );
    }
    if (i + BATCH < all.length) await new Promise((r) => setTimeout(r, 500));
  }

  console.log(
    `[backfill-ejendom] Done. processed=${processed}, upserted=${upserted}, failed=${failed}`
  );
}

main().catch((err) => {
  console.error('[backfill-ejendom] Fatal:', err);
  process.exit(1);
});
