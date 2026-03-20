/**
 * Supabase admin client — lib/supabase/admin.ts
 *
 * ⚠️  RESTRICTED — SERVER-SIDE ONLY. NEVER import in Client Components.
 *
 * Uses the SERVICE_ROLE_KEY which bypasses ALL Row Level Security policies.
 * Only use for:
 *   - Tenant provisioning (creating new tenant schemas on signup)
 *   - Background jobs / cron tasks
 *   - Admin-only operations that cannot be done with the anon key
 *
 * ISO 27001 A.9 (Access Control) + A.14 (Secure Development):
 *   The service role key is Restricted-classified data. It must never be
 *   logged, exposed in error messages, or sent to the client.
 *
 * Usage (server-side only):
 *   import { createAdminClient } from '@/lib/supabase/admin'
 *   const supabase = createAdminClient()
 *   await supabase.from('tenants').insert({ ... })
 */

import { createClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/supabase/types';

/**
 * Creates a Supabase admin client with the service role key.
 * Bypasses RLS — use with extreme caution.
 * Auto-refresh and session persistence are disabled (stateless server use).
 *
 * @returns Supabase admin client with full database access
 * @throws If SUPABASE_SERVICE_ROLE_KEY is not set in environment
 */
export function createAdminClient() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!serviceRoleKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not set. ' +
        'This is required for admin operations. ' +
        'Add it to .env.local (never commit this value).'
    );
  }

  return createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceRoleKey, {
    auth: {
      // Disable session persistence — admin client is stateless
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
