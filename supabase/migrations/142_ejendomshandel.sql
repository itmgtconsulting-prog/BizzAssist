-- 142: ejendomshandel — BIZZ-1566 Backfill 4
--
-- Persistent historisk salgsdata pr. BFE. Populeres fra /api/salgshistorik
-- og salgshistorik_cache. Bruges af Data Intelligence metric-aggregeringer.

CREATE TABLE IF NOT EXISTS public.ejendomshandel (
  id                BIGSERIAL PRIMARY KEY,
  bfe_nummer        INTEGER NOT NULL,
  dato              DATE,                 -- overtagelsesdato eller koebsaftaledato
  kontant_koebesum  BIGINT,               -- DKK hele kroner
  samlet_koebesum   BIGINT,
  overdragelsesmaade TEXT,                 -- 'Frit salg', 'Arv', 'Gave', 'Tvangsauktion' etc.
  koeber_navne      TEXT[],
  koeber_cvrs       TEXT[],               -- GIN-indexeret for CVR-søgning
  saelger_navne     TEXT[],
  kilde             TEXT DEFAULT 'ejf',   -- 'ejf' | 'tinglysning' | 'ai'
  fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_handel_bfe ON public.ejendomshandel (bfe_nummer, dato DESC);
CREATE INDEX IF NOT EXISTS ix_handel_dato ON public.ejendomshandel (dato);
CREATE INDEX IF NOT EXISTS ix_handel_koeber_cvr ON public.ejendomshandel USING GIN (koeber_cvrs);

COMMENT ON TABLE public.ejendomshandel IS 'BIZZ-1566: Persistent ejendomshandel-historik. Populeres fra EJF + Tinglysning. Bruges af DI metrics.';

ALTER TABLE public.ejendomshandel ENABLE ROW LEVEL SECURITY;
