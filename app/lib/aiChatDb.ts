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

    // Service-role client til join med public.tenants (RLS-sikret)
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: membership, error: membershipError } = (await (admin as any)
      .from('tenant_memberships')
      .select('tenant_id, tenants(schema_name)')
      .eq('user_id', user.id)
      .limit(1)
      .single()) as {
      data: { tenant_id: string; tenants: { schema_name: string } | null } | null;
      error: { message: string } | null;
    };
    if (membershipError) {
      console.warn('[aiChatDb] membership query error:', membershipError.message);
    }
    const schemaName = membership?.tenants?.schema_name;
    if (!membership?.tenant_id || !schemaName) {
      console.warn('[aiChatDb] no tenant for user', user.id, '— membership:', membership);
      return null;
    }

    return {
      db: tenantDb(schemaName),
      userId: user.id,
      tenantId: membership.tenant_id,
      schemaName,
    };
  } catch (err) {
    // BIZZ-1214: Log fejl så vi kan debugge persistenceError-banneret
    console.error('[aiChatDb] getAiChatDb exception:', err);
    return null;
  }
}
