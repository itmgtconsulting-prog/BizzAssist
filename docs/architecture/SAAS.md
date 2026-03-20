# BizzAssist — SaaS Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    SHARED CODEBASE                          │
│                   (Next.js 16 App)                          │
├─────────────────────────────────────────────────────────────┤
│  Marketing Layer    │  Auth Layer    │  App Layer           │
│  bizzassist.dk      │  /login        │  app.bizzassist.dk   │
│  (public)           │  /register     │  /[tenant]/...       │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
    ┌──────────────┐  ┌─────────────┐  ┌──────────────┐
    │  SHARED API  │  │  TENANT API │  │  ADMIN API   │
    │  /api/auth   │  │  /api/[t]/  │  │  /api/admin/ │
    │  /api/public │  │  (scoped)   │  │  (internal)  │
    └──────────────┘  └─────────────┘  └──────────────┘
              │               │               │
              ▼               ▼               ▼
    ┌──────────────────────────────────────────────────┐
    │              SUPABASE (PostgreSQL)                │
    ├──────────────────┬───────────────────────────────┤
    │  public schema   │  tenant_[id] schema (×N)      │
    │  (shared users,  │  (company data, AI context,   │
    │   tenants,       │   procedures, templates,       │
    │   billing)       │   conversations, reports)      │
    └──────────────────┴───────────────────────────────┘
              │               │
              ▼               ▼
    ┌──────────────┐  ┌─────────────────────────────┐
    │  CLAUDE API  │  │  VECTOR STORE (pgvector)     │
    │  (shared     │  │  namespace_[tenant_id]       │
    │   model)     │  │  (company-specific           │
    │              │  │   embeddings — isolated)     │
    └──────────────┘  └─────────────────────────────┘
```

---

## Tenant Resolution

Every request goes through tenant middleware:

```
Request → middleware.ts
  1. Extract tenant from subdomain or path
  2. Look up tenant in public.tenants
  3. Verify user is member of this tenant
  4. Attach tenant context to request
  5. All subsequent DB calls scoped to tenant schema
```

URL strategy:

- `bizzassist.dk` — marketing (no tenant)
- `app.bizzassist.dk/login` — auth (no tenant)
- `app.bizzassist.dk/[tenant-slug]/dashboard` — tenant app
- API: `X-Tenant-ID` header on all authenticated requests

---

## Layers

### Layer 1: Platform (Shared)

- User authentication (Supabase Auth)
- Tenant registration & provisioning
- Billing & subscription management
- Platform admin dashboard

### Layer 2: General User Repository (Shared)

- User profiles stored in `public.users`
- Users can belong to multiple tenants
- User preferences stored per-tenant (not shared)

### Layer 3: Business Domain Layer (Per-Tenant)

Each company gets a completely isolated environment:

- Own database schema (`tenant_[id]`)
- Own AI context (procedures, templates, output formats)
- Own vector store namespace (embeddings)
- Own conversation history
- Own audit log
- Own reports & saved searches

### Layer 4: AI Intelligence Layer (Per-Tenant)

Each company's AI learns from:

1. **Procedures** — how the company does things
2. **Templates** — how the company wants output formatted
3. **Documents** — company-specific uploaded knowledge
4. **Conversation history** — learned preferences over time

The AI uses RAG (Retrieval-Augmented Generation):

```
User query
  → Retrieve relevant company context (vector search in tenant namespace)
  → Build system prompt with company context
  → Call Claude API
  → Format response using company template
  → Log to tenant audit log
  → Return to user
```

**CRITICAL**: The vector search uses `namespace_[tenant_id]` filter.
It is architecturally impossible to retrieve documents from another tenant.

---

## Project Structure

```
bizzassist/
├── app/
│   ├── (marketing)/             ← Public homepage
│   │   ├── page.tsx
│   │   └── components/
│   ├── (auth)/                  ← Login, register, forgot password
│   │   ├── login/
│   │   └── register/
│   ├── (app)/                   ← Authenticated app shell
│   │   └── [tenant]/            ← Tenant-scoped routes
│   │       ├── layout.tsx       ← Validates tenant access
│   │       ├── dashboard/
│   │       ├── search/
│   │       ├── chat/            ← AI chat (tenant context)
│   │       ├── companies/
│   │       ├── people/
│   │       ├── properties/
│   │       ├── analysis/
│   │       ├── templates/       ← Company output templates
│   │       ├── procedures/      ← Company procedures for AI
│   │       └── settings/
│   └── api/
│       ├── auth/                ← Shared auth endpoints
│       ├── public/              ← Public data endpoints (no auth)
│       ├── [tenant]/            ← Tenant-scoped API
│       │   ├── search/
│       │   ├── chat/
│       │   ├── ai/
│       │   │   ├── query/       ← AI query with tenant context
│       │   │   ├── learn/       ← Feed new context to tenant AI
│       │   │   └── embeddings/  ← Manage tenant embeddings
│       │   ├── reports/
│       │   └── settings/
│       └── admin/               ← Platform admin (internal)
│           ├── tenants/
│           └── users/
├── lib/
│   ├── db/
│   │   ├── shared.ts            ← Client for public schema
│   │   ├── tenant.ts            ← Client for tenant schema (requires tenant_id)
│   │   └── migrations/
│   │       ├── shared/          ← Migrations for public schema
│   │       └── tenant/          ← Template migrations per new tenant
│   ├── ai/
│   │   ├── client.ts            ← Claude API client
│   │   ├── tenant-context.ts    ← Builds tenant-scoped system prompt
│   │   ├── embeddings.ts        ← Tenant-scoped vector operations
│   │   └── rag.ts               ← RAG pipeline (tenant-isolated)
│   ├── auth/
│   │   ├── middleware.ts        ← Tenant resolution + auth check
│   │   └── tenant-context.ts    ← React context for active tenant
│   └── types/
│       ├── tenant.ts
│       ├── user.ts
│       └── ai.ts
├── components/                  ← Shared UI components (web + mobile ready)
└── docs/
    ├── architecture/
    └── agents/
```

---

## Security Rules (enforced at all times)

1. **Never** query tenant schema without validated tenant_id
2. **Never** join across tenant schemas
3. **Never** use tenant_id from client — always derive from auth session
4. **Never** expose raw DB errors to client
5. **Every** write operation must create an audit log entry
6. **Every** AI query must use tenant-scoped vector namespace
7. **Every** API route must validate tenant membership before responding
