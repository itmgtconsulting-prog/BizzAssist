# BizzAssist — Data Classification Policy

**ISO 27001 A.8 — Asset Management**
Last updated: 2026-03-20

---

## Classification Levels

| Level | Label            | Description                                                   | Examples                                                          |
| ----- | ---------------- | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1     | **Public**       | Intentionally public, no harm if disclosed                    | Marketing copy, public feature descriptions                       |
| 2     | **Internal**     | For BizzAssist team only — not for customers or third parties | Source code, deployment configs, agent docs                       |
| 3     | **Confidential** | Customer business data — protected by contract and GDPR       | Company profiles, property records, person data, AI conversations |
| 4     | **Restricted**   | Credentials and secrets — severe harm if disclosed            | API keys, JWT signing keys, database passwords, OAuth tokens      |

---

## Data Inventory by Classification

### Public

- Marketing homepage content (text, images)
- Public API documentation
- Open-source dependencies list

### Internal

- Source code
- Architecture documentation (`docs/architecture/`)
- Agent team guidelines (`docs/agents/`)
- Deployment scripts
- Test data (must not contain real customer data)
- Error stack traces in Sentry (must be scrubbed of PII before sharing)

### Confidential

| Data type                                  | Source                    | Stored in                         | Tenant-scoped?                 |
| ------------------------------------------ | ------------------------- | --------------------------------- | ------------------------------ |
| CVR company records                        | Danish Business Authority | Supabase tenant schema            | Yes                            |
| Property (BBR/Tinglysning) records         | Danish registers          | Supabase tenant schema            | Yes                            |
| Business person profiles                   | Public registers          | Supabase tenant schema            | Yes                            |
| AI chat history                            | User input                | Supabase tenant schema            | Yes                            |
| AI learned context (procedures, templates) | Customer upload           | Supabase tenant schema + pgvector | Yes                            |
| Saved searches and reports                 | User actions              | Supabase tenant schema            | Yes                            |
| User profile (name, email, role)           | Registration              | Supabase `public.users`           | No — shared, but RLS-protected |

### Restricted

- Supabase service role key
- Supabase JWT secret
- Claude API key
- Sentry DSN (treat as restricted — leaking allows log injection)
- JIRA API token
- OAuth client secrets (Google, LinkedIn)
- Any private key material

---

## Handling Rules by Level

### Public

- May be cached by CDN without restriction
- May appear in analytics and logs

### Internal

- Only accessible to BizzAssist team members
- Must not be included in customer-facing error messages
- Git repository must be private

### Confidential

- **Never** cross tenant boundaries — enforced at DB (RLS), API, and AI layers
- Must not appear in application logs or Sentry events
- Must not be included in error messages returned to the client
- Encrypted at rest (AES-256 via Supabase) and in transit (TLS 1.2+)
- Access logged to `tenant.audit_log` for every read of sensitive fields
- Data subject requests (GDPR): must be fulfillable within 30 days

### Restricted

- Stored only in environment variables — never in code, comments, or git history
- Never logged — not even partial values
- Rotated every 90 days minimum, or immediately after suspected exposure
- Access limited to the system component that requires it (principle of least privilege)
- If exposed: treat as security incident — rotate immediately, file JIRA ticket with label `security-incident`

---

## PII Identification

The following fields are considered PII under GDPR:

- Full name
- Email address
- Phone number
- CVR-linked person identity (CPR-adjacent)
- IP address (when linkable to a person)
- Behavioural data (search history, when linked to a person)

**Rules for PII:**

- Never include PII in Sentry error events
- Never include PII in JIRA ticket titles or descriptions
- Never log PII to console or application logs
- Anonymise PII in test data — no real names or emails in `__tests__/`

---

## Data Retention

| Data type                | Retention period         | Deletion trigger                       |
| ------------------------ | ------------------------ | -------------------------------------- |
| Active customer data     | Duration of subscription | Account closure                        |
| Tenant data post-closure | 30 days                  | 30 days after account closure          |
| Audit logs               | 12 months                | Rolling — auto-purge at 12 months      |
| Sentry error events      | 90 days                  | Sentry auto-purge setting              |
| AI conversation history  | Configurable per tenant  | Tenant-controlled (default: 12 months) |

## Domæne-federation af forsikrings-analyser (ADR-0011)

Forsikrings-analyser, -dokumenter, -sager og -bibliotek er **Confidential** og
ejes personligt i brugerens egen tenant. De deles inden for et **domæne** som en
revocable læse-federation:

- **Delings-enhed:** domænet. Medlemskab af et domæne (`domain_member`) udgør
  brugerens **samtykke** til at dele sine forsikrings-data med de øvrige nuværende
  domæne-medlemmer.
- **Tilbagekald:** fjernelse af `domain_member`-rækken **tilbagekalder** samtykket
  øjeblikkeligt — federationen beregnes på query-tid (ingen cache), så den anden
  brugers adgang forsvinder med det samme. Data kopieres/flyttes aldrig; de er
  personlige igen.
- **Isolation:** cross-tenant LÆSNING er app-gated gennem én federations-grænse
  (`getDomainLinkedTenants`), dækket af en læk-regressionstest. Skrivning sker
  altid kun til brugerens egen tenant. Brugere uden fælles domæne kan aldrig se
  hinandens forsikrings-data.
- **Bibliotek:** delte standard-dokumenter scopes pr. domæne via `visibility` +
  `added_by_domain` + RLS (BIZZ-1907).
