## Summary

<!-- What does this PR do? Link the JIRA ticket: BIZZ-XXX -->

**JIRA:** [BIZZ-](https://bizzassist.atlassian.net/browse/BIZZ-)

## Type of change

- [ ] 🚀 New feature
- [ ] 🐛 Bug fix
- [ ] ♻️ Refactor
- [ ] 🔒 Security fix
- [ ] 📝 Documentation
- [ ] 🧪 Tests only
- [ ] 🔧 Chore / config

## Changes made

## <!-- Brief bullet list of what changed -->

- ***

## CODE REVIEWER Checklist

> All boxes must be checked before merging. See `docs/agents/RELEASE_PROCESS.md`

### Comments & Documentation

- [ ] Every new function/component/hook/API route has a JSDoc comment
- [ ] Complex logic has inline comments explaining _why_
- [ ] No TODO comments left without a linked JIRA ticket

### Security (ISO 27001)

- [ ] No secrets, tokens, or credentials in source code
- [ ] No PII (names, emails, IPs) in any log or error response
- [ ] All external input validated at API boundaries
- [ ] No `eval()` or `dangerouslySetInnerHTML`
- [ ] New API routes have rate limiting configured
- [ ] `npm audit` run — no new critical or high CVEs

### Data Isolation

- [ ] Every DB query scoped to a single verified `tenant_id`
- [ ] `tenant_id` sourced from JWT — never from request body/params
- [ ] No cross-tenant data access possible

### Code Quality

- [ ] No TypeScript `any` types without justification
- [ ] All async operations have error handling
- [ ] No hardcoded UI strings (all in `translations.ts`)
- [ ] Dark theme maintained in new UI components

### Tests

- [ ] Unit tests written for new logic
- [ ] E2E test updated if user-facing flow changed
- [ ] All tests pass: `npm test` ✅
- [ ] Coverage thresholds met: lines ≥70%, branches ≥60% ✅

### ARCHITECT sign-off (check if applicable)

- [ ] N/A — no structural/routing/DB/auth/middleware changes
- [ ] Required — ARCHITECT has reviewed and approved

---

## Screenshots (if UI changes)

<!-- Add before/after screenshots for any visual changes -->

## Testing instructions

<!-- How to manually verify this works -->

1.
2.
