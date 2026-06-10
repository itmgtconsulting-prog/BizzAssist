#!/usr/bin/env node
/**
 * BIZZ-1794: Fix partial addresses in bfe_adresse_cache.
 *
 * Finds entries with dawa_id but missing postnr/vejnavn (only husnr stored)
 * and resolves full address via DAWA single-ID lookup.
 *
 * Usage:
 *   node scripts/backfill-partial-addresses.mjs [--limit=10000] [--dry-run]
 */
import pg from 'pg';
import { config } from 'dotenv';
config({ path: '/root/BizzAssist/.env.local' });

const args = process.argv.slice(2);
const LIMIT = (() => { const a = args.find(x => x.startsWith('--limit=')); return a ? parseInt(a.split('=')[1], 10) : 50000; })();
const DRY_RUN = args.includes('--dry-run');

const client = new pg.Client({ connectionString: process.env.SUPABASE_PROD_DB_URL, statement_timeout: 30000 });
await client.connect();

/**
 * Fetch full address from DAWA by adgangsadresse UUID.
 *
 * @param {string} dawaId - Adgangsadresse UUID
 * @returns {object|null} Parsed address or null
 */
async function fetchDawaAddress(dawaId) {
  try {
    const res = await fetch(`https://api.dataforsyningen.dk/adgangsadresser/${dawaId}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const vejnavn = data.vejstykke?.navn || '';
    const husnr = data.husnr || '';
    if (!vejnavn) return null;
    return {
      adresse: `${vejnavn} ${husnr}`.trim(),
      postnr: String(data.postnummer?.nr || ''),
      postnrnavn: data.postnummer?.navn || '',
      kommune: data.kommune?.navn || '',
      kommune_kode: String(data.kommune?.kode || '').padStart(4, '0'),
    };
  } catch {
    return null;
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

const { rows } = await client.query(`
  SELECT bfe_nummer, dawa_id
  FROM bfe_adresse_cache
  WHERE dawa_id IS NOT NULL
    AND (postnr IS NULL OR postnr = '')
  ORDER BY bfe_nummer
  LIMIT $1
`, [LIMIT]);

console.log(`Found ${rows.length} partial addresses to fix`);
if (DRY_RUN) console.log('DRY RUN\n');

let resolved = 0;
let failed = 0;
const startTime = Date.now();

for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  const addr = await fetchDawaAddress(row.dawa_id);

  if (addr && addr.adresse && addr.postnr) {
    if (!DRY_RUN) {
      await client.query(`
        UPDATE bfe_adresse_cache
        SET adresse = $2, postnr = $3, postnrnavn = $4, kommune = $5, kommune_kode = $6,
            kilde = 'backfill_partial_fix', sidst_opdateret = NOW()
        WHERE bfe_nummer = $1
      `, [row.bfe_nummer, addr.adresse, addr.postnr, addr.postnrnavn, addr.kommune, addr.kommune_kode]);
    }
    resolved++;
  } else {
    failed++;
  }

  // Rate limit: ~6 req/s
  await new Promise(r => setTimeout(r, 150));

  if ((i + 1) % 500 === 0 || i === rows.length - 1) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rate = ((i + 1) / (elapsed || 1)).toFixed(1);
    console.log(`  [${i + 1}/${rows.length}] resolved=${resolved} failed=${failed} ${rate}/s (${elapsed}s)`);
  }
}

console.log(`\nDone! resolved=${resolved} failed=${failed} (${((resolved / rows.length) * 100).toFixed(1)}%)`);

const { rows: stats } = await client.query(`
  SELECT count(*) as total,
    count(CASE WHEN postnr IS NOT NULL AND postnr != '' THEN 1 END) as med_postnr
  FROM bfe_adresse_cache
`);
console.log(`bfe_adresse_cache: ${stats[0].med_postnr}/${stats[0].total} med fuld adresse (${(stats[0].med_postnr / stats[0].total * 100).toFixed(1)}%)`);

await client.end();
