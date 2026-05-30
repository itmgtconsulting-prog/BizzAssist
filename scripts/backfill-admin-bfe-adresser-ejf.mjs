#!/usr/bin/env node
/**
 * BIZZ-1817 Phase 2B: Backfill admin BFE addresses via EJF GraphQL.
 *
 * For BFEs not resolvable via DAWA, query EJF BestemtFastEjendom for
 * ejendomsadresse and insert into bfe_adresse_cache.
 *
 * Must run from a server with Datafordeler access (or via proxy).
 *
 * Usage:
 *   node scripts/backfill-admin-bfe-adresser-ejf.mjs [--limit=1000] [--dry-run]
 */
import pg from 'pg';
import { config } from 'dotenv';
config({ path: '/root/BizzAssist/.env.local' });

const args = process.argv.slice(2);
const LIMIT = (() => { const a = args.find(x => x.startsWith('--limit=')); return a ? parseInt(a.split('=')[1], 10) : 5000; })();
const DRY_RUN = args.includes('--dry-run');
const BATCH_SIZE = 50; // EJF GraphQL batch

const client = new pg.Client({ connectionString: process.env.SUPABASE_PROD_DB_URL, statement_timeout: 30000 });
await client.connect();

// ── Proxy-aware fetch ──────────────────────────────────────────────────────

const DF_PROXY_URL = process.env.DF_PROXY_URL ?? '';
const DF_PROXY_SECRET = process.env.DF_PROXY_SECRET ?? '';

/**
 * Rewrite URL through proxy if configured.
 *
 * @param {string} url - Direct Datafordeler URL
 * @returns {string} Proxied or direct URL
 */
function proxyUrl(url) {
  if (!DF_PROXY_URL) return url;
  return url.replace('https://', `${DF_PROXY_URL}/proxy/`);
}

/**
 * Extra headers for proxied requests.
 *
 * @returns {Record<string, string>}
 */
function proxyHeaders() {
  if (!DF_PROXY_URL || !DF_PROXY_SECRET) return {};
  return { 'x-df-proxy-secret': DF_PROXY_SECRET };
}

// ── OAuth token ────────────────────────────────────────────────────────────

/**
 * Get Datafordeler OAuth token.
 *
 * @returns {Promise<string|null>} Access token or null
 */
async function getToken() {
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.DATAFORDELER_OAUTH_CLIENT_ID,
    client_secret: process.env.DATAFORDELER_OAUTH_CLIENT_SECRET,
  });
  const url = proxyUrl('https://auth.datafordeler.dk/realms/distribution/protocol/openid-connect/token');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...proxyHeaders() },
    body: params.toString(),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  return data.access_token ?? null;
}

// ── EJF lookup ─────────────────────────────────────────────────────────────

/**
 * Query EJF BestemtFastEjendom for address data.
 *
 * @param {string} token - OAuth access token
 * @param {number[]} bfes - Array of BFE numbers
 * @returns {Promise<Map<number, {adresselinje1: string, adresselinje2: string}>>}
 */
async function fetchEjfAddresses(token, bfes) {
  const result = new Map();
  const vt = new Date().toISOString();

  for (const bfe of bfes) {
    try {
      const query = `{
        EJFCustom_BestemtFastEjendomBegraenset(
          first: 1
          virkningstid: "${vt}"
          where: { bFENr: { eq: ${bfe} } }
        ) {
          nodes {
            bFENr
            ejendomsadresse {
              adresselinje1
              adresselinje2
            }
          }
        }
      }`;

      const url = proxyUrl('https://graphql.datafordeler.dk/flexibleCurrent/v1/');
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...proxyHeaders(),
        },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(10000),
      });

      const data = await res.json();
      const nodes = data.data?.EJFCustom_BestemtFastEjendomBegraenset?.nodes ?? [];
      if (nodes.length > 0 && nodes[0].ejendomsadresse) {
        result.set(bfe, nodes[0].ejendomsadresse);
      }
    } catch {
      /* non-fatal */
    }
    await new Promise(r => setTimeout(r, 50));
  }

  return result;
}

/**
 * Parse EJF ejendomsadresse into cache-compatible format.
 *
 * EJF adresselinje1 = "Vejnavn Nr", adresselinje2 = "Postnr By"
 *
 * @param {{adresselinje1: string, adresselinje2: string}} addr
 * @returns {{adresse: string, postnr: string, postnrnavn: string} | null}
 */
