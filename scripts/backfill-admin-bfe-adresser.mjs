#!/usr/bin/env node
/**
 * BIZZ-1817: Backfill bfe_adresse_cache for admin-BFE'er der mangler adresse.
 *
 * Two-phase approach:
 *   Phase 1: Fix 9K+ partial addresses (have dawa_id but missing postnr/vejnavn)
 *   Phase 2: Resolve completely missing BFEs via DAWA jordstykke lookup
 *
 * Usage:
 *   node scripts/backfill-admin-bfe-adresser.mjs [--limit=5000] [--dry-run] [--phase=1|2]
 */
import pg from 'pg';
import { config } from 'dotenv';
config({ path: '/root/BizzAssist/.env.local' });

const args = process.argv.slice(2);
const LIMIT = (() => { const a = args.find(x => x.startsWith('--limit=')); return a ? parseInt(a.split('=')[1], 10) : 10000; })();
const DRY_RUN = args.includes('--dry-run');
const PHASE = (() => { const a = args.find(x => x.startsWith('--phase=')); return a ? parseInt(a.split('=')[1], 10) : 0; })();

const client = new pg.Client({ connectionString: process.env.SUPABASE_PROD_DB_URL, statement_timeout: 30000 });
await client.connect();

/**
 * Fetch DAWA adgangsadresse by UUID and return parsed address.
 *
 * @param {string} dawaId - Adgangsadresse UUID
 * @returns {object|null} Parsed address or null
 */
async function fetchDawaAddress(dawaId) {
  try {
    const res = await fetch(`https://dawa.aws.dk/adgangsadresser/${dawaId}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const vejnavn = data.vejstykke?.navn || '';
    const husnr = data.husnr || '';
    return {
      adresse: vejnavn ? `${vejnavn} ${husnr}`.trim() : null,
      postnr: String(data.postnummer?.nr || ''),
      postnrnavn: data.postnummer?.navn || '',
      kommune: data.kommune?.navn || '',
      kommune_kode: String(data.kommune?.kode || '').padStart(4, '0'),
      dawa_id: dawaId,
    };
  } catch {
    return null;
  }
}

/**
 * Try to find address for a BFE via DAWA jordstykke → adgangsadresse chain.
 *
 * @param {number} bfeNummer - BFE number
 * @returns {object|null} Parsed address or null
 */
async function fetchAddressViaBfe(bfeNummer) {
  try {
    const res = await fetch(`https://dawa.aws.dk/jordstykker?bfenummer=${bfeNummer}&format=json`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const jordstykker = await res.json();
    if (!jordstykker || jordstykker.length === 0) return null;

    const ejerlav = jordstykker[0].ejerlav?.kode;
    const matrikelnr = jordstykker[0].matrikelnr;
    if (!ejerlav || !matrikelnr) return null;

    const addrRes = await fetch(
      `https://dawa.aws.dk/adgangsadresser?jordstykke_ejerlav=${ejerlav}&jordstykke_matrikelnr=${matrikelnr}&format=json`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!addrRes.ok) return null;
    const addresses = await addrRes.json();
    if (!addresses || addresses.length === 0) return null;

    const addr = addresses[0];
    const vejnavn = addr.vejstykke?.navn || '';
    const husnr = addr.husnr || '';
    return {
      adresse: vejnavn ? `${vejnavn} ${husnr}`.trim() : null,
      postnr: String(addr.postnummer?.nr || ''),
      postnrnavn: addr.postnummer?.navn || '',
      kommune: addr.kommune?.navn || '',
      kommune_kode: String(addr.kommune?.kode || '').padStart(4, '0'),
      dawa_id: addr.id,
    };
  } catch {
    return null;
  }
}

/**
 * Upsert address into bfe_adresse_cache.
 *
 * @param {number} bfeNummer - BFE number
 * @param {object} addr - Parsed address
 * @param {string} kilde - Source identifier
 */
async function upsertAddress(bfeNummer, addr, kilde) {
  await client.query(`
    INSERT INTO bfe_adresse_cache (bfe_nummer, adresse, etage, doer, postnr, postnrnavn, kommune, kommune_kode, dawa_id, kilde, sidst_opdateret)
    VALUES ($1, $2, NULL, NULL, $3, $4, $5, $6, $7, $8, NOW())
    ON CONFLICT (bfe_nummer) DO UPDATE SET
      adresse = EXCLUDED.adresse,
      postnr = EXCLUDED.postnr,
      postnrnavn = EXCLUDED.postnrnavn,
      kommune = EXCLUDED.kommune,
      kommune_kode = EXCLUDED.kommune_kode,
      dawa_id = EXCLUDED.dawa_id,
      kilde = EXCLUDED.kilde,
      sidst_opdateret = NOW()
  `, [bfeNummer, addr.adresse, addr.postnr, addr.postnrnavn, addr.kommune, addr.kommune_kode, addr.dawa_id, kilde]);
}

// ── Phase 1: Fix partial addresses ─────────────────────────────────────────

async function phase1() {
  console.log('=== Phase 1: Fix partial addresses (have dawa_id, missing postnr/vejnavn) ===\n');

  const { rows } = await client.query(`
    SELECT c.bfe_nummer, c.dawa_id
    FROM ejf_administrator a
    INNER JOIN bfe_adresse_cache c ON a.bfe_nummer = c.bfe_nummer
    WHERE a.virksomhed_cvr IS NOT NULL AND a.status = 'gældende'
      AND c.dawa_id IS NOT NULL
      AND (c.postnr IS NULL OR c.postnr = '')
    ORDER BY c.bfe_nummer
    LIMIT $1
  `, [LIMIT]);

  console.log(`Found ${rows.length} admin BFEs with partial address\n`);

  let resolved = 0, failed = 0;
  const startTime = Date.now();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const addr = await fetchDawaAddress(row.dawa_id);

    if (addr && addr.adresse && addr.postnr) {
      if (!DRY_RUN) {
        await upsertAddress(Number(row.bfe_nummer), addr, 'backfill_admin_fix');
      }
      resolved++;
    } else {
      failed++;
    }

    // Rate limit to DAWA
    await new Promise(r => setTimeout(r, 150));

    if ((i + 1) % 100 === 0 || i === rows.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = ((i + 1) / (elapsed || 1)).toFixed(1);
      console.log(`  [${i + 1}/${rows.length}] resolved=${resolved} failed=${failed} ${rate}/s (${elapsed}s)`);
    }
  }

  console.log(`\nPhase 1 done: resolved=${resolved} failed=${failed}`);
  return resolved;
}

