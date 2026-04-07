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

### API Route Security (enforced on every new route)

- Every API route MUST call `resolveTenantId()` at the top and return 401 if unauthenticated
- Never expose raw external API error messages — return `'Ekstern API fejl'` instead
- Always add `AbortSignal.timeout(10000)` to external fetch calls
- Sentry: `maskAllText: true`, `blockAllMedia: true` — never capture PII in session replays
- Cron routes: verify `CRON_SECRET` bearer token AND `x-vercel-cron: 1` header in production

### GDPR Rules (non-negotiable)

- All new data-storing endpoints must document retention period in JSDoc
- User-scoped data must be deletable — every new table needs a user_id/tenant_id for cascade delete
- No PII sent to third-party services without explicit consent and documented DPA
- New sub-processors must be added to `app/privacy/page.tsx` processor list
- Search/activity data: max retention 12 months (enforced by `/api/cron/purge-old-data`)

### Performance Rules

- Heavy libraries (Mapbox, Recharts, diagram components) MUST use `next/dynamic` with `ssr: false`
- Never import `mapbox-gl/dist/mapbox-gl.css` in components — only in `app/layout.tsx`
- Every dashboard route MUST have a `loading.tsx` skeleton screen
- Use `React.memo` + `useCallback` for components that receive callback props
- LRU cache (max 150 entries) for repeated external API calls within a session

### Accessibility Rules (WCAG AA)

- All icon-only buttons MUST have `aria-label`
- Modal dialogs MUST have `role="dialog"` + `aria-modal="true"` + `aria-labelledby` + focus trap
- Tab interfaces MUST use `role="tablist"` / `role="tab"` / `aria-selected` / `role="tabpanel"`
- Interactive `<div>` elements with `onClick` MUST be converted to `<button>`
- Form labels MUST be associated with inputs via `htmlFor` + `id`
- All pages need a skip-to-main-content link (implemented in `app/dashboard/layout.tsx`)

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

### Commit Message Rules

- Subject must be **lowercase** (commitlint enforces `subject-case: lower-case`)
- Use conventional commits: `feat:`, `fix:`, `test:`, `chore:`, `docs:`, `refactor:`
- JIRA references (`BIZZ-123`) go in the commit **body**, not the subject
- Never use `git commit --no-verify` — fix the underlying issue instead

## Project Structure

See `docs/architecture/SAAS.md` for full folder structure.

## Release Process (mandatory — no exceptions)

Full process: `docs/agents/RELEASE_PROCESS.md`

**4 gates every code change must pass:**

1. **CODE REVIEWER** — JSDoc comments, security, ISO 27001, data isolation
2. **ARCHITECT** — architecture compliance (required for structural changes)
3. **TESTER** — `npm test` + `npm run test:e2e` green, coverage ≥ 70% lines / ≥ 35% branches
4. **Git pre-commit hook** — secret scan + test run (automated, runs on every `git commit`)

**Work is NOT done until all 4 gates are green.**
`git commit --no-verify` is forbidden.

### Test Coverage Requirements

- Minimum thresholds (enforced by vitest — CI fails below these):
  - Lines: **60%**
  - Functions: **50%**
  - Branches: **35%**
- `app/api/**` is excluded from unit coverage (tested via Playwright E2E)
- New lib utilities in `app/lib/` MUST have unit tests
- New React components MUST have component tests
- New Stripe webhook event types MUST have integration tests
- Run `npm run test:coverage` to verify before committing

## Agent Roles

- ARCHITECT: approves structural changes
- BACKEND DEV: API routes + DB
- FRONTEND DEV: UI components + pages
- CODE REVIEWER: quality gate before production
- DBA: schema + migrations + RLS
- AI/ML: intelligence layer + embeddings

---

## Mandatory Pre-Session Reading

**Before starting any task**, read these documents to understand the full system:

1. `docs/architecture/SAAS.md` — full system architecture and folder structure
2. `docs/architecture/DATABASE.md` — database schema, tenant model, RLS setup
3. `docs/security/ISMS.md` — ISO 27001 information security policy
4. `docs/http_api_beskrivelse_v112.docx` — interface documentation for external APIs
5. `docs/BACKLOG.md` — current backlog and known issues

These are the authoritative sources. Never assume — read first.

---

## State Management Rule (Non-Negotiable)

**Never use `localStorage` or `sessionStorage` for user data** unless it is a temporary offline fallback with a clearly documented justification.

- User preferences, recent searches, saved entities, notifications → stored in Supabase tables
- Users must be able to log in from any browser/device and see the same state
- `localStorage` is acceptable **only** as a fallback when Supabase is unavailable (e.g. `NotifikationsDropdown.tsx` hybrid pattern — fallback is acceptable there, but Supabase is always the primary source)
- Never use `localStorage` as the **primary** data store for anything that should persist across devices

---

## BizzAssist Solution Map

### Dashboard Routes (`app/dashboard/`)

