# Data Intelligence Arkitektur

**Status**: Forslag (2026-05-14)
**Forfatter**: AI/Architecture session
**Epic**: BIZZ-DI (Data Intelligence — træn AI på vores data)

## Baggrund

Den nuværende AI Query Builder (`/api/analyse/query`) og Pivot Explorer (`/api/analyse/pivot`)
fungerer ikke pålideligt:

- Pivot er rent manuel — ingen AI-hjælp og UX er svær for non-power-users
- AI Query Builder genererer en "structured query plan" mod en hardcoded whitelist,
  men Claude har ingen viden om hvad der _faktisk_ er i tabellerne (kolonner, datatyper,
  null-rates, værdifordelinger, temporal dækning), så plans bliver ofte forkerte
- Ingen pre-beregnede aggregater → simple spørgsmål som "hvor mange virksomheder i
  Aarhus?" kræver et fuldt DB-kald
- Ingen catalog over hvad der mangler i datasættet — AI'en kan ikke svare "hvad ved
  vi ikke?"

## Beslutning

Bygge et 3-lags Data Intelligence-system:

1. **Lag 1 — Data Catalog**: Pre-beregnet metadata-tabel + system prompt-injection
2. **Lag 2 — Knowledge Cache**: Pre-beregnede aggregater for top-50 common questions
3. **Lag 3 — Smart SQL**: AI-genereret SELECT mod read-only DB-rolle med AST-validering

## Arkitektur

```
AI Chat / Analyse
  │
  ├─ System Prompt (cached):
  │    ├─ Data Catalog (~2K tokens)
  │    └─ Knowledge Executive Summary (~1K tokens)
  │
  └─ Tools:
       ├─ hent_analytics_knowledge(topic, key)  ◄── Lag 2 (cache hit, <1s)
       ├─ execute_safe_sql(sql)                  ◄── Lag 3 (live, <10s)
       └─ 35+ eksisterende tools (live API)
```

## Lag 1 — Data Catalog

### Tabel

`analyse.data_catalog`:

- table_schema, table_name, column_name (NULL = table-level row)
- data_type, row_count, null_count, distinct_count
- top_values (jsonb, ekskl. PII-kolonner)
- min_value, max_value (text repræsentation)
- semantic_label (fx "kommunekode", "cvr")
- pii_flag
- computed_at

### Refresh

- Cron `/api/cron/refresh-data-catalog` natligt kl. 03:00
- `pg_class.reltuples` for tabeller > 1M rækker (estimat)
- TABLESAMPLE 1% for null/distinct/top-values på store tabeller
- COUNT(\*) for små tabeller (< 100k rækker)

### Prompt-injection

Kompakt Markdown-format. Eksempel:

```
### cvr_virksomhed (2.1M rækker)
- cvr (bigint, 0% null, unique)
- kommunekode (int, 2% null, top: 101, 751, 461)
- status (text, top: NORMAL 78%, OPHØRT 19%)
```

Budget: ~2.500 tokens. Cached som ephemeral (5min TTL via prompt caching).

## Lag 2 — Knowledge Cache

### Tabel

`analyse.analytics_knowledge`:

- topic (fx `company_count_by_municipality`)
- topic_label_da (fx "Virksomheder per kommune")
- key (jsonb, fx `{"kommunekode": 101}`)
- value (jsonb, fx `{"count": 142893, "active": 118402}`)
- computed_at, expires_at
- source_query (audit)

### Initial topic-sæt (12 stk)

| Topic                          | Builder fil                         |
| ------------------------------ | ----------------------------------- |
| company_count_by_municipality  | topics/companyByMunicipality.ts     |
| company_count_by_industry      | topics/companyByIndustry.ts         |
| company_status_distribution    | topics/companyStatusDistribution.ts |
| property_count_by_type         | topics/propertyByType.ts            |
| property_count_by_municipality | topics/propertyByMunicipality.ts    |
| avg_valuation_by_property_type | topics/avgValuationByType.ts        |
| data_coverage_bbr              | topics/dataCoverageBbr.ts           |
| data_coverage_valuation        | topics/dataCoverageValuation.ts     |
| data_coverage_energy           | topics/dataCoverageEnergy.ts        |
| ownership_distribution         | topics/ownershipDistribution.ts     |
| recent_company_registrations   | topics/recentRegistrations.ts       |
| temporal_coverage              | topics/temporalCoverage.ts          |

### Refresh

- Cron `/api/cron/refresh-knowledge-cache` natligt kl. 03:30
- Hver builder kører isoleret — fejl i én topic stopper ikke andre

### Adgang

- Tool: `hent_analytics_knowledge({ topic, key? })` → returnerer fact + `computed_at`
- System prompt: Top-10 mest relevante facts som "executive summary"

