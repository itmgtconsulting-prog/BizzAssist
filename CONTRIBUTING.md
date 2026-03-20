# Contributing to BizzAssist

Welcome. This guide covers everything you need to know to contribute code to BizzAssist.

---

## 1. Local Development Setup

### Prerequisites

| Tool    | Version                | Install                            |
| ------- | ---------------------- | ---------------------------------- |
| Node.js | 24.14.0 (see `.nvmrc`) | [nodejs.org](https://nodejs.org)   |
| npm     | 11.x+                  | Bundled with Node                  |
| Git     | 2.x+                   | [git-scm.com](https://git-scm.com) |

### First-time setup

```bash
# 1. Clone the repository
git clone https://github.com/bizzassist/bizzassist.git
cd bizzassist

# 2. Install dependencies (installs Husky hooks automatically)
npm install

# 3. Copy environment template and fill in your values
cp .env.local.example .env.local
# Edit .env.local with your credentials

# 4. Start the development server
npm run dev
# Open http://localhost:3000
```

### VS Code (recommended)

Open the project and accept the prompt to install recommended extensions (`.vscode/extensions.json`).
The workspace settings (`.vscode/settings.json`) configure auto-format on save.

---

## 2. Branching Strategy

We use **GitHub Flow** — simple, fast, and suitable for continuous deployment.

```
main          ← production-ready, protected, requires PR + review
  └── develop ← integration branch for the current sprint
        ├── feat/BIZZ-24-company-profile
        ├── fix/BIZZ-31-map-pin-clustering
        └── security/BIZZ-XX-csp-update
```

### Branch naming convention

```
<type>/BIZZ-<ticket>-<short-description>
```

| Type        | When to use                               |
| ----------- | ----------------------------------------- |
| `feat/`     | New feature                               |
| `fix/`      | Bug fix                                   |
| `security/` | Security fix or hardening                 |
| `refactor/` | Code restructure without behaviour change |
| `docs/`     | Documentation only                        |
| `chore/`    | Dependencies, config, build scripts       |
| `test/`     | Tests only                                |

**Examples:**

```
feat/BIZZ-24-company-profile-page
fix/BIZZ-45-login-redirect-loop
security/BIZZ-12-rate-limit-api-routes
```

---

## 3. Commit Message Convention

We enforce **Conventional Commits** via `commitlint`.

**Format:**

```
<type>(<scope>): <short description>

[optional body]

[optional footer: BIZZ-XXX]
```

**Examples:**

```
feat(auth): add Google OAuth login with tenant provisioning
fix(cvr): handle null financials in annual report parser
security(middleware): increase rate limit window to 60 seconds
docs(security): update ISMS supplier assessment table
chore(deps): upgrade Next.js to 16.3.0
test(companies): add unit tests for entity linker
```

**Rules (enforced by Husky commit-msg hook):**

- Type must be one of: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `security`, `ci`
- Subject must be lower-case
- Subject max 100 characters
- No trailing period

---

## 4. Development Workflow

```
1. Pick a JIRA ticket — assign it to yourself, move to "In Progress"
2. Create a branch: git checkout -b feat/BIZZ-24-company-profile
3. Write code following the standards in CLAUDE.md
4. Write tests (unit + E2E if user-facing)
5. Run full validation: npm run validate
6. Commit (Husky runs lint-staged + tests + commitlint automatically)
7. Push branch and open PR using the PR template
8. Address review feedback
9. Merge when all CI checks pass + CODE REVIEWER approves
```

---

## 5. Code Standards

All code must follow the standards in `CLAUDE.md`. Key rules:

- **JSDoc on every function/component/hook/API route** — missing = PR blocked
- **No `any` types** without documented justification
- **No secrets in source code** — use environment variables
- **No PII in logs or error responses**
- **All external input validated** at API boundaries
- **Tenant isolation** — every DB query scoped to a verified `tenant_id`
- **Dark theme** — no white/light backgrounds in new UI
- **Bilingual** — all strings in `app/lib/translations.ts`

See `docs/agents/RELEASE_PROCESS.md` for the full 4-gate release checklist.

---

## 6. Running Tests

```bash
# Unit + component tests
npm test

# Unit tests with coverage report (must meet thresholds)
npm run test:coverage

# End-to-end tests
npm run test:e2e

# All tests
npm run test:all

# Full validation (type-check + lint + format + tests)
npm run validate
```

**Coverage thresholds (enforced in CI):**

- Lines: ≥ 70%
- Functions: ≥ 70%
- Branches: ≥ 60%

---

## 7. Pull Request Process

1. Use the PR template — all checklist items must be ticked
2. Link the JIRA ticket in the PR title and description
3. All CI checks must be green before requesting review
4. At least one approval from a CODEOWNER is required
5. ARCHITECT sign-off required for structural/DB/auth changes (see `CLAUDE.md`)
6. Squash merge to keep main history clean

---

## 8. Security Reporting

Found a security vulnerability? **Do not open a public GitHub issue.**

Email: `security@bizzassist.dk` (set up pre-launch)
Response target: 24 hours for critical, 72 hours for high

See `docs/security/INCIDENT_RESPONSE.md` for full procedure.

---

## 9. Questions?

- JIRA: [bizzassist.atlassian.net](https://bizzassist.atlassian.net)
- Architecture questions: refer to `docs/architecture/`
- Security questions: refer to `docs/security/`
