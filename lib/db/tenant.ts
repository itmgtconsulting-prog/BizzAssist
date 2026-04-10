/**
 * Tenant-scoped database client factory — lib/db/tenant.ts
 *
 * SERVER-SIDE ONLY. Never import this in Client Components or
 * browser-side code. It uses the Supabase server client which
 * requires cookies(), and the admin client which holds the
 * service role key.
 *
 * ── How tenant isolation works ──────────────────────────────
 * Each BizzAssist customer gets a dedicated PostgreSQL schema:
 *   public schema   → shared data (users, tenants, plans…)
 *   tenant_[uuid]   → per-company isolated tables
 *
 * Data access goes through SECURITY DEFINER RPC functions so
 * PostgREST does not need to enumerate dynamic schema names.
 * For direct schema queries (admin operations), the service-role
 * admin client is used server-side with an explicit schema prefix.
 *
 * ── Usage (Server Component / Server Action / Route Handler) ─
 *
 *   import { getTenantContext } from '@/lib/db/tenant';
 *
 *   const ctx = await getTenantContext(tenantId);
 *   const entities = await ctx.savedEntities.list();
 *   await ctx.auditLog.write({ action: 'entity.saved', … });
 *
 * ISO 27001: A.9 (Access Control) — every function verifies the
 * calling user is a member of the requested tenant before any
 * query is executed. Tenant ID is always taken from the validated
 * auth session, never from user-supplied input.
 *
 * @module lib/db/tenant
 */

import { createClient as createServerClient } from '@/lib/supabase/server';
import { createAdminClient, type TenantDb } from '@/lib/supabase/admin';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Role a user can hold within a tenant */
export type TenantRole = 'tenant_admin' | 'tenant_member' | 'tenant_viewer';

/** Resolved tenant context — returned by getTenantContext() */
export type TenantContext = {
  tenantId: string;
  schemaName: string;
  role: TenantRole;
  /** Saved entities API (companies, properties, people) */
  savedEntities: SavedEntitiesApi;
  /** Saved searches API */
  savedSearches: SavedSearchesApi;
  /** Reports API */
  reports: ReportsApi;
  /** AI conversations API */
  aiConversations: AiConversationsApi;
  /** Property snapshots for change detection (cron job) */
  propertySnapshots: PropertySnapshotsApi;
  /** User-facing notifications */
  notifications: NotificationsApi;
  /** Audit log (write-only from application code) */
  auditLog: AuditLogApi;
};

// Row types matching migration 004 tables

export type EntityType = 'company' | 'property' | 'person';
export type EntityTypeAll = EntityType | 'all';
export type ReportType =
  | 'company_analysis'
  | 'property_report'
  | 'person_report'
  | 'market_overview'
  | 'custom';
export type AiRole = 'user' | 'assistant' | 'system';

