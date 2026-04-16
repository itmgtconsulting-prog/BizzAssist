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
export type User = {
  id: string; // UUID — matches auth.users.id
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  preferred_language: 'da' | 'en';
  created_at: string;
  updated_at: string;
};

/** A company/organisation that has a BizzAssist subscription */
export type Tenant = {
  id: string; // UUID
  name: string;
  cvr_number: string | null;
  logo_url: string | null;
  schema_name: string; // e.g. 'tenant_abc123' — the isolated DB schema
  created_at: string;
  updated_at: string;
};

/** Membership linking a user to a tenant with a role */
export type TenantMembership = {
  id: string;
  tenant_id: string;
  user_id: string;
  role: 'tenant_admin' | 'tenant_member' | 'tenant_viewer';
  created_at: string;
};

/** Subscription plan definition */
export type Plan = {
  id: string;
  name: 'free' | 'starter' | 'pro' | 'enterprise';
  price_dkk_monthly: number;
  max_users: number;
  max_searches_per_day: number;
  ai_enabled: boolean;
  export_enabled: boolean;
};

/** Active subscription for a tenant */
export type Subscription = {
  id: string;
  tenant_id: string;
  plan_id: string;
  status: 'active' | 'cancelled' | 'past_due' | 'trialing';
  current_period_start: string;
  current_period_end: string;
  stripe_subscription_id: string | null;
  created_at: string;
};

// ---------------------------------------------------------------------------
// Tenant schema — one copy per tenant (schema_name = 'tenant_[uuid]')
// ---------------------------------------------------------------------------

/** A company, property, or person saved/watched by this tenant */
export type SavedEntity = {
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
};

/** A saved search query */
export type SavedSearch = {
  id: string;
  tenant_id: string;
  query: string;
  filters: Record<string, unknown>;
  entity_type: 'company' | 'property' | 'person' | 'all';
  result_count: number | null;
  created_by: string;
  created_at: string;
};

/** A generated analysis report */
export type Report = {
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
};

/** An AI conversation thread */
export type AiConversation = {
  id: string;
  tenant_id: string;
  title: string | null;
  is_shared: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
};

/** A single message in an AI conversation */
export type AiMessage = {
  id: string;
  conversation_id: string;
  tenant_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tokens_used: number | null;
  created_at: string;
};

/** pgvector embedding for semantic search and RAG */
export type DocumentEmbedding = {
  id: string;
  tenant_id: string;
  source_type: 'company' | 'property' | 'person' | 'report' | 'search_result' | 'custom';
  source_id: string;
  chunk_index: number;
  content: string;
  embedding: number[]; // vector(1536) — serialised as float array by PostgREST
  metadata: Record<string, unknown>;
  created_at: string;
};

/** Immutable audit log entry for all data mutations (ISO 27001 A.12) */
export type AuditLog = {
  id: string;
  tenant_id: string;
  user_id: string | null;
  action: string; // e.g. 'entity.saved', 'report.exported', 'user.invited'
  resource_type: string;
  resource_id: string | null;
  metadata: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
};

// ---------------------------------------------------------------------------
// Service Manager types (BIZZ-86)
// ---------------------------------------------------------------------------

/** A single issue found during a Service Manager scan */
export type ServiceManagerScanIssue = {
  type: 'build_error' | 'runtime_error' | 'type_error' | 'config_error';
  severity: 'error' | 'warning';
  message: string;
  source: 'vercel_build' | 'vercel_logs' | 'static';
  context?: string;
};

/** A scan record from migration 020 */
export type ServiceManagerScan = {
  id: string;
  created_at: string;
  scan_type: 'manual' | 'scheduled' | 'triggered';
  issues_found: ServiceManagerScanIssue[];
  status: 'running' | 'completed' | 'failed';
  resolved_at: string | null;
  summary: string | null;
  triggered_by: string | null;
};

/** An AI-proposed fix from migration 021, extended by migration 037 */
export type ServiceManagerFix = {
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
  /** Set by the Release Agent when the hotfix commit is created (migration 037) */
  applied_at: string | null;
  /** Full Git commit SHA produced via GitHub API (migration 037) */
  commit_sha: string | null;
  created_at: string;
};

