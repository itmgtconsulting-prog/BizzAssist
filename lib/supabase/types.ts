/**
 * Supabase database type definitions — lib/supabase/types.ts
 *
 * This file provides TypeScript types for the full database schema.
 * It is the single source of truth for all table shapes used throughout the app.
 *
 * ── How to keep this in sync ────────────────────────────────────────────────
 * Once the Supabase project is created and migrations are applied, run:
 *   npx supabase gen types typescript --project-id <your-project-id> > lib/supabase/types.ts
 *
 * Until then, this file contains manual type definitions matching the planned
 * schema in docs/architecture/DATABASE.md.
 *
 * ISO 27001 A.14: strong typing prevents data handling errors that could
 * lead to security issues (e.g. exposing wrong tenant's data).
 */

// ---------------------------------------------------------------------------
// Public schema — shared across all tenants
// ---------------------------------------------------------------------------

/** User profile linked to Supabase auth.users */
export interface User {
  id: string; // UUID — matches auth.users.id
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  preferred_language: 'da' | 'en';
  created_at: string;
  updated_at: string;
}

/** A company/organisation that has a BizzAssist subscription */
export interface Tenant {
  id: string; // UUID
  name: string;
  cvr_number: string | null;
  logo_url: string | null;
  schema_name: string; // e.g. 'tenant_abc123' — the isolated DB schema
  created_at: string;
  updated_at: string;
}

/** Membership linking a user to a tenant with a role */
export interface TenantMembership {
  id: string;
  tenant_id: string;
  user_id: string;
  role: 'tenant_admin' | 'tenant_member' | 'tenant_viewer';
  created_at: string;
}

/** Subscription plan definition */
export interface Plan {
  id: string;
  name: 'free' | 'starter' | 'pro' | 'enterprise';
  price_dkk_monthly: number;
  max_users: number;
  max_searches_per_day: number;
  ai_enabled: boolean;
  export_enabled: boolean;
}

