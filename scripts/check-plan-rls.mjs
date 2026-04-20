import { createClient } from '@supabase/supabase-js';
const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Try inserting a test plan directly via service role
const testRow = {
  plan_id: 'diagnostic-test-plan',
  name_da: 'Diagnostic',
  name_en: 'Diagnostic',
  desc_da: '',
  desc_en: '',
  color: 'blue',
  price_dkk: 0,
  ai_tokens_per_month: 0,
  duration_months: 1,
  duration_days: 0,
  token_accumulation_cap_multiplier: 5,
  ai_enabled: false,
  requires_approval: false,
  is_active: true,
  free_trial_days: 0,
  payment_grace_hours: 0,
  max_sales: null,
  sales_count: 0,
  sort_order: 99,
  updated_at: new Date().toISOString(),
};
const { error, data } = await c.from('plan_configs').insert(testRow).select();
console.log('insert error:', JSON.stringify(error, null, 2));
console.log('insert data:', data);
// Cleanup
if (!error) {
  await c.from('plan_configs').delete().eq('plan_id', 'diagnostic-test-plan');
}
