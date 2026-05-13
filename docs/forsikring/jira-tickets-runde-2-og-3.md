# JIRA-tickets — Forsikrings-modul Runde 2 + 3 + Phase 1 finalize

Komplet ticket-plan for at få forsikrings-modulet fra MVP til fuld
feature-paritet med det slettede parallelle modul **plus** den oprindeligt
planlagte Runde 3 (BBR/Tinglysning/VUR cross-checks).

Hver sektion svarer til én JIRA-issue. Paste titel + beskrivelse direkte
ind i `bizzassist.atlassian.net` "Create Issue"-dialogen.

**Eksisterende tickets fra Phase 1:**

- BIZZ-1351 — Deploy migration 107 til dev/test/prod ✅ delvist done
- BIZZ-1352 — Manuel E2E test ⏳ blocked af BIZZ-1351
- BIZZ-1353 — Vercel preview deploy verifikation
- BIZZ-1354 — SUPABASE_ACCESS_TOKEN i CI ✅ done (CI workflow eksisterer)
- BIZZ-1355 — Epic: Runde 2 koncern-walk + tids-validering
- BIZZ-1356 — Epic: Runde 3 BBR/Tinglysning/VUR cross-checks

---

## 🔢 Execution order — kør i denne rækkefølge

```
PHASE 1 FINALIZE (blocking — gør først)
─────────────────────────────────────────
1.  BIZZ-NEW-01 — Investigér canceled migration 107 deployment
2.  BIZZ-NEW-02 — Open + merge PR claude/naughty-roentgen-d68ac1 → develop
3.  BIZZ-NEW-03 — Verificér migration 108 auto-deploy via CI
4.  BIZZ-NEW-04 — Investigér 20 åbne fejl i Service Manager
5.  BIZZ-1352   — Manuel E2E test (opdateret med filtyper)

PHASE 2 — Koncern-walk + asset matching (Epic: BIZZ-1355)
─────────────────────────────────────────────────────────
6.  BIZZ-NEW-05 — Migration 109: forsikring_aktiver + forsikring_analyser tabeller
7.  BIZZ-NEW-06 — koncernWalk.ts: CVR → aktiver via EJF/CVR/property-bridge
8.  BIZZ-NEW-07 — assetMatcher.ts: match aktiver mod policer
9.  BIZZ-NEW-08 — gapEngine: 4 nye checks (uninsured/underinsured/mortgage/D&O)
10. BIZZ-NEW-09 — Risk-scoring 0-100 + severity labels
11. BIZZ-NEW-10 — API: POST/GET /api/forsikring/analyser
12. BIZZ-NEW-11 — UI: customer picker + analyse-resultat side
13. BIZZ-NEW-12 — Phase 2 E2E test

PHASE 3 — Auto cross-checks + visualisering (Epic: BIZZ-1356)
─────────────────────────────────────────────────────────────
14. BIZZ-NEW-13 — Auto-trigger BBR cross-check efter parse
15. BIZZ-NEW-14 — Tinglysning cross-check (panthavere, sum vs. nyværdi)
16. BIZZ-NEW-15 — VUR cross-check (nyværdi-estimat vs. offentlig vurdering)
17. BIZZ-NEW-16 — Klyngerisiko (geografisk + branche-koncentration)
18. BIZZ-NEW-17 — Restaurant-køkken-krav auto-tjekliste
19. BIZZ-NEW-18 — D&O/Cyber/Driftstab anbefalingsmodul
20. BIZZ-NEW-19 — Force-directed koncern-visualisering med tids-slider
21. BIZZ-NEW-20 — Mæglerrapport-eksport (PDF/DOCX pr. police)
```

