#!/usr/bin/env node
/**
 * BIZZ-1796: Backfill ejerskab for ejerlejligheder der mangler i ejf_ejerskab.
 *
 * Finds BFEs in bfe_adresse_cache with ejendomstype='Ejerlejlighed' that have
 * no entry in ejf_ejerskab, then queries EJF GraphQL live for ownership data.
 *
 * Must run from a server with Datafordeler access (dev server).
 *
 * Usage:
 *   node scripts/backfill-ejl-ejerskab-live.mjs [--limit=1000] [--dry-run]
 */
import pg from 'pg';
import { config } from 'dotenv';
config({ path: '/root/BizzAssist/.env.local' });

const args = process.argv.slice(2);
const LIMIT = (() => { const a = args.find(x => x.startsWith('--limit=')); return a ? parseInt(a.split('=')[1], 10) : 5000; })();
const DRY_RUN = args.includes('--dry-run');

const client = new pg.Client({ connectionString: process.env.SUPABASE_PROD_DB_URL, statement_timeout: 120000 });
await client.connect();

// ── OAuth ──────────────────────────────────────────────────────────────────

let currentToken = null;
let tokenExpiry = 0;

/**
 * Get or refresh Datafordeler OAuth token.
 *
 * @returns {Promise<string>}
 */
async function getToken() {
  if (currentToken && Date.now() < tokenExpiry) return currentToken;
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.DATAFORDELER_OAUTH_CLIENT_ID,
    client_secret: process.env.DATAFORDELER_OAUTH_CLIENT_SECRET,
  });
  const res = await fetch('https://auth.datafordeler.dk/realms/distribution/protocol/openid-connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  currentToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 30) * 1000;
  return currentToken;
}

// ── Main ───────────────────────────────────────────────────────────────────

// Find BFEs without ejerskab
const { rows: missingBfes } = await client.query(`
  SELECT DISTINCT h.bfe_nummer
  FROM tinglysning_haeftelse h
  LEFT JOIN ejf_ejerskab e ON h.bfe_nummer = e.bfe_nummer
  WHERE e.bfe_nummer IS NULL
  LIMIT $1
`, [LIMIT]);

console.log(`Found ${missingBfes.length} BFEs without ejerskab`);
if (DRY_RUN) console.log('DRY RUN\n');

let resolved = 0;
let noData = 0;
let errors = 0;
const startTime = Date.now();

for (let i = 0; i < missingBfes.length; i++) {
  const bfe = missingBfes[i].bfe_nummer;

  try {
    const token = await getToken();
    const vt = new Date().toISOString();
    const query = `{
      EJFCustom_EjerskabBegraenset(
        first: 20
        virkningstid: "${vt}"
        where: { bestemtFastEjendomBFENr: { eq: ${bfe} } }
      ) {
        nodes {
          id_lokalId
          bestemtFastEjendomBFENr
          faktiskEjerandel_taeller
          faktiskEjerandel_naevner
          virkningFra
          virkningTil
          status
          personEllerVirksomhedLokalId
        }
      }
    }`;

    const res = await fetch('https://graphql.datafordeler.dk/flexibleCurrent/v1/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    const nodes = data.data?.EJFCustom_EjerskabBegraenset?.nodes ?? [];

    if (nodes.length > 0) {
      if (!DRY_RUN) {
        for (const n of nodes) {
          await client.query(`
            INSERT INTO ejf_ejerskab (bfe_nummer, ejer_ejf_id, virkning_fra, ejer_navn, ejer_type,
              ejerandel_taeller, ejerandel_naevner, status, virkning_til, sidst_opdateret, ejer_enheds_nummer)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10)
            ON CONFLICT (bfe_nummer, ejer_ejf_id) DO UPDATE SET
              ejerandel_taeller = EXCLUDED.ejerandel_taeller,
              ejerandel_naevner = EXCLUDED.ejerandel_naevner,
              status = EXCLUDED.status,
              sidst_opdateret = NOW()
          `, [
            bfe,
            n.id_lokalId,
            n.virkningFra,
            `Person ${n.personEllerVirksomhedLokalId || ''}`.trim(),
            'person',
            n.faktiskEjerandel_taeller,
            n.faktiskEjerandel_naevner,
            n.status || 'gældende',
            n.virkningTil,
            null,
          ]);
        }
      }
      resolved++;
    } else {
      noData++;
    }
  } catch {
    errors++;
  }

  // Rate limit: ~5 req/s
  await new Promise(r => setTimeout(r, 200));

  if ((i + 1) % 100 === 0 || i === missingBfes.length - 1) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rate = ((i + 1) / (elapsed || 1)).toFixed(1);
    console.log(`  [${i + 1}/${missingBfes.length}] resolved=${resolved} noData=${noData} errors=${errors} ${rate}/s (${elapsed}s)`);
  }
}

console.log(`\nDone! resolved=${resolved} noData=${noData} errors=${errors}`);
await client.end();
