import { createClient } from '@supabase/supabase-js';
const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Replicate the route's safeInsertRow logic
async function safeInsertRow(admin, row) {
  const { error } = await admin.from('plan_configs').insert(row);
  if (!error) return { error: null };
  const missingCol = error?.code === 'PGRST204' ? error.message?.match(/'([^']+)'\s+column/)?.[1] : null;
  if (!missingCol) return { error };
  const { [missingCol]: _omit, ...rest } = row;
  void _omit;
  console.log(`[retry without '${missingCol}']`);
  const { error: retryErr } = await admin.from('plan_configs').insert(rest);
  return { error: retryErr };
}

const row = {
  plan_id: 'safe-insert-test-plan',
  name_da: 'Safe Insert Test',
  name_en: 'Safe Insert Test',
  desc_da: 'Diagnostic',
  desc_en: 'Diagnostic',
  color: 'orange',
  price_dkk: 10,
  ai_tokens_per_month: 0,
  duration_months: 0,
  duration_days: 1,
  token_accumulation_cap_multiplier: 5,
  ai_enabled: true,
  requires_approval: true,
  is_active: true,
  free_trial_days: 0,
  payment_grace_hours: 0,
  max_sales: null,
  sales_count: 0,
  sort_order: 99,
  updated_at: new Date().toISOString(),
};
const { error } = await safeInsertRow(c, row);
console.log('Final error:', error ?? 'NONE');
// Cleanup
if (!error) {
  await c.from('plan_configs').delete().eq('plan_id', 'safe-insert-test-plan');
  console.log('Cleanup OK');
}
