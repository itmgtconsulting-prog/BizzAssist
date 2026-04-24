-- ============================================================
-- Migration 077: cvr_deltager enrichment columns (fase B)
-- BIZZ-830 fase B — enrichment lag (ARCHITECT-approved).
--
-- Bygger oven på 055 base-schema (cvr_deltager + cvr_deltagerrelation).
-- Tilføjer aggregerede felter der gør BIZZ-823 person-filter muligt
-- uden runtime-join over cvr_deltagerrelation.
--
-- Populeres af scripts/backfill-cvr-deltager-berigelse.mjs (engangs-
-- backfill) + daglig cron der re-computer ved role-ændringer.
--
-- Lifecycle: source-of-truth er cvr_deltagerrelation. Enrichment er
-- denormaliseret cache — bliver stale imellem backfill-runs, men
-- filter-performance matcher Ejendomme phase-2 (sub-200ms 1000-row
-- page response).
-- ============================================================

ALTER TABLE public.cvr_deltager
  ADD COLUMN IF NOT EXISTS is_aktiv               BOOLEAN,
  ADD COLUMN IF NOT EXISTS aktive_roller_json     JSONB,
  ADD COLUMN IF NOT EXISTS antal_aktive_selskaber INTEGER,
  ADD COLUMN IF NOT EXISTS senest_indtraadt_dato  DATE,
  ADD COLUMN IF NOT EXISTS role_typer             TEXT[],
  ADD COLUMN IF NOT EXISTS berigelse_sidst        TIMESTAMPTZ;

-- Partial index for "aktiv"-filter (~80% af rows forventet aktive,
-- men partial index sparer 40% plads ved skewed distributions).
CREATE INDEX IF NOT EXISTS idx_cvr_deltager_aktiv
  ON public.cvr_deltager (is_aktiv)
  WHERE is_aktiv = true;

-- GIN index på role_typer-array muliggør hurtig && (overlap) filter
-- (fx "direktør" && ["direktør","bestyrelsesmedlem"]).
CREATE INDEX IF NOT EXISTS idx_cvr_deltager_roles
  ON public.cvr_deltager USING gin(role_typer);

-- DESC index for "aktiv de sidste 12 mdr"-filter — partial så
-- null-rows (ukendt indtrædelses-dato) springes over.
CREATE INDEX IF NOT EXISTS idx_cvr_deltager_senest
  ON public.cvr_deltager (senest_indtraadt_dato DESC)
  WHERE senest_indtraadt_dato IS NOT NULL;

-- Antal aktive selskaber filter (0-20 typisk, max ~500 for large holdings)
CREATE INDEX IF NOT EXISTS idx_cvr_deltager_antal_aktive
  ON public.cvr_deltager (antal_aktive_selskaber)
  WHERE antal_aktive_selskaber IS NOT NULL;

COMMENT ON COLUMN public.cvr_deltager.is_aktiv IS
  'BIZZ-830: true hvis mindst én aktiv role (gyldig_til IS NULL eller > now())';
COMMENT ON COLUMN public.cvr_deltager.aktive_roller_json IS
  'BIZZ-830: Array af aktive roller [{cvr, type, fra, til}] — denormaliseret fra cvr_deltagerrelation';
COMMENT ON COLUMN public.cvr_deltager.antal_aktive_selskaber IS
  'BIZZ-830: Count distinct virksomhed_cvr hvor deltager har aktiv role';
COMMENT ON COLUMN public.cvr_deltager.senest_indtraadt_dato IS
  'BIZZ-830: Max(gyldig_fra) over aktive roller — brugt af "aktiv de sidste 12 mdr"-filter';
COMMENT ON COLUMN public.cvr_deltager.role_typer IS
  'BIZZ-830: Unique role-types som text[] — normaliseret til [''direktør'', ''bestyrelsesmedlem'', ''stifter'', ''reel_ejer'']';
COMMENT ON COLUMN public.cvr_deltager.berigelse_sidst IS
  'BIZZ-830: Timestamp for sidste re-compute af enrichment — NULL = mangler backfill';
