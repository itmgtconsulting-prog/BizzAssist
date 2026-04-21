-- ============================================================
-- Migration 054: cvr_virksomhed bulk-cache
-- BIZZ-651: Lokal kopi af Erhvervsstyrelsens CVR-indeks for at fjerne
-- 300-600ms latency fra live ES-opslag hver gang en bruger åbner en
-- virksomhedsside. Opdateres via daglig delta-cron med sidstOpdateret
-- som range-filter.
--
-- Samme pattern som public.ejf_ejerskab (migration 046) og daglig
-- Tinglysning-delta (migration 053).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.cvr_virksomhed (
  cvr                 TEXT        PRIMARY KEY,
  samt_id             BIGINT,
  navn                TEXT        NOT NULL,
  status              TEXT,
  branche_kode        TEXT,
  branche_tekst       TEXT,
  virksomhedsform     TEXT,
  stiftet             DATE,
  ophoert             DATE,
  -- Beskæftigelse-felter fra virksomhedMetadata.nyesteAarsbeskaeftigelse +
  -- nyesteKvartalsbeskaeftigelse. null hvis virksomheden ikke har rapporteret.
  ansatte_aar         INTEGER,
  ansatte_kvartal_1   INTEGER,
  ansatte_kvartal_2   INTEGER,
  ansatte_kvartal_3   INTEGER,
  ansatte_kvartal_4   INTEGER,
  -- Fuld beliggenhedsadresse som JSON så UI kan rendere conavn, etage, dør etc.
  adresse_json        JSONB,
  -- CVR-tidsstempler der bruges som delta-nøgle
  sidst_opdateret     TIMESTAMPTZ,
  sidst_indlaest      TIMESTAMPTZ,
  -- Intern: hvornår hentede BizzAssist denne record senest fra CVR ES
  sidst_hentet_fra_cvr TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Primær delta-index — bruges af monitoring + freshness-queries
CREATE INDEX IF NOT EXISTS cvr_virksomhed_status_opdateret_idx
  ON public.cvr_virksomhed (status, sidst_opdateret DESC);

-- CVR-nummer alene (lookup via numerisk-partial er hyppigt) — dækket af PK

-- Navn-søgning via Postgres full-text search (dansk config)
CREATE INDEX IF NOT EXISTS cvr_virksomhed_navn_tsv_idx
  ON public.cvr_virksomhed USING gin(to_tsvector('danish', navn));

-- Branche-kode lookup (branche-analyse)
CREATE INDEX IF NOT EXISTS cvr_virksomhed_branche_idx
  ON public.cvr_virksomhed (branche_kode) WHERE branche_kode IS NOT NULL;

-- RLS: kun service_role bruger (cron + admin). Ingen policies → bypass via
-- service_role, øvrige får 0 adgang. CVR-data er offentligt, men vi serverer
-- det via vores API-lag med rate-limit + caching.
ALTER TABLE public.cvr_virksomhed ENABLE ROW LEVEL SECURITY;
