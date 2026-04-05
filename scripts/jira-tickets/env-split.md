# JIRA Ticket: Split miljø-variabler mellem test og production

**Project:** BIZZ
**Type:** Task
**Priority:** Medium
**Labels:** devops, environment, security

---

## Beskrivelse

I dag bruger Preview (test.bizzassist.dk) og Production (bizzassist.dk) de **samme** værdier for alle miljø-variabler. Dette er en midlertidig løsning sat op 2026-04-05.

For korrekt test/prod-separation skal følgende variabler have **separate værdier** per miljø:

### Gruppe 1: Database (Supabase)

| Variabel                        | Test-handling                           |
| ------------------------------- | --------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | Opret separat Supabase-projekt til test |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Fra test-projektet                      |
| `SUPABASE_SERVICE_ROLE_KEY`     | Fra test-projektet                      |
| `SUPABASE_JWT_SECRET`           | Fra test-projektet                      |
| `SUPABASE_DB_URL`               | Fra test-projektet                      |
| `SUPABASE_DB_PASSWORD`          | Fra test-projektet                      |
| `SUPABASE_ACCESS_TOKEN`         | Kan genbruges (Supabase-konto)          |

### Gruppe 2: Payments (Stripe)

| Variabel                | Test-handling                        |
| ----------------------- | ------------------------------------ |
| `STRIPE_WEBHOOK_SECRET` | Brug Stripe test mode webhook secret |

### Gruppe 3: App URL

| Variabel              | Test                         | Production              |
| --------------------- | ---------------------------- | ----------------------- |
| `NEXT_PUBLIC_APP_URL` | `https://test.bizzassist.dk` | `https://bizzassist.dk` |

### Gruppe 4: Cache (Upstash Redis)

| Variabel                   | Test-handling                           |
| -------------------------- | --------------------------------------- |
| `UPSTASH_REDIS_REST_URL`   | Opret separat Upstash-database til test |
| `UPSTASH_REDIS_REST_TOKEN` | Fra test-databasen                      |

### Gruppe 5: NemLogin / SAML (lav prioritet)

Nuværende NemLogin-credentials peger på devtest4-miljø som allerede er et testmiljø — kan deles.

### Gruppe 6: Klar til deling (ingen ændring nødvendig)

Følgende kan forblive identiske i begge miljøer:

- `DATAFORDELER_*` — samme adgang
- `CVR_ES_*` — samme adgang
- `BIZZASSIST_CLAUDE_KEY` — samme AI-nøgle
- `BRAVE_SEARCH_API_KEY`, `GOOGLE_CSE_*` — samme
- `SENTRY_*` — separate environments konfigureret i Sentry UI
- `JIRA_*` — samme projekt

---

## Acceptkriterier

- [ ] Separat Supabase-projekt oprettet til test-miljø
- [ ] Supabase-migrationer kørt mod test-projektet
- [ ] Stripe test mode webhook konfigureret for test.bizzassist.dk
- [ ] Separat Upstash Redis-database til test (eller del prod-db med key-prefix)
- [ ] `NEXT_PUBLIC_APP_URL` sat korrekt per miljø i Vercel
- [ ] Vercel Preview env vars opdateret med test-værdier
- [ ] Smoke test: login + dashboard fungerer på test.bizzassist.dk

---

## Noter

- Oprettet i forbindelse med deploy-setup 2026-04-05
- Vercel-konfiguration: develop → Preview (test.bizzassist.dk), main → Production (bizzassist.dk)
- Se `scripts/jira-tickets/env-split.md` for fuld opgavebeskrivelse
