# Forsikrings-modul Runde 1 — Deploy & test guide

Trin-for-trin instruktioner til at deploye Runde 1 (MVP) og verificere
modulet end-to-end. Følges efter at PR-koden er review'd og unit-tests er grønne.

**Status før guiden:**

- ✅ Branch `claude/naughty-roentgen-d68ac1` pushet til GitHub
- ✅ Tier 1 verifikation: code review OK, 34/34 unit tests grønne
- ✅ JIRA tickets BIZZ-1351 → BIZZ-1356 oprettet

**Hvad guiden dækker:**

- Trin 1: Lokal UI-test uden DB (~5 min)
- Trin 2: Deploy migration 096 til Supabase (~10 min)
- Trin 3: Fuld E2E-test med 6 Belvedere-policer (~15 min)
- Trin 4: Merge PR mod `develop` (~5 min)
- Troubleshooting + rollback

Total tid ved første gennemløb: ca. **35-45 min**.

---

## Trin 1 — Lokal UI-test (BIZZ-1352, valgfri pre-flight)

Formålet er kun at verificere at UI rendrer og sidebar virker, før du
deployer migrationen. **Du kan skippe direkte til Trin 2** hvis du stoler
på unit-tests + code review fra Tier 1.

### 1.1 Setup

```powershell
# PowerShell, fra repo-roden
cd C:\Users\JakobJuulRasmussenHP\dev\BizzAssist\.claude\worktrees\naughty-roentgen-d68ac1

# Kopiér env-fil fra hoved-repo
Copy-Item ..\..\..\..\BizzAssist\.env.local .

# Start dev-server
npm run dev
```

Dev-server skal sige `Ready in ~1s` og lytte på http://localhost:3000.

### 1.2 Browser-test

1. Åbn http://localhost:3000 i din browser
2. Log ind (jjrchefen@gmail.com)
3. Verificér i venstre sidebar:
   - **"Forsikring"** vises mellem "AI Chat" og "Tokens"
   - Ikonet er ShieldCheck (skjold med flueben)

4. Klik på "Forsikring" → `/dashboard/forsikring`

### 1.3 Forventet observation (uden migration deployet)

✅ Sidebar viser Forsikring-knappen
✅ Page rendrer header "Forsikringer" + KPI-tiles (alle 0) + upload-zone
✅ Empty state "Ingen policer endnu" vises
❌ Browser console viser 500-fejl fra `GET /api/forsikring` (DB-tabel findes ikke)
❌ Upload vil fejle med "Serverfejl" (samme grund)

Hvis du ser ovenstående, **virker frontend som forventet** — næste trin
er at deploye DB-tabellerne.

### 1.4 Stop dev-server

Ctrl+C i terminalen. Dev-server skal stoppes før Trin 2 så ingen kald
rammer en halv-deployet DB.

---

## Trin 2 — Deploy migration 096 til Supabase (BIZZ-1351)

Migration 096 opretter:

- 4 nye tabeller (`forsikring_documents/policies/coverages/gaps`) i alle eksisterende tenant-schemaer
- Storage bucket `forsikring-documents` (private, 20 MB pdf-only)
- RPC `provision_tenant_forsikring_tables` så nye tenants automatisk får tabellerne

Migrationen er **idempotent** — kan køres flere gange uden fejl.

### Vælg deploy-metode

| Metode                       | Tid   | Kræver                  | Anbefalet til                    |
| ---------------------------- | ----- | ----------------------- | -------------------------------- |
| A) Supabase Studio SQL paste | 3 min | Browser + login         | dev (første gang)                |
| B) Management API runner     | 1 min | `SUPABASE_ACCESS_TOKEN` | test/prod (gentagne deploys)     |
| C) psql direkte              | 1 min | DB connection string    | Hvis du allerede har psql sat op |

### 2A — Via Supabase Studio (anbefalet til første deploy)

For **hvert** miljø (dev, test, prod):

