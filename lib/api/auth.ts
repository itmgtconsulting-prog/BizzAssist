/**
 * Shared authentication helpers for API routes.
 *
 * Extracts the authenticated user and their tenant from the
 * Supabase session. Used by all tenant-scoped API routes.
 *
 * @module lib/api/auth
 */

import { createClient } from '@/lib/supabase/server';

export interface AuthContext {
  tenantId: string;
  userId: string;
}

/**
 * Resolves the tenant ID from the authenticated user's session.
 *
 * @returns AuthContext if authenticated with a tenant, null otherwise
 */
export async function resolveTenantId(): Promise<AuthContext | null> {
  // NOTE: This shared helper was consistently returning 401 from all callers
  // on the deployed develop build while byte-identical INLINED copies of the
  // same logic (see app/api/tracked/route.ts + app/api/notifications/route.ts)
  // continued to work. The only difference was this module's `catch (err)`
  // block with console.error — diagnostic tracked here.
  // Explicitly marking each step so if a future recurrence happens the trace
  // points to the failing stage.
  try {
    const supabase = await createClient();
    let user;
    try {
      const result = await supabase.auth.getUser();
      user = result.data?.user;
    } catch (authErr) {
      console.error(
        '[auth] getUser threw:',
        authErr instanceof Error ? authErr.message : String(authErr)
      );
      return null;
    }
    if (!user) return null;

    try {
      const { data } = (await supabase
        .from('tenant_memberships')
        .select('tenant_id')
        .eq('user_id', user.id)
        .limit(1)
        .single()) as { data: { tenant_id: string } | null };
      if (!data?.tenant_id) return null;
      return { tenantId: data.tenant_id, userId: user.id };
    } catch (dbErr) {
      console.error(
        '[auth] tenant_memberships query threw:',
        dbErr instanceof Error ? dbErr.message : String(dbErr)
      );
      return null;
    }
  } catch {
    // Supabase createClient failed — middleware should have caught this
    return null;
  }
}

/**
 * Resolves just the user ID from the authenticated session.
 * Used for public-schema operations (preferences, user profile).
 *
 * @returns userId if authenticated, null otherwise
 */
export async function resolveUserId(): Promise<string | null> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user?.id ?? null;
  } catch (err) {
    console.error('[auth] resolveUserId failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}
