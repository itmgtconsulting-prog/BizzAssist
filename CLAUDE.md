# BizzAssist — Development Guidelines

## Architecture

Full specification: `docs/architecture/SAAS.md`
Database design: `docs/architecture/DATABASE.md`
Agent team: `docs/agents/TEAM.md`

## Security (ISO 27001)

ISMS policy: `docs/security/ISMS.md`
Data classification: `docs/security/DATA_CLASSIFICATION.md`
Access control: `docs/security/ACCESS_CONTROL.md`
Incident response: `docs/security/INCIDENT_RESPONSE.md`

## Non-Negotiable Rules

### Data Isolation (CRITICAL)

- Data from different companies MUST NEVER mix
- Every DB query requires an explicit `tenantId` parameter
- Always use `lib/db/tenant.ts` for tenant data — never raw queries
- AI vector searches MUST use `namespace_[tenant_id]` filter
- Never derive tenant_id from user input — always from validated auth session

### Tech Stack

- Next.js 16 App Router + TypeScript
- Tailwind CSS v4 (dark theme throughout — no white backgrounds)
- Supabase (PostgreSQL + pgvector + Auth)
- Claude API for AI features
- Sentry for error monitoring → JIRA for tickets

### UI Rules

- Dark theme everywhere (bg: #0f172a / #0a1020)
- Bilingual: all strings in `app/lib/translations.ts`
- Components must be mobile-ready (future React Native port)
- No hardcoded tenant references in UI components

### Code Quality

- No `any` types
- All API routes handle errors with try/catch
- All writes log to `tenant.audit_log`
- Critical paths have tests

### Security Standards (ISO 27001 — non-negotiable)

- **No secrets in code** — all keys via environment variables only
- **No PII in logs** — never log names, emails, IPs, or IDs in application logs or Sentry
- **Input validation** — validate and sanitise all external input at API boundaries
- **No `eval()` or dynamic code execution**
- **No cross-tenant queries** — every DB call must be scoped to a single verified tenant_id
- **HTTP security headers** applied to all responses (managed in `next.config.ts`)
- **Rate limiting** on all public API routes (managed in `middleware.ts`)
- **Dependencies** — run `npm audit` before any new package is added; no packages with critical CVEs
- See `docs/security/` for full ISMS, data classification, access control, and incident response policies

### Commenting Standards (enforced by CODE REVIEWER)

Every function, component, hook, and API route MUST have a JSDoc comment block:

```ts
/**
 * Brief description of what this does.
 *
 * @param paramName - What this parameter is
 * @returns What is returned
 */
```

- Inline comments required for any non-obvious logic
- All React components: describe props and purpose in JSDoc above the function
- All `useEffect` / `useCallback` / `useMemo`: comment explains _why_, not just _what_
- All API routes: comment describes endpoint, expected input, and returned shape
- Missing comments = PR blocked by CODE REVIEWER

## Project Structure

See `docs/architecture/SAAS.md` for full folder structure.

## Release Process (mandatory — no exceptions)

Full process: `docs/agents/RELEASE_PROCESS.md`

**4 gates every code change must pass:**

1. **CODE REVIEWER** — JSDoc comments, security, ISO 27001, data isolation
2. **ARCHITECT** — architecture compliance (required for structural changes)
3. **TESTER** — `npm test` + `npm run test:e2e` green, coverage ≥ 70% lines / ≥ 60% branches
4. **Git pre-commit hook** — secret scan + test run (automated, runs on every `git commit`)

**Work is NOT done until all 4 gates are green.**
`git commit --no-verify` is forbidden.

## Agent Roles

- ARCHITECT: approves structural changes
- BACKEND DEV: API routes + DB
- FRONTEND DEV: UI components + pages
- CODE REVIEWER: quality gate before production
- DBA: schema + migrations + RLS
- AI/ML: intelligence layer + embeddings
