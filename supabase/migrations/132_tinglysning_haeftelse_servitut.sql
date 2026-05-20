-- ============================================================================
-- 132: tinglysning_haeftelse + tinglysning_dokument + tinglysning_servitut
-- BIZZ-1566 Backfill 2+3
--
-- Persistent cache af hæftelser og servitutter fra Tinglysningsretten.
-- Erstatter live-fetching for DI v2 metrics (sum_pant_beloeb, count_pantebreve,
-- count_servitutter_per_ejendom).
-- ============================================================================

-- PDF-blobs metadata (Supabase Storage bucket 'tinglysning-akter')
CREATE TABLE IF NOT EXISTS public.tinglysning_dokument (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  akt_navn        TEXT        UNIQUE NOT NULL,         -- '17.04.2020-1011792115'
  storage_path    TEXT        NOT NULL,                 -- 'akter/2020/04/17/1011792115.pdf'
  dokument_type   TEXT,                                 -- 'realkreditpantebrev' | 'ejerpantebrev' | 'aktuelt-tinglyst'
  fetched_at      TIMESTAMPTZ DEFAULT now(),
  size_bytes      INTEGER,
  page_count      INTEGER
);

COMMENT ON TABLE public.tinglysning_dokument IS 'Metadata for tinglysning PDF-akter i Supabase Storage. BIZZ-1566.';

-- Hæftelser (pant) per ejendom
CREATE TABLE IF NOT EXISTS public.tinglysning_haeftelse (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  bfe_nummer      INTEGER     NOT NULL,
  prioritet       INTEGER     NOT NULL,                 -- Prioritets-nummer
  kreditor_navn   TEXT,
  kreditor_cvr    TEXT,
  debitor_navne   TEXT[],                               -- Array af debitor-navne
  type            TEXT        NOT NULL,                  -- 'Realkreditpantebrev' | 'Ejerpantebrev' | 'Anden' osv.
  hovedstol_dkk   NUMERIC(14,2),
  tinglyst_dato   DATE,
  status          TEXT        NOT NULL,                  -- 'gældende' | 'aflyst' | 'reduceret'
  akt_navn        TEXT,                                  -- Fx '17.04.2020-1011792115'
  dokument_id     UUID        REFERENCES public.tinglysning_dokument(id),
  sidst_opdateret TIMESTAMPTZ DEFAULT now(),
  UNIQUE(bfe_nummer, prioritet, status)
);

CREATE INDEX IF NOT EXISTS ix_haeftelse_bfe ON public.tinglysning_haeftelse(bfe_nummer);
CREATE INDEX IF NOT EXISTS ix_haeftelse_kreditor_cvr ON public.tinglysning_haeftelse(kreditor_cvr);
CREATE INDEX IF NOT EXISTS ix_haeftelse_status ON public.tinglysning_haeftelse(status) WHERE status = 'gældende';

COMMENT ON TABLE public.tinglysning_haeftelse IS 'Persistent cache af tinglysning-hæftelser per BFE. Bruges af DI v2 metrics. BIZZ-1566.';

-- Servitutter per ejendom
CREATE TABLE IF NOT EXISTS public.tinglysning_servitut (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  bfe_nummer      INTEGER     NOT NULL,
  prioritet       INTEGER,
  tekst           TEXT        NOT NULL,                  -- Servitut-titel
  type            TEXT,                                  -- 'Anden servitut' | 'Vej' | 'Byggelinje' osv.
  tinglyst_dato   DATE,
  akt_navn        TEXT,
  dokument_id     UUID        REFERENCES public.tinglysning_dokument(id),
  paataleberettiget TEXT,                                -- Hvem kan håndhæve
  ai_classification TEXT,                                -- 'neutral' | 'vaerdireducerende' | 'kraever_valuar' (BIZZ-1557)
  ai_classification_at TIMESTAMPTZ,
  sidst_opdateret TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_servitut_bfe ON public.tinglysning_servitut(bfe_nummer);

COMMENT ON TABLE public.tinglysning_servitut IS 'Persistent cache af tinglysning-servitutter per BFE. Bruges af DI v2 metrics. BIZZ-1566.';
