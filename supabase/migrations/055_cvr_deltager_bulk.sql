-- ============================================================
-- Migration 055: cvr_deltager + cvr_deltagerrelation bulk-cache
-- BIZZ-830 fase A — BASE schema (ARCHITECT-approved 2026-04-24).
--
-- Lokal kopi af Erhvervsstyrelsens deltager-register
-- (/cvr-permanent/deltager/_search). Keyed på enhedsNummer
-- (CVR ES surrogate ID). CPR gemmes ALDRIG — GDPR art. 9 +
-- persondataforordningen.
--
-- Relation mellem deltager og virksomhed er separat tabel så vi
-- kan filtrere direkte på type + aktiv-status uden JSONB-unnest.
--
-- Enrichment-kolonner (is_aktiv, aktive_roller_json osv.) kommer
-- i migration 077 (BIZZ-830 fase B). Denne migration er
-- minimale stamdata kun.
--
-- ADR: docs/adr/0007-cvr-deltager-schema.md
-- ============================================================

-- ---- Stamdata om personen ------------------------------------

CREATE TABLE IF NOT EXISTS public.cvr_deltager (
  enhedsNummer         BIGINT      PRIMARY KEY,
  -- Navn som det står i CVR — UTF-8, fulde navn inkl. mellemnavne
  navn                 TEXT        NOT NULL,
  -- Fuld beliggenhedsadresse som JSON (fritekst, conavn, postnr, etage osv.)
  adresse_json         JSONB,
  -- Roller som CVR ES embedded-reporter dem i deltager-record.
  -- Denormaliseret kopi — source-of-truth er cvr_deltagerrelation.
  -- Gem her som optimering for UI-rendering.
  roller_json          JSONB,
  -- CVR-tidsstempler brugt som delta-nøgle
  sidst_opdateret      TIMESTAMPTZ,
  sidst_indlaest       TIMESTAMPTZ,
  -- Intern: hvornår BizzAssist senest hentede denne record
  sidst_hentet_fra_cvr TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Delta-sync index (bruges af daily cron + monitoring)
CREATE INDEX IF NOT EXISTS cvr_deltager_sidst_opdateret_idx
  ON public.cvr_deltager (sidst_opdateret DESC);

-- Navn-søgning (dansk tsvector) — bruges af person-autocomplete
CREATE INDEX IF NOT EXISTS cvr_deltager_navn_tsv_idx
  ON public.cvr_deltager USING gin(to_tsvector('danish', navn));

-- ---- Relationer: deltager ↔ virksomhed -----------------------

CREATE TABLE IF NOT EXISTS public.cvr_deltagerrelation (
  virksomhed_cvr         TEXT        NOT NULL,
  deltager_enhedsNummer  BIGINT      NOT NULL,
  -- Rolle-type: direktør, bestyrelsesmedlem, stifter, reel_ejer, ejer
  -- Fritekst fordi CVR rapporterer mange varianter (suppleant, formand etc.).
  -- UI normaliserer via role_typer[] enum i enrichment-laget.
  type                   TEXT        NOT NULL,
  gyldig_fra             DATE,
  gyldig_til             DATE,
  sidst_opdateret        TIMESTAMPTZ,
  sidst_hentet_fra_cvr   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (virksomhed_cvr, deltager_enhedsNummer, type, gyldig_fra)
);

-- "Hvem er deltager i dette firma" — slaget op pr. CVR
CREATE INDEX IF NOT EXISTS cvr_deltagerrelation_cvr_idx
  ON public.cvr_deltagerrelation (virksomhed_cvr);

-- "Hvilke firmaer er denne person i" — slaget op pr. person
CREATE INDEX IF NOT EXISTS cvr_deltagerrelation_deltager_idx
  ON public.cvr_deltagerrelation (deltager_enhedsNummer);

-- Aktive roller filter (gyldig_til IS NULL = stadig aktiv)
CREATE INDEX IF NOT EXISTS cvr_deltagerrelation_aktiv_idx
  ON public.cvr_deltagerrelation (type, gyldig_til)
  WHERE gyldig_til IS NULL;

-- ---- RLS: service_role only (som cvr_virksomhed 054) ---------
-- Ingen policies → ikke-service_role får 0 rows. Alle
-- user-facing reads går gennem API-laget med rate-limiting +
-- billing-gates + audit-log.

ALTER TABLE public.cvr_deltager ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cvr_deltagerrelation ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.cvr_deltager IS
  'BIZZ-830 fase A: Erhvervsstyrelsen deltager-stamdata. PK=enhedsNummer. CPR gemmes ALDRIG (GDPR). Kilde: /cvr-permanent/deltager/_search.';
COMMENT ON TABLE public.cvr_deltagerrelation IS
  'BIZZ-830 fase A: Deltager↔virksomhed relation med type+gyldighedsperiode. Source-of-truth for person-filtrering.';
