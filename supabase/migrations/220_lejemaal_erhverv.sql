-- Migration 220: Erhvervslejemål-backend — observationer + område-aggregater (BIZZ-2306)
--
-- Baggrund: Gap-analysen mod Resights viste at BizzAssist mangler et
-- udlejnings-/lejemålsmodul (udbudte erhvervslejemål + lejeniveauer over tid).
-- ADR 0013 fastlægger designet: produktet eksponerer KUN område-aggregater
-- (gennemsnit/median pr. m²/år) — ALDRIG det enkelte lejemål, og UDEN
-- sporbarhed tilbage til kilden.
--
-- VIGTIGT — ingen indsamling endnu: Denne migration bygger kun datamodellen
-- og aggregerings-logikken (røret). Selve ind­samlingen fra portaler (scraping/
-- API) er BLOKERET indtil Fase 0 (juridisk godkendelse) er afsluttet, jf.
-- ADR 0013. Tabellerne kan derfor stå tomme indtil en godkendt kilde findes.
--
-- To tabeller med bevidst forskellig eksponering:
--   1) lejemaal_observation (INTERN, aldrig eksponeret): én række pr. observeret
--      udbud. Indeholder PER DESIGN ingen kilde-id, URL eller fuld adresse —
--      kun afledte felter (postnr, kommune, erhvervstype, areal-bucket,
--      leje kr/m²/år) + first_seen/last_seen til liggetid. dedup_hash gør
--      ugentlig gen-observation idempotent.
--   2) lejemaal_omraade_statistik (EKSPONERET): aggregat pr.
--      kommune/postnr/erhvervstype/periode. Genberegnes fra observationerne.
--      Re-identifikations-værn: en gruppe vises KUN hvis antal_udbud >= k (k=5),
--      så et aggregat aldrig kan afsløre et enkelt lejemål.
--
-- Isolation: dette er delt markedsdata (ikke tenant-scoped) — samme tal for
-- alle tenants. RLS er slået til og nægter al adgang for almindelige roller;
-- kun service_role (admin-klienten) læser/skriver, og læse-API'et scoper
-- adgang via auth før det rammer tabellen. Ingen person-PII gemmes (erhverv).
--
-- Retention: observationer 36 måneder (tidsserien ER moaten); aggregater
-- bevares. Ryddes sammen med øvrige data af purge-cron når kilde er aktiv.

-- ── 1) Intern observations-tabel (aldrig eksponeret) ──────────────────────
create table if not exists public.lejemaal_observation (
  id              uuid        primary key default gen_random_uuid(),
  postnr          integer     not null,
  kommune         text        not null,
  erhvervstype    text        not null,
  areal_bucket    text        not null,
  leje_kr_m2_aar  numeric(10,2) not null check (leje_kr_m2_aar > 0),
  first_seen      date        not null,
  last_seen       date        not null,
  dedup_hash      text        not null unique,
  created_at      timestamptz not null default now()
);

comment on table public.lejemaal_observation is
  'INTERN: observerede udbudte erhvervslejemål (afledte felter, ingen kilde/adresse/PII). Aldrig eksponeret. Kun grundlag for aggregater. BIZZ-2306 / ADR 0013.';
comment on column public.lejemaal_observation.dedup_hash is
  'Stabil hash af de normaliserede felter — gør ugentlig gen-observation idempotent (upsert on conflict).';

-- Aggregerings-opslag: gruppér hurtigt på område + type.
create index if not exists lejemaal_observation_omraade_idx
  on public.lejemaal_observation (kommune, postnr, erhvervstype, last_seen);

-- ── 2) Eksponeret område-aggregat ─────────────────────────────────────────
create table if not exists public.lejemaal_omraade_statistik (
  kommune               text    not null,
  postnr                integer not null,
  erhvervstype          text    not null,
  periode               date    not null,
  antal_udbud           integer not null check (antal_udbud >= 5),
  median_kr_m2_aar      numeric(10,2),
  p25_kr_m2_aar         numeric(10,2),
  p75_kr_m2_aar         numeric(10,2),
  median_liggetid_dage  integer,
  opdateret             timestamptz not null default now(),
  primary key (kommune, postnr, erhvervstype, periode)
);

comment on table public.lejemaal_omraade_statistik is
  'EKSPONERET: område-aggregater for erhvervslejeniveauer. Kun grupper med antal_udbud >= 5 (re-identifikations-værn, jf. ADR 0013). Ingen sporbarhed til enkelt-lejemål.';

-- ── 3) Genberegning: observationer → aggregater (k>=5 værn) ────────────────
-- Kaldes af aggregerings-jobbet efter ingest. security definer så service_role
-- kan køre den; min_antal default 5 håndhæver re-identifikations-værnet.
create or replace function public.recompute_lejemaal_statistik(min_antal integer default 5)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  -- Fuld genberegning: aggregaterne er rene afledninger af observationerne.
  delete from public.lejemaal_omraade_statistik;

  insert into public.lejemaal_omraade_statistik (
    kommune, postnr, erhvervstype, periode, antal_udbud,
    median_kr_m2_aar, p25_kr_m2_aar, p75_kr_m2_aar, median_liggetid_dage
  )
  select
    kommune,
    postnr,
    erhvervstype,
    date_trunc('month', last_seen)::date as periode,
    count(*)::integer                     as antal_udbud,
    round(percentile_cont(0.5)  within group (order by leje_kr_m2_aar)::numeric, 2),
    round(percentile_cont(0.25) within group (order by leje_kr_m2_aar)::numeric, 2),
    round(percentile_cont(0.75) within group (order by leje_kr_m2_aar)::numeric, 2),
    round(percentile_cont(0.5)  within group (order by (last_seen - first_seen)))::integer
  from public.lejemaal_observation
  group by kommune, postnr, erhvervstype, date_trunc('month', last_seen)
  having count(*) >= min_antal;   -- re-identifikations-værn: drop små grupper

  get diagnostics n = row_count;
  return n;
end;
$$;

comment on function public.recompute_lejemaal_statistik(integer) is
  'Genberegner lejemaal_omraade_statistik fra lejemaal_observation. Dropper grupper med < min_antal (default 5) udbud — re-identifikations-værn. BIZZ-2306.';

-- ── 4) RLS: nægt alt for almindelige roller; service_role bypasser ─────────
alter table public.lejemaal_observation       enable row level security;
alter table public.lejemaal_omraade_statistik enable row level security;

revoke all on public.lejemaal_observation       from anon, authenticated;
revoke all on public.lejemaal_omraade_statistik from anon, authenticated;

-- Funktionen må kun køres af service_role (admin-klienten), ikke af brugere.
revoke all on function public.recompute_lejemaal_statistik(integer) from anon, authenticated;
