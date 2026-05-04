#!/usr/bin/env node
/**
 * Option C: Fuld initial backfill af cvr_virksomhed fra CVR ES.
 *
 * Scroller ALLE virksomheder i Erhvervsstyrelsens CVR-permanent
 * ElasticSearch via search_after-paginering og upserter til
 * public.cvr_virksomhed i batches.
 *
 * Kørsel:
 *   node scripts/backfill-cvr-virksomhed.mjs [--limit=1000] [--dry-run] [--env=test|prod]
 *
 * Miljø (fra .env.local):
 *   * NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (til upsert)
 *   * CVR_ES_USER + CVR_ES_PASS (til CVR ES)
 *
 * For test/prod target: brug --env=test eller --env=prod med
 *   SUPABASE_ACCESS_TOKEN i .env.local.
 *
 * Estimeret tid: ~2.1M virksomheder × batch=500 = ~4200 batches ≈ 30-45 min.
 *
 * Idempotent: UPSERT pr. CVR (onConflict: cvr).
 */
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
import { createClient } from '@supabase/supabase-js';

loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});

// ─── Args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const LIMIT = (() => {
  const a = args.find((x) => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : Infinity;
})();
const DRY_RUN = args.includes('--dry-run');
const TARGET_ENV = (() => {
  const a = args.find((x) => x.startsWith('--env='));
  return a ? a.split('=')[1] : 'local';
})();

// ─── Environment resolution ──────────────────────────────────────────────────

const ENV_REFS = {
  local: 'wkzwxfhyfmvglrqtmebw',
  test: 'rlkjmqjxmkxuclehbrnl',
  prod: 'xsyldjqcntiygrtfcszm',
};

async function resolveSupabaseClient() {
  if (TARGET_ENV === 'local') {
    const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
      process.exit(1);
    }
    return createClient(url, key);
  }

  // For test/prod: hent credentials via Supabase Management API
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  if (!accessToken) {
    console.error('Missing SUPABASE_ACCESS_TOKEN for --env=' + TARGET_ENV);
    process.exit(1);
  }

  const ref = ENV_REFS[TARGET_ENV];
  if (!ref) {
    console.error('Unknown env: ' + TARGET_ENV + '. Use local, test, or prod.');
    process.exit(1);
  }

  // Hent service_role key via Management API
  const keysRes = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!keysRes.ok) {
    console.error('Failed to fetch API keys:', keysRes.status);
    process.exit(1);
  }
  const keys = await keysRes.json();
  const serviceKey = keys.find((k) => k.name === 'service_role')?.api_key;
  if (!serviceKey) {
    console.error('service_role key not found');
    process.exit(1);
  }

  return createClient(`https://${ref}.supabase.co`, serviceKey);
}

// ─── CVR ES ──────────────────────────────────────────────────────────────────

const CVR_ES_USER = process.env.CVR_ES_USER;
const CVR_ES_PASS = process.env.CVR_ES_PASS;

if (!CVR_ES_USER || !CVR_ES_PASS) {
  console.error('Missing CVR_ES_USER / CVR_ES_PASS');
  process.exit(1);
}

const AUTH = 'Basic ' + Buffer.from(`${CVR_ES_USER}:${CVR_ES_PASS}`).toString('base64');
const ES_URL = 'http://distribution.virk.dk/cvr-permanent/virksomhed/_search';

const ES_PAGE_SIZE = 500;
const UPSERT_BATCH = 500;

