# ADR-0007 — cvr_deltager base schema + enrichment strategy

**Status:** Accepted
**Date:** 2026-04-24
**Deciders:** jjrchefen (ARCHITECT)
**Related tickets:** BIZZ-830, BIZZ-823, BIZZ-651 (context)

## Context

CVR deltager-ingestion was deferred when `cvr_virksomhed` was
landed (migration 054, BIZZ-651) to keep the PR scoped. BIZZ-830
subsequently tried to add enrichment columns via `ALTER TABLE
public.cvr_deltager …` but the base table doesn't exist —
migration 055 was reserved as a placeholder.

BIZZ-823 (person-filtering: active role, role type, recent entry)
is blocked on the same base table.

We need to answer:

1. Primary key strategy — `enhedsNummer` vs CPR.
2. Relation model — single table or separate relations.
3. RLS policy — public schema, service_role only.
4. Indexing strategy — which filters matter.

## Decision

### 1. PK — `enhedsNummer` only

`enhedsNummer` is CVR ES's unique identifier for a deltager. It is
non-PII at the level we expose (it's a surrogate integer, not a
government ID).

**CPR is never stored.** This is non-negotiable:

- GDPR article 9 (personoplysninger af særlig kategori).
- Persondataforordningen (Danish supplementary rules).
- `cpr_nummer` is actively redacted from our ingestion path.

If we need cross-reference with external CPR-keyed systems we do
it via `enhedsNummer` lookup against CVR ES, never via direct CPR
storage.

### 2. Relation model — separate `cvr_deltagerrelation` table

Two tables:

```
cvr_deltager            (stamdata om personen)
  enhedsNummer PK
  navn, adresse_json, sidst_opdateret, raw_source

cvr_deltagerrelation    (hvilke firmaer personen er deltager i)
  virksomhed_cvr FK → cvr_virksomhed
  deltager_enhedsNummer FK → cvr_deltager
  type (direktør | bestyrelsesmedlem | stifter | reel_ejer | ejer)
  gyldig_fra, gyldig_til (null = active)
  sidst_opdateret
  PRIMARY KEY (virksomhed_cvr, deltager_enhedsNummer, type, gyldig_fra)
```

Rationale: one deltager has many roles across many companies over
time. Flat embedded JSONB would require array-unnesting for
every filter query. Separate table gives standard SQL joins and
GIN-free filters on `type`.

### 3. RLS — `service_role` only

CVR is public government data, but we serve it through our API
layer to apply:

- Rate-limiting (per-tenant via Upstash).
- Audit-logging (which tenant looked up whom).
- Billing-gate (AI-tools require paid plan).

Direct RLS-grants to authenticated users would bypass those
layers. Pattern is identical to `cvr_virksomhed` (054).

### 4. Indexing

**Base table:**

- `btree(sidst_opdateret DESC)` — delta-sync cursor.
- `GIN(to_tsvector('danish', navn))` — name-search autocomplete.

**Relation table:**

- `btree(virksomhed_cvr)` — "who's in this company".
- `btree(deltager_enhedsNummer)` — "what's this person in".
- `btree(type, gyldig_til)` WHERE `gyldig_til IS NULL` — active-role filter.

**Enrichment table (BIZZ-830 fase B):**

- `btree(is_aktiv) WHERE is_aktiv = true` — active-only filter.
- `GIN(role_typer)` — "has any director role" etc.
- `btree(senest_indtraadt_dato DESC)` — "joined in last 12mo".

## Execution plan

BIZZ-830 is split into four tickets:

**Fase A — migration 055 (base schema):**

- Create `cvr_deltager` + `cvr_deltagerrelation` tables + RLS + base indexes.
- ~50 lines SQL, modeled on 054.

**Fase B — migration 077 (enrichment columns):**

- `is_aktiv`, `aktive_roller_json`, `antal_aktive_selskaber`,
  `senest_indtraadt_dato`, `role_typer`, `berigelse_sidst`.
- Enrichment indexes.

**Fase C — backfill script:**

- `scripts/backfill-cvr-deltager.mjs`.
- Fetches from `/cvr-permanent/deltager/_search` with pagination.
- ~1.87M deltagere × batch 1000 × 300ms delay ≈ 3–4 timer run.
- Idempotent upsert on `enhedsNummer`.

**Fase D — daily delta-cron:**

- `/api/cron/pull-cvr-deltager-aendringer` using cursor-singleton
  pattern from migration 056.

## Consequences

**Positive:**

- BIZZ-830 and BIZZ-823 are unblocked with clear four-step plan.
- Schema mirrors the proven `cvr_virksomhed` pattern — same
  delta-sync cursor, same RLS, same raw_source snapshot.
- CPR never enters our system.

**Negative:**

- Initial backfill is a 3–4 hour long-running operation. Must be
  run in background with checkpointing. Script already handles
  `--resume-from=<enhedsNummer>` via sort-key.
- Two tables instead of one means backfill must hit both.

**Storage footprint:**

- `cvr_deltager`: ~1.87M rows × ~1KB = ~1.9 GB.
- `cvr_deltagerrelation`: est. ~5M rows (avg 2.7 roles/person)
  × ~200B = ~1 GB.
- Total: ~3 GB — well within Supabase plan limits.

## Rejected alternatives

- **Embedded JSONB array of roles on deltager row:** Rejected —
  forces array-unnesting on every role-filter query, breaks
  indexing for `type = 'direktør' AND gyldig_til IS NULL`.
- **Store CPR for exact person disambiguation:** Rejected —
  illegal under GDPR art. 9. If `enhedsNummer` collision occurs
  (two persons same name, different CPR), CVR ES itself resolves
  it via unique `enhedsNummer` so we never need CPR.
- **Single combined `cvr_deltager_with_roles` denormalized table:**
  Rejected — breaks idempotent upsert (you'd insert N rows for a
  single ES record, and deletions of expired roles become a purge
  scan).
