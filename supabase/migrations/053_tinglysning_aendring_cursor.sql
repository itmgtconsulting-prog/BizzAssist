-- ============================================================
-- Migration 053: tinglysning_aendring_cursor singleton tracking
-- BIZZ-650: Tinglysning delta-sync cron tracker last window per run
--
-- Singleton-tabel (PK = constant 'default') der holder state om den
-- daglige Tinglysning aendringer delta-sync. Mønsteret er kopieret fra
-- public.bbr_event_cursor (BIZZ-489 / migration 040).
--
-- Kolonner:
--   last_run_at          seneste successfulde run-tid
--   last_from_date       datoFra parameter brugt i seneste run (5 dage før run-tid)
--   last_to_date         datoTil parameter brugt i seneste run (run-tid selv)
--   rows_processed       antal ejf_ejerskab-rows upserted i seneste run
--   bfes_processed       antal unique BFE'er hentet EJFCustom for
--   error                seneste fejlmeddelelse hvis run fejlede (else null)
--   updated_at           auto-timestamp
-- ============================================================

CREATE TABLE IF NOT EXISTS public.tinglysning_aendring_cursor (
  id              TEXT        PRIMARY KEY DEFAULT 'default'
                              CHECK (id = 'default'),
  last_run_at     TIMESTAMPTZ,
  last_from_date  TIMESTAMPTZ,
  last_to_date    TIMESTAMPTZ,
  rows_processed  INTEGER     NOT NULL DEFAULT 0,
  bfes_processed  INTEGER     NOT NULL DEFAULT 0,
  error           TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed singleton row så cronen altid kan læse/opdatere uden at skulle
-- tjekke om den findes. id = 'default' er constant (check constraint).
INSERT INTO public.tinglysning_aendring_cursor (id)
VALUES ('default')
ON CONFLICT (id) DO NOTHING;

-- RLS: kun service_role bruger (cron + admin). Ingen policies = service_role
-- bypasser via bypass_rls, øvrige får 0 adgang.
ALTER TABLE public.tinglysning_aendring_cursor ENABLE ROW LEVEL SECURITY;
