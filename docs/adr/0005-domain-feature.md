# ADR-0005: Domain Feature — Enterprise Document Automation

**Status:** Accepted  
**Date:** 2026-04-22  
**Author:** Claude (ARCHITECT agent)  
**Ticket:** BIZZ-697 (parent epic: BIZZ-696)

## Context

BizzAssist adds a "Domain" feature for enterprise customers: AI-powered document generation from templates, using case-specific data + BizzAssist property/company intelligence. This ADR documents all architectural decisions before implementation begins.

## Decisions

### 1. Domain vs Tenant

**Decision: Parallel entity with `owner_tenant_id`.**

A Domain is NOT a tenant. It's a separate workspace entity owned by a tenant (the subscribing company). One tenant can own multiple domains (e.g. "Residential Sales", "Commercial Leasing"). Domains have their own members, templates, cases, and AI budgets.

Rationale: Existing tenant model handles billing + auth. Domain handles document workflows. Mixing them would require migrating all existing tenant logic.

### 2. Role names

**Decision: `admin` + `member` (two roles only).**

- `admin`: Full CRUD on templates, training docs, settings. Can invite/remove users.
- `member`: Can create cases, upload case docs, generate documents. Cannot modify templates or settings.

Rationale: Keep it simple for MVP. A `viewer` role can be added later if needed.

### 3. Template format

**Decision: `.docx` via docxtemplater (MIT license).**

Templates are uploaded as `.docx` files with `{placeholder}` syntax. The `docxtemplater` library fills placeholders programmatically while preserving formatting, styles, headers/footers, and images.

Rationale: End users work in Word. Markdown-first would require a conversion step that loses formatting. docxtemplater is battle-tested, MIT-licensed, and handles complex documents.

### 4. Embeddings provider

**Decision: Voyage AI (`voyage-3-lite`) via pgvector.**

- Model: `voyage-3-lite` (1536 dimensions, optimized for retrieval with Claude)
- Storage: pgvector extension in existing Supabase PostgreSQL
- Index: IVFFlat with 100 lists (sufficient for <1M embeddings initial scale)

Rationale: Voyage is purpose-built for Claude retrieval. pgvector is already available in Supabase — no new infrastructure. OpenAI embeddings would add a second AI provider dependency.

### 5. docx-fill library

**Decision: `docxtemplater` (MIT, open source).**

The free MIT version handles `{placeholder}` replacement, loops (`{#items}...{/items}`), and conditionals. Pro license ($295) adds image insertion, HTML injection, and table generation — purchase if needed post-MVP.

### 6. Generation: sync vs async

**Decision: Synchronous with streaming status.**

Document generation runs synchronously within a single API request:

1. Collect context (template + training docs + case docs via RAG)
2. Call Claude API (streaming)
3. Fill docx template with Claude output
4. Return generated document

Rationale: Typical generation is <60s. Async workers add infrastructure complexity (queues, status polling, failure recovery) that isn't justified for MVP. If generation exceeds 60s consistently, we add a background job queue later.

### 7. Namespace strategy

**Decision: `domain_{uuid}` (UUID is immutable).**

Embedding namespaces, storage paths, and audit log scoping all use `domain_{uuid}`. The UUID never changes even if the domain is renamed.

Example: `domain_a1b2c3d4-e5f6-7890-abcd-ef1234567890`

### 8. Case structure

**Decision: Flat document list + tagging (MVP). Hierarchic folders post-MVP.**

Cases contain a flat list of uploaded documents. Each document has optional tags (e.g. "purchase agreement", "title deed", "survey report"). AI uses all case documents as context.

Rationale: Folder hierarchies add UI complexity without improving AI retrieval quality. Tags are sufficient for organization and can inform the prompt.

### 9. Data retention

**Decision: Configurable per domain, defaults below.**

| Data type           | Default retention        | Configurable range           |
| ------------------- | ------------------------ | ---------------------------- |
| Cases + case docs   | 24 months                | 1–60 months                  |
| Templates           | Permanent                | Not deletable (archive only) |
| Training docs       | Permanent                | Manual delete by admin       |
| Generated documents | 24 months (follows case) | 1–60 months                  |
| Audit log           | 36 months                | 12–60 months                 |
| Embeddings          | Follows source document  | Automatic                    |

A nightly cron (`/api/cron/domain-retention`) hard-deletes expired data (GDPR Article 17 compliance).

## Implementation phases

| Phase                   | Tickets                      | Description                                     |
| ----------------------- | ---------------------------- | ----------------------------------------------- |
| **1: Foundation**       | 698, 699, 700                | Schema + feature flag + auth helpers            |
| **2: Admin**            | 701, 702, 703, 704, 705, 706 | Super-admin + Domain admin UI                   |
| **3: Templates**        | 707, 721, 710                | Upload + editor + versioning                    |
| **4: Training + Cases** | 709, 712, 713, 714           | Training docs + case workspace                  |
| **5: AI Pipeline**      | 715, 716, 717                | Embeddings + RAG + generation                   |
| **6: Compliance**       | 718, 719, 720                | Audit log + GDPR retention + Stripe + ISO 27001 |

## Data isolation (ISO 27001 A.13)

- All domain tables have `domain_id` column with RLS policies
- `is_domain_member(domain_id)` SECURITY DEFINER function validates membership
- Cross-domain queries are impossible without service role
- Storage buckets use path-based isolation: `domain-templates/{domain_id}/...`
- Embeddings use pgvector namespace filter: `WHERE domain_id = $1`

## Security considerations

- Domain Admin cannot access other domains (RLS enforced)
- Template/training doc uploads scanned for file type (docx/pdf/txt only)
- Generated documents inherit case retention policy
- AI prompts never include data from other domains
- Audit log is immutable (no DELETE policy for members/admins)

## Consequences

- New Supabase migration with 9 tables + RLS policies
- New Voyage AI dependency (`@voyageai/sdk`)
- New storage buckets (4)
- Feature flag gates all UI/API until launch
- Enterprise Stripe plan required for domain access