/** Map ES Vrvirksomhed → cvr_virksomhed row */
function mapDoc(v) {
  if (!v?.cvrNummer) return null;
  const cvr = String(v.cvrNummer);
  const meta = v.virksomhedMetadata ?? {};
  const navn = meta.nyesteNavn?.navn;
  if (!navn) return null;

  const forloeb = v.livsforloeb ?? [];
  const stiftet = forloeb[0]?.periode?.gyldigFra?.split('T')[0] ?? null;
  const latest = forloeb[forloeb.length - 1];
  const ophoert = latest?.periode?.gyldigTil?.split('T')[0] ?? null;

  const kvartaler = meta.nyesteKvartalsbeskaeftigelse ?? [];
  const kvMap = {};
  for (const kv of kvartaler) {
    if (kv.kvartal != null) kvMap[kv.kvartal] = kv.antalAnsatte ?? null;
  }

  return {
    cvr,
    samt_id: v.samtId ?? null,
    navn,
    status: meta.nyesteStatus ?? null,
    branche_kode: meta.nyesteHovedbranche?.branchekode
      ? String(meta.nyesteHovedbranche.branchekode)
      : null,
    branche_tekst: meta.nyesteHovedbranche?.branchetekst ?? null,
    virksomhedsform:
      meta.nyesteVirksomhedsform?.kortBeskrivelse ??
      meta.nyesteVirksomhedsform?.langBeskrivelse ??
      null,
    stiftet,
    ophoert,
    ansatte_aar: meta.nyesteAarsbeskaeftigelse?.antalAnsatte ?? null,
    ansatte_kvartal_1: kvMap[1] ?? null,
    ansatte_kvartal_2: kvMap[2] ?? null,
    ansatte_kvartal_3: kvMap[3] ?? null,
    ansatte_kvartal_4: kvMap[4] ?? null,
    adresse_json: meta.nyesteBeliggenhedsadresse ?? null,
    sidst_opdateret: v.sidstOpdateret ?? null,
    sidst_indlaest: v.sidstIndlaest ?? null,
    sidst_hentet_fra_cvr: new Date().toISOString(),
    raw_source: v,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`CVR virksomhed backfill → ${TARGET_ENV} (limit=${LIMIT}, dry=${DRY_RUN})`);

  const client = await resolveSupabaseClient();
  let searchAfter = null;
  let totalFetched = 0;
  let totalUpserted = 0;
  let page = 0;
  const startMs = Date.now();

  while (totalFetched < LIMIT) {
    const body = {
      size: ES_PAGE_SIZE,
      sort: [{ 'Vrvirksomhed.cvrNummer': 'asc' }],
      query: { match_all: {} },
    };
    if (searchAfter) body.search_after = searchAfter;

    const res = await fetch(ES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: AUTH },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      console.error(`ES HTTP ${res.status}: ${await res.text()}`);
      break;
    }

    const json = await res.json();
    const hits = json.hits?.hits ?? [];
    if (hits.length === 0) {
      console.log('Ingen flere hits — færdig.');
      break;
    }

    const rows = [];
    for (const h of hits) {
      const v = h._source?.Vrvirksomhed;
      if (!v) continue;
      const row = mapDoc(v);
      if (row) rows.push(row);
    }

    totalFetched += hits.length;
    page++;

    if (!DRY_RUN && rows.length > 0) {
      // Upsert i sub-batches
      for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
        const batch = rows.slice(i, i + UPSERT_BATCH);
        const { error } = await client.from('cvr_virksomhed').upsert(batch, {
          onConflict: 'cvr',
          ignoreDuplicates: false,
        });
        if (error) {
          console.error(`Upsert fejl (page ${page}):`, error.message);
        } else {
          totalUpserted += batch.length;
        }
      }
    }

    const last = hits[hits.length - 1];
    if (!last.sort || hits.length < ES_PAGE_SIZE) break;
    searchAfter = last.sort;

    // Progress log
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
    if (page % 10 === 0) {
      console.log(
        `  Page ${page}: ${totalFetched} hentet, ${totalUpserted} upserted (${elapsed}s)`
      );
    }

    // Kort delay for at undgå rate-limiting
    await new Promise((r) => setTimeout(r, 50));
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`\nFærdig: ${totalFetched} hentet, ${totalUpserted} upserted på ${elapsed}s`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
