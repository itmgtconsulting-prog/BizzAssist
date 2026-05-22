-- ============================================================================
-- 149_bfe_adresse_cache.sql — BIZZ-1670
-- ============================================================================
-- Cache-tabel for BFE → adresse mapping. Løser problemet med ældre
-- ejerlejligheder hvor DAWA /bfe/{bfe} returnerer 404 men adressen
-- eksisterer i DAWA /adresser. Populeres via backfill fra EJF/TL.
--
-- Bruges som fallback i /api/ejendomme-by-owner når DAWA+VP+BBR fejler.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.bfe_adresse_cache (
  bfe_nummer        bigint        PRIMARY KEY,
  adresse           text,          -- "Torvegade 3B" (vejnavn + husnr)
  etage             text,          -- "3" / "st" / null
  doer              text,          -- "1" / "tv" / null
  postnr            text,          -- "3000"
  postnrnavn        text,          -- "Helsingør"
  kommune           text,          -- "Helsingør"
  kommune_kode      text,          -- "0217"
  dawa_id           text,          -- DAWA adresse/adgangsadresse UUID
  ejendomstype      text,          -- "Ejerlejlighed" / "Normal ejendom"
  kilde             text           NOT NULL DEFAULT 'manual',  -- 'ejf_backfill' / 'tl' / 'manual'
  sidst_opdateret   timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_bfe_adresse_cache_dawa ON public.bfe_adresse_cache (dawa_id)
  WHERE dawa_id IS NOT NULL;

ALTER TABLE public.bfe_adresse_cache ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'bfe_adresse_cache' AND policyname = 'bfe_adresse_cache: authenticated read'
  ) THEN
    CREATE POLICY "bfe_adresse_cache: authenticated read"
      ON public.bfe_adresse_cache FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'bfe_adresse_cache' AND policyname = 'bfe_adresse_cache: service role all'
  ) THEN
    CREATE POLICY "bfe_adresse_cache: service role all"
      ON public.bfe_adresse_cache FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END;
$$;

COMMENT ON TABLE public.bfe_adresse_cache IS
  'BIZZ-1670: BFE→adresse cache for ejendomme DAWA /bfe ikke kender';
