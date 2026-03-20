# ADR 0001 — Use Next.js App Router with TypeScript

**Date:** 2026-03-01
**Status:** Accepted
**Deciders:** Jakob Juul Rasmussen

---

## Context

BizzAssist needs a full-stack web framework that supports:

- Server-side rendering (SEO for marketing pages)
- API routes (backend logic without a separate server)
- React component model (future React Native port)
- TypeScript (code quality and maintainability)

## Decision

Use **Next.js 16 with the App Router** and **TypeScript**.

## Rationale

- App Router enables server components (better performance, reduced client JS)
- API routes eliminate need for a separate backend service in early stages
- TypeScript enforces type safety across the full stack
- Strong ecosystem compatibility with Supabase, Sentry, Vercel
- React components can be ported to React Native for the future mobile app

## Consequences

- Learning curve for App Router patterns (server vs client components)
- Turbopack dev server (incompatible with some plugins — e.g. Sentry in dev)
- Must manage `'use client'` boundaries carefully

---

# ADR 0002 — Use Supabase for Database and Authentication

**Date:** 2026-03-10
**Status:** Accepted
**Deciders:** Jakob Juul Rasmussen

---

## Context

The platform requires:

- PostgreSQL with pgvector for AI embeddings
- Row Level Security for multi-tenant data isolation
- Authentication (email, OAuth) without building from scratch
- EU data residency (GDPR compliance)

## Decision

Use **Supabase** (hosted in EU West — Frankfurt).

## Rationale

- Schema-per-tenant pattern supported natively
- RLS enforced at the database layer — strongest isolation guarantee
- Supabase Auth handles email, Google OAuth, LinkedIn OAuth, TOTP 2FA
- pgvector extension available for AI embeddings
- SOC 2 Type II, GDPR DPA available
- No vendor lock-in on the DB layer — standard PostgreSQL

## Consequences

- Supabase service role key must be kept strictly server-side
- RLS policies add complexity but are non-negotiable for multi-tenant
- pgvector queries may need index tuning at scale (HNSW index)

---

# ADR 0003 — Use Claude API (Anthropic) for AI Features

**Date:** 2026-03-10
**Status:** Accepted
**Deciders:** Jakob Juul Rasmussen

---

## Context

BizzAssist needs AI capabilities for: company analysis, competitive intelligence, property market analysis, and conversational Q&A about Danish business data.

## Decision

Use **Anthropic Claude API** (`claude-3-5-sonnet` for analysis, `claude-3-haiku` for fast responses).

## Rationale

- Best-in-class reasoning for complex business analysis tasks
- Large context window (200K tokens) handles full company profiles
- Already using Claude Code for development
- Clear data processing terms — no training on customer data
- Danish language capability for bilingual support

## Consequences

- Anthropic DPA required before handling customer data
- Per-tenant context isolation must be enforced in every API call
- Costs must be tracked per tenant for usage-based billing

---

# ADR Template — Copy for new decisions

**Date:** YYYY-MM-DD
**Status:** Proposed | Accepted | Deprecated | Superseded by ADR-XXXX
**Deciders:** [names]

---

## Context

[What is the problem or situation that requires a decision?]

## Decision

[What is the decision that was made?]

## Rationale

[Why was this the best option? What alternatives were considered?]

## Consequences

[What are the positive and negative outcomes of this decision?]