export type SavedEntity = {
  id: string;
  tenant_id: string;
  entity_type: EntityType;
  entity_id: string;
  entity_data: Record<string, unknown>;
  is_monitored: boolean;
  label: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type SavedSearch = {
  id: string;
  tenant_id: string;
  query: string;
  filters: Record<string, unknown>;
  entity_type: EntityTypeAll;
  result_count: number | null;
  created_by: string;
  created_at: string;
};

export type Report = {
  id: string;
  tenant_id: string;
  title: string;
  report_type: ReportType;
  entity_type: EntityType | null;
  entity_id: string | null;
  content: Record<string, unknown>;
  is_exported: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type AiConversation = {
  id: string;
  tenant_id: string;
  title: string | null;
  is_shared: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type AiMessage = {
  id: string;
  tenant_id: string;
  conversation_id: string;
  role: AiRole;
  content: string;
  tokens_used: number | null;
  created_at: string;
};

export type AuditLogEntry = {
  id: string;
  tenant_id: string;
  user_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
};

export type WriteAuditEntry = {
  action: string;
  resource_type: string;
  resource_id?: string;
  metadata?: Record<string, unknown>;
  ip_address?: string;
};

/** Snapshot type for property change detection */
export type SnapshotType = 'bbr' | 'vurdering' | 'ejerskab' | 'energi' | 'plan' | 'cvr';

/** Notification type for property changes */
export type NotificationType =
  | 'bbr_change'
  | 'vurdering_change'
  | 'ejerskifte'
  | 'energi_change'
  | 'plan_change'
  | 'cvr_change'
  | 'generel';

export type PropertySnapshot = {
  id: string;
  tenant_id: string;
  entity_id: string;
  snapshot_type: SnapshotType;
  snapshot_hash: string;
  snapshot_data: Record<string, unknown>;
  created_at: string;
};

export type Notification = {
  id: string;
  tenant_id: string;
  user_id: string;
  entity_id: string;
  entity_type: 'property' | 'company' | 'person';
  notification_type: NotificationType;
  title: string;
  message: string;
  metadata: Record<string, unknown> | null;
  is_read: boolean;
  created_at: string;
};

// ---------------------------------------------------------------------------
// Tenant API interfaces
// ---------------------------------------------------------------------------

interface SavedEntitiesApi {
  list(opts?: { entity_type?: EntityType; monitored_only?: boolean }): Promise<SavedEntity[]>;
  get(id: string): Promise<SavedEntity | null>;
  upsert(
    data: Omit<SavedEntity, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>
  ): Promise<SavedEntity>;
  delete(id: string): Promise<void>;
}

interface SavedSearchesApi {
  list(): Promise<SavedSearch[]>;
  create(data: Omit<SavedSearch, 'id' | 'tenant_id' | 'created_at'>): Promise<SavedSearch>;
  delete(id: string): Promise<void>;
}

interface ReportsApi {
  list(opts?: { entity_type?: EntityType }): Promise<Report[]>;
  get(id: string): Promise<Report | null>;
  create(
    data: Omit<Report, 'id' | 'tenant_id' | 'created_at' | 'updated_at' | 'is_exported'>
  ): Promise<Report>;
  update(
    id: string,
    data: Partial<Pick<Report, 'title' | 'content' | 'is_exported'>>
  ): Promise<Report>;
  delete(id: string): Promise<void>;
}

interface AiConversationsApi {
  list(): Promise<AiConversation[]>;
  get(id: string): Promise<AiConversation | null>;
  create(data: { title?: string; is_shared?: boolean }): Promise<AiConversation>;
  addMessage(
    conversationId: string,
    role: AiRole,
    content: string,
    tokensUsed?: number
  ): Promise<AiMessage>;
  getMessages(conversationId: string): Promise<AiMessage[]>;
  delete(id: string): Promise<void>;
}

interface AuditLogApi {
  write(entry: WriteAuditEntry): Promise<void>;
  list(opts?: { limit?: number }): Promise<AuditLogEntry[]>;
}

interface PropertySnapshotsApi {
  /** Hent seneste snapshot for en ejendom og type */
  getLatest(entityId: string, snapshotType: SnapshotType): Promise<PropertySnapshot | null>;
  /** Opret nyt snapshot (service_role only — bruges af cron job) */
  create(
    data: Omit<PropertySnapshot, 'id' | 'tenant_id' | 'created_at'>
  ): Promise<PropertySnapshot>;
}

interface NotificationsApi {
  /** Hent notifikationer for den aktuelle bruger */
  list(opts?: { unread_only?: boolean; limit?: number }): Promise<Notification[]>;
  /** Antal ulæste notifikationer */
  countUnread(): Promise<number>;
  /** Marker én notifikation som læst */
  markAsRead(id: string): Promise<void>;
  /** Marker alle notifikationer som læst */
  markAllAsRead(): Promise<void>;
  /** Slet læste notifikationer */
  deleteRead(): Promise<void>;
  /** Opret notifikation (service_role only — bruges af cron job) */
  create(
    data: Omit<Notification, 'id' | 'tenant_id' | 'created_at' | 'is_read'>
  ): Promise<Notification>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns an admin client pre-scoped to the given tenant schema.
 *
 * The `Database` generic only knows about the `public` schema, so we cast
 * here to allow dynamic schema names. The cast is safe: the schema name is
 * validated by provision_tenant_schema() and always matches `tenant_[a-z0-9]+`.
 *
 * @internal
 */
function tenantDb(admin: ReturnType<typeof createAdminClient>, schemaName: string): TenantDb {
  // Cast the dynamic schema name to 'tenant' — the representative key in Database type.
  // At runtime the actual schema name (e.g. 'tenant_abc123') is used; the cast only
  // satisfies TypeScript so callers receive a typed PostgREST client.
  return admin.schema(schemaName as 'tenant');
}

// ---------------------------------------------------------------------------
// Access verification
// ---------------------------------------------------------------------------

/**
 * Verifies the current authenticated user is a member of the given tenant.
 * Throws if the user has no membership — never silently allows access.
 *
 * @param tenantId - The tenant UUID from public.tenants
 * @returns The user's role within the tenant
 * @throws Error if user is not authenticated or not a member of the tenant
 */
export async function verifyTenantAccess(tenantId: string): Promise<TenantRole> {
  const supabase = await createServerClient();

  // Always use getUser() not getSession() — validates JWT server-side
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    throw new Error('Not authenticated');
  }

  const { data: membership, error } = await supabase
    .from('tenant_memberships')
    .select('role')
    .eq('tenant_id', tenantId)
    .eq('user_id', user.id)
    .single<{ role: TenantRole }>();

  if (error || !membership) {
    throw new Error(`Access denied: user ${user.id} is not a member of tenant ${tenantId}`);
  }

  return membership.role;
}

/**
 * Looks up the schema name for a tenant.
 *
 * @param tenantId - The tenant UUID
 * @returns The schema name (e.g. 'tenant_abc123')
 * @throws Error if tenant not found
 */
export async function getTenantSchemaName(tenantId: string): Promise<string> {
  const supabase = await createServerClient();

  const { data: tenant, error } = await supabase
    .from('tenants')
    .select('schema_name')
    .eq('id', tenantId)
    .single<{ schema_name: string }>();

  if (error || !tenant) {
    throw new Error(`Tenant not found: ${tenantId}`);
  }

  return tenant.schema_name;
}

// ---------------------------------------------------------------------------
// Tenant context factory
// ---------------------------------------------------------------------------

/**
 * Returns a fully typed, access-verified tenant context.
 *
 * This is the main entry point for all tenant data access.
 * It verifies the calling user is a member of the tenant,
 * then returns an API object scoped to that tenant's schema.
 *
 * IMPORTANT: tenantId MUST come from the validated auth session
 * (e.g. from a cookie or a JWT claim), never from URL params
 * or request bodies. ISO 27001 A.9.
 *
 * @param tenantId - UUID of the tenant (from auth session)
 * @returns TenantContext with typed API for all tenant tables
 *
 * @example
 * // In a Server Action:
 * const ctx = await getTenantContext(session.tenantId);
 * const entities = await ctx.savedEntities.list({ entity_type: 'company' });
 * await ctx.auditLog.write({ action: 'entity.listed', resource_type: 'saved_entity' });
 */
export async function getTenantContext(tenantId: string): Promise<TenantContext> {
  // Step 1: Verify access — throws if not a member
  const role = await verifyTenantAccess(tenantId);

  // Step 2: Get schema name
  const schemaName = await getTenantSchemaName(tenantId);

  // Step 3: Admin client for schema-specific queries
  // The admin client bypasses RLS (service_role) — safe here because
  // we have already verified membership above. All queries still include
  // explicit tenant_id filters as defence-in-depth.
  const admin = createAdminClient();

  // ── Saved Entities ─────────────────────────────────────────
  const savedEntities: SavedEntitiesApi = {
    async list({ entity_type, monitored_only } = {}) {
      let q = tenantDb(admin, schemaName)
        .from('saved_entities')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false });
      if (entity_type) q = q.eq('entity_type', entity_type);
      if (monitored_only) q = q.eq('is_monitored', true);
      const { data, error } = await q;
      if (error) throw new Error(`saved_entities.list: ${error.message}`);
      return (data ?? []) as SavedEntity[];
    },

    async get(id) {
      const { data, error } = await tenantDb(admin, schemaName)
        .from('saved_entities')
        .select('*')
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .single();
      if (error) return null;
      return data as SavedEntity;
    },

    async upsert(payload) {
      const { data, error } = await tenantDb(admin, schemaName)
        .from('saved_entities')
        .upsert(
          { ...payload, tenant_id: tenantId },
          { onConflict: 'tenant_id,entity_type,entity_id' }
        )
        .select()
        .single();
      if (error) throw new Error(`saved_entities.upsert: ${error.message}`);
      return data as SavedEntity;
    },

    async delete(id) {
      const { error } = await tenantDb(admin, schemaName)
        .from('saved_entities')
        .delete()
        .eq('id', id)
        .eq('tenant_id', tenantId);
      if (error) throw new Error(`saved_entities.delete: ${error.message}`);
    },
  };

  // ── Saved Searches ─────────────────────────────────────────
  const savedSearches: SavedSearchesApi = {
    async list() {
      const { data, error } = await tenantDb(admin, schemaName)
        .from('saved_searches')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false });
      if (error) throw new Error(`saved_searches.list: ${error.message}`);
      return (data ?? []) as SavedSearch[];
    },

    async create(payload) {
      const { data, error } = await tenantDb(admin, schemaName)
        .from('saved_searches')
        .insert({ ...payload, tenant_id: tenantId })
        .select()
        .single();
      if (error) throw new Error(`saved_searches.create: ${error.message}`);
      return data as SavedSearch;
    },

    async delete(id) {
      const { error } = await tenantDb(admin, schemaName)
        .from('saved_searches')
        .delete()
        .eq('id', id)
        .eq('tenant_id', tenantId);
      if (error) throw new Error(`saved_searches.delete: ${error.message}`);
    },
  };

  // ── Reports ────────────────────────────────────────────────
  const reports: ReportsApi = {
    async list({ entity_type } = {}) {
      let q = tenantDb(admin, schemaName)
        .from('reports')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false });
      if (entity_type) q = q.eq('entity_type', entity_type);
      const { data, error } = await q;
      if (error) throw new Error(`reports.list: ${error.message}`);
      return (data ?? []) as Report[];
    },

    async get(id) {
      const { data, error } = await tenantDb(admin, schemaName)
        .from('reports')
        .select('*')
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .single();
      if (error) return null;
      return data as Report;
    },

    async create(payload) {
      const { data, error } = await tenantDb(admin, schemaName)
        .from('reports')
        .insert({ ...payload, tenant_id: tenantId, is_exported: false })
        .select()
        .single();
      if (error) throw new Error(`reports.create: ${error.message}`);
      return data as Report;
    },

    async update(id, updates) {
      const { data, error } = await tenantDb(admin, schemaName)
        .from('reports')
        .update(updates)
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .select()
        .single();
      if (error) throw new Error(`reports.update: ${error.message}`);
      return data as Report;
    },

    async delete(id) {
      const { error } = await tenantDb(admin, schemaName)
        .from('reports')
        .delete()
        .eq('id', id)
        .eq('tenant_id', tenantId);
      if (error) throw new Error(`reports.delete: ${error.message}`);
    },
  };

  // ── AI Conversations ───────────────────────────────────────
  const aiConversations: AiConversationsApi = {
    async list() {
      const { data, error } = await tenantDb(admin, schemaName)
        .from('ai_conversations')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('updated_at', { ascending: false });
      if (error) throw new Error(`ai_conversations.list: ${error.message}`);
      return (data ?? []) as AiConversation[];
    },

    async get(id) {
      const { data, error } = await tenantDb(admin, schemaName)
        .from('ai_conversations')
        .select('*')
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .single();
      if (error) return null;
      return data as AiConversation;
    },

    async create({ title, is_shared = false }) {
      const supabase = await createServerClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await tenantDb(admin, schemaName)
        .from('ai_conversations')
        .insert({ tenant_id: tenantId, title: title ?? null, is_shared, created_by: user.id })
        .select()
        .single();
      if (error) throw new Error(`ai_conversations.create: ${error.message}`);
      return data as AiConversation;
    },

    async addMessage(conversationId, role, content, tokensUsed) {
      const { data, error } = await tenantDb(admin, schemaName)
        .from('ai_messages')
        .insert({
          tenant_id: tenantId,
          conversation_id: conversationId,
          role,
          content,
          tokens_used: tokensUsed ?? null,
        })
        .select()
        .single();
      if (error) throw new Error(`ai_messages.insert: ${error.message}`);
      return data as AiMessage;
    },

    async getMessages(conversationId) {
      const { data, error } = await tenantDb(admin, schemaName)
        .from('ai_messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: true });
      if (error) throw new Error(`ai_messages.list: ${error.message}`);
      return (data ?? []) as AiMessage[];
    },

    async delete(id) {
      const { error } = await tenantDb(admin, schemaName)
        .from('ai_conversations')
        .delete()
        .eq('id', id)
        .eq('tenant_id', tenantId);
      if (error) throw new Error(`ai_conversations.delete: ${error.message}`);
    },
  };

  // ── Property Snapshots ──────────────────────────────────────
  const propertySnapshots: PropertySnapshotsApi = {
    async getLatest(entityId, snapshotType) {
      const { data, error } = await tenantDb(admin, schemaName)
        .from('property_snapshots')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('entity_id', entityId)
        .eq('snapshot_type', snapshotType)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`property_snapshots.getLatest: ${error.message}`);
      return data as PropertySnapshot | null;
    },

    async create(payload) {
      const { data, error } = await tenantDb(admin, schemaName)
        .from('property_snapshots')
        .insert({ ...payload, tenant_id: tenantId })
        .select()
        .single();
      if (error) throw new Error(`property_snapshots.create: ${error.message}`);
      return data as PropertySnapshot;
    },
  };

  // ── Notifications ──────────────────────────────────────────
  const notifications: NotificationsApi = {
    async list({ unread_only, limit = 50 } = {}) {
      let q = tenantDb(admin, schemaName)
        .from('notifications')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (unread_only) q = q.eq('is_read', false);

      // Scopér til brugerens egne notifikationer
      const supabase = await createServerClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) q = q.eq('user_id', user.id);

      const { data, error } = await q;
      if (error) throw new Error(`notifications.list: ${error.message}`);
      return (data ?? []) as Notification[];
    },

    async countUnread() {
      const supabase = await createServerClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return 0;

      const { count, error } = await tenantDb(admin, schemaName)
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('user_id', user.id)
        .eq('is_read', false);
      if (error) throw new Error(`notifications.countUnread: ${error.message}`);
      return count ?? 0;
    },

    async markAsRead(id) {
      const { error } = await tenantDb(admin, schemaName)
        .from('notifications')
        .update({ is_read: true })
        .eq('id', id)
        .eq('tenant_id', tenantId);
      if (error) throw new Error(`notifications.markAsRead: ${error.message}`);
    },

    async markAllAsRead() {
      const supabase = await createServerClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      const { error } = await tenantDb(admin, schemaName)
        .from('notifications')
        .update({ is_read: true })
        .eq('tenant_id', tenantId)
        .eq('user_id', user.id)
        .eq('is_read', false);
      if (error) throw new Error(`notifications.markAllAsRead: ${error.message}`);
    },

    async deleteRead() {
      const supabase = await createServerClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      const { error } = await tenantDb(admin, schemaName)
        .from('notifications')
        .delete()
        .eq('tenant_id', tenantId)
        .eq('user_id', user.id)
        .eq('is_read', true);
      if (error) throw new Error(`notifications.deleteRead: ${error.message}`);
    },

    async create(payload) {
      const { data, error } = await tenantDb(admin, schemaName)
        .from('notifications')
        .insert({ ...payload, tenant_id: tenantId, is_read: false })
        .select()
        .single();
      if (error) throw new Error(`notifications.create: ${error.message}`);
      return data as Notification;
    },
  };

  // ── Audit Log ──────────────────────────────────────────────
  const auditLog: AuditLogApi = {
    /**
     * Writes an immutable audit entry.
     * Always called server-side via the admin client (service_role).
     * Never exposed to the browser. ISO 27001 A.12.
     *
     * @param entry - The audit entry to write
     */
    async write(entry) {
      const supabase = await createServerClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      const { error } = await tenantDb(admin, schemaName)
        .from('audit_log')
        .insert({
          tenant_id: tenantId,
          user_id: user?.id ?? null,
          action: entry.action,
          resource_type: entry.resource_type,
          resource_id: entry.resource_id ?? null,
          metadata: entry.metadata ?? null,
          ip_address: entry.ip_address ?? null,
        });
      if (error) {
        // Audit log failures must not be silently swallowed.
        // Log to Sentry/console but do not throw — never block the main operation.
        console.error('[AUDIT LOG FAILURE]', error.message, entry);
      }
    },

    async list({ limit = 100 } = {}) {
      const { data, error } = await tenantDb(admin, schemaName)
        .from('audit_log')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw new Error(`audit_log.list: ${error.message}`);
      return (data ?? []) as AuditLogEntry[];
    },
  };

  return {
    tenantId,
    schemaName,
    role,
    savedEntities,
    savedSearches,
    reports,
    aiConversations,
    propertySnapshots,
    notifications,
    auditLog,
  };
}

