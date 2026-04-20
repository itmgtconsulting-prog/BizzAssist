import { createClient } from '@supabase/supabase-js';
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const c = createClient(url, key);
// Try listing schema migrations
const { data, error } = await c.from('schema_migrations').select('*').order('version', { ascending: false }).limit(20);
console.log('error:', error?.message);
console.log(JSON.stringify(data?.slice(0,20), null, 2));
