import { createClient } from '@supabase/supabase-js';
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const c = createClient(url, key);
const { data, error } = await c.from('cron_heartbeats').select('job_name, last_run_at, last_status, last_duration_ms, last_error').limit(20);
console.log('error:', error);
console.log('rows:', data?.length ?? 0);
console.log(JSON.stringify(data, null, 2));
