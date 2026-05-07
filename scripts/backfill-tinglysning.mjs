#!/usr/bin/env node
/**
 * BIZZ-1194: Backfill ejf_ejerskab per BFE via Datafordeler EJFCustom GraphQL.
 *
 * Itererer alle BFE-numre fra bbr_ejendom_status og slår ejerskab op for
 * hvert BFE via EJFCustom_EjerskabBegraenset. Resultaterne upsertes til
 * ejf_ejerskab med composite PK (bfe_nummer, ejer_ejf_id, virkning_fra).
 *
 * Komplementerer:
 *   - BIZZ-1195 backfill-ejf-ejerskab.mjs (fuld paginated bulk)
 *   - ingest-ejf-bulk cron (daglig inkrementel)
 *   - pull-tinglysning-aendringer cron (5-dages delta-sync)
 *
 * Usage:
 *   node scripts/backfill-tinglysning.mjs [--limit=1000] [--dry-run] [--offset=0]
 *
 * Flags:
 *   --limit=N    Max antal BFE'er at processere (default: unlimited)
 *   --offset=N   Spring N BFE'er over (resume efter afbrydelse)
 *   --dry-run    Log hvad der ville ske, skriv ikke til DB
 *
 * Estimering: ~2.5M BFE × 500ms delay = ~14 dage.
 * Anbefaling: Kør med --limit=50000 ad gangen fra dev-server.
 *
 * @retention Permanent — ejerskab er offentlig data (ingen GDPR PII)
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { readFileSync, writeFileSync, existsSync } from 'fs';

config({ path: '.env.local' });

// ── Config ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DF_CLIENT_ID = process.env.DATAFORDELER_OAUTH_CLIENT_ID;
const DF_CLIENT_SECRET = process.env.DATAFORDELER_OAUTH_CLIENT_SECRET;
const DF_PROXY_URL = process.env.DF_PROXY_URL ?? '';
const DF_PROXY_SECRET = process.env.DF_PROXY_SECRET ?? '';

const TOKEN_URL = 'https://auth.datafordeler.dk/realms/distribution/protocol/openid-connect/token';
const EJF_GQL_URL = 'https://graphql.datafordeler.dk/flexibleCurrent/v1/';

const BATCH_SIZE = 50;
const DELAY_MS = 500;
const SUPABASE_PAGE_SIZE = 1000;
const CHECKPOINT_FILE = '/tmp/tinglysning-backfill-offset.txt';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
if (!DF_CLIENT_ID || !DF_CLIENT_SECRET) {
  console.error('Missing DATAFORDELER_OAUTH_CLIENT_ID or DATAFORDELER_OAUTH_CLIENT_SECRET');
  process.exit(1);
}

const client = createClient(SUPABASE_URL, SUPABASE_KEY);

const args = process.argv.slice(2);
const LIMIT = args.find((a) => a.startsWith('--limit='))
  ? parseInt(args.find((a) => a.startsWith('--limit=')).split('=')[1], 10)
  : Infinity;
const OFFSET = args.find((a) => a.startsWith('--offset='))
  ? parseInt(args.find((a) => a.startsWith('--offset=')).split('=')[1], 10)
  : loadCheckpoint();
const DRY_RUN = args.includes('--dry-run');

// ── OAuth ───────────────────────────────────────────────────────────────────

let cachedToken = null;

async function getToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: DF_CLIENT_ID,
      client_secret: DF_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`OAuth failed: ${res.status}`);
  const json = await res.json();
  cachedToken = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cachedToken.token;
}

// ── Proxy ───────────────────────────────────────────────────────────────────

function proxyUrl(url) {
  if (!DF_PROXY_URL) return url;
  return url.replace('https://', `${DF_PROXY_URL}/proxy/`);
}

function proxyHeaders() {
  if (!DF_PROXY_URL || !DF_PROXY_SECRET) return {};
  return { 'X-Proxy-Secret': DF_PROXY_SECRET };
}

// ── Checkpoint ──────────────────────────────────────────────────────────────

function loadCheckpoint() {
  if (!existsSync(CHECKPOINT_FILE)) return 0;
  const val = parseInt(readFileSync(CHECKPOINT_FILE, 'utf8').trim(), 10);
  return isNaN(val) ? 0 : val;
}

function saveCheckpoint(offset) {
  writeFileSync(CHECKPOINT_FILE, String(offset), 'utf8');
}

// ── Per-BFE EJF lookup ─────────────────────────────────────────────────────

async function fetchEjerskabForBFE(bfe, token) {
  const vt = new Date().toISOString();
  const query = `{
    EJFCustom_EjerskabBegraenset(
      first: 500
      virkningstid: "${vt}"
      where: { bestemtFastEjendomBFENr: { eq: ${bfe} } }
    ) {
      nodes {
        bestemtFastEjendomBFENr
        ejerforholdskode
        faktiskEjerandel_taeller
        faktiskEjerandel_naevner
        virkningFra
        virkningTil
        status
        ejendeVirksomhedCVRNr_20_Virksomhed_CVRNummer_ref { CVRNummer }
        ejendePersonBegraenset { id, navn { navn }, foedselsdato }
      }
    }
  }`;

  const res = await fetch(proxyUrl(EJF_GQL_URL), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...proxyHeaders(),
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) return null;
  const json = await res.json();
  if (json.errors?.length) return null;
  return json.data?.EJFCustom_EjerskabBegraenset?.nodes ?? [];
}

function mapNode(node) {
  const bfe = node.bestemtFastEjendomBFENr;
  if (bfe == null) return null;
  const person = node.ejendePersonBegraenset;
  const cvr = node.ejendeVirksomhedCVRNr_20_Virksomhed_CVRNummer_ref?.CVRNummer
    ? String(node.ejendeVirksomhedCVRNr_20_Virksomhed_CVRNummer_ref.CVRNummer) : null;
  const personId = person?.id ?? null;
  const personNavn = person?.navn?.navn ?? null;

  let ejerType, ejfId, navn;
  if (personId && personNavn) {
    ejerType = 'person'; ejfId = personId; navn = personNavn;
  } else if (cvr) {
    ejerType = 'virksomhed'; ejfId = `virk-${cvr}`; navn = `CVR ${cvr}`;
  } else {
    return null;
  }

  return {
    bfe_nummer: bfe,
    ejer_ejf_id: ejfId,
    virkning_fra: node.virkningFra ?? new Date(0).toISOString(),
    ejer_navn: navn,
    ejer_foedselsdato: ejerType === 'person' ? (person?.foedselsdato ?? null) : null,
    ejer_cvr: ejerType === 'virksomhed' ? cvr : null,
    ejer_type: ejerType,
    ejerandel_taeller: node.faktiskEjerandel_taeller ?? null,
    ejerandel_naevner: node.faktiskEjerandel_naevner ?? null,
    status: (node.status ?? '').toLowerCase().includes('historisk') ? 'historisk' : 'gældende',
    virkning_til: node.virkningTil ?? null,
    sidst_opdateret: new Date().toISOString(),
  };
}

async function flushBatch(rows) {
  if (rows.length === 0 || DRY_RUN) return rows.length;
  const seen = new Map();
  for (const r of rows) {
    seen.set(`${r.bfe_nummer}|${r.ejer_ejf_id}|${r.virkning_fra}`, r);
  }
  const deduped = Array.from(seen.values());
  const { error } = await client
    .from('ejf_ejerskab')
    .upsert(deduped, { onConflict: 'bfe_nummer,ejer_ejf_id,virkning_fra', ignoreDuplicates: false });
  if (error) {
    console.error('  Upsert error:', error.message);
    return 0;
  }
  return deduped.length;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Tinglysning Backfill — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Limit: ${LIMIT === Infinity ? 'unlimited' : LIMIT}, Offset: ${OFFSET}`);
  console.log(`Proxy: ${DF_PROXY_URL || 'disabled (direct)'}`);
  console.log('');

  const token = await getToken();
  console.log('OAuth token acquired');

  // Fetch total BFE count
  const { count: totalBfe } = await client
    .from('bbr_ejendom_status')
    .select('bfe_nummer', { count: 'exact', head: true });
  console.log(`Total BFE in bbr_ejendom_status: ${totalBfe?.toLocaleString() ?? '?'}`);

  let processed = 0;
  let ejfRows = 0;
  let errors = 0;
  let bfesWithData = 0;
  let currentOffset = OFFSET;
  const startMs = Date.now();
  let pendingRows = [];

  while (processed < LIMIT) {
    // Fetch next page of BFE numbers
    const { data: bfePage, error: fetchErr } = await client
      .from('bbr_ejendom_status')
      .select('bfe_nummer')
      .order('bfe_nummer', { ascending: true })
      .range(currentOffset, currentOffset + SUPABASE_PAGE_SIZE - 1);

    if (fetchErr) {
      console.error('Failed to fetch BFE page:', fetchErr.message);
      break;
    }
    if (!bfePage || bfePage.length === 0) {
      console.log('No more BFE numbers — complete!');
      break;
    }

    for (const row of bfePage) {
      if (processed >= LIMIT) break;
      const bfe = row.bfe_nummer;

      try {
        const currentToken = await getToken();
        const nodes = await fetchEjerskabForBFE(bfe, currentToken);

        if (nodes && nodes.length > 0) {
          bfesWithData++;
          for (const node of nodes) {
            const mapped = mapNode(node);
            if (mapped) pendingRows.push(mapped);
          }
        }

        // Flush when batch is full
        if (pendingRows.length >= BATCH_SIZE * 10) {
          const flushed = await flushBatch(pendingRows);
          ejfRows += flushed;
          pendingRows = [];
        }
      } catch (err) {
        errors++;
        if (errors < 10) console.error(`  BFE ${bfe} error:`, err.message);
      }

      processed++;
      currentOffset++;

      // Rate limit
      await new Promise((r) => setTimeout(r, DELAY_MS));

      // Progress + checkpoint every 100 BFEs
      if (processed % 100 === 0) {
        saveCheckpoint(currentOffset);
        const elapsed = (Date.now() - startMs) / 1000;
        const rate = Math.round(processed / elapsed * 3600);
        const eta = totalBfe ? Math.round((totalBfe - currentOffset) / (processed / elapsed) / 3600) : '?';
        console.log(
          `  ${processed.toLocaleString()} BFEs (offset ${currentOffset.toLocaleString()}), ` +
          `${ejfRows.toLocaleString()} rows, ${bfesWithData} with data, ${errors} errors ` +
          `(${rate}/hr, ETA ~${eta}h)`
        );
      }
    }
  }

  // Flush remaining
  if (pendingRows.length > 0) {
    const flushed = await flushBatch(pendingRows);
    ejfRows += flushed;
  }
  saveCheckpoint(currentOffset);

  console.log('');
  console.log('=== DONE ===');
  console.log(`BFEs processed: ${processed.toLocaleString()}`);
  console.log(`EJF rows upserted: ${ejfRows.toLocaleString()}`);
  console.log(`BFEs with ejerskab: ${bfesWithData.toLocaleString()}`);
  console.log(`Errors: ${errors}`);
  console.log(`Final offset: ${currentOffset.toLocaleString()} (saved to ${CHECKPOINT_FILE})`);
}

main();