| Route                              | Purpose                                                       |
| ---------------------------------- | ------------------------------------------------------------- |
| `/dashboard`                       | Main dashboard — search, recent entities, quick stats         |
| `/dashboard/ejendomme/[id]`        | Property detail — BBR, ownership, tinglysning, tax, docs, map |
| `/dashboard/companies/[cvr]`       | Company detail — CVR data, owners, subsidiaries, financials   |
| `/dashboard/owners/[enhedsNummer]` | Owner/person detail page                                      |
| `/dashboard/kort`                  | Full-screen map with WMS layers, property markers             |
| `/dashboard/compare`               | Side-by-side property/company comparison                      |
| `/dashboard/tokens`                | API token management for tenant                               |
| `/dashboard/settings`              | User profile, GDPR export/delete, notifications               |
| `/dashboard/settings/security`     | Password change, 2FA                                          |
| `/dashboard/admin/*`               | Super-admin: user management, support analytics, tickets      |

### Key Components (`app/components/`)

| Component                   | Purpose                                                             |
| --------------------------- | ------------------------------------------------------------------- |
| `AIChatPanel.tsx`           | Streaming AI assistant sidebar with 12 tools                        |
| `BugReportModal.tsx`        | In-app bug report dialog (Sentry-integrated)                        |
| `CookieBanner.tsx`          | GDPR cookie consent banner                                          |
| `ErrorBoundary.tsx`         | React error boundary with Sentry capture                            |
| `FeedbackButton.tsx`        | Floating feedback button                                            |
| `FoelgTooltip.tsx`          | "Follow property" tooltip/button                                    |
| `Navbar.tsx`                | Public marketing navbar with DA/EN toggle                           |
| `NotifikationsDropdown.tsx` | Bell icon with notification tabs (Supabase + localStorage fallback) |
| `OnboardingModal.tsx`       | First-login onboarding flow                                         |
| `SessionTimeoutWarning.tsx` | Warns user before Supabase session expires                          |
| `SubscriptionGate.tsx`      | Blocks premium features without active subscription                 |
| `SupportChatWidget.tsx`     | Intercom-style support chat                                         |
| `ejendomme/PropertyMap.tsx` | BBR property map with Mapbox                                        |
| `diagrams/`                 | Company/owner relationship diagrams (force-directed)                |

### Public Pages (`app/(public)/`)

| Route                      | Purpose                                 |
| -------------------------- | --------------------------------------- |
| `/`                        | Marketing homepage                      |
| `/login`                   | Supabase Auth login                     |
| `/signup`                  | Registration + tenant provisioning      |
| `/privacy`                 | GDPR privacy policy with processor list |
| `/virksomhed/[slug]/[cvr]` | Public company SEO page                 |
| `/ejendom/[slug]/[bfe]`    | Public property SEO page                |

---

## External Services & Credentials

**All secrets are in `.env.local` — never hardcode.**

| Service                   | Purpose                      | How to find credentials                                                                                |
| ------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Supabase**              | PostgreSQL + Auth + pgvector | `.env.local`: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |
| **Vercel**                | Hosting + CI/CD              | Project: `prj_HX46RO3u4Jhbvira8ju2hsF3xtTs`, repo branch: `develop` → PR → `main`                      |
| **GitHub**                | Source control               | Repo: `itmgtconsulting-prog/BizzAssist`                                                                |
| **JIRA**                  | Issue tracking               | `bizzassist.atlassian.net`, see `docs/agents/TEAM.md`                                                  |
| **Sentry**                | Error monitoring             | DSN in `.env.local`: `NEXT_PUBLIC_SENTRY_DSN`                                                          |
| **Anthropic / Claude**    | AI chat features             | `.env.local`: `BIZZASSIST_CLAUDE_KEY`                                                                  |
| **Stripe**                | Subscriptions (live mode)    | `.env.local`: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`                                             |
| **Upstash Redis**         | Rate limiting                | `.env.local`: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`                                     |
| **Mapbox**                | Property maps                | `.env.local`: `NEXT_PUBLIC_MAPBOX_TOKEN`                                                               |
| **Datafordeler**          | BBR, MAT, DAR, VUR data      | `.env.local`: `DATAFORDELER_USER`, `DATAFORDELER_PASS`                                                 |
| **CVR Erhvervsstyrelsen** | System-to-system CVR access  | `.env.local`: `CVR_ES_USER`, `CVR_ES_PASS` (pending approval)                                          |
| **Resend**                | Transactional email          | `.env.local`: `RESEND_API_KEY`                                                                         |
| **Twilio**                | SMS notifications            | `.env.local`: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`                                                |
| **Brave Search**          | Web search in AI tools       | `.env.local`: `BRAVE_SEARCH_API_KEY`                                                                   |
| **Mediastack**            | News feed                    | `.env.local`: `MEDIASTACK_API_KEY`                                                                     |
| **Cron**                  | Vercel cron jobs             | `.env.local`: `CRON_SECRET` (bearer token for cron routes)                                             |

---

## Interface Documentation

External API integration specs are in:

- `docs/http_api_beskrivelse_v112.docx` — HTTP API description v1.12 (primary interface reference)
- `docs/adr/` — Architecture Decision Records (ADRs) for significant decisions

When integrating a new external API, check this document first to see if the interface is already specified.

---

## Current Backlog

See `docs/BACKLOG.md` for the authoritative list of open issues, pending integrations, and known limitations. Always check this before starting new work — the task may already be scoped there.
