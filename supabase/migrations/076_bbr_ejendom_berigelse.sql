-- ============================================================
-- BIZZ-828: Berigelse af bbr_ejendom_status med BBR-felter der
-- kræves af BIZZ-821 filter-phase-2 (Areal + Opførelsesår +
-- Energimærke + Anvendelse).
--
-- Udvider eksisterende bbr_ejendom_status-tabel (migration 069)
-- i stedet for at oprette ny tabel — alle felter har samme
-- nøgle (bfe_nummer) og lifecycle (live BBR-mirror, refreshes
-- via cron). Fields er nullable så partial-backfill ikke
-- blokerer filter-flow.
--
-- ETL-populering sker via scripts/backfill-bbr-ejendom.mjs
-- (manuel run) + fremtidig udvidelse af daily-BBR-cron.
-- Energimærke NULLes indtil EMO-integration ADR er truffet.
--
-- Retention: permanent (mirror af live BBR). Ingen PII.
-- ============================================================

ALTER TABLE public.bbr_ejendom_status
  ADD COLUMN IF NOT EXISTS samlet_boligareal     integer,
  ADD COLUMN IF NOT EXISTS samlet_erhvervsareal  integer,
  ADD COLUMN IF NOT EXISTS grundareal            integer,
  ADD COLUMN IF NOT EXISTS bebygget_areal        integer,
  ADD COLUMN IF NOT EXISTS opfoerelsesaar        smallint,
  ADD COLUMN IF NOT EXISTS ombygningsaar         smallint,
  -- BBR byg021-kode (120 Parcelhus, 130 Række/kæde/dobbelthus,
  -- 140 Etageejendom, 320 Erhverv handel osv.). Se
  -- app/lib/bbrKoder.ts for fuld kode-mapping.
  ADD COLUMN IF NOT EXISTS byg021_anvendelse     smallint,
  -- Energimærke fra EMO (Energistyrelsen). Nullable — integration
  -- er ADR-kandidat; filter i BIZZ-821 skjules via feature-flag
  -- hvis <50% coverage.
  ADD COLUMN IF NOT EXISTS energimaerke          text,
  ADD COLUMN IF NOT EXISTS energimaerke_dato     date,
  -- Hvornår berigelse-felterne sidst blev refreshet (adskilt fra
  -- status_last_checked_at så status-cron og berigelse-cron kan
  -- køre uafhængigt).
  ADD COLUMN IF NOT EXISTS berigelse_sidst       timestamptz;

-- Range-filter-indexer (partial — kun rows med data)
CREATE INDEX IF NOT EXISTS idx_bbr_boligareal
  ON public.bbr_ejendom_status (samlet_boligareal)
  WHERE samlet_boligareal IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bbr_erhvervsareal
  ON public.bbr_ejendom_status (samlet_erhvervsareal)
  WHERE samlet_erhvervsareal IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bbr_grundareal
  ON public.bbr_ejendom_status (grundareal)
  WHERE grundareal IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bbr_bebygget_areal
  ON public.bbr_ejendom_status (bebygget_areal)
  WHERE bebygget_areal IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bbr_opfoerelsesaar
  ON public.bbr_ejendom_status (opfoerelsesaar)
  WHERE opfoerelsesaar IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bbr_energimaerke
  ON public.bbr_ejendom_status (energimaerke)
  WHERE energimaerke IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bbr_anvendelse
  ON public.bbr_ejendom_status (byg021_anvendelse)
  WHERE byg021_anvendelse IS NOT NULL;

-- Composite index for typisk filter-kombo (areal + årstal)
CREATE INDEX IF NOT EXISTS idx_bbr_area_year
  ON public.bbr_ejendom_status (samlet_boligareal, opfoerelsesaar)
  WHERE samlet_boligareal IS NOT NULL;

COMMENT ON COLUMN public.bbr_ejendom_status.samlet_boligareal IS
  'BIZZ-828: Summen af byg039 BygningensSamledeBoligAreal for alle aktive bygninger på ejendommen.';
COMMENT ON COLUMN public.bbr_ejendom_status.samlet_erhvervsareal IS
  'BIZZ-828: Summen af byg040 BygningensSamledeErhvervsAreal for alle aktive bygninger.';
COMMENT ON COLUMN public.bbr_ejendom_status.grundareal IS
  'BIZZ-828: Summen af grd_areal for alle jordstykker knyttet til BFE (BBR_Grund).';
COMMENT ON COLUMN public.bbr_ejendom_status.bebygget_areal IS
  'BIZZ-828: Summen af byg041 BebyggetAreal for alle aktive bygninger.';
COMMENT ON COLUMN public.bbr_ejendom_status.opfoerelsesaar IS
  'BIZZ-828: Mindste (ældste) byg026 Opfoerelsesaar blandt aktive bygninger — repræsenterer hvornår ejendommen først blev bebygget.';
COMMENT ON COLUMN public.bbr_ejendom_status.ombygningsaar IS
  'BIZZ-828: Seneste byg027 OmTilbygningsaar blandt aktive bygninger.';
COMMENT ON COLUMN public.bbr_ejendom_status.byg021_anvendelse IS
  'BIZZ-828: Primær byg021 BygningensAnvendelse for ejendommen — størst areal-bygningens anvendelseskode.';
COMMENT ON COLUMN public.bbr_ejendom_status.energimaerke IS
  'BIZZ-828: Energimærke (A2020/A2015/A/B/C/D/E/F/G) fra EMO. NULL indtil EMO-integration er truffet (ADR).';
