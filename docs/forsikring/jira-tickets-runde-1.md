# JIRA-tickets — Forsikrings-modul Runde 1 follow-ups

Forberedte tickets der skal oprettes i `bizzassist.atlassian.net` for at få MVP'en
fra "kode-klar på branch" til "fuldt deployet og verificeret".

Hver sektion svarer til én JIRA-issue. Paste titel + description direkte ind i
JIRA's "Create Issue"-dialog.

Branch: `claude/naughty-roentgen-d68ac1`
PR (mod develop): https://github.com/itmgtconsulting-prog/BizzAssist/compare/develop...claude/naughty-roentgen-d68ac1

---

## Ticket 1 — Deploy migration 096 (forsikring tabeller)

**Summary:** Deploy migration 096 (forsikring-modul tabeller) til dev/test/prod

**Issue type:** Task
**Priority:** High
**Component:** Database, Forsikring
**Labels:** forsikring, migration, mvp, runde-1

### Description

PR `claude/naughty-roentgen-d68ac1` introducerer fire nye tenant-scoped tabeller
til forsikrings-modulet:

- `forsikring_documents` — uploaded PDF-filer
- `forsikring_policies` — strukturerede police-data (parsed via Claude)
- `forsikring_coverages` — dækninger pr. police
- `forsikring_gaps` — gap-detektioner fra analyse-engine

Migration 096 indeholder:

1. `provision_tenant_forsikring_tables(schema, tenant_id)` RPC — opretter tabeller + RLS + indeks
2. Backfill-loop der kører funktionen på alle eksisterende `tenant_*` schemaer
3. Storage bucket `forsikring-documents` (private, 20 MB, application/pdf only)

`provisionTenantSchema()` i `lib/db/tenant.ts` er udvidet til at kalde den nye
RPC for nye tenants.

### Acceptance criteria

- [ ] Migration 096 er kørt mod **dev** (`wkzwxfhyfmvglrqtmebw`) uden fejl
- [ ] Migration 096 er kørt mod **test** (`rlkjmqjxmkxuclehbrnl`) uden fejl
- [ ] Migration 096 er kørt mod **prod** (`xsyldjqcntiygrtfcszm`) uden fejl
- [ ] De 4 nye tabeller eksisterer i alle eksisterende `tenant_*` schemaer på alle 3 miljøer
- [ ] Storage bucket `forsikring-documents` eksisterer på alle 3 miljøer
- [ ] En ny test-tenant der provisioneres efter deploy får automatisk de 4 tabeller (verificér ved at oprette én)

### Hvordan

Migration er idempotent (CREATE TABLE IF NOT EXISTS + backfill loop).
Kan deployes på 3 måder:

**A) Via Management API runner** (kræver SUPABASE_ACCESS_TOKEN):

```sh
$env:SUPABASE_ACCESS_TOKEN = "<sbp_xxxxx>"
cd <repo>
node scripts/run-migrations.mjs dev
node scripts/run-migrations.mjs test
node scripts/run-migrations.mjs prod
```

**B) Via Supabase Studio SQL Editor**:

1. Åbn projektets SQL editor
2. Paste indhold af `supabase/migrations/096_forsikring.sql`
3. Run

**C) Via psql/CLI** med direkte forbindelse.

### Verifikation

Efter deploy, kør i SQL editor for hvert miljø:

```sql
-- Tjek backfill ramte alle tenants
SELECT t.schema_name,
       EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema = t.schema_name
                 AND table_name = 'forsikring_policies') as has_forsikring
FROM public.tenants t
ORDER BY t.created_at;

-- Tjek storage bucket
SELECT id, name, public, file_size_limit, allowed_mime_types
FROM storage.buckets
WHERE id = 'forsikring-documents';
```

Begge skal returnere fuldt resultat hvor `has_forsikring = true` for alle tenants.

### Risiko

- **Lav** — kun ADD-operations, ingen DROP/ALTER på eksisterende tabeller
- Backfill-loop tager ~1 sek pr. tenant (skanner information_schema)
- Hvis miljø allerede har 096 kørt: idempotent, ingen ændring

---

## Ticket 2 — Manuel end-to-end test af forsikrings-MVP

**Summary:** Manuel E2E-test af forsikrings-modul med Belvedere-PDF'er

**Issue type:** Task
**Priority:** Medium
**Component:** Forsikring, QA
**Labels:** forsikring, mvp, qa, runde-1
**Blocked by:** Ticket 1 (migration deploy)

### Description

Verificér at MVP-flowet virker end-to-end i et deployet miljø (test eller dev) med rigtige PDF'er.

Test-data: De 9 PDF'er fra Belvedere Ejendomme A/S (CVR 24301117) som er brugt under specifikationen — ligger i `C:\Users\JakobJuulRasmussenHP\Downloads\`:

