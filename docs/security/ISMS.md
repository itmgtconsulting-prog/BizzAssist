# BizzAssist — Information Security Management System (ISMS)

**ISO/IEC 27001:2022 Aligned**
Last updated: 2026-03-20
Owner: Jakob Juul Rasmussen, BizzAssist

---

## 1. Scope

This ISMS covers all information assets related to the BizzAssist SaaS platform, including:

- Source code and development infrastructure
- Customer data (company profiles, property data, business person data)
- Authentication and session data
- AI model inputs and outputs
- Third-party integrations (Sentry, JIRA, Supabase, Claude API)

**Out of scope:** Physical office security, personal devices not used for development.

---

## 2. Information Security Policy (ISO 27001 A.5)

BizzAssist is committed to protecting the confidentiality, integrity, and availability of all information it processes.

**Core principles:**

1. **Confidentiality** — Customer data is never shared across tenant boundaries. All access is need-to-know.
2. **Integrity** — Data is protected against unauthorised modification via audit logs and RLS policies.
3. **Availability** — The platform targets 99.9% uptime. Incidents are tracked and resolved via JIRA.
4. **Compliance** — The platform complies with GDPR (as a Danish company processing EU data) and this ISMS.

---

## 3. Risk Management (ISO 27001 A.6 / Clause 6)

Risk assessments are performed:

- Before every major architectural change
- When onboarding a new third-party integration
- After any security incident

**Risk register:** Maintained in JIRA project `BIZZ` with label `security-risk`.

**Risk treatment approach:**
| Risk level | Action |
|---|---|
| Critical | Immediate fix before deployment |
| High | Fix within 1 sprint (2 weeks) |
| Medium | Fix within current quarter |
| Low | Accept + document, review quarterly |

---

## 4. Asset Management (ISO 27001 A.8)

### Data Assets

| Asset                      | Classification | Owner      | Location                                  |
| -------------------------- | -------------- | ---------- | ----------------------------------------- |
| Customer company data      | Confidential   | BizzAssist | Supabase (tenant schema)                  |
| Property data              | Confidential   | BizzAssist | Supabase (tenant schema)                  |
| Business person data       | Confidential   | BizzAssist | Supabase (tenant schema)                  |
| AI conversation history    | Confidential   | Tenant     | Supabase (tenant schema)                  |
| Authentication credentials | Restricted     | BizzAssist | Supabase Auth                             |
| Source code                | Internal       | BizzAssist | Git repository                            |
| API keys and secrets       | Restricted     | BizzAssist | `.env.local` / production secrets manager |
| Audit logs                 | Internal       | BizzAssist | Supabase (tenant.audit_log)               |

### System Assets

| Asset                       | Purpose                 | Owner      |
| --------------------------- | ----------------------- | ---------- |
| Vercel / Next.js deployment | Application hosting     | BizzAssist |
| Supabase                    | Database + Auth         | BizzAssist |
| Sentry                      | Error monitoring        | BizzAssist |
| JIRA (Atlassian Cloud)      | Bug + incident tracking | BizzAssist |
| Claude API (Anthropic)      | AI inference            | BizzAssist |

---

## 5. Access Control (ISO 27001 A.9)

See `docs/security/ACCESS_CONTROL.md` for full policy.

**Summary:**

- Role-based access control (RBAC) at application layer
- Row Level Security (RLS) at database layer enforced by Supabase
- All admin functions require re-authentication
- API keys rotated minimum every 90 days
- No shared credentials — each developer has individual accounts

---

## 6. Cryptography (ISO 27001 A.10)

- All data in transit: TLS 1.2+ (enforced by HSTS header, 2-year max-age)
- All data at rest: AES-256 encryption (Supabase default)
- Passwords: bcrypt with minimum cost factor 12 (via Supabase Auth)
- API tokens: stored only as environment variables, never in code or logs
- JWT tokens: signed with RS256, expiry ≤ 1 hour, refresh tokens rotated on use

