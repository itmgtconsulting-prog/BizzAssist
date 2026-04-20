-- ============================================================
-- Migration 052: Service probe history for infra_down detection
-- BIZZ-623 Trigger 2: logger hver probe-kørsel så service-scan kan
-- detektere 2 konsekutive down-states og udløse infra_down scan.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.service_probe_history (
  id              BIGSERIAL PRIMARY KEY,
  service_id      TEXT NOT NULL,
  probed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_down         BOOLEAN NOT NULL,
  http_status     INTEGER,
  detail          TEXT
);

-- Indeks for "seneste N pr. service_id" query (core use case)
CREATE INDEX IF NOT EXISTS ix_service_probe_history_service_time
  ON public.service_probe_history (service_id, probed_at DESC);

-- GDPR / house-keeping: vi behøver ikke holde probe-historik længere end
-- 30 dage — ældre rækker kan purges af cron/purge-old-data.
CREATE INDEX IF NOT EXISTS ix_service_probe_history_probed_at
  ON public.service_probe_history (probed_at);

-- RLS: ikke aktiveret — tabellen tilgås kun via service_role (cron +
-- admin-endpoints). Ingen user-scoped queries.
ALTER TABLE public.service_probe_history ENABLE ROW LEVEL SECURITY;

-- Ingen policies = service_role bypasser, normal users får nul adgang.
