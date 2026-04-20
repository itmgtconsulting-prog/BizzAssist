/**
 * Kør manglende migrations på Supabase-miljø via Management API.
 * Kører via fetch til /v1/projects/{ref}/database/query endpoint.
 *
 * Idempotent — hver migration bruger IF NOT EXISTS / DO-blocks.
 */
import fs from 'node:fs';
const token = process.env.SUPABASE_ACCESS_TOKEN;

// BIZZ-644: 040 + 043 er tenant-skema-skabeloner der refererer en literal
// 'tenant' schema (kun til stede på dev). Test/prod bruger tenant_<id>-
// pattern via provision_tenant_schema. Migration 051 backfiller tenant-
// scoped tabeller til alle eksisterende tenant_*-schemaer via ny
// provision_tenant_ai_tables-helper og sikrer nye tenants også får dem.
const envs = {
  dev: { ref: 'wkzwxfhyfmvglrqtmebw', migrations: ['040', '041', '042', '043', '045', '046', '047', '049', '050', '051'] },
  test: { ref: 'rlkjmqjxmkxuclehbrnl', migrations: ['041', '042', '045', '049', '050', '051'] },
  prod: { ref: 'xsyldjqcntiygrtfcszm', migrations: ['041', '042', '045', '049', '050', '051'] },
};

const migrationFiles = {
  '040': '040_ai_feedback_log.sql',
  '041': '041_cron_heartbeats.sql',
  '042': '042_consent_log.sql',
  '043': '043_notification_preferences.sql',
  '045': '045_plan_configs_payment_grace.sql',
  '046': '046_ejf_ejerskab_bulk.sql',
  '047': '047_ejf_ejerskab_id_text.sql',
  '049': '049_plan_configs_admin_write_rls.sql',
  '050': '050_service_manager_scan_types_extended.sql',
  '051': '051_tenant_ai_feedback_notification_backfill.sql',
};

async function runQuery(ref, sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const body = await r.text();
  return { status: r.status, body };
}

const targetEnv = process.argv[2];
if (!targetEnv || !envs[targetEnv]) {
  console.error('Usage: node run-migrations.mjs <dev|test|prod>');
  process.exit(1);
}

const { ref, migrations } = envs[targetEnv];
console.log(`\n=== Running migrations on ${targetEnv} (${ref}) ===\n`);

for (const mig of migrations) {
  const file = migrationFiles[mig];
  if (!file) continue;
  const sql = fs.readFileSync(`supabase/migrations/${file}`, 'utf8');
  console.log(`📦 ${file} (${sql.length} bytes)`);
  const result = await runQuery(ref, sql);
  if (result.status === 201 || result.status === 200) {
    console.log(`   ✅ OK (HTTP ${result.status})`);
  } else {
    console.log(`   ❌ HTTP ${result.status}`);
    console.log(`   body: ${result.body.slice(0, 400)}`);
    process.exit(1);
  }
}

console.log(`\n✅ Alle migrations kørt på ${targetEnv}`);
