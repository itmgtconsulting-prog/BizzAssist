/**
 * Runs missing migrations on the PROD Supabase database via HTTP Management API.
 * Uses native fetch with proper JSON serialization.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'supabase', 'migrations');
const PROJECT_REF = 'xsyldjqcntiygrtfcszm';
const TOKEN = 'sbp_6fd8f5e06fbc6690ee03cdc1f8d450f194d8a5e1';
const API_URL = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

const MISSING = [
  '007_user_preferences_and_recents.sql',
  '008_support_questions.sql',
  '018_session_settings.sql',
  '019_plan_configs_ensure_columns.sql',
  '020_service_manager.sql',
  '021_service_manager_v2.sql',
  '023_rls_security_fixes.sql',
  '024_search_history_ttl.sql',
  '025_bbr_event_tracking.sql',
  '026_recent_entities_search_type.sql',
  '027_public_recent_entities.sql',
  '028_activity_log.sql',
  '029_support_chat.sql',
  '030_ai_token_usage.sql',
  '031_rls_fixes.sql',
  '032_tenant_knowledge.sql',
  '033_api_tokens.sql',
  '034_email_integrations.sql',
  '035_linkedin_integration.sql',
  '036_plan_configs_sort_order.sql',
];

async function runMigration(file) {
  const path = join(MIGRATIONS_DIR, file);
  if (!existsSync(path)) {
    console.log(`SKIP (not found): ${file}`);
    return;
  }

  const sql = readFileSync(path, 'utf8');
  const body = JSON.stringify({ query: sql });

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body,
  });

  if (res.ok) {
    console.log(`OK: ${file}`);
  } else {
    const text = await res.text();
    // If table already exists or column already exists, it's fine
    if (text.includes('already exists') || text.includes('duplicate column')) {
      console.log(`OK (already exists): ${file}`);
    } else {
      console.log(`ERR: ${file} — ${text.slice(0, 200)}`);
    }
  }
}

console.log('Running missing migrations on PROD...');
for (const file of MISSING) {
  await runMigration(file);
}
console.log('Done.');