1. Åbn projektets SQL editor:
   - **Dev:** https://supabase.com/dashboard/project/wkzwxfhyfmvglrqtmebw/sql/new
   - **Test:** https://supabase.com/dashboard/project/rlkjmqjxmkxuclehbrnl/sql/new
   - **Prod:** https://supabase.com/dashboard/project/xsyldjqcntiygrtfcszm/sql/new

2. Åbn filen `supabase/migrations/096_forsikring.sql` lokalt og kopiér **hele indholdet** (385 linjer)

3. Paste i SQL editor

4. Klik **Run** (eller Ctrl+Enter)

5. Forventet output (nederst i editoren):

   ```
   Success. No rows returned.
   NOTICE: Backfilled forsikring-tabeller til tenant_xxxxxxxx
   NOTICE: Backfilled forsikring-tabeller til tenant_yyyyyyyy
   ...
   ```

   Antal NOTICEs = antal eksisterende tenants på det miljø.

### 2B — Via runner-script (kræver SUPABASE_ACCESS_TOKEN)

```powershell
# Generér personal access token: https://supabase.com/dashboard/account/tokens
$env:SUPABASE_ACCESS_TOKEN = "sbp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

cd C:\Users\JakobJuulRasmussenHP\dev\BizzAssist\.claude\worktrees\naughty-roentgen-d68ac1

# Deploy til dev
node scripts/run-migrations.mjs dev

# Hvis dev går godt, deploy til test
node scripts/run-migrations.mjs test

# Først efter test er verificeret, deploy til prod
node scripts/run-migrations.mjs prod
```

Scripten kører **alle** migrations som er i `migrations`-arrayet for det
miljø, ikke kun 096. Det er sikkert fordi alle migrations er idempotente
(de springer over hvis allerede kørt).

### 2.3 Verifikation efter deploy

I Supabase Studio SQL editor for det miljø du lige deployede til, kør:

```sql
-- Skal returnere 4 tabeller pr. tenant-schema
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_name LIKE 'forsikring_%'
  AND table_schema LIKE 'tenant_%'
ORDER BY table_schema, table_name;

-- Skal returnere row 'forsikring-documents'
SELECT id, name, public, file_size_limit, allowed_mime_types
FROM storage.buckets
WHERE id = 'forsikring-documents';

-- Skal returnere antal tenants der har forsikrings-tabeller
SELECT COUNT(DISTINCT table_schema) as tenants_with_forsikring
FROM information_schema.tables
WHERE table_name = 'forsikring_policies'
  AND table_schema LIKE 'tenant_%';
```

Forventet resultat:

- Første query: 4 rows pr. eksisterende tenant_xxx schema
- Anden query: 1 row med `public=false`, `file_size_limit=20971520`, `allowed_mime_types={application/pdf}`
- Tredje query: antal aktive tenants på miljøet

Hvis nogen af disse fejler, se Troubleshooting nederst.

---

## Trin 3 — Fuld E2E test (BIZZ-1352)

Test mod **dev**-miljø først. Først efter alle acceptance-kriterier
er grønne på dev kører du samme test mod test/prod.

### 3.1 Start dev-server

```powershell
cd C:\Users\JakobJuulRasmussenHP\dev\BizzAssist\.claude\worktrees\naughty-roentgen-d68ac1
npm run dev
```

### 3.2 Login + navigation

1. Åbn http://localhost:3000/login
2. Log ind som `jjrchefen@gmail.com`
3. Verificér sidebar viser "Forsikring" (mellem AI Chat og Tokens)
4. Klik på Forsikring

### 3.3 Upload sequence

Upload Belvedere-policerne **én ad gangen** og verificér forventede gaps
matcher tabellen nedenfor.

Belvedere-PDF'erne ligger på din maskine i:

```
C:\Users\JakobJuulRasmussenHP\Downloads\
```

