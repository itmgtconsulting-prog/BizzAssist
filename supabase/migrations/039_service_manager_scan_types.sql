-- ============================================================
-- Migration 039: Expand service_manager_scans scan_type values
-- BizzAssist
-- ============================================================
-- The original CHECK constraint only allowed 'manual', 'scheduled',
-- 'triggered'. New scan sources (deploy webhooks, email triggers,
-- deep scans) need additional values.
-- ============================================================

ALTER TABLE public.service_manager_scans
  DROP CONSTRAINT service_manager_scans_scan_type_check;

ALTER TABLE public.service_manager_scans
  ADD CONSTRAINT service_manager_scans_scan_type_check
    CHECK (scan_type IN (
      'manual',
      'scheduled',
      'triggered',
      'deploy_webhook',
      'email_trigger',
      'deep'
    ));
