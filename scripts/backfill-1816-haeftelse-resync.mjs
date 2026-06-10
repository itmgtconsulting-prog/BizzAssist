#!/usr/bin/env node
/**
 * BIZZ-1816: Re-sync tinglysning_haeftelse for ~17K BFEer hvor hovedstol_dkk
 * eller kreditor_navn er NULL. Bruger /api/cron/sync-tinglysning-detail med
 * eksplicit BFE-liste (BIZZ-1827 ?bfes= parameter, max 500 per kald).
 *
 * Kører mod prod via bizzassist.dk så vi får BIZZ-1797 parser fix anvendt.
 */
import fs from 'fs';
import pg from 'pg';

const env = fs.readFileSync('/root/BizzAssist/.env.local', 'utf8');
const PROD = env.match(/^SUPABASE_PROD_DB_URL=(.+)$/m)?.[1];
const CRON_SECRET = env.match(/^CRON_SECRET=(.+)$/m)?.[1];
const BASE = process.argv.find(a => a.startsWith('--base='))?.split('=')[1] || 'https://bizzassist.dk';
const DRY = process.argv.includes('--dry-run');

const c = new pg.Client({ connectionString: PROD });
await c.connect();

const { rows } = await c.query(`
  SELECT DISTINCT bfe_nummer FROM tinglysning_haeftelse
  WHERE hovedstol_dkk IS NULL OR kreditor_navn IS NULL
  ORDER BY bfe_nummer
`);
const bfes = rows.map(r => r.bfe_nummer);
console.log(`[1816] Target: ${bfes.length} distinct BFE-numre`);
if (DRY) { await c.end(); process.exit(0); }

const BATCH = 500;
let processed = 0, totalHaeftelser = 0, errors = 0;
const start = Date.now();

for (let i = 0; i < bfes.length; i += BATCH) {
  const batch = bfes.slice(i, i + BATCH);
  const url = `${BASE}/api/cron/sync-tinglysning-detail?bfes=${batch.join(',')}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${CRON_SECRET}`, 'x-vercel-cron': '1' },
      signal: AbortSignal.timeout(540000), // 9 min, cron timeout is 10 min on vercel
    });
    const text = await res.text();
    if (res.ok) {
      const data = JSON.parse(text);
      processed += batch.length;
      totalHaeftelser += data.haeftelserUpserted ?? data.haeftelser_upserted ?? 0;
      const el = (Date.now() - start) / 1000;
      const eta = (bfes.length - processed) / (processed / el);
      console.log(`[1816] batch ${i}-${i+batch.length}: ${res.status} processed=${processed}/${bfes.length} haeftelser=${totalHaeftelser} eta=${(eta/60).toFixed(0)}min`);
    } else {
      errors++;
      console.warn(`[1816] batch ${i}: HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
  } catch (e) {
    errors++;
    console.warn(`[1816] batch ${i}: ${e.message}`);
  }
}

console.log(`\n[1816] DONE. processed=${processed}, haeftelser_upserted=${totalHaeftelser}, errors=${errors}`);

// Verify reduction
const r2 = await c.query(`SELECT COUNT(*) FROM tinglysning_haeftelse WHERE hovedstol_dkk IS NULL OR kreditor_navn IS NULL`);
console.log(`[1816] Remaining NULL rows: ${r2.rows[0].count} (var 48430 før)`);
await c.end();
