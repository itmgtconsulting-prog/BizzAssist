# BizzAssist — Database Architecture

## Core Principle: Strict Tenant Isolation

**Data from different companies MUST NEVER mix.**
This is enforced at three independent layers (defense in depth):

1. PostgreSQL schema isolation (structural)
2. Row Level Security policies (database)
3. Application middleware (runtime)

---

## Database Strategy: Schema-Per-Tenant

```
PostgreSQL (Supabase)
│
├── public schema (SHARED — platform level)
│   ├── users                  ← All users across all tenants
│   ├── tenants                ← Company registry
│   ├── subscriptions          ← Billing & plans
│   ├── tenant_memberships     ← Which user belongs to which tenant
│   └── audit_log_platform     ← Platform-level audit trail
│
├── tenant_[uuid] schema (PER COMPANY — isolated)
│   ├── company_profile        ← Company-specific configuration
│   ├── searches               ← Search history scoped to company
│   ├── reports                ← Generated reports
│   ├── saved_entities         ← Bookmarked companies/people/properties
│   ├── ai_context             ← Company-specific AI procedures & templates
│   ├── ai_conversations       ← Chat history per user per company
│   ├── document_templates     ← Company output format templates
│   ├── procedures             ← Company-specific procedures AI learns from
│   └── audit_log              ← All actions within this tenant
│
└── vector store (Supabase pgvector — per tenant namespace)
    ├── embeddings_[tenant_id] ← Company-specific document embeddings
    └── (NEVER cross-reference between tenants)
```

---

## Shared Schema (public)

```sql
-- Tenants (companies on the platform)
CREATE TABLE public.tenants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT UNIQUE NOT NULL,         -- used in URLs: app.bizzassist.dk/[slug]
  name          TEXT NOT NULL,
  plan          TEXT NOT NULL DEFAULT 'free', -- free | pro | enterprise
  schema_name   TEXT UNIQUE NOT NULL,         -- tenant_[id]
  created_at    TIMESTAMPTZ DEFAULT now(),
  is_active     BOOLEAN DEFAULT true
);

-- Users (shared across platform)
CREATE TABLE public.users (
  id            UUID PRIMARY KEY REFERENCES auth.users,
  email         TEXT UNIQUE NOT NULL,
  full_name     TEXT,
  avatar_url    TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Tenant Memberships (who belongs to which company)
CREATE TABLE public.tenant_memberships (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES public.users(id),
  tenant_id     UUID REFERENCES public.tenants(id),
  role          TEXT NOT NULL DEFAULT 'member', -- owner | admin | member | viewer
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, tenant_id)
);

-- Subscriptions
CREATE TABLE public.subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID REFERENCES public.tenants(id),
  plan          TEXT NOT NULL,
  status        TEXT NOT NULL,               -- active | cancelled | past_due
  current_period_end TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now()
);
```

---

## Tenant Schema Template (replicated per company)