function parseEjfAddress(addr) {
  const line1 = addr.adresselinje1?.trim();
  const line2 = addr.adresselinje2?.trim();
  if (!line1) return null;

  let postnr = '';
  let postnrnavn = '';
  if (line2) {
    const match = line2.match(/^(\d{4})\s+(.+)$/);
    if (match) {
      postnr = match[1];
      postnrnavn = match[2];
    }
  }

  return { adresse: line1, postnr, postnrnavn };
}

// ── Main ───────────────────────────────────────────────────────────────────

console.log('=== Phase 2B: Resolve admin BFEs via EJF GraphQL ===\n');
console.log('Proxy:', DF_PROXY_URL || 'DISABLED (direct)');

const token = await getToken();
if (!token) {
  console.error('Failed to get OAuth token — aborting');
  process.exit(1);
}
console.log('OAuth token obtained\n');

// Find missing admin BFEs
const { rows: missingBfes } = await client.query(`
  SELECT DISTINCT a.bfe_nummer
  FROM ejf_administrator a
  LEFT JOIN bfe_adresse_cache c ON a.bfe_nummer = c.bfe_nummer
  WHERE a.virksomhed_cvr IS NOT NULL
    AND a.status = 'gældende'
    AND c.bfe_nummer IS NULL
  ORDER BY a.bfe_nummer
  LIMIT $1
`, [LIMIT]);

console.log(`Found ${missingBfes.length} admin BFEs without cached address\n`);
if (DRY_RUN) console.log('DRY RUN — not writing\n');

let resolved = 0;
let failed = 0;
const startTime = Date.now();

for (let i = 0; i < missingBfes.length; i += BATCH_SIZE) {
  const batch = missingBfes.slice(i, i + BATCH_SIZE);
  const bfes = batch.map(r => Number(r.bfe_nummer));

  // Refresh token every 1000 BFEs (tokens expire in 5 min)
  let currentToken = token;
  if (i > 0 && i % 1000 === 0) {
    const newToken = await getToken();
    if (newToken) currentToken = newToken;
  }

  const addresses = await fetchEjfAddresses(currentToken, bfes);

  for (const bfe of bfes) {
    const ejfAddr = addresses.get(bfe);
    if (!ejfAddr) {
      failed++;
      continue;
    }

    const parsed = parseEjfAddress(ejfAddr);
    if (!parsed || !parsed.adresse) {
      failed++;
      continue;
    }

    if (!DRY_RUN) {
      await client.query(`
        INSERT INTO bfe_adresse_cache (bfe_nummer, adresse, postnr, postnrnavn, kilde, sidst_opdateret)
        VALUES ($1, $2, $3, $4, 'backfill_admin_ejf', NOW())
        ON CONFLICT (bfe_nummer) DO UPDATE SET
          adresse = EXCLUDED.adresse,
          postnr = EXCLUDED.postnr,
          postnrnavn = EXCLUDED.postnrnavn,
          kilde = EXCLUDED.kilde,
          sidst_opdateret = NOW()
      `, [bfe, parsed.adresse, parsed.postnr, parsed.postnrnavn]);
    }
    resolved++;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  const rate = ((i + batch.length) / (elapsed || 1)).toFixed(1);
  console.log(`  [${i + batch.length}/${missingBfes.length}] resolved=${resolved} failed=${failed} ${rate}/s (${elapsed}s)`);
}

console.log(`\nDone! resolved=${resolved} failed=${failed}`);

// Final stats
const { rows: stats } = await client.query(`
  SELECT
    count(DISTINCT a.bfe_nummer) as total,
    count(DISTINCT CASE WHEN c.postnr IS NOT NULL AND c.postnr != '' THEN a.bfe_nummer END) as med_fuld
  FROM ejf_administrator a
  LEFT JOIN bfe_adresse_cache c ON a.bfe_nummer = c.bfe_nummer
  WHERE a.virksomhed_cvr IS NOT NULL AND a.status = 'gældende'
`);
console.log(`Coverage: ${stats[0].med_fuld}/${stats[0].total} (${(stats[0].med_fuld / stats[0].total * 100).toFixed(1)}%)`);

await client.end();
