#!/usr/bin/env node
/**
 * BIZZ-2092: Diagnose scope of bfe_adresse_cache duplicate corruption.
 * Finds groups of 2+ BFEs sharing same (dawa_id) with kilde='cache_dar'.
 *
 * Usage: node scripts/diag-2092-scope.mjs --env=prod|preview
 */
import https from 'node:https';
import { config } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, '..', '.env.local') });

const TARGET_ENV = process.argv.find((x) => x.startsWith('--env='))?.split('=')[1] || 'prod';
const ENV_REFS = { dev: 'wkzwxfhyfmvglrqtmebw', preview: 'rlkjmqjxmkxuclehbrnl', prod: 'xsyldjqcntiygrtfcszm' };
const PROJECT_REF = ENV_REFS[TARGET_ENV];
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

function runSql(sql) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ query: sql });
    const req = https.request(
      { hostname: 'api.supabase.com', path: `/v1/projects/${PROJECT_REF}/database/query`, method: 'POST', headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' } },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); }
    );
    req.on('error', (e) => resolve({ message: e.message }));
    req.write(body); req.end();
  });
}

console.log(`=== BIZZ-2092 scope — env=${TARGET_ENV} ===`);

const total = await runSql(`SELECT count(*) AS n FROM bfe_adresse_cache WHERE kilde='cache_dar'`);
console.log('Total kilde=cache_dar rows:', JSON.stringify(total));

const dupGroups = await runSql(`
  SELECT count(*) AS groups, sum(n) AS rows
  FROM (
    SELECT dawa_id, count(*) AS n
    FROM bfe_adresse_cache
    WHERE kilde='cache_dar' AND dawa_id IS NOT NULL
    GROUP BY dawa_id HAVING count(*) > 1
  ) g`);
console.log('Duplicate dawa_id groups (kilde=cache_dar):', JSON.stringify(dupGroups));

const sample = await runSql(`
  SELECT dawa_id, adresse, postnr, count(*) AS n, array_agg(bfe_nummer ORDER BY bfe_nummer) AS bfes
  FROM bfe_adresse_cache
  WHERE kilde='cache_dar' AND dawa_id IS NOT NULL
  GROUP BY dawa_id, adresse, postnr HAVING count(*) > 1
  ORDER BY n DESC LIMIT 10`);
console.log('Top-10 groups:');
for (const r of Array.isArray(sample) ? sample : []) console.log(` ${r.n}x ${r.adresse} (${r.postnr}) dawa=${String(r.dawa_id).slice(0, 13)}… bfes=${JSON.stringify(r.bfes).slice(0, 120)}`);

const belvedere = await runSql(`
  SELECT bfe_nummer, adresse, postnr, kilde, dawa_id, sidst_opdateret
  FROM bfe_adresse_cache WHERE bfe_nummer IN (5322348,5322350,5322351,5322352,5322356,5322372)
  ORDER BY bfe_nummer`);
console.log('BELVEDERE rows:', JSON.stringify(belvedere, null, 1));

// Other kilder with dup dawa_id for context
const byKilde = await runSql(`
  SELECT kilde, count(*) AS rows FROM bfe_adresse_cache b
  WHERE dawa_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM bfe_adresse_cache b2 WHERE b2.dawa_id=b.dawa_id AND b2.bfe_nummer<>b.bfe_nummer AND b2.kilde='cache_dar'
  ) AND kilde='cache_dar'
  GROUP BY kilde ORDER BY rows DESC LIMIT 10`);
console.log('Dup rows by kilde:', JSON.stringify(byKilde));