| Police-PDF                  | Forsikringssted         | Forventede critical gaps                    | Forventede warning gaps                |
| --------------------------- | ----------------------- | ------------------------------------------- | -------------------------------------- |
| `Police 50143392.pdf`       | Stengade 7 (restaurant) | Insekt/svamp (1900-bygning + restaurant)    | Glas, sanitet, restværdi, stikledning  |
| `Police 50143465.pdf`       | Gefionsvej 47A          | (afhænger af BBR-data — ikke trigget endnu) | Glas, sanitet, restværdi, stikledning  |
| `Police 50143511.pdf`       | Klostermosevej 123      | Insekt/svamp (>50 år)                       | Glas, sanitet, restværdi, stikledning  |
| `Police 50143554 .pdf`      | Bramstræde 5 (hotel)    | Insekt/svamp (1890 hotel)                   | Glas, sanitet, stikledning             |
| `Police 67500725 .pdf`      | Gefionsvej 45A          | (bedst dækket — har insekt + stikledning)   | Glas, sanitet, restværdi               |
| `TOP Police 9417319074.pdf` | Stjernegade 17          | Aftale udløbet (1.1.2026)                   | (TOP har glas/sanitet/insekt allerede) |

For hver upload:

1. Træk PDF til upload-zone (eller klik for fil-vælger)
2. Vent på status: **Uploader…** → **Analyserer police med AI…** (10-30 sek)
3. Verificér final status: **✓**
4. Police vises i tabellen med selskab, forsikringstager, adresse, præmie, udløb
5. Gap-badges vises i kolonnen "Gaps" (røde for kritisk, gule for warning, grå for info)
6. Klik på policen → detail-side åbner
7. Verificér mod forventede gaps i tabellen ovenfor

### 3.4 Yderligere acceptance criteria

- [ ] Skift sprog DA → EN: alle forsikrings-UI-strings oversættes
- [ ] Slet en police via detail-side → coverages + gaps slettes (cascade)
- [ ] Upload 3 policer hurtigt efter hinanden → ingen race conditions, alle parses
- [ ] Browser console viser **ingen** errors (kun warnings OK)
- [ ] Sentry viser **ingen** unhandled exceptions

### 3.5 Hvis noget fejler

Se Troubleshooting nederst, og vedhæft screenshots + console-output til
BIZZ-1352 ticketet.

---

## Trin 4 — Merge PR til develop

Når dev er grøn og du har verificeret upload på mindst 2-3 policer.

### 4.1 Opret PR (hvis ikke allerede gjort)

Åbn:

https://github.com/itmgtconsulting-prog/BizzAssist/compare/develop...claude/naughty-roentgen-d68ac1?expand=1

Titel: `feat(forsikring): MVP insurance gap analysis module`

Body: Brug PR-template fra docs/forsikring/jira-tickets-runde-1.md
(eller den template jeg gav tidligere i conversation).

Link til JIRA-tickets:

- BIZZ-1351 (migration deploy)
- BIZZ-1352 (E2E test)
- BIZZ-1353 (Vercel preview)
- BIZZ-1354 (CI token)
- BIZZ-1355 (Runde 2 epic)
- BIZZ-1356 (Runde 3 epic)

### 4.2 CI checks

Vent på at GitHub Actions kører:

- ✅ TypeScript type-check
- ✅ ESLint
- ✅ Prettier
- ✅ Vitest unit tests
- ✅ Playwright E2E (smoke)
- ✅ Vercel preview deploy

Hvis CI fejler, fix lokalt → push → retry.

### 4.3 Code review

Bed en kollega (eller ARCHITECT/CODE REVIEWER agent jf. CLAUDE.md
release process) om at review'e PR'en. Specifikt at de tjekker:

- Tenant-isolering via `getTenantContext()`
- RLS policies på alle 4 nye tabeller
- JSDoc-kommentarer på alle eksporterede funktioner
- Ingen `any`-typer
- Audit-log entries på alle writes

### 4.4 Merge

Når CI er grøn + review godkendt:

- Klik **Squash and merge** (foretrukket — én ren commit på develop)
- Slet feature-branch efter merge

### 4.5 Verificér develop er grøn

Efter merge:

1. Tjek `develop` branch på GitHub viser dit merge-commit
2. Verificér Vercel preview deploy af develop kører grøn
3. Test hurtigt på preview-URL'en at /dashboard/forsikring stadig virker

---

## Trin 5 — Deploy til prod (senere)

