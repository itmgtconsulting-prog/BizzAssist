#!/usr/bin/env node
/**
 * BIZZ-829 — warm-on-demand backfill for regnskab_cache.
 *
 * Populerer regnskab_cache ved at iterere gennem CVR-numre fra
 * cvr_virksomhed og kalde XBRL-parse-endpointet via fetch. Cache
 * er idempotent og retention er 5 år (ADR-0006) så gentagne runs
 * er billige.
 *
 * ADR-0006 design-decisions:
 *   - Ingen partitionering (2M-row threshold ikke nået endnu)
 *   - 5 års retention (håndteres af purge-cron)
 *   - DKK only (normaliserTilTDKK)
 *   - Ingen raw XBRL XML gemmes
 *
 * Kører manuelt:
 *   node scripts/backfill-regnskab-cache.mjs --base-url=https://bizzassist.dk --limit=1000
 *
 * Krav:
 *   * ADMIN_SESSION_COOKIE: A valid Supabase auth cookie for an admin user
 *     (endpoint er auth-gated; session_role=service_role virker ikke direkte)
 *   * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for CVR-iteration
 *
 * Rate-limit: 2 req/sec mod eget API (hvilket internt kalder ES med timeout).
 * Full coverage (500k CVRs) ~70 timer — kør i baggrund eller del op i daglige chunks.
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
const SESSION_COOKIE = process.env.ADMIN_SESSION_COOKIE;

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const args = process.argv.slice(2);
const BASE_URL = (() => {
  const a = args.find((x) => x.startsWith('--base-url='));
  return a ? a.split('=')[1] : 'http://localhost:3000';
})();
const LIMIT = (() => {
  const a = args.find((x) => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : 100;
})();
const ONLY_MISSING = args.includes('--only-missing');
const DRY_RUN = args.includes('--dry-run');

const client = createClient(SUPABASE_URL, SERVICE_ROLE);
const REQ_DELAY_MS = 500; // 2 req/sec

/** Iterér CVR-numre fra cvr_virksomhed, optionally filtrered til missing cache. */
async function* iterateCvrNumre(limit) {
  let offset = 0;
  let returned = 0;
  const pageSize = 200;
  // Subquery til at filtrere "missing": vi kunne lave en LEFT JOIN men
  // PostgREST er clunky. Simplest: paginer CVR og per-kald tjek om cache mangler.
  while (returned < limit) {
    const { data, error } = await client
      .from('cvr_virksomhed')
      .select('cvr_nummer')
      .order('cvr_nummer')
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) return;
    for (const row of data) {
      if (returned >= limit) return;
      const cvr = String(row.cvr_nummer).padStart(8, '0');
      if (!/^\d{8}$/.test(cvr)) continue;
      if (ONLY_MISSING) {
        const { data: cached } = await client
          .from('regnskab_cache')
          .select('cvr')
          .eq('cvr', cvr)
          .maybeSingle();
        if (cached) continue;
      }
      yield cvr;
      returned++;
    }
    offset += pageSize;
  }
}

/** Kald XBRL-parse-endpoint — cacheen populeres som bi-effekt. */
async function warmCache(cvr) {
  const url = `${BASE_URL}/api/regnskab/xbrl?cvr=${cvr}`;
  const headers = SESSION_COOKIE ? { cookie: SESSION_COOKIE } : {};
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    return { ok: false, status: res.status };
  }
  const data = await res.json();
  return {
    ok: true,
    years: Array.isArray(data.years) ? data.years.length : 0,
    cached: !!data.cached,
    error: data.error ?? null,
  };
}

async function main() {
  console.log(
    `Starter regnskab-cache backfill (base=${BASE_URL}, limit=${LIMIT}, DRY=${DRY_RUN}, ONLY_MISSING=${ONLY_MISSING})`
  );
  if (!SESSION_COOKIE && !DRY_RUN) {
    console.warn(
      'ADVARSEL: ADMIN_SESSION_COOKIE ikke sat — endpoint returnerer 401. Brug --dry-run eller sæt cookie.'
    );
  }
  let processed = 0;
  let warmed = 0;
  let alreadyCached = 0;
  let errors = 0;
  let emptyYears = 0;

  for await (const cvr of iterateCvrNumre(LIMIT)) {
    if (DRY_RUN) {
      console.log(`  DRY: ville warme cvr=${cvr}`);
      processed++;
      continue;
    }
    try {
      const res = await warmCache(cvr);
      if (res.ok) {
        if (res.cached) alreadyCached++;
        else if (res.years > 0) warmed++;
        else emptyYears++;
      } else {
        errors++;
        if (errors <= 5) console.warn(`  FAIL cvr=${cvr}: status=${res.status}`);
      }
    } catch (err) {
      errors++;
      if (errors <= 5) console.warn(`  ERR cvr=${cvr}:`, err.message);
    }
    processed++;
    if (processed % 50 === 0) {
      console.log(
        `  processed=${processed}, warmed=${warmed}, cached=${alreadyCached}, empty=${emptyYears}, errors=${errors}`
      );
    }
    await new Promise((r) => setTimeout(r, REQ_DELAY_MS));
  }

  console.log(
    `\nFaerdig. processed=${processed}, warmed=${warmed}, cached=${alreadyCached}, empty=${emptyYears}, errors=${errors}`
  );
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