```sql
-- Run once per new tenant, replacing {TENANT_ID} with actual UUID

CREATE SCHEMA tenant_{TENANT_ID};

-- Company AI context (procedures, formats, templates the AI learns)
CREATE TABLE tenant_{TENANT_ID}.ai_context (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          TEXT NOT NULL,   -- 'procedure' | 'template' | 'format' | 'preference'
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  embedding     vector(1536),    -- pgvector embedding
  created_by    UUID NOT NULL,   -- user_id from public.users
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- AI Conversations (scoped to company + user)
CREATE TABLE tenant_{TENANT_ID}.ai_conversations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL,
  title         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE tenant_{TENANT_ID}.ai_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES tenant_{TENANT_ID}.ai_conversations(id),
  role          TEXT NOT NULL,   -- 'user' | 'assistant' | 'system'
  content       TEXT NOT NULL,
  context_used  JSONB,           -- which company documents were retrieved
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Company procedures the AI learns from
CREATE TABLE tenant_{TENANT_ID}.procedures (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  description   TEXT,
  steps         JSONB NOT NULL,
  embedding     vector(1536),
  created_by    UUID NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Output templates (AI formats responses using these)
CREATE TABLE tenant_{TENANT_ID}.document_templates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,   -- 'report' | 'email' | 'analysis' | 'summary'
  structure     JSONB NOT NULL,  -- template structure
  example       TEXT,
  embedding     vector(1536),
  created_by    UUID NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Saved searches & entities
CREATE TABLE tenant_{TENANT_ID}.saved_entities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL,
  entity_type   TEXT NOT NULL,   -- 'company' | 'person' | 'property'
  entity_id     TEXT NOT NULL,   -- external ID (CVR etc.)
  entity_name   TEXT NOT NULL,
  notes         TEXT,
  tags          TEXT[],
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Reports generated within this company
CREATE TABLE tenant_{TENANT_ID}.reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL,
  title         TEXT NOT NULL,
  type          TEXT NOT NULL,
  content       JSONB NOT NULL,
  template_id   UUID REFERENCES tenant_{TENANT_ID}.document_templates(id),
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Full audit log — every action within this tenant
CREATE TABLE tenant_{TENANT_ID}.audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL,
  action        TEXT NOT NULL,
  resource_type TEXT,
  resource_id   TEXT,
  metadata      JSONB,
  ip_address    INET,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- RLS: Enable on all tables
ALTER TABLE tenant_{TENANT_ID}.ai_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_{TENANT_ID}.ai_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_{TENANT_ID}.ai_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_{TENANT_ID}.procedures ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_{TENANT_ID}.document_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_{TENANT_ID}.saved_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_{TENANT_ID}.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_{TENANT_ID}.audit_log ENABLE ROW LEVEL SECURITY;
```

---

## Data Isolation Checklist (enforced by DBA agent on every migration)

- [ ] New table has RLS enabled
- [ ] New table has `created_by` (user_id) column
- [ ] All queries in application use tenant-scoped DB client
- [ ] No joins across tenant schemas
- [ ] AI embeddings stored in tenant-specific namespace
- [ ] Audit log entry created for all write operations
- [ ] Migration is reversible (down migration exists)

---

## Migration deployment (BIZZ-735)

Three Supabase environments, three separate secret stores. Migrations must be
applied to each manually (Supabase CLI `db push` isn't wired in yet) — and
every env must have `supabase_migrations.schema_migrations` tracking enabled
so drift is detectable.

| Env  | Project ref            | Migration tracking          |
| ---- | ---------------------- | --------------------------- |
| test | `rlkjmqjxmkxuclehbrnl` | enabled (seeded 2026-04-22) |
| dev  | `wkzwxfhyfmvglrqtmebw` | enabled                     |
| prod | `xsyldjqcntiygrtfcszm` | enabled                     |

### Applying a new migration

1. Write the migration as `supabase/migrations/NNN_description.sql`
   (zero-padded 3-digit version, next in sequence).
2. Apply via Management API SQL (preferred — no local CLI required):
   ```bash
   TOKEN=$SUPABASE_ACCESS_TOKEN
   REF=<project-ref>
   curl -s -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     --data-binary @<(jq -Rs '{query: .}' < supabase/migrations/NNN_description.sql)
   ```
3. Record as applied in the tracking table:
   ```sql
   INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
   VALUES ('NNN', 'description', '{}')
   ON CONFLICT (version) DO NOTHING;
   ```
4. Repeat for all three envs.

### Drift check (automated)

- Script: `scripts/check-migration-drift.mjs`
- CI: `.github/workflows/migration-drift.yml` runs weekly (Mondays 06:00 UTC).
- Exit code 1 when any env is missing a migration that exists locally.

### Incident precedent

**BIZZ-735 (2026-04-22):** Supabase security-advisor alerted that
`public.regnskab_cache` was publicly accessible in test-env. Migration
`044_regnskab_cache_rls.sql` had been skipped silently because test-env had
no migration tracking. Fixed by enabling tracking in all three envs and
adding this weekly drift check.