Først efter mindst 24 timer på develop uden indrapporterede fejl.

```sh
# Deploy migration til prod
node scripts/run-migrations.mjs prod

# Verificér via SQL (samme query som Trin 2.3 men mod prod)
```

Merge develop → main via separat PR. Vercel deployer automatisk til prod.

---

## Troubleshooting

### "Cannot find module 'pizzip'" i unit tests

```sh
npm install
```

Worktree havde manglende deps. Sker kun første gang.

### Upload fejler med "Forsikrings-tabel findes ikke"

Migration 096 er ikke deployet. Gå til Trin 2.

### Parse fejler med "BIZZASSIST_CLAUDE_KEY ikke sat"

Tjek `.env.local` indeholder:

```
BIZZASSIST_CLAUDE_KEY=sk-ant-api03-...
```

Hvis ikke, kopiér fra hoved-repo eller hent fra password manager.

### Upload fejler med "Storage bucket not found"

Storage bucket `forsikring-documents` blev ikke oprettet af migrationen.
Kør i SQL editor:

```sql
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('forsikring-documents', 'forsikring-documents', false, 20971520,
        ARRAY['application/pdf']::text[])
ON CONFLICT (id) DO NOTHING;
```

### Parse hænger > 60 sekunder

Claude-API'en er langsom eller PDF'en er meget stor. Tjek:

- Browser network tab → kig efter `/api/forsikring/parse` request
- Hvis 504 timeout: PDF'en var > 120k chars tekst, blev trimmed automatisk
- Hvis 429: rate limit, vent 1 min og prøv igen

### Gap-engine finder ikke forventede gaps

Mest sandsynligt parse-fejl. Tjek detail-siden for at se hvilke
dækninger Claude faktisk uddrog. Hvis fx "Insekt og svamp" mangler i
listen men du forventede den, har Claude misset en linje i policen.

Indrapportér i BIZZ-1352 så vi kan forbedre system-prompten i Runde 1.5.

---

## Rollback plan

Hvis noget går galt i prod:

### Hurtig revert (alt på én gang)

```sql
-- I Supabase Studio SQL editor (prod)
-- ADVARSEL: Sletter alle uploadede forsikrings-data permanent!

BEGIN;

-- 1. Slet storage objects
DELETE FROM storage.objects WHERE bucket_id = 'forsikring-documents';
DELETE FROM storage.buckets WHERE id = 'forsikring-documents';

-- 2. Drop tabeller pr. tenant (kør for hver tenant_xxx schema)
DO $$
DECLARE schema_rec record;
BEGIN
  FOR schema_rec IN
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name LIKE 'tenant\_%' ESCAPE '\'
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS %I.forsikring_gaps CASCADE', schema_rec.schema_name);
    EXECUTE format('DROP TABLE IF EXISTS %I.forsikring_coverages CASCADE', schema_rec.schema_name);
    EXECUTE format('DROP TABLE IF EXISTS %I.forsikring_policies CASCADE', schema_rec.schema_name);
    EXECUTE format('DROP TABLE IF EXISTS %I.forsikring_documents CASCADE', schema_rec.schema_name);
  END LOOP;
END $$;

-- 3. Drop provision-funktion
DROP FUNCTION IF EXISTS public.provision_tenant_forsikring_tables(text, uuid);

COMMIT;
```

### Soft revert (behold data, skjul UI)

I `app/dashboard/layout.tsx`, kommentér nav-item ud:

```ts
// { icon: ShieldCheck, key: 'forsikring' as const, href: '/dashboard/forsikring', adminOnly: false },
```

Brugere kan ikke længere finde modulet, men data + DB-tabeller forbliver.

---

## Næste skridt efter Runde 1 er stabil

1. **Lav post-mortem af Runde 1** — hvad gik godt, hvad lærte vi?
2. **Start Runde 2** (BIZZ-1355) — koncern-walk + tids-validering
3. **Start Runde 3** (BIZZ-1356) — BBR/Tinglysning/VUR auto-checks + 100+ gaps

Når du er klar til Runde 2, sig til så går jeg i gang.