**Kritisk afhængighed:** Phase 2 (#6-13) er blokeret af #2 (PR merge).
Phase 3 (#14-21) er blokeret af #13 (Phase 2 E2E grøn).

---

## PHASE 1 FINALIZE — Akutte tickets

### BIZZ-NEW-01 — Investigér canceled migration 107 deployment

**Type:** Bug
**Priority:** Critical
**Component:** Database, Forsikring, DevOps
**Labels:** forsikring, migration, phase-1
**Estimate:** 30 min

**Beskrivelse:**

Migration 107 deployment via `.github/workflows/deploy-migrations.yml` blev
canceled 13. maj 15.05 ifølge Service Manager på test.bizzassist.dk.
Subsekvente commits (`ci(migrations)` 15.07, `fix(forsikring)` 15.22) blev
deployet succesfuldt, men det er uklart om 107 selv kørte.

Konsekvens: hvis 107 ikke er deployet til test-Supabase, fejler upload
af forsikrings-PDF'er med "table does not exist".

**Acceptance criteria:**

- [ ] SQL-query mod test (`rlkjmqjxmkxuclehbrnl`) returnerer > 0 tenants med
      forsikring_policies tabel
- [ ] Storage bucket `forsikring-documents` eksisterer på test
- [ ] Samme verificeret på dev (`wkzwxfhyfmvglrqtmebw`) og prod
      (`xsyldjqcntiygrtfcszm`)
- [ ] Hvis 107 mangler, manuel deploy via Supabase Studio + rapport her

**Verifikations-SQL:**

```sql
SELECT
  COUNT(DISTINCT table_schema) AS tenants_with_forsikring
FROM information_schema.tables
WHERE table_name = 'forsikring_policies'
  AND table_schema LIKE 'tenant_%';
```

---

### BIZZ-NEW-02 — Merge claude/naughty-roentgen-d68ac1 → develop

**Type:** Task
**Priority:** High
**Component:** Forsikring, DevOps
**Labels:** forsikring, mvp, phase-1
**Blocked by:** BIZZ-NEW-01
**Estimate:** 15 min

**Beskrivelse:**

PR-link: https://github.com/itmgtconsulting-prog/BizzAssist/compare/develop...claude/naughty-roentgen-d68ac1?expand=1

Indeholder:

- MVP forsikrings-modul på /dashboard/forsikring/
- Sletning af parallelt modul /dashboard/analyse/forsikring/ (12 filer)
- Analyse-menu integration via registry
- Filtype-udvidelse (PDF/DOCX/XLSX/PPTX/RTF/text/email/billeder)
- Migration 108: udvider storage bucket MIME-types
- 40 forsikring unit tests + 1934/1948 fuld test-suite grøn

**Acceptance criteria:**

- [ ] PR oprettet med titel + body fra `docs/forsikring/deployment-guide-runde-1.md`
- [ ] CI-checks grønne (type-check, lint, prettier, vitest, playwright, Vercel)
- [ ] Code review godkendt af mindst én anden agent/person
- [ ] "Squash and merge" gennemført
- [ ] Feature-branch slettet efter merge

---

### BIZZ-NEW-03 — Verificér migration 108 auto-deploy efter merge

**Type:** Task
**Priority:** High
**Component:** Database, Forsikring
**Labels:** forsikring, migration, phase-1
**Blocked by:** BIZZ-NEW-02
**Estimate:** 15 min

**Beskrivelse:**

Migration 108 (`108_forsikring_all_filetypes.sql`) udvider storage bucket
`forsikring-documents` allowed_mime_types fra `{application/pdf}` til
~25 MIME-types. Auto-deployes via deploy-migrations workflow når PR mergers.

**Acceptance criteria:**

- [ ] GitHub Actions → "Deploy migrations" workflow trigget af develop-merge
- [ ] Begge matrix-jobs (dev + test) grønne
- [ ] SQL-verifikation mod test:
      `SELECT allowed_mime_types FROM storage.buckets WHERE id = 'forsikring-documents';`
      returnerer ~25 MIME-types
- [ ] Test-upload af både PDF og XLSX virker uden "MIME type not allowed"

**Hvis workflow fejler:** Re-run failed jobs i Actions tab. Eller deploy
manuelt fra develop branch:

```sh
SUPABASE_ACCESS_TOKEN=<token> node scripts/run-migrations.mjs test
```

---

### BIZZ-NEW-04 — Investigér 20 åbne fejl i Service Manager

**Type:** Bug
**Priority:** Medium
**Component:** Service Manager, Observability
**Labels:** investigation, errors
**Estimate:** 1 time

**Beskrivelse:**

Service Manager på `test.bizzassist.dk/dashboard/admin/service-manager` viser
**20 åbne fejl** pr. 13. maj 16.20. Sandsynligvis pre-existing, men værd at
verificere de **ikke** stammer fra forsikrings-modul-deploy.

**Acceptance criteria:**

- [ ] Liste de 5 vigtigste fejl med rute + stack trace
- [ ] Klassificér hver fejl: forsikrings-relateret eller ej
- [ ] For forsikrings-relaterede: opret separat bug-ticket
- [ ] For ikke-forsikrings-relaterede: vurder om de skal lukkes, prioriteres
      eller dokumenteres som known issues

---

### BIZZ-1352 (opdatering) — Manuel E2E test inkl. alle filtyper

**Tilføj som kommentar til eksisterende BIZZ-1352:**

> Acceptance criteria udvidet med filtype-test efter merge af PR `claude/naughty-roentgen-d68ac1`:
>
> - [ ] Upload PDF (Belvedere `Police 50143392.pdf`) → forventet gaps detekteres
> - [ ] Upload DOCX (en valgfri police i Word-format) → upload + parse virker
> - [ ] Upload XLSX (police-liste i Excel) → upload + parse virker
> - [ ] Upload billede (PNG/JPG af scannet police) → Claude vision parser
> - [ ] Verificér modul er tilgængeligt BÅDE fra top-level sidebar OG under Analyse-menu
> - [ ] Brug `docs/forsikring/tester-instruktion.md` som facit
>
> **Blocked by:** BIZZ-NEW-03 (migration 108 deployet til test)

---

## PHASE 2 — Koncern-walk + Asset Matching (BIZZ-1355 epic)

Disse 8 sub-tasks udfylder BIZZ-1355's epic. Kør i nummerisk rækkefølge.

### BIZZ-NEW-05 — Migration 109: aktiver + analyser tabeller

**Type:** Sub-task af BIZZ-1355
**Priority:** High
**Component:** Database, Forsikring
**Labels:** forsikring, migration, phase-2
**Blocked by:** BIZZ-NEW-03
**Estimate:** 2 timer

**Beskrivelse:**

Tilføj to nye tenant-scoped tabeller:

**forsikring_analyser** — én row pr. gap-analyse-kørsel:

```
id, tenant_id, kunde_type (cvr|person), kunde_id, kunde_navn,
total_aktiver, insured_count, total_risk_score, summary jsonb,
created_by, created_at
```

**forsikring_aktiver** — assets opdaget under koncern-walk:

```
id, tenant_id, analyse_id (FK), type (ejendom|virksomhed|bil|bestyrelsespost),
label, bfe, cvr, regnr, vaerdi_dkk, haeftelser_dkk, byggeaar, ansatte,
adresse, matched_policy_id (FK forsikring_policies, nullable), raw_data jsonb,
created_at
```

**Acceptance criteria:**

- [ ] Migration 109_forsikring_aktiver.sql oprettet
- [ ] Begge tabeller har RLS-policies + indices på (tenant_id, analyse_id)
- [ ] provision_tenant_forsikring_tables() udvidet med begge nye tabeller
- [ ] Backfill-loop kører for alle eksisterende tenants
- [ ] Cascade-delete: slet analyse → aktiver slettes
- [ ] TypeScript-types tilføjet til lib/supabase/types.ts

---

### BIZZ-NEW-06 — koncernWalk.ts: CVR → aktiver

**Type:** Sub-task af BIZZ-1355
**Priority:** High
**Component:** Forsikring, Backend
**Labels:** forsikring, koncern-walk, phase-2
**Blocked by:** BIZZ-NEW-05
**Estimate:** 1 dag

**Beskrivelse:**

Ren funktion der tager en kunde (CVR eller person enheds_nummer) og returnerer
en liste af `Aktiv`-objekter. Bruger eksisterende interne API'er:

- **Virksomhed (CVR):** ejf_ejerskab cache → DAWA → ejendomme + datterselskaber
- **Person (enheds_nummer):** person-bridge → person-properties + cvr-public
  for virksomheder + bestyrelsesposter

Inkluderer:

- Ejendomme (privat + via selskaber)
- Virksomheder (selskaber kunden ejer)
- Køretøjer (via Bilbog hvis tilgængelig)
- Bestyrelsesposter (med selskab+rolle metadata for D&O-detection)

**Acceptance criteria:**

- [ ] Funktionen `walkKoncern(kundeType, kundeId): Promise<Aktiv[]>`
- [ ] Kaster ved manglende cache + manglende live-API (graceful fallback)
- [ ] Unit tests med mocked fetch — minimum 5 scenarios
- [ ] Returnerer max 500 aktiver (sikkerhedsloft mod runaway koncerner)
- [ ] Inkluderer cyclic detection (A ejer B ejer A)
- [ ] BBR-data inline for ejendomme (byggeår, areal, anvendelse)

---

### BIZZ-NEW-07 — assetMatcher.ts: Asset↔police matching

**Type:** Sub-task af BIZZ-1355
**Priority:** High
**Component:** Forsikring, Backend
**Labels:** forsikring, matching, phase-2
**Blocked by:** BIZZ-NEW-06
**Estimate:** 1 dag

**Beskrivelse:**

Ren funktion der matcher `Aktiv[]` mod `ForsikringPolicy[]` og returnerer
match-array med score 0-100 pr. match.

Matching-heuristik (port fra slettet forsikringGapEngine.ts):

- **Ejendom ↔ police:** BFE-match (100), adresse-match (90), matr.nr-match (85)
- **Køretøj ↔ police:** registreringsnr-match (100)
- **Virksomhed ↔ police:** CVR-match (100), navn-match (75)
- **Bestyrelsespost ↔ police:** D&O type + selskab-CVR match

**Acceptance criteria:**

- [ ] Pure function `matchAssetsToPolicies(aktiver, policer): MatchResult[]`
- [ ] Returnerer for hver aktiv: bedste match + score + alle kandidater
- [ ] Threshold: < 50 score → ingen match (uforsikret)
- [ ] Unit tests for hver match-type
- [ ] Idempotent — samme input giver samme output
- [ ] Persisterer `matched_policy_id` på `forsikring_aktiver`

---

### BIZZ-NEW-08 — Gap-engine: 4 nye checks

**Type:** Sub-task af BIZZ-1355
**Priority:** High
**Component:** Forsikring, Backend
**Labels:** forsikring, gap-engine, phase-2
**Blocked by:** BIZZ-NEW-07
**Estimate:** 1 dag

**Beskrivelse:**

Udvid `app/lib/forsikring/gapEngine.ts` med:

- **GAP-100 Uforsikret aktiv:** Aktiv uden match-policy (score 0). Critical hvis værdi > 1M DKK.
- **GAP-101 Underforsikret aktiv:** Police-sum < 90% af aktiv-værdi. Critical hvis < 70%.
- **GAP-102 Realkredit-gab:** Tinglyste hæftelser > police-sum. Critical altid (panthaver-risiko).
- **GAP-103 Manglende D&O:** Bestyrelsespost uden D&O-police. Critical for A/S.

**Acceptance criteria:**

- [ ] 4 nye checks tilføjet til CHECKS-array
- [ ] Hver check er ren funktion (input → DetectedGap | null)
- [ ] Unit tests: minimum 12 nye test-cases (3 pr. check: trigger, ikke-trigger, edge)
- [ ] Severity-eskalering baseret på værdi + alder + faktorer
- [ ] Recommendation-tekst på dansk for hver
- [ ] estimated_impact_dkk udfyldt med tab-estimat ved skade

---

### BIZZ-NEW-09 — Risk-scoring 0-100

**Type:** Sub-task af BIZZ-1355
**Priority:** Medium
**Component:** Forsikring, Backend
**Labels:** forsikring, scoring, phase-2
**Blocked by:** BIZZ-NEW-08
**Estimate:** 0.5 dag

**Beskrivelse:**

Tilføj `riskScore` (0-100) til hver `DetectedGap`. Højere = mere kritisk.

Formel (port fra slettet forsikringGapEngine.ts):

- **Base score pr. gap-type:**
  - GAP-100 (uforsikret): 60
  - GAP-101 (underforsikret): 40
  - GAP-102 (mortgage): 70
  - GAP-103 (D&O): 50
  - GAP-010 til 014 (manglende dækninger): 20-35
- **Modifiers:**
  - Bygning > 50 år: +15
  - Aktiv-værdi > 5M: +10
  - Aktiv-værdi > 10M: +20
  - Hæftelser > 0: +10

Severity-labels (afledt af score):

- 0-25: `lav` (info)
- 26-50: `middel` (info)
- 51-75: `høj` (warning)
- 76-100: `kritisk` (critical)

**Acceptance criteria:**

- [ ] Helper `computeRiskScore(gap, asset?): number` i gapEngine.ts
- [ ] Helper `riskLabel(score): 'lav'|'middel'|'høj'|'kritisk'`
- [ ] Persisterer `risk_score` på forsikring_gaps (kræver migration 110 ALTER)
- [ ] Unit tests dækker alle severity-grænser
- [ ] UI viser risk_score som badge ved hver gap

---

### BIZZ-NEW-10 — API: POST/GET /api/forsikring/analyser

**Type:** Sub-task af BIZZ-1355
**Priority:** High
**Component:** Forsikring, API
**Labels:** forsikring, api, phase-2
**Blocked by:** BIZZ-NEW-09
**Estimate:** 0.5 dag

**Beskrivelse:**

Tre nye routes:

**POST /api/forsikring/analyser:** Body: `{ kunde_type, kunde_id }`. Walks
koncern + matcher mod tenantens forsikring_policies + kører gap-engine.
Persisterer alt i forsikring_analyser + forsikring_aktiver + forsikring_gaps.
Returnerer `{ analyse_id }`.

**GET /api/forsikring/analyser:** Liste alle analyser for tenant.

**GET /api/forsikring/analyser/[id]:** Detail med aktiver + gaps + scoring.

**Acceptance criteria:**

- [ ] Tre routes implementeret med JSDoc + try/catch + audit log
- [ ] Rate limiting via aiRateLimit (Claude-tunge operation)
- [ ] maxDuration 60 (koncern-walk kan tage tid)
- [ ] Tenant-isolering via getInsuranceApi
- [ ] Integration test (med mocked walker) der verificerer end-to-end persist

---

### BIZZ-NEW-11 — UI: customer picker + analyse-resultat side

**Type:** Sub-task af BIZZ-1355
**Priority:** High
**Component:** Forsikring, Frontend
**Labels:** forsikring, ui, phase-2
**Blocked by:** BIZZ-NEW-10
**Estimate:** 1 dag

**Beskrivelse:**

To UI-ændringer:

**1. `/dashboard/forsikring` — tilføj "Start analyse" sektion:**

- Customer-picker (autocomplete på CVR + person via eksisterende /api/search)
- "Start gap-analyse" knap → POST /api/forsikring/analyser
- Liste over tidligere analyser med status + risk-score

**2. Ny `/dashboard/forsikring/analyser/[id]` — analyse-detail:**

- Header: kunde-navn + samlet risk-score med donut-chart
- Aktiver-tabel: type, label, værdi, matched_policy, gap-badges
- Gaps-sektion: severity-grupperet med risk-score badges
- Eksport-knap (PDF/DOCX)

**Acceptance criteria:**

- [ ] Customer picker bruger eksisterende search-komponent
- [ ] Persistens af analyse-resultat — gen-besøg viser samme data
- [ ] Sprog-skift DA ↔ EN på alle nye strings
- [ ] WCAG: aria-labels, focus-trap på modal/eksport
- [ ] Loading.tsx skeleton mens analyse kører (~30 sek)

---

### BIZZ-NEW-12 — Phase 2 E2E test

**Type:** Task
**Priority:** High
**Component:** Forsikring, QA
**Labels:** forsikring, qa, phase-2
**Blocked by:** BIZZ-NEW-11
**Estimate:** 4 timer

**Beskrivelse:**

Manuel E2E test af komplet Phase 2-flow med Belvedere Ejendomme A/S (CVR 24301117):

**Acceptance criteria:**

- [ ] Søg "Belvedere Ejendomme" i customer-picker → fundet
- [ ] Klik "Start analyse" → analyse-side åbner med spinner
- [ ] Efter ~30-60 sek vises resultat med:
  - 6+ ejendomme (matching forventet Belvedere-portefølje)
  - X virksomheder (datterselskaber)
  - Y bestyrelsesposter
  - Samlet risk-score
- [ ] Hver ejendom har en matched_policy (hvis policer er uploaded)
- [ ] Uforsikrede ejendomme har GAP-100 med høj risk-score
- [ ] Rapportér mod facit-tabel i `docs/forsikring/tester-instruktion.md`

---

## PHASE 3 — Auto cross-checks + visualisering (BIZZ-1356 epic)

Disse 8 sub-tasks udfylder BIZZ-1356. Kør i nummerisk rækkefølge efter Phase 2.

### BIZZ-NEW-13 — Auto-trigger BBR cross-check efter parse

**Type:** Sub-task af BIZZ-1356
**Priority:** Medium
**Estimate:** 0.5 dag
**Blocked by:** BIZZ-NEW-12

Auto-call `hent_bbr_data` ved police-parse hvis `property_bfe` er sat. Re-kør
gap-engine med BBR-fakta → opdaterer gaps med GAP-001 (areal-mismatch) + GAP-040
(anvendelse-mismatch).

---

### BIZZ-NEW-14 — Tinglysning cross-check

**Type:** Sub-task af BIZZ-1356
**Priority:** Medium
**Estimate:** 0.5 dag
**Blocked by:** BIZZ-NEW-13

Auto-call `hent_tinglysning` for hver ejendom-aktiv → hent panthavere +
hæftelser → trigger GAP-102 (mortgage-gap) hvis pant > police-sum.

---

### BIZZ-NEW-15 — VUR cross-check

**Type:** Sub-task af BIZZ-1356
**Priority:** Low
**Estimate:** 0.5 dag
**Blocked by:** BIZZ-NEW-13

Auto-call `hent_forelobig_vurdering` → sammenlign med police-sum_insured.
Flag som info hvis vurdering > police × 1.5 (mulig underforsikring).

---

### BIZZ-NEW-16 — Klyngerisiko-detection

**Type:** Sub-task af BIZZ-1356
**Priority:** Low
**Estimate:** 0.5 dag
**Blocked by:** BIZZ-NEW-14

Aggregér eksponering pr. matr.nr (samlet erstatningsbeløb hvis fælles brand)
og pr. postnummer (geografisk koncentration). Flag hvis > 50% af koncernens
samlede sum-insured er på samme matrikel eller postnummer.

---

### BIZZ-NEW-17 — Restaurant-køkken-krav

**Type:** Sub-task af BIZZ-1356
**Priority:** Low
**Estimate:** 0.5 dag
**Blocked by:** BIZZ-NEW-13

For aktiver med branche-kode "restaurant" (CVR DB07): auto-generér tjekliste
matchende police 67500725's krav (fedthåndslukker, CO2-slukker, brandtæppe,
emfang-rensning). Tilføj som info-gap "Kræver dokumentation".

---

### BIZZ-NEW-18 — D&O/Cyber/Driftstab anbefalingsmodul

**Type:** Sub-task af BIZZ-1356
**Priority:** Medium
**Estimate:** 0.5 dag
**Blocked by:** BIZZ-NEW-08

Tilføj 3 anbefalings-checks:

- D&O: hvis koncernen har A/S-bestyrelsesposter uden D&O-police
- Cyber/GDPR: hvis koncernen har ansatte > 0 (håndterer PII)
- Driftstab: hvis koncernen har erhvervsudlejning og ingen driftstabsforsikring

Severity: warning. Recommendation: hvilken type police, estimeret pris.

---

### BIZZ-NEW-19 — Koncern-visualisering med tids-slider

**Type:** Sub-task af BIZZ-1356
**Priority:** Low
**Estimate:** 2 dage
**Blocked by:** BIZZ-NEW-11

Force-directed graph der viser:

- Rod: kunde (CVR/person)
- Niveauer: ejede selskaber, ejendomme, biler, bestyrelsesposter
- Kanter: ejerskab + adkomst (med fra/til-dato)
- Tids-slider øverst: ændrer snapshot-dato

Genbruger eksisterende `app/components/diagrams/` infrastruktur.

---

### BIZZ-NEW-20 — Mæglerrapport-eksport

**Type:** Sub-task af BIZZ-1356
**Priority:** Medium
**Estimate:** 1 dag
**Blocked by:** BIZZ-NEW-12

Eksport-knap på analyse-detail-side → genererer PDF + DOCX med:

- Header: kunde + dato + samlet risk-score
- Aktiv-oversigt med matched policer
- Prioriteret gap-liste
- Anbefalinger
- Append: alle original police-PDF'er som vedhæftning

Bruger eksisterende `generate_document`-pipeline.

---

## Sammenfatning — totale estimater

| Fase                     | Estimat                  | Tickets        | Status                |
| ------------------------ | ------------------------ | -------------- | --------------------- |
| Phase 1 finalize         | ~3 timer                 | 5 tickets      | I gang (PR opretning) |
| Phase 2 (BIZZ-1355 epic) | ~6 dage                  | 8 tickets      | Ikke startet          |
| Phase 3 (BIZZ-1356 epic) | ~6 dage                  | 8 tickets      | Ikke startet          |
| **Total**                | **~12-13 dages arbejde** | **21 tickets** |                       |

Hver Phase 2 + 3 sub-task kan parallelt udføres af forskellige agenter
**hvis** dependencies er respekteret.

## Anbefalet next step

1. **Opret BIZZ-NEW-01 til BIZZ-NEW-04** først (Phase 1 finalize)
2. **Opret BIZZ-NEW-05 til BIZZ-NEW-12** som sub-tasks under BIZZ-1355
3. **Opret BIZZ-NEW-13 til BIZZ-NEW-20** som sub-tasks under BIZZ-1356
4. **Kør i den execution-order der er angivet øverst**
