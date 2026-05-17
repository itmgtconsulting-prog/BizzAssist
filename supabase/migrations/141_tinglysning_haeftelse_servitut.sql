-- 141: tinglysning_haeftelse + tinglysning_servitut — BIZZ-1566 Backfill 2+3
--
-- Persistent cache for tinglysning hæftelser og servitutter.
-- Bruges af Data Intelligence metric-aggregeringer og Finansrapport.

-- ── Hæftelser ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tinglysning_haeftelse (
  id            BIGSERIAL PRIMARY KEY,
  bfe_nummer    INTEGER NOT NULL,
  dokument_uuid TEXT,
  type          TEXT,              -- 'Pantebrev', 'Ejerpantebrev', 'Realkreditpantebrev' etc.
  beloeb        BIGINT,            -- Hovedstol i DKK (hele kroner)
  valuta        TEXT DEFAULT 'DKK',
  kreditor_navn TEXT,
  kreditor_cvr  TEXT,
  debitor_navne TEXT[],            -- PII — RLS-beskyttet
  tinglyst_dato DATE,
  status        TEXT DEFAULT 'gældende', -- 'gældende' | 'aflyst' | 'udløbet'
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_haeftelse_bfe ON public.tinglysning_haeftelse (bfe_nummer);
CREATE INDEX IF NOT EXISTS ix_haeftelse_kreditor_cvr ON public.tinglysning_haeftelse (kreditor_cvr) WHERE kreditor_cvr IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_haeftelse_status ON public.tinglysning_haeftelse (status) WHERE status = 'gældende';

COMMENT ON TABLE public.tinglysning_haeftelse IS 'BIZZ-1566: Persistent tinglysning hæftelser — beloeb, kreditor, type pr. BFE. Delta-sync via cron.';

-- ── Servitutter ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tinglysning_servitut (
  id            BIGSERIAL PRIMARY KEY,
  bfe_nummer    INTEGER NOT NULL,
  dokument_uuid TEXT,
  type          TEXT,              -- 'Deklaration', 'Lokalplan', 'Vejservitut' etc.
  tekst         TEXT,              -- Kort beskrivelse / overskrift
  tinglyst_dato DATE,
  paataleberettiget TEXT,          -- Hvem kan påtale (kommune, grundejerforening etc.)
  status        TEXT DEFAULT 'gældende',
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_servitut_bfe ON public.tinglysning_servitut (bfe_nummer);
CREATE INDEX IF NOT EXISTS ix_servitut_status ON public.tinglysning_servitut (status) WHERE status = 'gældende';

COMMENT ON TABLE public.tinglysning_servitut IS 'BIZZ-1566: Persistent tinglysning servitutter pr. BFE. Delta-sync via cron.';

-- ── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.tinglysning_haeftelse ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tinglysning_servitut ENABLE ROW LEVEL SECURITY;