/** A release-agent activity log entry from migration 021 */
export type ServiceManagerActivity = {
  id: string;
  action: string;
  details: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
};

// ---------------------------------------------------------------------------
// Additional public-schema table row types
// ---------------------------------------------------------------------------

/** A recently viewed entity, stored per user/tenant (migration 013) */
export type RecentEntity = {
  id: string;
  tenant_id: string;
  user_id: string;
  entity_type: 'company' | 'property' | 'person' | 'search';
  entity_id: string;
  display_name: string;
  entity_data: Record<string, unknown>;
  visited_at: string;
};

/** Sitemap entry used by /api/cron/generate-sitemap (migration 019) */
export type SitemapEntry = {
  id: string;
  /** 'ejendom' or 'virksomhed' */
  type: 'ejendom' | 'virksomhed';
  slug: string;
  entity_id: string;
  updated_at: string;
};

/** Cached XBRL financial report (migration 022) */
export type RegnskabCache = {
  id: string;
  cvr: string;
  /** Parsed XBRL year objects — replaces legacy `year`/`data` columns */
  years: unknown[];
  /** Erhvervsstyrelsen ES-timestamp used for cache invalidation */
  es_timestamp: string;
  fetched_at: string;
  created_at: string;
};

/** Immutable audit log entry (ISO 27001 A.12) — lives in public schema */
export type AuditLogRow = {
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

/** Key-value settings store used by cron and AI features */
export type AiSettings = {
  key: string;
  value: string;
  updated_at: string;
};

/** Gmail integration credentials per tenant (migration 030) */
export type IntegrationGmail = {
  id: string;
  tenant_id: string;
  user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scope: string;
  created_at: string;
  updated_at: string;
};

/** LinkedIn integration credentials per tenant */
export type IntegrationLinkedIn = {
  id: string;
  tenant_id: string;
  user_id: string;
  access_token: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

/** Knowledge base document stored per tenant (migration 031) */
export type KnowledgeDocument = {
  id: string;
  tenant_id: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
};

/** tenant_knowledge row — text items uploaded to the per-tenant knowledge base */
export type TenantKnowledgeRow = {
  id: number;
  tenant_id: string;
  title: string;
  content: string;
  source_type: 'manual' | 'upload' | 'url';
  created_by: string;
  created_at: string;
  updated_at: string;
};

/** API token issued to a tenant */
export type ApiToken = {
  id: string;
  tenant_id: string;
  name: string;
  token_hash: string;
  last_used_at: string | null;
  expires_at: string | null;
  created_by: string;
  created_at: string;
};

/** api_tokens row in tenant schema — enterprise API tokens */
export type ApiTokenRow = {
  id: number;
  tenant_id: string;
  user_id: string;
  name: string;
  token_hash: string;
  prefix: string;
  scopes: string[];
  last_used?: string | null;
  expires_at: string | null;
  revoked: boolean;
  created_at: string;
};

/** support_chat_abuse row — abuse detection for the support chat feature */
export type SupportChatAbuseRow = {
  user_id: string;
  violation_count: number;
  locked_until: string | null;
  permanently_locked: boolean;
  last_violation: string | null;
  updated_at: string;
};

/** plan_configs row — configurable plan definitions managed by admins */
export type PlanConfigRow = {
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
};

/** BBR event polling cursor (migration 034) — tracks last-pulled event timestamp */
export type BbrEventCursor = {
  id: number;
  last_event_at: string;
  last_pulled_at: string | null;
};

/** BBR object tracked per tenant — maps BBR UUID to BFE number (migration 034) */
export type BbrTrackedObject = {
  id: string;
  tenant_id: string;
  bfe_nummer: string;
  bbr_object_id: string;
  created_at: string;
};

// ---------------------------------------------------------------------------
// Tenant schema row types (shared across all tenant_[uuid] schemas)
// ---------------------------------------------------------------------------

/** property_snapshots row (migration 006) */
export type PropertySnapshotRow = {
  id: string;
  tenant_id: string;
  entity_id: string;
  snapshot_type: string;
  snapshot_hash: string;
  snapshot_data: Record<string, unknown>;
  created_at: string;
};

/** notifications row (migration 006) */
export type NotificationRow = {
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
};

/** saved_entities row in tenant schema */
export type SavedEntityRow = {
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
};

/** activity_log row in tenant schema */
export type ActivityLogRow = {
  id: string;
  tenant_id: string;
  user_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
};

/** ai_conversations row in tenant schema */
export type AiConversationRow = {
  id: string;
  tenant_id: string;
  title: string | null;
  is_shared: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
};

/** ai_messages row in tenant schema */
export type AiMessageRow = {
  id: string;
  tenant_id: string;
  conversation_id: string;
  role: string;
  content: string;
  tokens_used: number | null;
  created_at: string;
};

/** ai_token_usage row in tenant schema — billing and budget tracking */
export type AiTokenUsageRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  tokens_in: number;
  tokens_out: number;
  tokens_used: number;
  model: string;
  created_at: string;
};

/** email_integrations row in tenant schema — stores OAuth tokens for Gmail/LinkedIn */
export type EmailIntegrationRow = {
  id: string;
  user_id: string;
  provider: 'gmail' | 'linkedin';
  email_address: string | null;
  access_token: string;
  refresh_token: string | null;
  /** Column name in DB: token_expires_at */
  token_expires_at: string | null;
  scopes: string[];
  connected_at: string;
  profile_data: Record<string, unknown> | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};

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
      Relationships: [];
    };
    property_snapshots: {
      Row: PropertySnapshotRow;
      Insert: Omit<PropertySnapshotRow, 'id' | 'created_at'>;
      Update: Partial<PropertySnapshotRow>;
      Relationships: [];
    };
    notifications: {
      Row: NotificationRow;
      Insert: Omit<NotificationRow, 'id' | 'created_at' | 'is_read'> & { is_read?: boolean };
      Update: Partial<NotificationRow>;
      Relationships: [];
    };
    activity_log: {
      Row: ActivityLogRow;
      Insert: Omit<ActivityLogRow, 'id' | 'created_at'>;
      Update: Partial<ActivityLogRow>;
      Relationships: [];
    };
    ai_conversations: {
      Row: AiConversationRow;
      Insert: Omit<AiConversationRow, 'id' | 'created_at' | 'updated_at'>;
      Update: Partial<AiConversationRow>;
      Relationships: [];
    };
    ai_messages: {
      Row: AiMessageRow;
      Insert: Omit<AiMessageRow, 'id' | 'created_at'>;
      Update: Partial<AiMessageRow>;
      Relationships: [];
    };
    ai_token_usage: {
      Row: AiTokenUsageRow;
      Insert: Omit<AiTokenUsageRow, 'id' | 'created_at' | 'tokens_used'> & {
        tokens_used?: number;
      };
      Update: Partial<AiTokenUsageRow>;
      Relationships: [];
    };
    email_integrations: {
      Row: EmailIntegrationRow;
      Insert: Omit<EmailIntegrationRow, 'id' | 'created_at' | 'updated_at' | 'last_used_at'> & {
        last_used_at?: string | null;
      };
      Update: Partial<EmailIntegrationRow>;
      Relationships: [];
    };
    tenant_knowledge: {
      Row: TenantKnowledgeRow;
      Insert: Omit<TenantKnowledgeRow, 'id' | 'created_at' | 'updated_at'>;
      Update: Partial<TenantKnowledgeRow>;
      Relationships: [];
    };
    api_tokens: {
      Row: ApiTokenRow;
      Insert: Omit<ApiTokenRow, 'id' | 'created_at'>;
      Update: Partial<ApiTokenRow>;
      Relationships: [];
    };
    recent_entities: {
      Row: RecentEntity;
      Insert: {
        tenant_id: string;
        user_id: string;
        entity_type: string;
        entity_id: string;
        display_name: string;
        entity_data?: Record<string, unknown>;
        visited_at?: string;
      };
      Update: Partial<RecentEntity>;
      Relationships: [];
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
      Relationships: [];
    };
    saved_searches: {
      Row: {
        id: string;
        tenant_id: string;
        query: string;
        filters: Record<string, unknown>;
        entity_type: string;
        result_count: number | null;
        created_by: string;
        created_at: string;
      };
      Insert: {
        tenant_id: string;
        entity_type: string;
        created_by: string;
        query: string;
        filters: Record<string, unknown>;
        result_count?: number | null;
      };
      Update: Partial<{
        query: string;
        filters: Record<string, unknown>;
        entity_type: string;
        result_count: number | null;
      }>;
      Relationships: [];
    };
    reports: {
      Row: {
        id: string;
        tenant_id: string;
        title: string;
        report_type: string;
        entity_type: string | null;
        entity_id: string | null;
        content: Record<string, unknown>;
        is_exported: boolean;
        created_by: string;
        created_at: string;
        updated_at: string;
      };
      Insert: {
        tenant_id: string;
        title: string;
        report_type: string;
        entity_type?: string | null;
        entity_id?: string | null;
        content: Record<string, unknown>;
        is_exported?: boolean;
        created_by: string;
      };
      Update: Partial<{
        title: string;
        content: Record<string, unknown>;
        is_exported: boolean;
      }>;
      Relationships: [];
    };
    audit_log: {
      Row: {
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
      Insert: {
        tenant_id: string;
        user_id?: string | null;
        action: string;
        resource_type: string;
        resource_id?: string | null;
        metadata?: Record<string, unknown> | null;
        ip_address?: string | null;
      };
      Update: Record<string, never>;
      Relationships: [];
    };
    ai_feedback_log: {
      Row: {
        id: number;
        tenant_id: string;
        user_id: string;
        conversation_id: string | null;
        question_text: string;
        feedback_type: string;
        ai_response_snippet: string | null;
        page_context: string | null;
        metadata: Record<string, unknown>;
        jira_ticket_id: string | null;
        created_at: string;
      };
      Insert: {
        tenant_id: string;
        user_id: string;
        conversation_id?: string | null;
        question_text: string;
        feedback_type: string;
        ai_response_snippet?: string | null;
        page_context?: string | null;
        metadata?: Record<string, unknown>;
        jira_ticket_id?: string | null;
      };
      Update: Partial<{
        jira_ticket_id: string | null;
      }>;
      Relationships: [];
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
      users: {
        Row: User;
        Insert: Omit<User, 'created_at' | 'updated_at'>;
        Update: Partial<User>;
        Relationships: [];
      };
      tenants: {
        Row: Tenant;
        Insert: {
          id?: string;
          name: string;
          schema_name: string;
          cvr_number?: string | null;
          logo_url?: string | null;
        };
        Update: Partial<Tenant>;
        Relationships: [];
      };
      tenant_memberships: {
        Row: TenantMembership;
        Insert: {
          id?: string;
          tenant_id: string;
          user_id: string;
          role: string;
        };
        Update: Partial<TenantMembership>;
        Relationships: [];
      };
      plans: {
        Row: Plan;
        Insert: Plan;
        Update: Partial<Plan>;
        Relationships: [];
      };
      subscriptions: {
        Row: Subscription;
        Insert: Omit<Subscription, 'created_at'>;
        Update: Partial<Subscription>;
        Relationships: [];
      };
      audit_log: {
        Row: AuditLogRow;
        Insert: {
          action: string;
          resource_type: string;
          resource_id?: string | null;
          metadata?: Record<string, unknown> | string | null;
          tenant_id?: string | null;
          user_id?: string | null;
          ip_address?: string | null;
        };
        Update: Record<string, never>;
        Relationships: [];
      };
      recent_entities: {
        Row: RecentEntity;
        Insert: {
          tenant_id: string;
          user_id: string;
          entity_type: string;
          entity_id: string;
          display_name: string;
          entity_data?: Record<string, unknown>;
          visited_at?: string;
        };
        Update: Partial<RecentEntity>;
        Relationships: [];
      };
      sitemap_entries: {
        Row: SitemapEntry;
        Insert: {
          type: 'ejendom' | 'virksomhed';
          slug: string;
          entity_id: string;
          updated_at?: string;
        };
        Update: Partial<SitemapEntry>;
        Relationships: [];
      };
      regnskab_cache: {
        Row: RegnskabCache;
        Insert: {
          cvr: string;
          years: unknown[];
          es_timestamp: string;
          fetched_at?: string;
        };
        Update: Partial<RegnskabCache>;
        Relationships: [];
      };
      ai_settings: {
        Row: AiSettings;
        Insert: { key: string; value: unknown; updated_at?: string };
        Update: Partial<AiSettings>;
        Relationships: [];
      };
      service_manager_scans: {
        Row: ServiceManagerScan;
        Insert: {
          scan_type: string;
          status: string;
          triggered_by?: string | null;
          issues_found?: unknown[];
          summary?: string | null;
          resolved_at?: string | null;
        };
        Update: Partial<ServiceManagerScan>;
        Relationships: [];
      };
      service_manager_fixes: {
        Row: ServiceManagerFix;
        Insert: {
          scan_id: string;
          issue_index: number;
          file_path: string;
          proposed_diff: string;
          classification: string;
          status: string;
          claude_reasoning?: string | null;
          rejection_reason?: string | null;
          reviewed_by?: string | null;
          reviewed_at?: string | null;
          applied_at?: string | null;
          commit_sha?: string | null;
        };
        Update: Partial<ServiceManagerFix>;
        Relationships: [];
      };
      service_manager_activity: {
        Row: ServiceManagerActivity;
        Insert: {
          action: string;
          details?: Record<string, unknown>;
          created_by?: string | null;
        };
        Update: Partial<ServiceManagerActivity>;
        Relationships: [];
      };
      integrations_gmail: {
        Row: IntegrationGmail;
        Insert: Omit<IntegrationGmail, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<IntegrationGmail>;
        Relationships: [];
      };
      integrations_linkedin: {
        Row: IntegrationLinkedIn;
        Insert: Omit<IntegrationLinkedIn, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<IntegrationLinkedIn>;
        Relationships: [];
      };
      knowledge_documents: {
        Row: KnowledgeDocument;
        Insert: Omit<KnowledgeDocument, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<KnowledgeDocument>;
        Relationships: [];
      };
      api_tokens: {
        Row: ApiToken;
        Insert: Omit<ApiToken, 'id' | 'created_at'>;
        Update: Partial<ApiToken>;
        Relationships: [];
      };
      bbr_event_cursor: {
        Row: BbrEventCursor;
        Insert: Omit<BbrEventCursor, 'id'>;
        Update: Partial<BbrEventCursor>;
        Relationships: [];
      };
      bbr_tracked_objects: {
        Row: BbrTrackedObject;
        Insert: Omit<BbrTrackedObject, 'id' | 'created_at'>;
        Update: Partial<BbrTrackedObject>;
        Relationships: [];
      };
      support_chat_abuse: {
        Row: SupportChatAbuseRow;
        Insert: SupportChatAbuseRow;
        Update: Partial<SupportChatAbuseRow>;
        Relationships: [];
      };
      plan_configs: {
        Row: PlanConfigRow;
        Insert: PlanConfigRow;
        Update: Partial<PlanConfigRow>;
        Relationships: [];
      };
      consent_log: {
        Row: {
          id: string;
          user_id: string | null;
          session_id: string | null;
          consent_value: string;
          categories: string | null;
          ip_hash: string | null;
          user_agent: string | null;
          created_at: string;
        };
        Insert: {
          user_id?: string | null;
          session_id?: string | null;
          consent_value: string;
          categories?: string | null;
          ip_hash?: string | null;
          user_agent?: string | null;
        };
        Update: Record<string, never>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      provision_tenant_schema: {
        Args: { p_schema_name: string; p_tenant_id: string };
        Returns: undefined;
      };
    };
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
