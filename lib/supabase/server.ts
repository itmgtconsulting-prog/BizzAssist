/**
 * Supabase server client — lib/supabase/server.ts
 *
 * Use this in Server Components, Route Handlers, and Server Actions.
 * Reads and writes the session cookie to keep auth tokens fresh.
 *
 * ISO 27001 A.9 (Access Control): all queries run as the authenticated user,
 * meaning RLS policies are enforced automatically by Supabase.
 *
 * Usage (Server Component):
 *   import { createClient } from '@/lib/supabase/server'
 *   const supabase = await createClient()
 *   const { data: { user } } = await supabase.auth.getUser()
 *
 * Usage (Route Handler):
 *   import { createClient } from '@/lib/supabase/server'
 *   export async function GET() {
 *     const supabase = await createClient()
 *     ...
 *   }
 */

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

import type { Database } from '@/lib/supabase/types';

/**
 * Creates a Supabase client for server-side contexts (Server Components,
 * Route Handlers, Server Actions). Automatically manages the session cookie.
 *
 * Must be called inside a request context (not at module level).
 *
 * @returns Supabase server client typed against the Database schema
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        /**
         * Returns all cookies from the current request.
         * Used by Supabase to read the session token.
         */
        getAll() {
          return cookieStore.getAll();
        },

        /**
         * Sets cookies on the response to persist the refreshed session.
         * Called by Supabase when it refreshes an access token.
         *
         * @param cookiesToSet - Array of cookie name/value/option objects
         */
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // setAll is called from Server Components where cookies cannot be
            // mutated. The middleware handles token refresh in those cases.
          }
        },
      },
    }
  );
}