- `Alm. Brand.Forsikringsoversigt .pdf` (sammenfatning, ikke en police)
- `Police 50143392.pdf` (Stengade 7 — restaurant)
- `Police 50143465.pdf` (Gefionsvej 47A — erhvervsudlejning)
- `Police 50143511.pdf` (Klostermosevej 123 — værksted/sprøjtelakering)
- `Police 50143554 .pdf` (Bramstræde 5 — hotel)
- `Police 67500725 .pdf` (Gefionsvej 45A — restaurant)
- `RTM Forsikringsoversigt.pdf`
- `TOP Forsikringsoversigt.pdf`
- `TOP Police 9417319074.pdf` (Stjernegade 17 — beboelse + butik)

### Acceptance criteria

- [ ] Login som test-bruger → "Forsikring" vises i sidebar (ShieldCheck-ikon)
- [ ] Klik på Forsikring → `/dashboard/forsikring` renderes med empty state ("Ingen policer endnu")
- [ ] Træk en police-PDF til upload-zone → upload-job vises med status "Uploader…" → "Analyserer police med AI…" → "✓"
- [ ] Efter ~30 sek vises policen i tabellen med selskab, forsikringstager, adresse, præmie, udløb og gap-badges
- [ ] Klik på policen → detail-side viser metadata-grid + dækningsliste + severity-grupperede gaps
- [ ] Bekræft for **Police 50143392 (Stengade 7)** at gap-engine finder:
  - ✅ Kritisk: Manglende dækning Insekt og svamp (bygning fra 1900)
  - ✅ Warning: Manglende glas, restværdi, stikledning
  - ✅ Info: Manglende sanitet
- [ ] Slet policen → coverages + gaps cascade-slettes
- [ ] Skift sprog DA → EN: alle UI-strings i forsikrings-modulet er oversat
- [ ] Upload **af 5 forskellige policer i træk** virker uden race conditions

### Forventede fund (baseret på spec-analyse)

Hvis modulet fungerer korrekt, skal det finde for hver police:

| Police                    | Forventede kritiske gaps                                              |
| ------------------------- | --------------------------------------------------------------------- |
| 50143392 Stengade 7       | Insekt/svamp (1900-bygning + restaurant)                              |
| 50143465 Gefionsvej 47A   | Restværdi mangler (1965 m. blandet anvendelse)                        |
| 50143511 Klostermosevej   | Mismatch: police siger "udlejning", men anvendelse er sprøjtelakering |
| 50143554 Bramstræde 5     | Insekt/svamp (1890 hotel m. udnyttet tagetage)                        |
| 67500725 Gefionsvej 45A   | (Bedst dækket — restaurant med insekt/svamp + stikledning)            |
| 9417319074 Stjernegade 17 | (TOP-policen — bedst dækket men aftale udløbet 1.1.2026)              |

### Rapportering

Vedhæft til ticketet:

- Screenshots af forsikrings-side med uploadede policer
- Screenshot af én detail-side med gaps
- Eventuelle fejlmeldinger (browser console + Sentry)

---

## Ticket 3 — Vercel preview deploy + smoke test af forsikrings-route

**Summary:** Konfigurer Vercel preview deploy så `/dashboard/forsikring` er tilgængelig fra PR

**Issue type:** Task
**Priority:** Medium
**Component:** DevOps, Forsikring
**Labels:** forsikring, ci, devops, runde-1
**Blocked by:** Ticket 1 (migration på dev/test)

### Description

Når PR'en mod develop åbnes, skal Vercel automatisk lave en preview deploy.
Verificér at preview-URL'en:

1. Kan tilgås uden særlig konfiguration
2. Routes til forsikrings-modulet svarer korrekt
3. Storage bucket eksisterer og PDF-upload virker

### Acceptance criteria

- [ ] PR-trigget Vercel deploy succeed (build green)
- [ ] Preview-URL viser sidebar med "Forsikring" efter login
- [ ] `/dashboard/forsikring` rendrerer empty state (ikke 500-fejl)
- [ ] Playwright E2E smoke test `e2e/forsikring.spec.ts` passer i CI mod preview deploy

---

## Ticket 4 — Tilføj SUPABASE_ACCESS_TOKEN til CI for automatisk migration-deploy

**Summary:** Konfigurer SUPABASE_ACCESS_TOKEN i GitHub Actions så migrations kan deployes via pipeline

**Issue type:** Task
**Priority:** Low
**Component:** DevOps, Database
**Labels:** devops, ci, supabase

### Description

Manuel deploy af migrations via Supabase Studio er fejl-prone og uden audit-trail.
Sæt op CI-flow så `scripts/run-migrations.mjs` kan køres automatisk når PR merges.

### Acceptance criteria

