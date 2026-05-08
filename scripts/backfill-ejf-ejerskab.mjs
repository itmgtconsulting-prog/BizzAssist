#!/usr/bin/env node
/**
 * BIZZ-1195: Backfill ejf_ejerskab fra Datafordeler EJFCustom GraphQL.
 *
 * Paginerer gennem EJFCustom_EjerskabBegraenset og upserter til ejf_ejerskab.
 * Genoptager fra sidst-gemte cursor i ejf_ingest_runs.
 * Ingen tidsbudget — kører til dataene er opbrugt.
 *
 * Usage:
 *   node scripts/backfill-ejf-ejerskab.mjs [--limit=5000] [--dry-run] [--reset]
 *
 * Flags:
 *   --limit=N   Maks antal sider at processere (default: unlimited)
 *   --dry-run   Log hvad der ville ske uden at skrive til DB
 *   --reset     Start forfra (ignorer gemt cursor)
 *
 * Kræver i .env.local:
 *   DATAFORDELER_OAUTH_CLIENT_ID, DATAFORDELER_OAUTH_CLIENT_SECRET
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   DF_PROXY_URL, DF_PROXY_SECRET (valgfrit — bruger proxy hvis sat)
 *
 * @retention Permanent — ingen GDPR PII (ejernavn er offentligt tilgængeligt)
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

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

const GQL_PAGE_SIZE = 1000;
const BATCH_SIZE = 500;
const DELAY_BETWEEN_PAGES_MS = 200;

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
const DRY_RUN = args.includes('--dry-run');
const RESET = args.includes('--reset');

// ── OAuth token ─────────────────────────────────────────────────────────────

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

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OAuth token failed: ${res.status} ${body}`);
  }

  const json = await res.json();
  cachedToken = {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
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

// ── GraphQL ─────────────────────────────────────────────────────────────────

function buildQuery(cursor) {
  const vt = new Date().toISOString();
  const afterClause = cursor ? `, after: "${cursor}"` : '';
  return `{
    EJFCustom_EjerskabBegraenset(
      first: ${GQL_PAGE_SIZE}
      virkningstid: "${vt}"
      ${afterClause}
    ) {
      nodes {
        bestemtFastEjendomBFENr
        ejerforholdskode
        faktiskEjerandel_taeller
        faktiskEjerandel_naevner
        virkningFra
        virkningTil
        status
        ejendeVirksomhedCVRNr_20_Virksomhed_CVRNummer_ref {
          CVRNummer
        }
        ejendePersonBegraenset {
          id
          navn { navn }
          foedselsdato
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }`;
}

function mapNode(node) {
  const bfe = node.bestemtFastEjendomBFENr;
  if (bfe == null) return null;

  const person = node.ejendePersonBegraenset;
  const virksomhedRef = node.ejendeVirksomhedCVRNr_20_Virksomhed_CVRNummer_ref;
  const cvr = virksomhedRef?.CVRNummer ? String(virksomhedRef.CVRNummer) : null;
  const personNavn = person?.navn?.navn ?? null;
  const personId = person?.id ?? null;
  const foedselsdato = person?.foedselsdato ?? null;

  let ejerType, ejfId, navn;
  if (personId && personNavn) {
    ejerType = 'person';
    ejfId = personId;
    navn = personNavn;
  } else if (cvr) {
    ejerType = 'virksomhed';
    ejfId = `virk-${cvr}`;
    navn = `CVR ${cvr}`;
  } else {
    return null;
  }

  const virkningFra = node.virkningFra ?? new Date(0).toISOString();
  const rawStatus = (node.status ?? '').toLowerCase();
  const status = rawStatus.includes('historisk') ? 'historisk' : 'gældende';

  return {
    bfe_nummer: bfe,
    ejer_ejf_id: ejfId,
    virkning_fra: virkningFra,
    ejer_navn: navn,
    ejer_foedselsdato: ejerType === 'person' ? foedselsdato : null,
    ejer_cvr: ejerType === 'virksomhed' ? cvr : null,
    ejer_type: ejerType,
    ejerandel_taeller: node.faktiskEjerandel_taeller ?? null,
    ejerandel_naevner: node.faktiskEjerandel_naevner ?? null,
    status,
    virkning_til: node.virkningTil ?? null,
    sidst_opdateret: new Date().toISOString(),
  };
}

async function flushBatch(batch) {
  if (batch.length === 0 || DRY_RUN) return { upserted: batch.length, failed: 0 };

  // Deduplicate on composite PK
  const seen = new Map();
  for (const row of batch) {
    const key = `${row.bfe_nummer}|${row.ejer_ejf_id}|${row.virkning_fra}`;
    seen.set(key, row);
  }
  const deduped = Array.from(seen.values());

  const { error } = await client
    .from('ejf_ejerskab')
    .upsert(deduped, { onConflict: 'bfe_nummer,ejer_ejf_id,virkning_fra', ignoreDuplicates: false });

  if (error) {
    console.error('  Batch upsert error:', error.message);
    return { upserted: 0, failed: batch.length };
  }
  return { upserted: deduped.length, failed: 0 };
}

// ── Cursor management ───────────────────────────────────────────────────────

async function loadCursor() {
  if (RESET) return null;
  const { data } = await client
    .from('ejf_ingest_runs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(1);
  // Check if there's a field storing cursor — may vary
  const last = data?.[0];
  if (!last) return null;
  // The cron route doesn't store cursor in ejf_ingest_runs (schema lacks it).
  // We'll use a simple file-based checkpoint instead.
  return null;
}

async function saveIngestRun(stats) {
  if (DRY_RUN) return;
  await client.from('ejf_ingest_runs').insert({
    started_at: stats.startedAt,
    finished_at: new Date().toISOString(),
    rows_processed: stats.processed,
    rows_inserted: stats.inserted,
    rows_updated: 0,
    rows_failed: stats.failed,
    error: stats.error,
  });
}

// ── File-based checkpoint for cursor resume ─────────────────────────────────

import { readFileSync, writeFileSync, existsSync } from 'fs';

const CHECKPOINT_FILE = '/tmp/ejf-backfill-cursor.txt';

function loadCheckpoint() {
  if (RESET) return null;
  if (!existsSync(CHECKPOINT_FILE)) return null;
  const data = readFileSync(CHECKPOINT_FILE, 'utf8').trim();
  return data || null;
}

function saveCheckpoint(cursor) {
  writeFileSync(CHECKPOINT_FILE, cursor ?? '', 'utf8');
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`EJF Ejerskab Backfill — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Limit: ${LIMIT === Infinity ? 'unlimited' : LIMIT} pages`);
  console.log(`Page size: ${GQL_PAGE_SIZE}, Batch size: ${BATCH_SIZE}`);
  console.log(`Proxy: ${DF_PROXY_URL || 'disabled (direct)'}`);
  console.log('');

  const token = await getToken();
  console.log('OAuth token acquired');

  let cursor = loadCheckpoint();
  if (cursor) {
    console.log(`Resuming from checkpoint cursor: ${cursor.substring(0, 40)}...`);
  } else {
    console.log('Starting from beginning (no checkpoint)');
  }

  const startedAt = new Date().toISOString();
  let processed = 0;
  let inserted = 0;
  let failed = 0;
  let pages = 0;
  let batch = [];

  try {
    while (pages < LIMIT) {
      // Refresh token if needed
      const currentToken = await getToken();

      const query = buildQuery(cursor);
      const res = await fetch(proxyUrl(EJF_GQL_URL), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${currentToken}`,
          ...proxyHeaders(),
        },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`GraphQL HTTP ${res.status}: ${body.substring(0, 200)}`);
        break;
      }

      const json = await res.json();
      if (json.errors?.length) {
        console.error('GraphQL errors:', json.errors.map((e) => e.message).join(', '));
        break;
      }

      const ejf = json.data?.EJFCustom_EjerskabBegraenset;
      const nodes = ejf?.nodes ?? [];
      const pageInfo = ejf?.pageInfo;

      if (nodes.length === 0) {
        console.log('No more nodes — backfill complete!');
        break;
      }

      for (const node of nodes) {
        processed++;
        const row = mapNode(node);
        if (!row) continue;
        batch.push(row);
        if (batch.length >= BATCH_SIZE) {
          const result = await flushBatch(batch);
          inserted += result.upserted;
          failed += result.failed;
          batch = [];
        }
      }

      pages++;
      cursor = pageInfo?.endCursor ?? null;

      // Save checkpoint every 10 pages
      if (pages % 10 === 0) {
        saveCheckpoint(cursor);
        const rate = Math.round(processed / ((Date.now() - new Date(startedAt).getTime()) / 1000));
        console.log(
          `  Page ${pages}: ${processed.toLocaleString()} processed, ` +
            `${inserted.toLocaleString()} inserted, ${failed} failed ` +
            `(${rate} rows/s)`
        );
      }

      if (!pageInfo?.hasNextPage) {
        console.log('Reached last page — backfill complete!');
        break;
      }

      // Rate limit
      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_PAGES_MS));
    }

    // Flush remaining batch
    if (batch.length > 0) {
      const result = await flushBatch(batch);
      inserted += result.upserted;
      failed += result.failed;
    }

    // Save final checkpoint
    saveCheckpoint(cursor);

    // Save ingest run
    await saveIngestRun({
      startedAt,
      processed,
      inserted,
      failed,
      error: null,
    });

    console.log('');
    console.log('=== DONE ===');
    console.log(`Pages: ${pages}`);
    console.log(`Processed: ${processed.toLocaleString()}`);
    console.log(`Inserted/Updated: ${inserted.toLocaleString()}`);
    console.log(`Failed: ${failed}`);
    console.log(`Cursor: ${cursor?.substring(0, 40) ?? 'complete'}...`);
  } catch (err) {
    console.error('Fatal error:', err);
    saveCheckpoint(cursor);
    await saveIngestRun({
      startedAt,
      processed,
      inserted,
      failed,
      error: err.message,
    });
    process.exit(1);
  }
}

main();
