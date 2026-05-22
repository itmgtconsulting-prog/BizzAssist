-- ============================================================================
-- 133: ejendomshandel — komplet handelshistorik per ejendom
-- BIZZ-1566 Backfill 4
--
-- Erstatter on-demand /api/salgshistorik med persistent tabel.
-- Bruges af DI v2 metrics og Finansrapport-modul.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ejendomshandel (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  bfe_nummer        INTEGER     NOT NULL,
  dato              DATE        NOT NULL,               -- Overtagelsesdato
  koebsaftale_dato  DATE,
  tinglyst_dato     DATE,
  type              TEXT,                                -- 'Fri handel' | 'Familieoverdragelse' | 'Tvangsauktion' | 'Arv' | 'Andet'
  andel_taeller     INTEGER,
  andel_naevner     INTEGER,
  koebesum          NUMERIC(14,2),                      -- Kontant købssum
  samlet_koebesum   NUMERIC(14,2),                      -- Inkl. løsøre/entreprise
  koeber_navne      TEXT[],                              -- Array hvis flere køber sammen
  koeber_cvrs       TEXT[],
  saelger_navne     TEXT[],
  saelger_cvrs      TEXT[],
  kilde             TEXT        NOT NULL,                -- 'ejf' | 'tinglysning-summarisk' | 'manual'
  sidst_opdateret   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_handel_bfe ON public.ejendomshandel(bfe_nummer, dato DESC);
CREATE INDEX IF NOT EXISTS ix_handel_dato ON public.ejendomshandel(dato);
CREATE INDEX IF NOT EXISTS ix_handel_koeber_cvr ON public.ejendomshandel USING GIN(koeber_cvrs);

COMMENT ON TABLE public.ejendomshandel IS 'Komplet ejendomshandel-historik per BFE. Koordinerer med BIZZ-1550 (salgshistorik-enrichment). BIZZ-1566.';
