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
// Full Database type used by Supabase client generics
// ---------------------------------------------------------------------------

/**
 * Database type passed to Supabase client generics.
 * Will be replaced by auto-generated types from `supabase gen types` once
 * the project is created and migrations are applied.
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
      // service_manager_scans, service_manager_fixes, service_manager_activity
      // are intentionally omitted here — they are accessed via (admin as any) casts
      // in their respective route files to avoid strict overload conflicts until
      // types are regenerated with `supabase gen types` after migrations are applied.
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
};
