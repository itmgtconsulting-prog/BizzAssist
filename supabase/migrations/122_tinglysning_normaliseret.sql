-- ============================================================================
-- 122: Normaliserede tinglysning-tabeller — BIZZ-1456..1459
-- Adkomst (skøder/salgspriser), hæftelser (pant/lån), servitutter, dokumenter.
-- ============================================================================

-- ── 1. Adkomst (BIZZ-1456) ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tinglysning_adkomst (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  bfe_nummer      BIGINT      NOT NULL,
  -- Ejerskiftedata
  ejer_navn       TEXT,
  ejer_cvr        TEXT,
  ejer_type       TEXT,
  overtagelsesdato DATE,
  tinglysningsdato DATE,
  koebsaftale_dato DATE,
  -- Priser fra skøde
  kontant_koebesum BIGINT,
  i_alt_koebesum   BIGINT,
  -- Dokument-reference
  dokument_id     TEXT,
  -- Metadata
  kilde           TEXT        DEFAULT 'summarisk',
  fetched_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tl_adkomst_bfe ON public.tinglysning_adkomst (bfe_nummer);
CREATE INDEX IF NOT EXISTS idx_tl_adkomst_dato ON public.tinglysning_adkomst (overtagelsesdato);
CREATE INDEX IF NOT EXISTS idx_tl_adkomst_cvr ON public.tinglysning_adkomst (ejer_cvr) WHERE ejer_cvr IS NOT NULL;

ALTER TABLE public.tinglysning_adkomst ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tl_adkomst: service_role full" ON public.tinglysning_adkomst FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "tl_adkomst: authenticated read" ON public.tinglysning_adkomst FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.tinglysning_adkomst TO ai_query_reader;

COMMENT ON TABLE public.tinglysning_adkomst IS 'BIZZ-1456: Normaliserede adkomster/skøder fra Tinglysning summarisk XML.';

-- ── 2. Hæftelser (BIZZ-1457) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tinglysning_haeftelser (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  bfe_nummer      BIGINT      NOT NULL,
  -- Hæftelsesdata
  type            TEXT,
  kreditor_navn   TEXT,
  kreditor_cvr    TEXT,
  hovedstol       BIGINT,
  restgaeld       BIGINT,
  valuta          TEXT        DEFAULT 'DKK',
  rente_pct       NUMERIC(6,3),
  tinglysningsdato DATE,
  -- Dokument-reference
  dokument_id     TEXT,
  -- Metadata
  kilde           TEXT        DEFAULT 'summarisk',
  fetched_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tl_haeft_bfe ON public.tinglysning_haeftelser (bfe_nummer);
CREATE INDEX IF NOT EXISTS idx_tl_haeft_kreditor ON public.tinglysning_haeftelser (kreditor_cvr) WHERE kreditor_cvr IS NOT NULL;

ALTER TABLE public.tinglysning_haeftelser ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tl_haeft: service_role full" ON public.tinglysning_haeftelser FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "tl_haeft: authenticated read" ON public.tinglysning_haeftelser FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.tinglysning_haeftelser TO ai_query_reader;

COMMENT ON TABLE public.tinglysning_haeftelser IS 'BIZZ-1457: Normaliserede hæftelser/pantbreve fra Tinglysning.';

-- ── 3. Servitutter (BIZZ-1458) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tinglysning_servitutter (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  bfe_nummer      BIGINT      NOT NULL,
  -- Servitutdata
  type            TEXT,
  beskrivelse     TEXT,
  tinglysningsdato DATE,
  paategning      TEXT,
  -- Dokument-reference
  dokument_id     TEXT,
  -- Metadata
  kilde           TEXT        DEFAULT 'summarisk',
  fetched_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tl_servitut_bfe ON public.tinglysning_servitutter (bfe_nummer);

ALTER TABLE public.tinglysning_servitutter ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tl_serv: service_role full" ON public.tinglysning_servitutter FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "tl_serv: authenticated read" ON public.tinglysning_servitutter FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.tinglysning_servitutter TO ai_query_reader;

COMMENT ON TABLE public.tinglysning_servitutter IS 'BIZZ-1458: Normaliserede servitutter fra Tinglysning.';

-- ── 4. Dokumenter (BIZZ-1459) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tinglysning_dokumenter (
  dokument_id     TEXT        PRIMARY KEY,
  dokument_type   TEXT,
  tinglysningsdato DATE,
  bfe_nummer      BIGINT,
  parter          JSONB,
  beloeb          JSONB,
  -- Metadata
  kilde           TEXT        DEFAULT 'dokaktuel',
  fetched_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tl_dok_bfe ON public.tinglysning_dokumenter (bfe_nummer) WHERE bfe_nummer IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tl_dok_type ON public.tinglysning_dokumenter (dokument_type);

ALTER TABLE public.tinglysning_dokumenter ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tl_dok: service_role full" ON public.tinglysning_dokumenter FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "tl_dok: authenticated read" ON public.tinglysning_dokumenter FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.tinglysning_dokumenter TO ai_query_reader;

COMMENT ON TABLE public.tinglysning_dokumenter IS 'BIZZ-1459: Central dokumentreference for e-TL dokumenter.';
