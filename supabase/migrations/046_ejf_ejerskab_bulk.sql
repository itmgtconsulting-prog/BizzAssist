-- ============================================================================
-- 046_ejf_ejerskab_bulk.sql — BIZZ-534
-- ============================================================================
-- Bulk-ingestion-tabel for EJF (Ejendoms-Fortegnelsen) ejerskabs-data.
--
-- Baggrund: Live EJF-API'et (EJF_Ejerskab, EJF_PersonVirksomhedsoplys) kræver
-- speciel grant vi ikke har. EJFCustom_EjerskabBegraenset (vores nuværende
-- adgang) understøtter kun BFE/CVR-filter, ikke person-lookup. Datafordeler
-- udstiller dog hele EJF som offentlige bulk-data uden grant. Denne tabel
-- ingesterer dump'en dagligt så vi kan svare deterministisk på "hvilke
-- ejendomme ejer person X?" via SQL.
--
-- Index-strategi:
--   - ix_ejf_person_lookup: primær person→ejendomme query (navn lowercased)
--   - ix_ejf_bfe: BFE→ejere reverse-lookup
--   - ix_ejf_cvr: CVR→ejendomme for virksomheds-ejerskab
--
-- GDPR: Tabel indeholder fødselsdato (kategoriseret som almindelig persondata
-- ifm. ejendomshandel — ikke følsom). Persondata stammer fra offentlige
-- registre (EJF) og er allerede tilgængelige via tinglysning.dk + ois.dk.
-- Vores aggregering for hurtig lookup ændrer ikke datakvaliteten.
-- Retention: opdateres dagligt; gamle rækker overskrives via UPSERT på
-- (bfe_nummer, ejer_ejf_id, virkning_fra). Historik bevares via virkning_til.
-- ============================================================================

create table if not exists public.ejf_ejerskab (
  -- Identity (composite PK)
  bfe_nummer        bigint        not null,
  ejer_ejf_id       uuid          not null,  -- ejendePersonBegraenset.id fra EJF
  virkning_fra      timestamptz   not null,

  -- Ejer-info
  ejer_navn         text          not null,
  ejer_foedselsdato date,                    -- null for virksomheder
  ejer_cvr          text,                    -- null for personer
  ejer_type         text          not null
    check (ejer_type in ('person', 'virksomhed')),

  -- Ejerandel (typisk taeller/naevner-format fra EJF)
  ejerandel_taeller integer,
  ejerandel_naevner integer,

  -- Status og bitemporale felter
  status            text          not null
    check (status in ('gældende', 'historisk')),
  virkning_til      timestamptz,

  -- Metadata
  sidst_opdateret   timestamptz   not null default now(),

  primary key (bfe_nummer, ejer_ejf_id, virkning_fra)
);

comment on table public.ejf_ejerskab is
  'BIZZ-534: Bulk-indekseret EJF ejerskabs-data for hurtig person→ejendomme lookup. '
  'Opdateres dagligt via cron /api/cron/ingest-ejf-bulk. Erstatter live EJF-API-kald '
  'der kræver grant.';

-- ─── Index: Primær person-lookup ────────────────────────────────────────────
-- Bruges af /api/ejerskab/person-properties?navn=X&fdato=Y
create index if not exists ix_ejf_person_lookup
  on public.ejf_ejerskab (lower(ejer_navn), ejer_foedselsdato)
  where ejer_type = 'person' and status = 'gældende';

-- ─── Index: BFE → ejere reverse-lookup ──────────────────────────────────────
create index if not exists ix_ejf_bfe
  on public.ejf_ejerskab (bfe_nummer)
  where status = 'gældende';

-- ─── Index: CVR → ejendomme ──────────────────────────────────────────────
create index if not exists ix_ejf_cvr
  on public.ejf_ejerskab (ejer_cvr)
  where ejer_cvr is not null and status = 'gældende';

-- ─── RLS ────────────────────────────────────────────────────────────────────
-- Tabellen indeholder kun offentlige EJF-data og kan læses af alle
-- authenticated brugere. Skrivning er kun for service_role (cron).
alter table public.ejf_ejerskab enable row level security;

create policy ejf_ejerskab_read_authenticated
  on public.ejf_ejerskab
  for select
  to authenticated
  using (true);

create policy ejf_ejerskab_write_service_only
  on public.ejf_ejerskab
  for all
  to service_role
  using (true)
  with check (true);

-- ─── Statistik-tabel for cron-runs ──────────────────────────────────────────
create table if not exists public.ejf_ingest_runs (
  id              bigserial primary key,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  rows_processed  bigint,
  rows_inserted   bigint,
  rows_updated    bigint,
  rows_failed     bigint,
  error           text
);

comment on table public.ejf_ingest_runs is
  'BIZZ-534: Audit log for daglige EJF bulk-ingest cron-runs.';

alter table public.ejf_ingest_runs enable row level security;

-- Kun service_role kan læse/skrive ingest-logs (admin-only data)
create policy ejf_ingest_runs_service_only
  on public.ejf_ingest_runs
  for all
  to service_role
  using (true)
  with check (true);
