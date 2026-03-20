# Changelog

All notable changes to BizzAssist are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- ISO 27001 ISMS policy documentation (`docs/security/ISMS.md`)
- Data classification policy (`docs/security/DATA_CLASSIFICATION.md`)
- Access control policy (`docs/security/ACCESS_CONTROL.md`)
- Incident response procedure (`docs/security/INCIDENT_RESPONSE.md`)
- HTTP security headers on all responses: CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy (`next.config.ts`)
- Edge middleware with rate limiting (10 req/60s per IP) and HTTPS enforcement (`middleware.ts`)
- 4-gate release process: CODE REVIEWER, ARCHITECT, TESTER, git pre-commit hook
- Husky pre-commit hook: lint-staged (ESLint + Prettier) + unit tests
- Husky commit-msg hook: Conventional Commits enforced via commitlint
- Prettier code formatter with project-standard config
- lint-staged: only lints/formats staged files for fast commits
- GitHub Actions CI pipeline: lint, type-check, unit tests, E2E tests, security audit, build check
- PR template with CODE REVIEWER checklist
- CODEOWNERS for security-critical file review routing
- Health check endpoint (`GET /api/health`) for uptime monitoring
- Environment variable validation with t3-env + Zod (`lib/env.ts`)
- VS Code workspace settings, recommended extensions, debug launch configurations
- `.nvmrc` pinning Node.js to v24.14.0
- `.editorconfig` for consistent editor behaviour
- CONTRIBUTING.md developer guide
- JIRA product backlog: 50 issues across 8 epics (BIZZ-6 to BIZZ-55)
- Product backlog document (`docs/BACKLOG.md`)
- Agent team documentation (`docs/agents/TEAM.md`, `docs/agents/RELEASE_PROCESS.md`)
- Architecture documentation (`docs/architecture/SAAS.md`, `docs/architecture/DATABASE.md`)
- PWA support: service worker, manifest, app icons
- Bilingual DA/EN support via `LanguageContext` and `translations.ts`
- Bug/feedback reporting modal with JIRA integration (`/api/report-bug`)
- Sentry error monitoring integration

### Infrastructure

- Multi-tenant SaaS architecture design (schema-per-tenant PostgreSQL)
- 3-layer data isolation: PostgreSQL RLS, application middleware, AI namespace scoping

---

## [0.1.0] — 2026-03-01 (Initial development build)

### Added

- Next.js 16 App Router project scaffold
- Marketing homepage: Navbar, Hero, Stats, Features, UseCases, CTABanner, Footer
- Login page UI (mockup — no auth backend yet)
- Dashboard UI shell: sidebar, topbar, main content area
- Dashboard home: quick stats, search bar, recent searches, AI chat panel, market trends
- Dark theme throughout (`#0f172a` / `#0a1020`)
