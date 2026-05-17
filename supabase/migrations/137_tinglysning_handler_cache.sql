-- ============================================================================
-- 137: tinglysning_handler — cache af berigede handler fra Tinglysning (BIZZ-1550)
-- ============================================================================
-- Cache for berigede handler-rows fra Tinglysning summarisk. Salgshistorik
-- på ejendomssider læser cache først; trigger backfill når interface har
-- flere rows end cache eller cache er ældre end 14 dage.
--
-- Felter dækker hele tabel-visningen: dato + køber-info + pris-fordeling
-- (kontant/løsøre/entreprise) + tinglyst_dato + andel. Data er offentlig
-- (Tinglysning er public registry) → alle authenticated kan read.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.tinglysning_handler (
  bfe_nummer        BIGINT      NOT NULL,
  /** Handlens overtagelsesdato (ISO date) — sammen med bfe = primary key */
  overtagelsesdato  DATE        NOT NULL,
  /** Dokument-UUID fra Tinglysning — link til selve akten */
  dokument_id       TEXT,
  /** Hvornår handlen blev tinglyst (kan være senere end overtagelse) */
  tinglysningsdato  DATE,
  /** Køber-info — kan være person eller virksomhed */
  koeber_navn       TEXT,
  koeber_cvr        BIGINT,
  /** Adkomst-type fra Tinglysning ('Skoede', 'Arv', 'Gave', osv) */
  adkomst_type      TEXT,
  /** Hovedpris-felter — alle DKK heltal */
  kontant_koebesum  BIGINT,
  ialt_koebesum     BIGINT,
  /** Fordelte priselementer */
  loesoere          BIGINT,
  entreprise        BIGINT,
  tinglysningsafgift BIGINT,
  /** Ejer-andel (text format som "1/1", "1/2" etc) */
  andel             TEXT,
  /** Cache-metadata */
  sidst_opdateret   TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (bfe_nummer, overtagelsesdato)
);

CREATE INDEX IF NOT EXISTS idx_tl_handler_bfe
  ON public.tinglysning_handler (bfe_nummer, overtagelsesdato DESC);

CREATE INDEX IF NOT EXISTS idx_tl_handler_opdateret
  ON public.tinglysning_handler (sidst_opdateret);

CREATE INDEX IF NOT EXISTS idx_tl_handler_koeber_cvr
  ON public.tinglysning_handler (koeber_cvr)
  WHERE koeber_cvr IS NOT NULL;

ALTER TABLE public.tinglysning_handler ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tl_handler: service_role full" ON public.tinglysning_handler;
CREATE POLICY "tl_handler: service_role full"
  ON public.tinglysning_handler FOR ALL
  TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "tl_handler: authenticated read" ON public.tinglysning_handler;
CREATE POLICY "tl_handler: authenticated read"
  ON public.tinglysning_handler FOR SELECT
  TO authenticated USING (true);

COMMENT ON TABLE public.tinglysning_handler IS
  'BIZZ-1550: Cache af berigede handler fra Tinglysning summarisk. Cache-first lookup + interface-check + backfill-cron. Data er offentlig (Tinglysning public registry).';
