-- ============================================================================
-- 117: Ejerskifte historik — salgspris-database (BIZZ-1454)
-- ============================================================================
-- Kombiner ejf_ejerskab ejerskifter med Tinglysning købesummer.
-- Populeres via cron /api/cron/backfill-ejerskifte-historik.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ejerskifte_historik (
  id                  BIGSERIAL   PRIMARY KEY,
  bfe_nummer          BIGINT      NOT NULL,
  -- Ejerskifte-tidspunkt fra EJF
  overtagelsesdato    DATE,
  fratraedelsesdato   DATE,
  -- Ejer-info
  ejer_navn           TEXT,
  ejer_cvr            TEXT,
  ejer_type           TEXT        CHECK (ejer_type IN ('person', 'virksomhed')),
  ejerandel_taeller   INTEGER,
  ejerandel_naevner   INTEGER,
  -- Tinglysning købesum (berigelse)
  kontant_koebesum    BIGINT,
  i_alt_koebesum      BIGINT,
  koebsaftale_dato    DATE,
  dokument_id         TEXT,
  -- Kommune + type for AI-queries
  kommune_kode        SMALLINT,
  byg021_anvendelse   SMALLINT,
  -- Metadata
  kilde               TEXT        DEFAULT 'ejf+tinglysning',
  created_at          TIMESTAMPTZ DEFAULT now(),
  UNIQUE (bfe_nummer, overtagelsesdato, ejer_navn)
);

-- Indeks for AI-queries
CREATE INDEX IF NOT EXISTS idx_ejerskifte_hist_bfe ON public.ejerskifte_historik (bfe_nummer);
CREATE INDEX IF NOT EXISTS idx_ejerskifte_hist_dato ON public.ejerskifte_historik (overtagelsesdato);
CREATE INDEX IF NOT EXISTS idx_ejerskifte_hist_kommune ON public.ejerskifte_historik (kommune_kode);
CREATE INDEX IF NOT EXISTS idx_ejerskifte_hist_koebesum ON public.ejerskifte_historik (kontant_koebesum)
  WHERE kontant_koebesum IS NOT NULL;

-- RLS
ALTER TABLE public.ejerskifte_historik ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ejerskifte_historik: service_role full"
  ON public.ejerskifte_historik FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "ejerskifte_historik: authenticated read"
  ON public.ejerskifte_historik FOR SELECT
  TO authenticated USING (true);

-- Giv ai_query_reader leseadgang
GRANT SELECT ON public.ejerskifte_historik TO ai_query_reader;

COMMENT ON TABLE public.ejerskifte_historik IS 'BIZZ-1454: Ejerskifte-historik med Tinglysning koebessummer. Populeres via cron.';
COMMENT ON COLUMN public.ejerskifte_historik.kontant_koebesum IS 'KontantKoebesum fra Tinglysning adkomst-summarisk (DKK)';
COMMENT ON COLUMN public.ejerskifte_historik.i_alt_koebesum IS 'IAltKoebesum fra Tinglysning (DKK) — fallback naar kontant er NULL';
