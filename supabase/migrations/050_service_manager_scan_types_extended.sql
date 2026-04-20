-- ============================================================
-- Migration 050: Add cron_failure + infra_down scan_types
-- BIZZ-623: Service Manager auto-trigger ved cron-heartbeat-fejl og
-- infra-down events. Kræver at service_manager_scans-tabellens
-- CHECK-constraint accepterer de nye trigger-typer.
-- ============================================================
-- Idempotent via conditional DROP — kan køres flere gange uden fejl.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'service_manager_scans_scan_type_check'
      AND conrelid = 'public.service_manager_scans'::regclass
  ) THEN
    ALTER TABLE public.service_manager_scans
      DROP CONSTRAINT service_manager_scans_scan_type_check;
  END IF;
END $$;

ALTER TABLE public.service_manager_scans
  ADD CONSTRAINT service_manager_scans_scan_type_check
    CHECK (scan_type IN (
      'manual',
      'scheduled',
      'triggered',
      'deploy_webhook',
      'email_trigger',
      'deep',
      'cron_failure',
      'infra_down'
    ));
