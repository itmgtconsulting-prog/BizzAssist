-- 143: holding_path pre-computed graph — BIZZ-1566 Backfill 7
--
-- Pre-computed ejerskabsstier: person → holding → ... → ejendom.
-- Beregnes via recursive CTE — for tung til ad-hoc queries.
-- Refreshes ugentligt via cron.

CREATE TABLE IF NOT EXISTS public.holding_path (
  id              BIGSERIAL PRIMARY KEY,
  person_enhedsnummer BIGINT NOT NULL,
  bfe_nummer      INTEGER NOT NULL,
  depth           INTEGER NOT NULL,       -- antal holding-led mellem person og ejendom
  path_cvrs       TEXT[] NOT NULL,         -- CVR-numre i kæden (person → holding1 → ... → ejendom-ejer)
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_holding_path_bfe ON public.holding_path (bfe_nummer);
CREATE INDEX IF NOT EXISTS ix_holding_path_person ON public.holding_path (person_enhedsnummer);
CREATE INDEX IF NOT EXISTS ix_holding_path_depth ON public.holding_path (depth);

COMMENT ON TABLE public.holding_path IS 'BIZZ-1566: Pre-computed person→ejendom holding-stier. Refreshes ugentligt. Bruges af DI avg_holding_depth metric.';

ALTER TABLE public.holding_path ENABLE ROW LEVEL SECURITY;
