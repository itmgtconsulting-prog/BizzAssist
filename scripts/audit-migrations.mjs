/**
 * Audit hvilke nyere migrations der mangler på det Supabase-miljø som
 * .env.local peger på. Tester tilstedeværelsen af specifikke kolonner
 * + tabeller der introduceres af migration 041+. Hvis en probe fejler
 * med PGRST204 (missing column) eller PGRST205 (missing table), er
 * migrationen ikke kørt.
 */
import { createClient } from '@supabase/supabase-js';
const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

console.log('Supabase URL:', process.env.NEXT_PUBLIC_SUPABASE_URL);
console.log('---');

const probes = [
  { migration: '039_service_manager_scan_types', check: async () => {
      const { error } = await c.from('service_manager_scans').select('scan_type').limit(1);
      return { ok: !error, detail: error?.message ?? 'table exists' };
  }},
  { migration: '040_ai_feedback_log', check: async () => {
      const { error } = await c.from('ai_feedback_log').select('id').limit(1);
      return { ok: !error, detail: error?.message ?? 'table exists' };
  }},
  { migration: '041_cron_heartbeats', check: async () => {
      const { error } = await c.from('cron_heartbeats').select('job_name').limit(1);
      return { ok: !error, detail: error?.message ?? 'table exists' };
  }},
  { migration: '042_consent_log', check: async () => {
      const { error } = await c.from('consent_log').select('id').limit(1);
      return { ok: !error, detail: error?.message ?? 'table exists' };
  }},
  { migration: '043_notification_preferences', check: async () => {
      const { error } = await c.from('notification_preferences').select('user_id').limit(1);
      return { ok: !error, detail: error?.message ?? 'table exists' };
  }},
  { migration: '044_regnskab_cache_rls', check: async () => {
      // RLS-migration er svært at teste uden insert-forsøg. Spring over.
      return { ok: 'skip', detail: 'RLS-only — manual verification' };
  }},
  { migration: '045_plan_configs_payment_grace', check: async () => {
      const { error } = await c.from('plan_configs').select('payment_grace_hours').limit(1);
      return { ok: !error, detail: error?.message ?? 'column exists' };
  }},
  { migration: '046_ejf_ejerskab_bulk', check: async () => {
      const { error } = await c.from('ejf_ejerskab').select('bfe_nummer').limit(1);
      return { ok: !error, detail: error?.message ?? 'table exists' };
  }},
  { migration: '047_ejf_ejerskab_id_text', check: async () => {
      // Columns introduced in 046, renamed/retyped in 047 — ejf_ejerskab_id text
      const { error } = await c.from('ejf_ejerskab').select('ejer_ejf_id').limit(1);
      return { ok: !error, detail: error?.message ?? 'column exists' };
  }},
  { migration: '048_ejf_ejerskab_navn_exact_idx', check: async () => {
      // Index-only migration, svært at teste uden pg_index. Skip.
      return { ok: 'skip', detail: 'index-only — pg_index query required' };
  }},
  { migration: '049_plan_configs_admin_write_rls', check: async () => {
      // Probe via insert + rollback
      const testRow = { plan_id: 'rls-audit-test', price_dkk: 0, ai_tokens_per_month: 0, duration_months: 1, name_da: 'x', name_en: 'x' };
      const { error } = await c.from('plan_configs').insert(testRow).select();
      if (!error) {
        await c.from('plan_configs').delete().eq('plan_id', 'rls-audit-test');
        return { ok: true, detail: 'insert allowed (write-policy present)' };
      }
      return { ok: false, detail: error.code + ' ' + error.message };
  }},
  { migration: '050_service_manager_scan_types_extended', check: async () => {
      // Trigger CHECK constraint via forsøg på insert med cron_failure
      const testRow = { scan_type: 'cron_failure', status: 'completed', issues_found: [], summary: 'audit probe' };
      const { error, data } = await c.from('service_manager_scans').insert(testRow).select();
      if (!error && data) {
        await c.from('service_manager_scans').delete().eq('id', data[0].id);
        return { ok: true, detail: 'cron_failure scan_type accepted' };
      }
      return { ok: false, detail: error?.code + ' ' + error?.message };
  }},
];

for (const p of probes) {
  try {
    const r = await p.check();
    const status = r.ok === true ? '✅' : r.ok === 'skip' ? '⏭️ ' : '❌';
    console.log(status + ' ' + p.migration.padEnd(42) + ' — ' + r.detail);
  } catch (e) {
    console.log('💥 ' + p.migration.padEnd(42) + ' — ' + (e?.message ?? e));
  }
}
