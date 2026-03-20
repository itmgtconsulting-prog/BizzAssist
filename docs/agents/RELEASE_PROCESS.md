# BizzAssist — Release Process & Quality Gates

**ISO 27001 A.14 — System Development and Maintenance**
Last updated: 2026-03-20

---

## Overview

Every piece of code written for BizzAssist must pass through 4 mandatory gates before it can be used in production. No exceptions.

```
DEVELOPER writes code
       ↓
  [GATE 1] CODE REVIEWER checklist — all boxes ticked?
       ↓
  [GATE 2] ARCHITECT sign-off — architecture + ISO 27001 compliance?
       ↓
  [GATE 3] TESTER — all tests green? Coverage thresholds met?
       ↓
  [GATE 4] git pre-commit hook — secret scan + test run pass?
       ↓
  CODE IS RELEASED
```

---

## Gate 1 — CODE REVIEWER Checklist

**Who:** CODE REVIEWER agent
**When:** After any function, component, API route, or database change is written

The CODE REVIEWER must confirm ALL of the following before approving:

### Comments & Documentation

- [ ] Every function has a JSDoc comment describing: purpose, parameters, return value
- [ ] Every React component has a JSDoc comment describing: purpose, props
- [ ] Every API route has a JSDoc comment describing: method, input, output, auth requirement
- [ ] Complex logic has inline comments explaining _why_, not just _what_

### Security (ISO 27001)

- [ ] No secrets, API keys, or credentials anywhere in source code
- [ ] No PII (names, emails, IPs) in any log statement or error response
- [ ] All external user input validated and sanitised at API boundary
- [ ] No `eval()`, `dangerouslySetInnerHTML`, or dynamic code execution
- [ ] New public API routes have rate limiting configured in `middleware.ts`
- [ ] `npm audit` run — zero new critical or high CVEs introduced
- [ ] New third-party dependencies reviewed for security and necessity

### Data Isolation (non-negotiable)

- [ ] Every database query is scoped to a single verified `tenant_id`
- [ ] `tenant_id` is sourced from the authenticated session JWT — never from request body or query params
- [ ] No query touches more than one tenant schema
- [ ] No cross-tenant references in UI state or cache

### Code Quality

- [ ] No TypeScript `any` types without documented justification
- [ ] All async operations have proper error handling (try/catch or .catch())
- [ ] No N+1 query patterns
- [ ] No hardcoded UI strings — all text goes through `translations.ts`
- [ ] Dark theme maintained — no white/light backgrounds in new UI components

---

## Gate 2 — ARCHITECT Review

**Who:** ARCHITECT agent
**When:** Any change that touches: routing structure, database schema, authentication, middleware, or third-party integrations

The ARCHITECT must confirm:

- [ ] New routes follow the SaaS path convention: `app/(app)/[tenant]/...`
- [ ] No shared mutable state between tenants
- [ ] Database migrations include RLS policies (see `docs/architecture/DATABASE.md`)
- [ ] Security headers and middleware in `next.config.ts` / `middleware.ts` are not bypassed
- [ ] New integrations reviewed against `docs/security/ISMS.md` Section 10 (Supplier Security)
- [ ] Architecture does not create a single point of failure
- [ ] Change is documented if it affects the architecture docs

---

## Gate 3 — TESTER Verification

**Who:** TESTER (CODE REVIEWER performs this in the current agent setup)
**When:** Before every commit and before every production release

### Required test commands

```bash
# Unit + component tests (must pass with zero failures)
npm test

# With coverage report (thresholds: lines ≥70%, branches ≥60%)
npm run test:coverage

# End-to-end tests (must pass on all 3 viewports: desktop, mobile Chrome, mobile Safari)
npm run test:e2e
```

### Coverage thresholds (enforced in vitest.config.ts)

| Metric    | Minimum |
| --------- | ------- |
| Lines     | 70%     |
| Functions | 70%     |
| Branches  | 60%     |

### New code requirements

- Every new API route handler: at least 1 unit test
- Every new React component with logic: at least 1 component test
- Every user-facing flow change: E2E test updated or added
- Tests must cover the happy path AND at least one error/edge case

---

## Gate 4 — Git Pre-Commit Hook (Automated)

**Runs automatically on every `git commit`**
Located at: `.git/hooks/pre-commit`

The hook automatically:

1. Scans staged files for hardcoded secrets/credentials → **blocks commit if found**
2. Runs `npm test` → **blocks commit if any test fails**
3. Prints the CODE REVIEWER reminder checklist

This gate **cannot be skipped** — `git commit --no-verify` is forbidden per `CLAUDE.md`.

---

## Release Workflow Summary

```
1. Feature/fix implemented by DEVELOPER agent
2. Self-review: DEVELOPER runs npm test locally first
3. CODE REVIEWER gate: full checklist review
4. ARCHITECT gate: (if applicable) architecture review
5. TESTER gate: npm test + npm run test:coverage + npm run test:e2e
6. git commit: pre-commit hook runs automatically (secret scan + tests)
7. PR created with checklist in description
8. Merge to main only when all gates are green
```

---

## What "Work is Done" Means

Work is **not done** when the code is written.
Work is **done** when:

- ✅ All CODE REVIEWER boxes are checked
- ✅ ARCHITECT has signed off (if required)
- ✅ `npm test` passes with zero failures
- ✅ `npm run test:coverage` meets thresholds
- ✅ Pre-commit hook passes (no blocked commit)
- ✅ No `any` types, no missing JSDoc, no hardcoded strings

---

## Escalation

If any gate cannot be passed without a waiver:

1. Create a JIRA ticket in project `BIZZ` with label `quality-exception`
2. Document: what is being skipped, why, what the risk is, when it will be fixed
3. Get explicit approval from Jakob Juul Rasmussen before proceeding
4. Fix must be scheduled in the current or next sprint — no exceptions left open indefinitely