// ── Phase 2: Resolve completely missing BFEs ───────────────────────────────

async function phase2() {
  console.log('=== Phase 2: Resolve missing admin BFEs via DAWA jordstykke ===\n');

  const { rows } = await client.query(`
    SELECT DISTINCT a.bfe_nummer, b.adgangsadresse_id
    FROM ejf_administrator a
    LEFT JOIN bfe_adresse_cache c ON a.bfe_nummer = c.bfe_nummer
    LEFT JOIN bbr_ejendom_status b ON a.bfe_nummer = b.bfe_nummer
    WHERE a.virksomhed_cvr IS NOT NULL AND a.status = 'gældende'
      AND c.bfe_nummer IS NULL
    ORDER BY a.bfe_nummer
    LIMIT $1
  `, [LIMIT]);

  console.log(`Found ${rows.length} admin BFEs without any cached address\n`);

  let resolved = 0, failed = 0;
  const startTime = Date.now();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let addr = null;

    // Try bbr_ejendom_status adgangsadresse_id first
    if (row.adgangsadresse_id) {
      addr = await fetchDawaAddress(row.adgangsadresse_id);
    }

    // Fallback: DAWA jordstykke lookup
    if (!addr) {
      addr = await fetchAddressViaBfe(Number(row.bfe_nummer));
    }

    if (addr && addr.adresse && addr.postnr) {
      if (!DRY_RUN) {
        await upsertAddress(Number(row.bfe_nummer), addr, 'backfill_admin_new');
      }
      resolved++;
    } else {
      failed++;
    }

    await new Promise(r => setTimeout(r, 200));

    if ((i + 1) % 50 === 0 || i === rows.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = ((i + 1) / (elapsed || 1)).toFixed(1);
      console.log(`  [${i + 1}/${rows.length}] resolved=${resolved} failed=${failed} ${rate}/s (${elapsed}s)`);
    }
  }

  console.log(`\nPhase 2 done: resolved=${resolved} failed=${failed}`);
  return resolved;
}

// ── Run ────────────────────────────────────────────────────────────────────

if (PHASE === 0 || PHASE === 1) await phase1();
if (PHASE === 0 || PHASE === 2) await phase2();

// Final stats
const { rows: stats } = await client.query(`
  SELECT
    count(DISTINCT a.bfe_nummer) as total_admin_bfe,
    count(DISTINCT CASE WHEN c.bfe_nummer IS NOT NULL AND c.postnr IS NOT NULL AND c.postnr != '' THEN a.bfe_nummer END) as med_fuld_adresse,
    count(DISTINCT CASE WHEN c.bfe_nummer IS NOT NULL THEN a.bfe_nummer END) as med_nogen_adresse
  FROM ejf_administrator a
  LEFT JOIN bfe_adresse_cache c ON a.bfe_nummer = c.bfe_nummer
  WHERE a.virksomhed_cvr IS NOT NULL AND a.status = 'gældende'
`);
console.log(`\n=== Final stats ===`);
console.log(`Admin BFE med fuld adresse: ${stats[0].med_fuld_adresse}/${stats[0].total_admin_bfe} (${(stats[0].med_fuld_adresse / stats[0].total_admin_bfe * 100).toFixed(1)}%)`);
console.log(`Admin BFE med nogen adresse: ${stats[0].med_nogen_adresse}/${stats[0].total_admin_bfe} (${(stats[0].med_nogen_adresse / stats[0].total_admin_bfe * 100).toFixed(1)}%)`);

await client.end();
