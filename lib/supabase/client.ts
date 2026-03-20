/**
 * Supabase browser client — lib/supabase/client.ts
 *
 * Use this in Client Components ('use client') only.
 * Handles user sessions via browser cookies automatically.
 *
 * ISO 27001 A.9 (Access Control): uses the anon key — all access is
 * governed by Row Level Security policies at the database layer.
 *
 * Usage:
 *   'use client'
 *   import { createClient } from '@/lib/supabase/client'
 *   const supabase = createClient()
 *   const { data } = await supabase.from('...').select()
 */

import { createBrowserClient } from '@supabase/ssr';

import type { Database } from '@/lib/supabase/types';

/**
 * Creates a Supabase client for use in browser (client-side) contexts.
 * Safe to call multiple times — creates a new instance each call.
 * Uses the public anon key; all data access enforced by RLS.
 *
 * @returns Supabase browser client typed against the Database schema
 */
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