- [ ] Personal Access Token genereret i Supabase (kort levetid, audit-logget)
- [ ] Token gemt som GitHub Actions secret `SUPABASE_ACCESS_TOKEN`
- [ ] Workflow `.github/workflows/deploy-migrations.yml` der kører:
  - Ved merge til `develop` → deploy til dev + test
  - Ved merge til `main` → deploy til prod (med approval)
- [ ] Workflow rapporterer success/failure pr. miljø som status checks på PR
- [ ] Token rotation procedure dokumenteret i `docs/security/ACCESS_CONTROL.md`

---

## Ticket 5 — Runde 2: Koncern-walk + tids-validering (Epic)

**Summary:** Forsikrings-modul Runde 2 — koncern-walk gennem ejerskab + tids-gyldige links

**Issue type:** Epic
**Priority:** Medium
**Component:** Forsikring, AI Tools
**Labels:** forsikring, koncern, runde-2

### Description

Bygger oven på Runde 1 (MVP). Lader brugere indtaste ét holding-CVR og se
forsikringsstatus for hele koncernens ejendomsportefølje, med snapshot-dato
så ejerskifter under forsikringstid kan detekteres.

### Stories (sub-tickets)

1. **walk_koncern AI-tool** — recursivt traversér CVR → datterselskaber → ejendomme med snapshot-dato
2. **koncern_snapshots tabel** — immutable graph-snapshots for audit + reproducerbarhed
3. **hent_ejendomme_for_virksomhed_historisk** — udvid eksisterende tool med `as_of_date` parameter
4. **verificer_forsikringstager** — match police-CVR mod tinglyst adkomsthaver på tegningsdato + i dag
5. **Drift-detector cron** — daglig sammenligning af aktuel CVR/Tingbog mod sidste snapshot
6. **Tids-slider UI** — date-picker øverst på forsikrings-side der re-beregner alle tal
7. **Tidslinje-visualisering** — pr. ejendom: ejerskift + police-tegninger som timeline

### Acceptance criteria

- [ ] Bruger indtaster CVR 24301117 (Belvedere) → ser alle 6 ejendomme med koncern-niveau
- [ ] Hvis Belvedere ejes af et holdingselskab → vises som rod-node
- [ ] Snapshot-dato 2022-08-01 vs. 2026-05-13 viser konsistente data
- [ ] Drift-detector flagger hvis en ejendom solgt under forsikringstid

### Estimate

~5-7 dages arbejde (50+ filer). Skal opdeles i sprint-stories.

---

## Ticket 6 — Runde 3: BBR/Tinglysning/VUR cross-checks + avancerede gaps

**Summary:** Forsikrings-modul Runde 3 — auto-trigger eksterne API-cross-checks + 100+ gap-detektioner

**Issue type:** Epic
**Priority:** Medium
**Component:** Forsikring, AI Tools
**Labels:** forsikring, runde-3

### Description

Runde 1 har gap-engine med BBR-checks bygget ind, men de kører kun når BBR-data
leveres som input. Denne runde automatiserer det og udvider check-listen til
de 100+ punkter fra spec-analysen.

### Stories

1. **Auto-hent BBR** efter parse — kald `hent_bbr_data` med property_bfe og kør gap-engine igen
2. **Auto-hent VUR** — sammenlign nyværdi-estimat med offentlig vurdering
3. **Auto-hent Tinglysning** — flag panthavere, ejerskifte, pant > forsikringssum
4. **Auto-hent virksomheder på adressen** — flag risikoforandring vs. police-virksomhedsart
5. **Klimaeksponering** — kald `app/api/flood/route.ts` og flag manglende oversvømmelses-dækning
6. **Restaurant-køkken-krav** — auto-tjekliste hvis branche = restaurant
7. **Klyngerisiko** — summér ekspositioner pr. matr.nr og pr. postnummer
8. **D&O/Cyber/Driftstab-anbefalinger** — separat liste over manglende standardforsikringer
9. **Mæglerrapport-eksport** — PDF/DOCX rapport pr. police til mægler-deling

### Estimate

~7-10 dages arbejde. Kan splittes til separate sprints.

---

## Hvad du skal gøre nu

1. **Opret Ticket 1** først — alt andet er blokeret af migration-deploy
2. **Opret Ticket 2 + 3** parallelt — kan startes så snart Ticket 1 er done på dev
3. **Opret Ticket 4** som backlog — ikke kritisk for Runde 1
4. **Opret Ticket 5 + 6** som Epics — planlæg i kommende sprint-planlægning
5. **Merge PR'en** mod `develop` når Ticket 1 + 2 er done

PR-link igen til reference:
https://github.com/itmgtconsulting-prog/BizzAssist/compare/develop...claude/naughty-roentgen-d68ac1?expand=1
