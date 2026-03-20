# BizzAssist — Access Control Policy

**ISO 27001 A.9 — Access Control**
Last updated: 2026-03-20

---

## Principles

1. **Least privilege** — Users and system components have only the access they need.
2. **Separation of duties** — No single person can both approve and deploy a production change.
3. **Default deny** — Access is denied unless explicitly granted.
4. **Audit everything** — All access to Confidential and Restricted data is logged.

---

## User Roles (Application Layer)

| Role            | Access                                                                    |
| --------------- | ------------------------------------------------------------------------- |
| `super_admin`   | BizzAssist team only — full platform access, tenant management            |
| `tenant_admin`  | Full access within their own tenant — user management, billing, AI config |
| `tenant_member` | Read/write access to their tenant's data — searches, reports, AI chat     |
| `tenant_viewer` | Read-only access to their tenant's data                                   |
| `api_client`    | Machine-to-machine — scoped to specific tenant, specific resources        |

**Rules:**

- Roles are assigned in `public.tenant_memberships` table
- Role escalation requires `tenant_admin` or `super_admin` approval
- `super_admin` accounts must use MFA — no exceptions
- Service accounts use API tokens, never passwords

---

## Authentication Requirements

| Account type    | MFA required         | Password policy                | Session expiry |
| --------------- | -------------------- | ------------------------------ | -------------- |
| `super_admin`   | Yes — mandatory      | 16+ chars, complexity required | 1 hour         |
| `tenant_admin`  | Strongly recommended | 12+ chars                      | 8 hours        |
| `tenant_member` | Optional             | 8+ chars                       | 8 hours        |
| API token       | N/A                  | Token rotation every 90 days   | Token-based    |

**Session management:**

- JWT access tokens expire after 1 hour
- Refresh tokens rotated on every use
- Sessions invalidated on password change
- Concurrent session limit: 5 per user

---

## Database Access Control (Supabase RLS)

Every table in every tenant schema has Row Level Security enabled.

**Pattern for tenant tables:**

```sql
-- Allow tenant members to read their own data only
CREATE POLICY "tenant_read" ON tenant_abc123.companies
  FOR SELECT USING (
    auth.uid() IN (
      SELECT user_id FROM public.tenant_memberships
      WHERE tenant_id = 'abc123'
    )
  );
```

**Rules:**

- The Supabase `service_role` key is **never** used from the frontend
- All frontend requests use the `anon` key — RLS is the security boundary
- All backend/API routes use the `service_role` key scoped with explicit `tenant_id`
- Cross-tenant queries are architecturally impossible via the tenant-scoped client

---

## API Access Control

- All `/api/[tenant]/*` routes validate the active tenant from the authenticated session
- Tenant ID is **never** derived from request body or query parameters — always from verified JWT
- Rate limiting: 10 requests / 60 seconds per IP (enforced in `middleware.ts`)
- API tokens are hashed before storage — raw token shown once on creation only

---

## Third-Party Access

| Integration | Access level                      | Scoping                                                      |
| ----------- | --------------------------------- | ------------------------------------------------------------ |
| Sentry      | Error data only — no customer PII | Production environment only                                  |
| JIRA        | Bug/incident metadata only        | API token scoped to BIZZ project                             |
| Claude API  | Tenant-scoped query context       | Per-request, never stored at Anthropic                       |
| Supabase    | Full DB access                    | Separate keys: `anon` (frontend) vs `service_role` (backend) |

---

## Developer Access

| Environment | Who has access            | How                                   |
| ----------- | ------------------------- | ------------------------------------- |
| Local dev   | Individual developer      | `.env.local` — personal keys          |
| Staging     | BizzAssist team           | Shared secrets manager                |
| Production  | Jakob Juul Rasmussen only | Vercel dashboard + Supabase dashboard |

**Rules:**

- No production access from developer laptops directly
- All production deployments go through CI/CD pipeline
- Production database is never queried from a local machine
- Production secrets are never placed in `.env.local`

---

## Access Review Schedule

| Review                              | Frequency                   | Who                  |
| ----------------------------------- | --------------------------- | -------------------- |
| Active user accounts and roles      | Quarterly                   | `super_admin`        |
| API token inventory                 | Quarterly                   | ARCHITECT            |
| Third-party integration permissions | Semi-annual                 | ARCHITECT            |
| Developer access to production      | Annual                      | Jakob Juul Rasmussen |
| RLS policy review                   | After each schema migration | DBA                  |