---

## 7. Operations Security (ISO 27001 A.12)

### Logging

- All application errors captured by Sentry → automatically creates JIRA ticket
- All tenant data mutations logged to `tenant.audit_log` table
- Logs retained for minimum 12 months (GDPR Article 30)

### Vulnerability Management

- Dependencies audited with `npm audit` before every release
- Critical CVEs patched within 72 hours
- Security patches applied via dedicated PR — no bundling with feature work

### Change Management

- All code changes go through CODE REVIEWER before merge
- Architecture changes require ARCHITECT sign-off
- Database schema changes require DBA sign-off

---

## 8. Communications Security (ISO 27001 A.13)

- HTTP security headers on all responses (see `next.config.ts`)
  - Content-Security-Policy (CSP)
  - Strict-Transport-Security (HSTS)
  - X-Frame-Options: DENY
  - X-Content-Type-Options: nosniff
  - Referrer-Policy: strict-origin-when-cross-origin
  - Permissions-Policy
- Rate limiting on all public API endpoints (middleware.ts)
- CORS: only trusted origins allowed in production

---

## 9. Secure Development (ISO 27001 A.14)

- Secure coding standards enforced by CODE REVIEWER (see `CLAUDE.md`)
- JSDoc comments required on all functions — aids security audit
- No secrets in source code (enforced by pre-commit check)
- Input validation on all API route handlers
- No `eval()` or dynamic code execution
- Dependencies reviewed before addition (`npm audit`, known-good publishers)

---

## 10. Supplier Security (ISO 27001 A.15)

| Supplier               | Data shared                 | Security assessment                               |
| ---------------------- | --------------------------- | ------------------------------------------------- |
| Supabase               | All customer data           | SOC 2 Type II, GDPR DPA in place                  |
| Vercel                 | Request/response data       | SOC 2 Type II, GDPR DPA in place                  |
| Anthropic (Claude API) | Tenant-scoped query context | Data Processing Agreement required before go-live |
| Sentry                 | Error stack traces (no PII) | SOC 2 Type II                                     |
| Atlassian (JIRA)       | Bug reports (no PII)        | SOC 2 Type II, ISO 27001 certified                |

**Rule:** No customer PII may be sent to any supplier without a signed Data Processing Agreement (DPA).

---

## 11. Incident Management (ISO 27001 A.16)

See `docs/security/INCIDENT_RESPONSE.md` for full procedure.

**Summary flow:**

```
Error detected (Sentry)
    → Auto-creates JIRA ticket (label: incident)
    → Severity assessed within 1 hour
    → Containment actions within 4 hours (critical) / 24 hours (high)
    → Customer notification if data affected
    → Post-incident review within 5 days
    → Lessons learned documented in JIRA
```

---

## 12. Business Continuity (ISO 27001 A.17)

- Database: Supabase automated daily backups, point-in-time recovery (7 days)
- Code: Git repository is the authoritative backup — always pushed to remote
- Recovery Time Objective (RTO): 4 hours
- Recovery Point Objective (RPO): 24 hours

---

## 13. GDPR Compliance (ISO 27001 A.18 + Danish DPA)

- Legal basis for processing: Legitimate interest (B2B platform, publicly registered data)
- Data minimisation: only collect data required for platform function
- Data subject rights: erasure and export endpoints to be implemented pre-launch
- Data retention: customer data deleted within 30 days of account closure
- Privacy Policy: required before public launch
- Records of processing activities: maintained as part of this ISMS

---

## 14. Review Schedule

| Review               | Frequency           | Owner                |
| -------------------- | ------------------- | -------------------- |
| ISMS full review     | Annual              | Jakob Juul Rasmussen |
| Risk register        | Quarterly           | ARCHITECT agent      |
| Access control audit | Quarterly           | ARCHITECT + DBA      |
| Dependency audit     | Per release         | BACKEND DEVELOPER    |
| Incident review      | After each incident | All agents           |
