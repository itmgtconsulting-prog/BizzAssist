# BizzAssist

**Danish business intelligence platform** — aggregates data on companies, properties, and business persons from Danish public registers, with AI-powered analysis and conversational search.

> Similar to [resights.dk](https://resights.dk) — built for Danish B2B professionals.

---

## Quick Start

```bash
# Requires Node.js 24.14.0 (see .nvmrc)
npm install
cp .env.local.example .env.local   # Fill in your credentials
npm run dev                         # http://localhost:3000
```

## Tech Stack

| Layer            | Technology                              |
| ---------------- | --------------------------------------- |
| Framework        | Next.js 16 (App Router + TypeScript)    |
| Styling          | Tailwind CSS v4 (dark theme)            |
| Database         | Supabase (PostgreSQL + pgvector + Auth) |
| AI               | Anthropic Claude API                    |
| Error monitoring | Sentry                                  |
| Issue tracking   | JIRA (project: BIZZ)                    |
| Testing          | Vitest (unit) + Playwright (E2E)        |
| Deployment       | Vercel                                  |

## Key Commands

```bash
npm run dev              # Start dev server (Turbopack)
npm run build            # Production build
npm run validate         # Full check: type-check + lint + format + tests
npm test                 # Unit + component tests
npm run test:coverage    # Tests with coverage report
npm run test:e2e         # End-to-end tests (Playwright)
npm run lint:fix         # Auto-fix ESLint issues
npm run format           # Format all files with Prettier
npm run type-check       # TypeScript check without building
```

## Project Structure

```
bizzassist/
├── app/                     # Next.js App Router pages + API routes
│   ├── api/                 # API route handlers
│   │   ├── health/          # GET /api/health — uptime monitoring
│   │   └── report-bug/      # POST /api/report-bug — JIRA integration
│   ├── components/          # Shared React components
│   ├── context/             # React context providers (language, auth)
│   ├── dashboard/           # Authenticated app area
│   ├── lib/                 # Utilities (translations, AI, DB clients)
│   └── login/               # Auth pages
├── docs/                    # All project documentation
│   ├── BACKLOG.md           # Prioritised product backlog (42 items)
│   ├── adr/                 # Architecture Decision Records
│   ├── agents/              # Agent team guidelines + release process
│   ├── architecture/        # SaaS + database architecture
│   └── security/            # ISO 27001 ISMS policies
├── __tests__/               # Test files (unit, component, E2E)
├── public/                  # Static assets + PWA files
├── .github/                 # CI/CD workflows + PR template
├── .husky/                  # Git hooks (pre-commit + commit-msg)
├── middleware.ts             # Rate limiting + auth guard
├── CLAUDE.md                # Non-negotiable coding standards
├── CONTRIBUTING.md          # Developer guide
└── CHANGELOG.md             # Release history
```

## Documentation

| Document                                                         | Purpose                                                    |
| ---------------------------------------------------------------- | ---------------------------------------------------------- |
| [CONTRIBUTING.md](CONTRIBUTING.md)                               | How to contribute, branching, commit conventions           |
| [CHANGELOG.md](CHANGELOG.md)                                     | Release history                                            |
| [CLAUDE.md](CLAUDE.md)                                           | Non-negotiable coding standards (read before writing code) |
| [docs/BACKLOG.md](docs/BACKLOG.md)                               | Prioritised product backlog                                |
| [docs/agents/RELEASE_PROCESS.md](docs/agents/RELEASE_PROCESS.md) | 4-gate release checklist                                   |
| [docs/architecture/SAAS.md](docs/architecture/SAAS.md)           | Multi-tenant SaaS architecture                             |
| [docs/architecture/DATABASE.md](docs/architecture/DATABASE.md)   | Database schema design                                     |
| [docs/security/ISMS.md](docs/security/ISMS.md)                   | ISO 27001 Information Security policy                      |

## CI/CD

Every PR runs automatically:

1. **ESLint** — code quality
2. **Prettier** — formatting
3. **TypeScript** — type checking
4. **Vitest** — unit tests with coverage
5. **Playwright** — E2E tests (desktop + mobile)
6. **npm audit** — security vulnerability scan
7. **Next.js build** — production build check

## Security

This project is aligned with **ISO 27001**. See `docs/security/` for:

- ISMS policy
- Data classification (Public / Internal / Confidential / Restricted)
- Access control policy
- Incident response procedure

To report a security vulnerability: `security@bizzassist.dk`

## License

Private — All rights reserved. BizzAssist ApS, Denmark.
