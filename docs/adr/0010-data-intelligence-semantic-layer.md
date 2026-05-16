# ADR-0010: Data Intelligence Semantic Layer

## Status

Accepted (2026-05-16) — implementering kan begynde med L2.1 (BIZZ-1562).

## Context

Data Intelligence v1 (BIZZ-1428) genererer SQL fra naturligt sprog via Claude.
Det virker for simple queries men fejler på komplekse joins, hallucinerer
kolonner, og kan ikke garantere reproducerbarhed eller performance.

BIZZ-1558 epic foreslår en 3-lags arkitektur:

- **Lag 1 (Generativ):** schema-aware RAG + agentic loop (fallback)
- **Lag 2 (Semantisk):** NL → metric+dim+filter routing → deterministisk SQL
- **Lag 3 (Cache):** materialiserede views for top-N spørgsmål

Det semantiske lag (Lag 2) er kernen — det er hvad der gør produktet "smart"
uden at brænde AI-tokens på hallucinerede SQL-statements. Vi skal vælge en
implementations-strategi.

## Options Considered

### Option A: Cube.dev self-hosted (Hetzner)

**Pro:**

- Production-grade open-source semantic layer (10k+ stjerner på GitHub)
- Indbygget pre-aggregation / caching (= L3 "gratis")
- REST + GraphQL endpoints out-of-the-box
- Cube AI: native NL → query support
- Bevist på Snowflake/BigQuery/Postgres-stacks

**Con:**

- Extra runtime + container på Hetzner — ny infra-overhead
- Schema defineres i Cube's JS/YAML — separate fra TypeScript-stacken
- Latency-tier ekstra (Vercel → Cube → Postgres ≈ +50-150ms)
- Vi skal lære og vedligeholde et nyt DSL

### Option B: Cube Cloud (managed)

Som A, men med managed hosting. **Eliminerer self-host-overhead** men tilføjer
prisleje ($199/mnd start-tier, $999/mnd team-tier). For early-stage produkt er
det relativt dyrt i forhold til at vi kører på Hetzner CPX42 (€18/mnd).

### Option C: Custom TypeScript metric-DSL

**Pro:**

- Ingen extra infrastruktur — alt i Next.js + Supabase
- Typesikker fra metric-definition til SQL-output (vi får compile-time checks)
- Minimal latency overhead (in-process)
- Holder al kode i samme stack som resten af systemet

**Con:**

- Vi bygger det selv — 2-3 ugers eng-tid for MVP
- Materialiserede views skal håndteres separat (L3)
- Vi mister Cube's AI-integrations (men har vores egen Claude-prompt
  alligevel)

### Option D: Hybrid — Cube-syntaks + custom TypeScript-executor

Adopter Cube's metric-definition-syntaks (`cube { name, sql, dimensions, measures, joins }`)
men skriv vores egen TypeScript-executor mod Supabase.

**Pro:**

- Bevarer mulighed for senere at swappe til Cube proper hvis behov vokser
- Får typesikkerhed + lav latency NU
- Metric-katalogerne er fremtidssikret med en standardiseret syntaks

**Con:**

- Vi får ikke Cube AI eller pre-aggregations gratis
- Skal selv implementere YAML/JS-parser hvis vi vil tro fast på syntaksen
  (eller bruge `cube/server-core` som lib-only)

## Decision

**Valgt: Option D — Hybrid med Cube-inspireret syntaks + custom executor.**

### Rationale

1. **Start lean:** Vi har endnu ikke proven product-market-fit på Data
   Intelligence. Cube self-host eller Cloud er overhead vi ikke kan retfærdiggøre
   før vi ved at brugerne faktisk efterspørger denne kapacitet.

2. **Typesikkerhed nu:** TypeScript-executor giver compile-time verification af
   metric-definitioner mod schema-katalogen (BIZZ-1559) — vi opdager hallucinerede
   kolonner i CI, ikke i prod.

3. **Latency-budget:** Vi har set fra BIZZ-1555 at 90s server-timeout allerede
   er stramt for komplekse queries. Ekstra 50-150ms Cube-roundtrip vil gøre nogle
   spørgsmål utid-løse. In-process executor undgår dette.

4. **Future-proof med Cube-syntaks:** Hvis brugerne senere kræver Cube's
   pre-aggregations eller Cube AI, kan vi swappe executor uden at omskrive
   metric-katalogerne.

5. **L3 implementeres separat:** Vi håndterer pre-aggregation via egne
   materialized views i Postgres (L3 / BIZZ-1565). Det er en kendt teknik vi
   allerede bruger til `mv_analyse_virksomhed`, `mv_analyse_ejendom`,
   `mv_ejerskab_beriget` osv.

## Consequences

### Ændringer

- **Ny mappe:** `app/lib/dataIntelligence/semantic/` for metric-DSL, parser,
  executor.
- **Ny dependency:** Ingen (vi skriver det selv). Eventuelt `cube/schema-compiler`
  hvis vi vil parse Cube-YAML direkte — men start uden.
- **Test:** Hver metric skal have unit-test der validerer den compiler til
  forventet SQL.

### Hosting

Ingen ændringer. Alt kører fortsat på Vercel + Supabase.

### Deployment

Ingen ny CI/CD pipeline. Metric-definitioner i `.ts` filer der bygges sammen
med resten af koden.

### Performance

- Lag 2 routing: < 100ms (Claude-call + plan-build + SQL-compile)
- Lag 3 cache: < 50ms (materialized view query)
- Lag 1 fallback: 5-30s (eksisterende AI-SQL-gen, kun når L2 ikke matcher)

## Implementation Plan

Følgende tickets afhænger af denne ADR:

1. **BIZZ-1562** L2.1 — Metric- og dimensions-katalog (med 3-persona analyse).
   Brug Cube-inspireret syntaks i TypeScript. Definér metrics for top-30
   identificerede bruger­spørgsmål.

2. **BIZZ-1563** L2.2 — NL → metric+dim+filter routing-lag. Claude-prompt med
   constraint-output bundet til metric-katalog-navne.

3. **BIZZ-1564** L2.3 — Semantic-layer SQL-compiler + executor. Ren TypeScript,
   deterministisk, ingen AI.

4. **BIZZ-1565** L3 — Materialiserede views (Postgres) for top-N spørgsmål.
   Cache-routing-laget der serverer pre-computed answers før Lag 2 rammes.

5. **BIZZ-1559** ✓ L1.1 Schema-katalog allerede leveret (forudsætning for L2.1).

## Future Reconsideration

Re-vurder migration til Cube proper hvis ÉN af følgende bliver sande:

- Bruger­efterspørgsel efter Cube AI features (NL → BI dashboards, ad-hoc analytics).
- Material­ized views bliver svære at vedligeholde manuelt (> 50 views med
  dependencies).
- Latency-budget bliver mindre stramt (fx via Vercel Edge Functions).
- Vi vinder en større kunde der bruger Looker/Tableau og forventer
  semantic-layer-interop.

Når dette sker: dokumentér migration-plan i ny ADR.
