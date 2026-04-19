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
  // Byte-identical to the working INLINED copies in app/api/tracked and
  // app/api/notifications. Some prior combination of try/catch branches in
  // this shared module was returning null reliably on Vercel's deploy while
  // the inlined versions kept working — swapping back to the minimal form
  // is the quickest route to restoring auth on all 81 call sites.
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    const { data } = (await supabase
      .from('tenant_memberships')
      .select('tenant_id')
      .eq('user_id', user.id)
      .limit(1)
      .single()) as { data: { tenant_id: string } | null };
    if (!data?.tenant_id) return null;
    return { tenantId: data.tenant_id, userId: user.id };
  } catch {
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
