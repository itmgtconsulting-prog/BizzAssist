#!/usr/bin/env node
/**
 * BIZZ-1461 — Backfill tinglysning_adkomst for kendte BFE-numre.
 *
 * Henter summarisk-data fra Tinglysning API via fetchTinglysningPriceRowsByBfe
 * og inserter i tinglysning_adkomst. Resumable via --offset.
 *
 * Kører manuelt:
 *   node scripts/backfill-tinglysning-adkomst.mjs [--limit=500] [--offset=0] [--dry-run]
 *
 * Batch: 4 concurrent, 400ms delay (Tinglysning rate limit 10 req/s).
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

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const args = process.argv.slice(2);
const LIMIT = (() => { const a = args.find(x => x.startsWith('--limit=')); return a ? parseInt(a.split('=')[1], 10) : 500; })();
const OFFSET = (() => { const a = args.find(x => x.startsWith('--offset=')); return a ? parseInt(a.split('=')[1], 10) : 0; })();
const DRY_RUN = args.includes('--dry-run');

const client = createClient(SUPABASE_URL, SERVICE_ROLE);

const PROXY_URL = process.env.DF_PROXY_URL;
const PROXY_SECRET = process.env.DF_PROXY_SECRET;
const TL_REST_BASE = 'https://www.tinglysning.dk/tinglysning/ssl';
const TL_BASE = PROXY_URL
  ? TL_REST_BASE.replace('https://', `${PROXY_URL}/proxy/`)
  : TL_REST_BASE;
const PROXY_HEADERS = PROXY_SECRET ? { 'X-Proxy-Secret': PROXY_SECRET } : {};
const CONCURRENCY = 4;
const DELAY_MS = 400;

/** Fetch price rows for a BFE from Tinglysning summarisk. */
async function fetchPricesForBfe(bfe) {
  try {
    // Step 1: BFE → UUID
    const searchRes = await fetch(`${TL_BASE}/ejendom/hovednoteringsnummer?hovednoteringsnummer=${bfe}`, {
      headers: { Accept: 'application/json', ...PROXY_HEADERS },
      signal: AbortSignal.timeout(10000),
    });
    if (!searchRes.ok) return [];
    let uuid;
    try {
      const data = await searchRes.json();
      uuid = data?.items?.[0]?.uuid;
    } catch { return []; }
    if (!uuid) return [];

    // Step 2: UUID → summarisk XML → price rows
    const xmlRes = await fetch(`${TL_BASE}/ejdsummarisk/${uuid}`, {
      headers: { Accept: 'application/xml', ...PROXY_HEADERS },
      signal: AbortSignal.timeout(15000),
    });
    if (!xmlRes.ok) return [];
    const xml = await xmlRes.text();

    // Parse adkomst entries
    const section = xml.match(/AdkomstSummariskSamling[\s\S]*?<\/[^:]*:?AdkomstSummariskSamling/)?.[0] ?? '';
    const entries = [...section.matchAll(/AdkomstSummarisk>([\s\S]*?)<\/[^:]*:?AdkomstSummarisk/g)];
    const rows = [];
    for (const [, entry] of entries) {
      const overtagelsesdato = entry.match(/SkoedeOvertagelsesDato[^>]*>([^<]+)/)?.[1]?.split(/[+T]/)[0] ?? null;
      const tinglysningsdato = entry.match(/TinglysningsDato[^>]*>([^<]+)/)?.[1]?.split(/[+T]/)[0] ?? null;
      const koebsaftaleDato = entry.match(/KoebsaftaleDato[^>]*>([^<]+)/)?.[1]?.split(/[+T]/)[0] ?? null;
      const kontantKoebesum = parseInt(entry.match(/KontantKoebesum[^>]*>([^<]+)/)?.[1]?.trim() ?? '', 10) || null;
      const iAltKoebesum = parseInt(entry.match(/IAltKoebesum[^>]*>([^<]+)/)?.[1]?.trim() ?? '', 10) || null;
      const dokumentId = entry.match(/DokumentIdentifikator[^>]*>([^<]+)/)?.[1] ?? null;
      const ejerNavn = entry.match(/PersonNavn[^>]*>([^<]+)/)?.[1] ?? entry.match(/VirksomhedNavn[^>]*>([^<]+)/)?.[1] ?? null;
      const ejerCvr = entry.match(/VirksomhedCvrNummer[^>]*>([^<]+)/)?.[1] ?? null;
      if (!overtagelsesdato && !kontantKoebesum && !iAltKoebesum) continue;
      rows.push({
        bfe_nummer: bfe,
        ejer_navn: ejerNavn,
        ejer_cvr: ejerCvr,
        ejer_type: ejerCvr ? 'virksomhed' : 'person',
        overtagelsesdato,
        tinglysningsdato,
        koebsaftale_dato: koebsaftaleDato,
        kontant_koebesum: kontantKoebesum,
        i_alt_koebesum: iAltKoebesum,
        dokument_id: dokumentId,
      });
    }
    return rows;
  } catch {
    return [];
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log(`Backfill tinglysning_adkomst — limit=${LIMIT}, offset=${OFFSET}, dryRun=${DRY_RUN}`);

  // Hent BFE'er der har ejerskifter men endnu ikke adkomst-data
  const { data: bfes, error } = await client
    .from('ejf_ejerskab')
    .select('bfe_nummer')
    .eq('status', 'gældende')
    .order('virkning_fra', { ascending: false })
    .range(OFFSET, OFFSET + LIMIT - 1);

  if (error) { console.error('DB error:', error.message); process.exit(1); }
  const uniqueBfes = [...new Set(bfes.map(r => r.bfe_nummer))];
  console.log(`${uniqueBfes.length} unikke BFE'er at behandle`);

  let fetched = 0, inserted = 0, errors = 0;

  for (let i = 0; i < uniqueBfes.length; i += CONCURRENCY) {
    const batch = uniqueBfes.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(bfe => fetchPricesForBfe(bfe)));

    for (let j = 0; j < results.length; j++) {
      fetched++;
      const result = results[j];
      if (result.status !== 'fulfilled' || result.value.length === 0) continue;
      const rows = result.value;

      if (DRY_RUN) {
        console.log(`  [dry] BFE ${batch[j]}: ${rows.length} adkomster`);
        inserted += rows.length;
        continue;
      }

      const { error: upErr } = await client
        .from('tinglysning_adkomst')
        .upsert(rows, { ignoreDuplicates: true });
      if (upErr) {
        errors++;
        if (errors <= 5) console.error(`  Upsert error BFE ${batch[j]}:`, upErr.message);
      } else {
        inserted += rows.length;
      }
    }

    process.stdout.write(`\r  fetched=${fetched} inserted=${inserted} errors=${errors}`);
    await sleep(DELAY_MS);
  }

  console.log(`\n\nDone! fetched=${fetched} inserted=${inserted} errors=${errors}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