## Lag 3 — Smart SQL Generation

### Sikkerheds-stack

**Trin 1: AST-parser** (`pg-query-emscripten`):

- Afvis DDL (CREATE/DROP/ALTER), DML (INSERT/UPDATE/DELETE), DCL (GRANT/REVOKE)
- Afvis system-schemas (pg\_\*, information_schema, auth, storage)
- Whitelist: kun analyse/public + specifikke tabeller
- Injicér `LIMIT 10000` hvis mangler

**Trin 2: Read-only execution**:

```sql
CREATE ROLE ai_query_reader NOLOGIN;
GRANT USAGE ON SCHEMA public, analyse TO ai_query_reader;
GRANT SELECT ON [whitelistede tabeller] TO ai_query_reader;
-- Ingen ALTER, INSERT, UPDATE, DELETE, TRUNCATE
```

Per request:

- `SET ROLE ai_query_reader`
- `SET statement_timeout = '10s'`
- `SET lock_timeout = '1s'`
- Read-only transaction

**Trin 3: Audit**:
`analyse.ai_sql_audit` med tenant_id, user_id, prompt, sql, executed-flag, duration, row_count

## Risici & Mitigationer

| Risiko                                        | Mitigation                                                  |
| --------------------------------------------- | ----------------------------------------------------------- |
| Token-omkostning ved daglige cache-injections | Prompt caching (allerede aktiv) → 90% cache hit rate        |
| SQL injection via Smart SQL                   | AST-validation + read-only rolle + statement_timeout        |
| Stale knowledge cache giver forkerte svar     | Freshness-timestamps; UI viser "opdateret kl. X"            |
| Schema-drift (nye kolonner)                   | Catalog auto-refresher; nightly mismatch detection          |
| Store result-sets blæser context op           | LIMIT 10000 hard cap; CSV-preview før AI ser det            |
| PII-lækage via top-values                     | `pii_flag` kolonne; navne/emails/CPR ekskluderet by default |

## Faser

| Fase | Indhold                      | Tickets                              |
| ---- | ---------------------------- | ------------------------------------ |
| 1    | Data Catalog                 | BIZZ-DI-01 … BIZZ-DI-06 (6 tickets)  |
| 2    | Knowledge Cache              | BIZZ-DI-07 … BIZZ-DI-16 (10 tickets) |
| 3    | Smart SQL                    | BIZZ-DI-17 … BIZZ-DI-25 (9 tickets)  |
| 4    | UX Polish                    | BIZZ-DI-26 … BIZZ-DI-29 (4 tickets)  |
| 5    | E2E test + iterativ fix-loop | BIZZ-DI-30 … BIZZ-DI-33 (4 tickets)  |

## Fase 5 — Iterativ E2E test-protokol

Test-scenarie-kataloget indeholder 25 spørgsmål fordelt på 4 niveauer:

- Niveau 1 (8 stk): Knowledge cache (Lag 2) — forventet <2s
- Niveau 2 (8 stk): Catalog-informeret SQL (Lag 1+3) — forventet <8s
- Niveau 3 (6 stk): Komplekse joins — forventet <12s
- Niveau 4 (3 stk): Edge cases & sikkerhed (SQL injection, cross-tenant, timeout)

### Fix-loop protokol

```
FOR scenario N IN [1..25]:
  1. Run scenario
  2. If pass → log & continue til N+1
  3. If fail:
     a. Capture: error, generated SQL, AI response, tool sequence, network logs
     b. Classify root cause (catalog / knowledge / sql-gen / validator / UX / infra)
     c. Create fix-ticket BIZZ-DI-32-fixN
     d. Implement fix on develop
     e. Deploy til test.bizzassist.dk
     f. Re-run scenario N (IKKE N+1)
     g. Max 3 retries; ved 3 fejl → escalate til bruger
  4. Log resultat i docs/test-evidence/data-intelligence-YYYY-MM-DD.md
```

### Done-kriterier

- Alle 25 scenarier passerer i én sammenhængende kørsel
- Coverage ≥70% line / ≥35% branch for `lib/dataIntelligence/**`
- Audit-tabellen indeholder alle 25 + fix-attempts (sporbarhed)
- Performance-budget overholdt for alle niveauer

## Referencer

- `app/lib/analyseQueryWhitelist.ts` — eksisterende table whitelist
- `app/api/analyse/query/route.ts` — eksisterende structured query plan (erstattes i Fase 3)
- `app/api/ai/chat/route.ts` — eksisterende AI chat (udvides i Fase 1+2)
- `docs/architecture/DATABASE.md` — tenant model + RLS setup
