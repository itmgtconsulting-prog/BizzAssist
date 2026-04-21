-- ============================================================
-- Migration 056: cvr_aendring_cursor singleton tracking
-- BIZZ-651: Daglig CVR delta-sync cron tracker last window per run.
-- Mønster kopieret fra public.tinglysning_aendring_cursor (migration 053).
--
-- NOTE: Migration 055 (cvr_deltager + cvr_deltagerrelation) er reserveret
-- til separat iteration når deltager-ingestion bygges. 056 er nummereret
-- forud så rækkefølgen er stabil.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.cvr_aendring_cursor (
  id                      TEXT        PRIMARY KEY DEFAULT 'default'
                                      CHECK (id = 'default'),
  last_run_at             TIMESTAMPTZ,
  last_from_date          TIMESTAMPTZ,
  last_to_date            TIMESTAMPTZ,
  rows_processed          INTEGER     NOT NULL DEFAULT 0,
  virksomheder_processed  INTEGER     NOT NULL DEFAULT 0,
  error                   TEXT,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.cvr_aendring_cursor (id)
VALUES ('default')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.cvr_aendring_cursor ENABLE ROW LEVEL SECURITY;
