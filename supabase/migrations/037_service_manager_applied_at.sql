-- ============================================================
-- Migration 037: Service Manager — applied_at + commit_sha
-- BizzAssist — BIZZ-86 follow-up
-- ============================================================
-- Adds two columns to service_manager_fixes that the Release Agent
-- needs to record when a fix was applied and what commit it produced.
--
-- applied_at:  timestamp when the Release Agent created the hotfix commit
-- commit_sha:  the full Git commit SHA produced by the GitHub API
--
-- These were omitted from migration 021 and are required so the UI
-- and audit log can show the full lifecycle of an applied fix.
-- ============================================================

ALTER TABLE public.service_manager_fixes
  ADD COLUMN IF NOT EXISTS applied_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS commit_sha  TEXT;

-- Index for quick lookup of applied fixes (audit / history view)
CREATE INDEX IF NOT EXISTS service_manager_fixes_applied_at_idx
  ON public.service_manager_fixes (applied_at DESC NULLS LAST)
  WHERE applied_at IS NOT NULL;

COMMENT ON COLUMN public.service_manager_fixes.applied_at IS
  'Timestamp when the Release Agent committed this fix to a hotfix branch via GitHub API.';

COMMENT ON COLUMN public.service_manager_fixes.commit_sha IS
  'Full Git commit SHA produced by the GitHub API when the fix was applied.';
