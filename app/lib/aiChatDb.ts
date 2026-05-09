/**
 * BIZZ-819 (sub af BIZZ-783): Helper til tenant-schema-scoped adgang
 * til ai_chat_sessions + ai_chat_messages.
 *
 * Centraliserer auth + tenant-resolve pattern så alle session-routes
 * kan genbruge: getAiChatDb() → { db, userId, tenantId, schemaName }.
 */

import { createClient } from '@/lib/supabase/server';
import { createAdminClient, tenantDb, type TenantDb } from '@/lib/supabase/admin';

export interface AiChatDbContext {
  /** Schema-scoped Supabase client (tenant-schema). */
  db: TenantDb;
  userId: string;
  tenantId: string;
  schemaName: string;
}

/**
 * Resolve current user's tenant + return schema-scoped DB client.
 * Null hvis user ikke er autentificeret eller ikke tilhører en tenant.
 *
 * Bruger samme auth-pattern som resolveTenantId() (user-scoped client
 * til membership-query) + admin-client til schema-lookup. Undgår
 * embedded PostgREST select der kan fejle i visse miljøer.
 *
 * @returns AiChatDbContext eller null
 */
export async function getAiChatDb(): Promise<AiChatDbContext | null> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      console.warn('[aiChatDb] no authenticated user');
      return null;
    }

    // Step 1: Resolve tenant_id via user-scoped client (same as resolveTenantId)
    const { data: membership, error: membershipError } = (await supabase
      .from('tenant_memberships')
      .select('tenant_id')
      .eq('user_id', user.id)
      .limit(1)
      .single()) as {
      data: { tenant_id: string } | null;
      error: { message: string } | null;
    };
    if (membershipError) {
      console.warn('[aiChatDb] membership query error:', membershipError.message);
    }
    if (!membership?.tenant_id) {
      console.warn('[aiChatDb] no tenant for user', user.id);
      return null;
    }

    // Step 2: Resolve schema_name via admin client (service_role bypasses RLS)
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: tenant } = (await (admin as any)
      .from('tenants')
      .select('schema_name')
      .eq('id', membership.tenant_id)
      .single()) as { data: { schema_name: string } | null };
    if (!tenant?.schema_name) {
      console.warn('[aiChatDb] no schema_name for tenant', membership.tenant_id);
      return null;
    }

    return {
      db: tenantDb(tenant.schema_name),
      userId: user.id,
      tenantId: membership.tenant_id,
      schemaName: tenant.schema_name,
    };
  } catch (err) {
    console.error('[aiChatDb] getAiChatDb exception:', err);
    return null;
  }
}
