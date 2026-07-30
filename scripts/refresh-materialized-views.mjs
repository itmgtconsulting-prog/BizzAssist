#!/usr/bin/env node
/**
 * Direct MV refresh via PG — bypasses Vercel function timeout.
 *
 * Vercel's 300s maxDuration is too short for 11 MVs sequentially.
 * This script runs from the dev-server crontab and refreshes each MV
 * with its own 5-min statement_timeout, so one slow view doesn't kill the rest.
 *
 * Crontab: 0 5 * * * /usr/bin/node /root/BizzAssist/scripts/refresh-materialized-views.mjs
 */
import fs from 'fs';
import pg from 'pg';

const envContent = fs.readFileSync('/root/BizzAssist/.env.local', 'utf8');
const DB_URL = envContent.match(/^SUPABASE_PROD_DB_URL=(.+)$/m)?.[1];
if (!DB_URL) { console.error('No SUPABASE_PROD_DB_URL'); process.exit(1); }

const VIEWS = [
  'mv_analyse_ejendom',
  'mv_analyse_virksomhed',
  'mv_ejendom_master',
  'mv_ejerskab_beriget',
  'mv_virksomhed_struktur',
  'mv_deltager_beriget',
  'mv_virksomhed_portefolje',
  'mv_kommune_statistik',
  'mv_boligpris_maaned',
  'mv_boligpris_handler',
  'mv_virksomhedshandel_kandidater',
];

async function main() {
  const client = new pg.Client({
    connectionString: DB_URL,
    statement_timeout: 600000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 30000,
  });
  await client.connect();

  let ok = 0, fail = 0;
  console.log(`[${ts()}] Starting MV refresh (${VIEWS.length} views)`);

  for (const view of VIEWS) {
    const start = Date.now();
    try {
      await client.query("SET LOCAL statement_timeout = '300000'");
      await client.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY public.${view}`);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`  [${ts()}] ✓ ${view} (${elapsed}s)`);
      ok++;
    } catch (concErr) {
      // CONCURRENTLY can fail if no unique index exists — fall back to regular
      try {
        await client.query("SET LOCAL statement_timeout = '300000'");
        await client.query(`REFRESH MATERIALIZED VIEW public.${view}`);
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`  [${ts()}] ✓ ${view} (${elapsed}s, fallback)`);
        ok++;
      } catch (err) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`  [${ts()}] ✗ ${view} FAILED (${elapsed}s): ${err.message.substring(0, 120)}`);
        fail++;
      }
    }
  }

  console.log(`[${ts()}] Done: ${ok} ok, ${fail} failed`);
  await client.end();
}

function ts() { return new Date().toISOString().slice(0, 19); }

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
