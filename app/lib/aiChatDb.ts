/**
 * BIZZ-1206: Helper til tenant-schema-scoped adgang til ai_chat
 * via RPC-funktioner (migration 096).
 *
 * Bruger SQL RPC i stedet for PostgREST schema-scoped queries
 * for at undgå afhængighed af PostgREST db_schema config.
 *
 * @module app/lib/aiChatDb
 */

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export interface AiChatDbContext {
  userId: string;
  tenantId: string;
  schemaName: string;

  /**
   * List chat sessions for the current user.
   */
  listSessions(opts?: { includeArchived?: boolean; limit?: number }): Promise<AiChatSession[]>;

  /**
   * Create a new chat session.
   */
  createSession(opts?: {
    title?: string;
    contextType?: string | null;
    contextId?: string | null;
  }): Promise<AiChatSession>;

  /**
   * Get a single session with its messages.
   */
  getSession(sessionId: string): Promise<{
    session: AiChatSession;
    messages: AiChatMessage[];
  } | null>;

  /**
   * Insert a message into a session.
   */
  insertMessage(opts: {
    sessionId: string;
    role: string;
    content: string;
    toolCalls?: unknown;
    tokenCount?: number;
  }): Promise<AiChatMessage>;

  /**
   * Update a session (title, archive).
   */
  updateSession(
    sessionId: string,
    opts: { title?: string; archive?: boolean }
  ): Promise<AiChatSession | null>;

  /**
   * Get messages since a timestamp (polling).
   */
  getMessagesSince(sessionId: string, since: string): Promise<AiChatMessage[]>;

  /**
   * Delete a session and its messages.
   */
  deleteSession(sessionId: string): Promise<boolean>;
}

export interface AiChatSession {
  id: string;
  tenant_id: string;
  user_id: string;
  title: string;
  context_type: string | null;
  context_id: string | null;
  last_msg_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AiChatMessage {
  id: string;
  session_id: string;
  role: string;
  content: string;
  tool_calls: unknown;
  token_count: number | null;
  created_at: string;
}

/**
 * Resolve current user's tenant + return RPC-based chat context.
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

    // Resolve tenant_id + schema_name via user-scoped client.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: membership, error: membershipError } = (await (supabase as any)
      .from('tenant_memberships')
      .select('tenant_id, tenants(schema_name)')
      .eq('user_id', user.id)
      .limit(1)
      .single()) as {
      data: { tenant_id: string; tenants: { schema_name: string } | null } | null;
      error: { message: string; code: string } | null;
    };
    if (membershipError) {
      console.warn(
        '[aiChatDb] membership query error:',
        membershipError.message,
        membershipError.code
      );
    }
    const schemaName = membership?.tenants?.schema_name;
    if (!membership?.tenant_id || !schemaName) {
      console.warn('[aiChatDb] no tenant for user', user.id, '— data:', JSON.stringify(membership));
      return null;
    }

    const admin = createAdminClient();
    const userId = user.id;
    const tenantId = membership.tenant_id;

    return {
      userId,
      tenantId,
      schemaName,

      async listSessions(opts = {}) {
        const { includeArchived = false, limit = 50 } = opts;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (admin.rpc as any)('ai_chat_list_sessions', {
          p_schema_name: schemaName,
          p_user_id: userId,
          p_include_archived: includeArchived,
          p_limit: Math.max(1, Math.min(limit, 200)),
        });
        if (error) throw new Error(`listSessions: ${error.message}`);
        return (data ?? []) as AiChatSession[];
      },

      async createSession(opts = {}) {
        const { title = 'Ny samtale', contextType = null, contextId = null } = opts;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (admin.rpc as any)('ai_chat_create_session', {
          p_schema_name: schemaName,
          p_tenant_id: tenantId,
          p_user_id: userId,
          p_title: title,
          p_context_type: contextType,
          p_context_id: contextId,
        });
        if (error) throw new Error(`createSession: ${error.message}`);
        return data as AiChatSession;
      },

      async getSession(sessionId: string) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (admin.rpc as any)('ai_chat_get_session', {
          p_schema_name: schemaName,
          p_session_id: sessionId,
          p_user_id: userId,
        });
        if (error) throw new Error(`getSession: ${error.message}`);
        if (!data) return null;
        return data as { session: AiChatSession; messages: AiChatMessage[] };
      },

      async insertMessage(opts) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (admin.rpc as any)('ai_chat_insert_message', {
          p_schema_name: schemaName,
          p_session_id: opts.sessionId,
          p_role: opts.role,
          p_content: opts.content,
          p_tool_calls: opts.toolCalls ?? null,
          p_token_count: opts.tokenCount ?? null,
        });
        if (error) throw new Error(`insertMessage: ${error.message}`);
        return data as AiChatMessage;
      },

      async updateSession(sessionId: string, opts) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (admin.rpc as any)('ai_chat_update_session', {
          p_schema_name: schemaName,
          p_session_id: sessionId,
          p_user_id: userId,
          p_title: opts.title ?? null,
          p_archived_at: null,
          p_set_archived: opts.archive ?? false,
        });
        if (error) throw new Error(`updateSession: ${error.message}`);
        return data as AiChatSession | null;
      },

      async getMessagesSince(sessionId: string, since: string) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (admin.rpc as any)('ai_chat_get_messages_since', {
          p_schema_name: schemaName,
          p_session_id: sessionId,
          p_since: since,
        });
        if (error) throw new Error(`getMessagesSince: ${error.message}`);
        return (data ?? []) as AiChatMessage[];
      },

      async deleteSession(sessionId: string) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (admin.rpc as any)('ai_chat_delete_session', {
          p_schema_name: schemaName,
          p_session_id: sessionId,
          p_user_id: userId,
        });
        if (error) throw new Error(`deleteSession: ${error.message}`);
        return data as boolean;
      },
    };
  } catch (err) {
    console.error('[aiChatDb] getAiChatDb exception:', err);
    return null;
  }
}
