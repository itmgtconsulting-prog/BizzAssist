-- ============================================================
-- Migration 020: Service Manager scans table
-- BizzAssist — BIZZ-86
-- ============================================================
-- Stores results from automated bug scans triggered by the
-- Service Manager admin tool. Admin-only table in the public
-- schema — no tenant isolation needed (platform-level data).
--
-- Issues are stored as JSONB array where each element is:
-- {
--   type:     'build_error' | 'runtime_error' | 'type_error' | 'config_error',
--   severity: 'error' | 'warning',
--   message:  string,
--   source:   'vercel_build' | 'vercel_logs' | 'static',
--   context:  string   (optional extra detail)
-- }
-- ============================================================

CREATE TABLE IF NOT EXISTS public.service_manager_scans (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  scan_type     TEXT        NOT NULL DEFAULT 'manual'
                  CHECK (scan_type IN ('manual', 'scheduled', 'triggered')),
  issues_found  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  status        TEXT        NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'completed', 'failed')),
  resolved_at   TIMESTAMPTZ,
  summary       TEXT,
  triggered_by  UUID        REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Index for recent-first queries (main access pattern)
CREATE INDEX IF NOT EXISTS service_manager_scans_created_at_idx
  ON public.service_manager_scans (created_at DESC);

ALTER TABLE public.service_manager_scans ENABLE ROW LEVEL SECURITY;

-- Only admin users can read scan results.
-- Admin status is stored in auth.users.app_metadata.isAdmin (boolean).
CREATE POLICY "service_manager_scans: admin read"
  ON public.service_manager_scans
  FOR SELECT
  USING (
    (
      SELECT (raw_app_meta_data ->> 'isAdmin')::boolean
      FROM auth.users
      WHERE id = auth.uid()
    ) = true
  );

-- All writes go via service_role from API routes — no INSERT/UPDATE policy
-- needed for authenticated role. service_role bypasses RLS by default.
