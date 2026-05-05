# ADR-0006 — Regnskab cache retention, currency, and raw XBRL handling

**Status:** Accepted
**Date:** 2026-04-24
**Deciders:** jjrchefen (ARCHITECT)
**Related tickets:** BIZZ-829, BIZZ-822

## Context

BIZZ-829 implements nøgletal-based filtering (omsætning, resultat,
soliditetsgrad, ROI) in the unified search. This requires the
`regnskab_cache` table to hold enough history for trend analysis,
and raises four schema questions:

1. Should the table be partitioned (by year, by status)?
2. How long should financial data be retained?
3. Should EUR be supported alongside DKK?
4. Should raw XBRL XML be archived?

## Decision

### 1. Partitioning — No

`regnskab_cache` uses CVR as primary key with all years inside a
single `years JSONB` column. Current row pattern is one-row-per-
company, fetched on-demand. Even at full Danish coverage (~9M
CVRs), cache stays lean because rows are only written when a user
looks up a company.

Partitioning threshold: **2M rows**. Below that the single-table
pattern wins on simplicity and index locality. Add a monitor on
`SELECT count(*) FROM regnskab_cache` → alert at 1.5M.

### 2. Retention — 5 years hot, on-demand re-fetch

Previous retention was 90 days (aggressive cache flush), set when
trend UI was not built. Now that the frontend shows up-to-5-year
charts, we extend:

- **Hot cache:** 5 years of financial history (years inside JSONB).
- **Cold tier:** none — if older data is needed, re-fetch from
  regnskabsvirk.dk on-demand (XBRL is permanent public record).
- **Purge policy:** `fetched_at < NOW() - interval '5 years'` in
  `/api/cron/purge-old-data/route.ts`.

This retention covers standard credit-analysis use cases without
unbounded storage growth. We never lose data — it's all in the
public XBRL archive.

### 3. Currency — DKK only

All Danish XBRL filings are in DKK (reported in tusinde DKK via
the `normaliserTilTDKK()` helper). EUR conversion is a
post-launch P4 feature if/when we expand to non-Danish filings or
international comparison reports.

Rationale: Denmark has no mandatory EUR reporting requirement.
Adding EUR now = premature complexity (historical rate lookup,
currency-of-record tagging, display-mode toggle).

### 4. Raw XBRL XML — Do not archive

Parsed `RegnskabsAar` JSON is sufficient for all product features.
Archiving raw XML adds GDPR risk (narrative notes may contain
personal data about directors, founders, auditors) without product
benefit.

- Raw XBRL is **fetched, parsed, and discarded** per request.
- Parser version (`v6`) is stored in the cache row so upgraded
  parsers can invalidate old cached data.
- The authoritative raw record lives at regnskabsvirk.dk; we
  never become the source of truth.

## Consequences

**Positive:**

- No GDPR retention conflict — we only store the structured fields
  our UI consumes.
- Unbounded archive of raw XML avoided.
- Simpler schema (one table, no partitioning, one currency).

**Negative:**

- Cross-currency reporting requires a future ADR.
- Audit trail for pre-parse state is not ours — relies on
  regnskabsvirk.dk availability. Acceptable because it's a
  government system with SLA.

**Follow-up work:**

- BIZZ-829 implementation: extend purge cron threshold to 5y.
- BIZZ-822 implementation: filter UI can rely on `years[*]` fields
  being populated for companies active in the last 5 years.
- Monitoring ticket: alert on `regnskab_cache` row-count > 1.5M.

## Rejected alternatives

- **Partitioning by year (PostgreSQL declarative partitioning):**
  Adds operational complexity without current scale justification.
  Revisit if row-count exceeds 2M.
- **EUR conversion layer:** Out of scope. Danish product, Danish
  data source, Danish currency.
- **Raw XBRL archive with 3-year retention + anonymization:**
  Rejected — the anonymization pipeline itself would be a GDPR
  risk surface, and the data is publicly retrievable by CVR.