/** Active subscription for a tenant */
export interface Subscription {
  id: string;
  tenant_id: string;
  plan_id: string;
  status: 'active' | 'cancelled' | 'past_due' | 'trialing';
  current_period_start: string;
  current_period_end: string;
  stripe_subscription_id: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Tenant schema — one copy per tenant (schema_name = 'tenant_[uuid]')
// ---------------------------------------------------------------------------

/** A company, property, or person saved/watched by this tenant */
export interface SavedEntity {
  id: string;
  tenant_id: string;
  entity_type: 'company' | 'property' | 'person';
  entity_id: string; // CVR number, BFE number, or person ID
  entity_data: Record<string, unknown>; // JSONB snapshot of entity at save time
  is_monitored: boolean; // Whether to send change alerts
  label: string | null; // User-defined label
  created_by: string; // user_id
  created_at: string;
  updated_at: string;
}

/** A saved search query */
export interface SavedSearch {
  id: string;
  tenant_id: string;
  query: string;
  filters: Record<string, unknown>;
  entity_type: 'company' | 'property' | 'person' | 'all';
  result_count: number | null;
  created_by: string;
  created_at: string;
}

/** A generated analysis report */
export interface Report {
  id: string;
  tenant_id: string;
  title: string;
  report_type:
    | 'company_analysis'
    | 'property_report'
    | 'person_report'
    | 'market_overview'
    | 'custom';
  entity_type: 'company' | 'property' | 'person' | null;
  entity_id: string | null;
  content: Record<string, unknown>;
  is_exported: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** An AI conversation thread */
export interface AiConversation {
  id: string;
  tenant_id: string;
  title: string | null;
  is_shared: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** A single message in an AI conversation */
export interface AiMessage {
  id: string;
  conversation_id: string;
  tenant_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tokens_used: number | null;
  created_at: string;
}

/** pgvector embedding for semantic search and RAG */
export interface DocumentEmbedding {
  id: string;
  tenant_id: string;
  source_type: 'company' | 'property' | 'person' | 'report' | 'search_result' | 'custom';
  source_id: string;
  chunk_index: number;
  content: string;
  embedding: number[]; // vector(1536) — serialised as float array by PostgREST
  metadata: Record<string, unknown>;
  created_at: string;
}

/** Immutable audit log entry for all data mutations (ISO 27001 A.12) */
export interface AuditLog {
  id: string;
  tenant_id: string;
  user_id: string | null;
  action: string; // e.g. 'entity.saved', 'report.exported', 'user.invited'
  resource_type: string;
  resource_id: string | null;
  metadata: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Service Manager types (BIZZ-86)
// ---------------------------------------------------------------------------

/** A single issue found during a Service Manager scan */
export interface ServiceManagerScanIssue {
  type: 'build_error' | 'runtime_error' | 'type_error' | 'config_error';
  severity: 'error' | 'warning';
  message: string;
  source: 'vercel_build' | 'vercel_logs' | 'static';
  context?: string;
}

/** A scan record from migration 020 */
export interface ServiceManagerScan {
  id: string;
  created_at: string;
  scan_type: 'manual' | 'scheduled' | 'triggered';
  issues_found: ServiceManagerScanIssue[];
  status: 'running' | 'completed' | 'failed';
  resolved_at: string | null;
  summary: string | null;
  triggered_by: string | null;
}

/** An AI-proposed fix from migration 021 */
export interface ServiceManagerFix {
  id: string;
  scan_id: string;
  issue_index: number;
  file_path: string;
  proposed_diff: string;
  classification: 'bug-fix' | 'config-fix' | 'rejected';
  status: 'proposed' | 'approved' | 'applied' | 'rejected';
  claude_reasoning: string | null;
  rejection_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
}

/** A release-agent activity log entry from migration 021 */
export interface ServiceManagerActivity {
  id: string;
  action: string;
  details: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Additional public-schema table row types
// ---------------------------------------------------------------------------

/** A recently viewed entity, stored per user/tenant (migration 013) */
export interface RecentEntity {
  id: string;
  tenant_id: string;
  user_id: string;
  entity_type: 'company' | 'property' | 'person' | 'search';
  entity_id: string;
  display_name: string;
  entity_data: Record<string, unknown>;
  visited_at: string;
}

/** Sitemap entry used by /api/cron/generate-sitemap (migration 019) */
export interface SitemapEntry {
  id: string;
  /** 'ejendom' or 'virksomhed' */
  type: 'ejendom' | 'virksomhed';
  slug: string;
  entity_id: string;
  updated_at: string;
}

/** Cached XBRL financial report (migration 022) */
export interface RegnskabCache {
  id: string;
  cvr: string;
  year: number;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Immutable audit log entry (ISO 27001 A.12) — lives in public schema */
export interface AuditLogRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
}

/** Key-value settings store used by cron and AI features */
export interface AiSettings {
  key: string;
  value: string;
  updated_at: string;
}

/** Gmail integration credentials per tenant (migration 030) */
export interface IntegrationGmail {
  id: string;
  tenant_id: string;
  user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scope: string;
  created_at: string;
  updated_at: string;
}

/** LinkedIn integration credentials per tenant */
export interface IntegrationLinkedIn {
  id: string;
  tenant_id: string;
  user_id: string;
  access_token: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

/** Knowledge base document stored per tenant (migration 031) */
export interface KnowledgeDocument {
  id: string;
  tenant_id: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** tenant_knowledge row — text items uploaded to the per-tenant knowledge base */
export interface TenantKnowledgeRow {
  id: number;
  tenant_id: string;
  title: string;
  content: string;
  source_type: 'manual' | 'upload' | 'url';
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** API token issued to a tenant */
export interface ApiToken {
  id: string;
  tenant_id: string;
  name: string;
  token_hash: string;
  last_used_at: string | null;
  expires_at: string | null;
  created_by: string;
  created_at: string;
}

/** api_tokens row in tenant schema — enterprise API tokens */
export interface ApiTokenRow {
  id: number;
  tenant_id: string;
  user_id: string;
  name: string;
  token_hash: string;
  prefix: string;
  scopes: string[];
  last_used: string | null;
  expires_at: string | null;
  revoked: boolean;
  created_at: string;
}

/** support_chat_abuse row — abuse detection for the support chat feature */
export interface SupportChatAbuseRow {
  user_id: string;
  violation_count: number;
  locked_until: string | null;
  permanently_locked: boolean;
  last_violation: string | null;
  updated_at: string;
}

/** plan_configs row — configurable plan definitions managed by admins */
export interface PlanConfigRow {
  plan_id: string;
  name_da: string;
  name_en: string;
  desc_da: string;
  desc_en: string;
  color: string;
  price_dkk: number;
  ai_tokens_per_month: number;
  duration_months: number;
  duration_days: number;
  token_accumulation_cap_multiplier: number;
  ai_enabled: boolean;
  requires_approval: boolean;
  is_active: boolean;
  free_trial_days: number;
  max_sales: number | null;
  sales_count: number;
  stripe_price_id: string | null;
}

/** BBR event polling cursor (migration 034) — tracks last-pulled event timestamp */
export interface BbrEventCursor {
  id: number;
  last_event_at: string;
  last_pulled_at: string | null;
}

/** BBR object tracked per tenant — maps BBR UUID to BFE number (migration 034) */
export interface BbrTrackedObject {
  id: string;
  tenant_id: string;
  bfe_nummer: string;
  bbr_object_id: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Tenant schema row types (shared across all tenant_[uuid] schemas)
// ---------------------------------------------------------------------------

/** property_snapshots row (migration 006) */
export interface PropertySnapshotRow {
  id: string;
  tenant_id: string;
  entity_id: string;
  snapshot_type: string;
  snapshot_hash: string;
  snapshot_data: Record<string, unknown>;
  created_at: string;
}

/** notifications row (migration 006) */
export interface NotificationRow {
  id: string;
  tenant_id: string;
  user_id: string;
  entity_id: string;
  entity_type: string;
  notification_type: string;
  title: string;
  message: string;
  metadata: Record<string, unknown> | null;
  is_read: boolean;
  created_at: string;
}

/** saved_entities row in tenant schema */
export interface SavedEntityRow {
  id: string;
  tenant_id: string;
  entity_type: string;
  entity_id: string;
  entity_data: Record<string, unknown>;
  is_monitored: boolean;
  label: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** activity_log row in tenant schema */
export interface ActivityLogRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

/** ai_conversations row in tenant schema */
export interface AiConversationRow {
  id: string;
  tenant_id: string;
  title: string | null;
  is_shared: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** ai_messages row in tenant schema */
export interface AiMessageRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  role: string;
  content: string;
  tokens_used: number | null;
  created_at: string;
}

/** ai_token_usage row in tenant schema — billing and budget tracking */
export interface AiTokenUsageRow {
  id: string;
  tenant_id: string;
  user_id: string;
  tokens_in: number;
  tokens_out: number;
  model: string;
  created_at: string;
}

/** email_integrations row in tenant schema — stores OAuth tokens for Gmail/LinkedIn */
export interface EmailIntegrationRow {
  id: string;
  user_id: string;
  provider: 'gmail' | 'linkedin';
  email_address: string | null;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  scopes: string | null;
  connected_at: string;
  profile_data: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Full Database type used by Supabase client generics
// ---------------------------------------------------------------------------

/**
 * Tables shape shared by every per-tenant PostgreSQL schema (tenant_[uuid]).
 * Used as the value type for the `tenant` key in the Database type so that
 * `.schema(schemaName)` returns a typed PostgREST client.
 */
type TenantSchemaShape = {
  Tables: {
    saved_entities: {
      Row: SavedEntityRow;
      Insert: Omit<SavedEntityRow, 'id' | 'created_at' | 'updated_at'>;
      Update: Partial<SavedEntityRow>;
    };
    property_snapshots: {
      Row: PropertySnapshotRow;
      Insert: Omit<PropertySnapshotRow, 'id' | 'created_at'>;
      Update: Partial<PropertySnapshotRow>;
    };
    notifications: {
      Row: NotificationRow;
      Insert: Omit<NotificationRow, 'id' | 'created_at'>;
      Update: Partial<NotificationRow>;
    };
    activity_log: {
      Row: ActivityLogRow;
      Insert: Omit<ActivityLogRow, 'id' | 'created_at'>;
      Update: Partial<ActivityLogRow>;
    };
    ai_conversations: {
      Row: AiConversationRow;
      Insert: Omit<AiConversationRow, 'id' | 'created_at' | 'updated_at'>;
      Update: Partial<AiConversationRow>;
    };
    ai_messages: {
      Row: AiMessageRow;
      Insert: Omit<AiMessageRow, 'id' | 'created_at'>;
      Update: Partial<AiMessageRow>;
    };
    ai_token_usage: {
      Row: AiTokenUsageRow;
      Insert: Omit<AiTokenUsageRow, 'id' | 'created_at'>;
      Update: Partial<AiTokenUsageRow>;
    };
    email_integrations: {
      Row: EmailIntegrationRow;
      Insert: Omit<EmailIntegrationRow, 'id' | 'created_at' | 'updated_at'>;
      Update: Partial<EmailIntegrationRow>;
    };
    tenant_knowledge: {
      Row: TenantKnowledgeRow;
      Insert: Omit<TenantKnowledgeRow, 'id' | 'created_at' | 'updated_at'>;
      Update: Partial<TenantKnowledgeRow>;
    };
    api_tokens: {
      Row: ApiTokenRow;
      Insert: Omit<ApiTokenRow, 'id' | 'created_at'>;
      Update: Partial<ApiTokenRow>;
    };
    support_chat_sessions: {
      Row: {
        id: string;
        tenant_id: string;
        user_id: string;
        tokens_used: number;
        created_at: string;
      };
      Insert: {
        tenant_id: string;
        user_id: string;
        tokens_used: number;
      };
      Update: Partial<{
        tenant_id: string;
        user_id: string;
        tokens_used: number;
      }>;
    };
  };
  Views: Record<string, never>;
  Functions: Record<string, never>;
  Enums: Record<string, never>;
};

/**
 * Database type passed to Supabase client generics.
 * Will be replaced by auto-generated types from `supabase gen types` once
 * the project is created and migrations are applied.
 *
 * The `tenant` key represents the shape of every per-tenant schema
 * (named `tenant_[uuid]` in production). It allows `.schema(name)` calls
 * to return a typed PostgREST client without casting to `any`.
 */
export type Database = {
  public: {
    Tables: {
      users: { Row: User; Insert: Omit<User, 'created_at' | 'updated_at'>; Update: Partial<User> };
      tenants: {
        Row: Tenant;
        Insert: Omit<Tenant, 'created_at' | 'updated_at'>;
        Update: Partial<Tenant>;
      };
      tenant_memberships: {
        Row: TenantMembership;
        Insert: Omit<TenantMembership, 'created_at'>;
        Update: Partial<TenantMembership>;
      };
      plans: { Row: Plan; Insert: Plan; Update: Partial<Plan> };
      subscriptions: {
        Row: Subscription;
        Insert: Omit<Subscription, 'created_at'>;
        Update: Partial<Subscription>;
      };
      audit_log: {
        Row: AuditLogRow;
        Insert: Omit<AuditLogRow, 'id' | 'created_at'>;
        Update: never;
      };
      recent_entities: {
        Row: RecentEntity;
        Insert: Omit<RecentEntity, 'id'>;
        Update: Partial<RecentEntity>;
      };
      sitemap_entries: {
        Row: SitemapEntry;
        Insert: Omit<SitemapEntry, 'id'>;
        Update: Partial<SitemapEntry>;
      };
      regnskab_cache: {
        Row: RegnskabCache;
        Insert: Omit<RegnskabCache, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<RegnskabCache>;
      };
      ai_settings: {
        Row: AiSettings;
        Insert: AiSettings;
        Update: Partial<AiSettings>;
      };
      service_manager_scans: {
        Row: ServiceManagerScan;
        Insert: Omit<ServiceManagerScan, 'id' | 'created_at'>;
        Update: Partial<ServiceManagerScan>;
      };
      service_manager_fixes: {
        Row: ServiceManagerFix;
        Insert: Omit<ServiceManagerFix, 'id' | 'created_at'>;
        Update: Partial<ServiceManagerFix>;
      };
      service_manager_activity: {
        Row: ServiceManagerActivity;
        Insert: Omit<ServiceManagerActivity, 'id' | 'created_at'>;
        Update: Partial<ServiceManagerActivity>;
      };
      integrations_gmail: {
        Row: IntegrationGmail;
        Insert: Omit<IntegrationGmail, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<IntegrationGmail>;
      };
      integrations_linkedin: {
        Row: IntegrationLinkedIn;
        Insert: Omit<IntegrationLinkedIn, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<IntegrationLinkedIn>;
      };
      knowledge_documents: {
        Row: KnowledgeDocument;
        Insert: Omit<KnowledgeDocument, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<KnowledgeDocument>;
      };
      api_tokens: {
        Row: ApiToken;
        Insert: Omit<ApiToken, 'id' | 'created_at'>;
        Update: Partial<ApiToken>;
      };
      bbr_event_cursor: {
        Row: BbrEventCursor;
        Insert: Omit<BbrEventCursor, 'id'>;
        Update: Partial<BbrEventCursor>;
      };
      bbr_tracked_objects: {
        Row: BbrTrackedObject;
        Insert: Omit<BbrTrackedObject, 'id' | 'created_at'>;
        Update: Partial<BbrTrackedObject>;
      };
      support_chat_abuse: {
        Row: SupportChatAbuseRow;
        Insert: SupportChatAbuseRow;
        Update: Partial<SupportChatAbuseRow>;
      };
      plan_configs: {
        Row: PlanConfigRow;
        Insert: PlanConfigRow;
        Update: Partial<PlanConfigRow>;
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
  /**
   * Representative key for per-tenant schemas (named `tenant_[uuid]` at runtime).
   * TypeScript cannot express dynamic schema names, so we use a fixed `tenant`
   * key here. The `tenantDb()` helper in `lib/supabase/admin.ts` uses this type
   * via an explicit cast so all callers get a fully typed PostgREST client.
   */
  tenant: TenantSchemaShape;
};