// ---------------------------------------------------------------------------
// Admin: provision a new tenant schema
// ---------------------------------------------------------------------------

/**
 * Provisions a new tenant schema in the database.
 *
 * Call this ONCE after inserting a new row into public.tenants.
 * The function is idempotent — safe to retry on failure.
 *
 * SERVER-SIDE ONLY. Uses the service role key.
 *
 * @param schemaName - The schema name to create (e.g. 'tenant_abc123')
 * @param tenantId   - The UUID of the new tenant
 *
 * @example
 * // In a server action after creating the tenant record:
 * await provisionTenantSchema(`tenant_${tenantId.replace(/-/g, '')}`, tenantId);
 */
export async function provisionTenantSchema(schemaName: string, tenantId: string): Promise<void> {
  // Validate schema name format — only allow safe identifier characters
  if (!/^tenant_[a-z0-9]+$/.test(schemaName)) {
    throw new Error(`Invalid schema name: "${schemaName}". Must match tenant_[a-z0-9]+`);
  }

  const admin = createAdminClient();

  const { error } = await admin.rpc('provision_tenant_schema', {
    p_schema_name: schemaName,
    p_tenant_id: tenantId,
  });

  if (error) {
    throw new Error(`Failed to provision tenant schema "${schemaName}": ${error.message}`);
  }
}
