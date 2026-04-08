-- ============================================================
-- Migration 021: Service Manager v2 — Auto-fix + Activity log
-- BizzAssist — BIZZ-86 v2
-- ============================================================
-- Adds two new tables to support the AI-powered auto-fix workflow
-- and the release agent's activity audit trail.
--
-- service_manager_fixes:
--   Stores AI-proposed code fixes (diffs) for issues found by
--   the Service Manager scanner. Each fix is tied to a scan record
--   and must be admin-approved before it can be applied.
--
-- service_manager_activity:
--   Immutable audit log for all Release Agent actions —
--   hotfix creation, test deployments, production promotions.
-- ============================================================

-- ─── service_manager_fixes ────────────────────────────────────────────────────
--
-- A fix is proposed by Claude after analysing a ScanIssue.
-- classification: what kind of change Claude determined this is
--   'bug-fix'    — code defect correction, eligible for auto-apply
--   'config-fix' — environment/config correction, eligible for auto-apply
--   'rejected'   — would add features or change UI; never applied
-- status: lifecycle of the fix
--   'proposed'  — created by Claude, awaiting admin review
--   'approved'  — admin approved, ready for Release Agent
--   'applied'   — Release Agent committed the fix to a hotfix branch
--   'rejected'  — admin rejected (or Claude self-classified as rejected)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.service_manager_fixes (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id           UUID        NOT NULL
                      REFERENCES public.service_manager_scans(id) ON DELETE CASCADE,
  -- Index into scan.issues_found so we can cross-reference the original error
  issue_index       INT         NOT NULL DEFAULT 0,
  file_path         TEXT        NOT NULL,
  proposed_diff     TEXT        NOT NULL,
  -- 'bug-fix' | 'config-fix' | 'rejected'
  classification    TEXT        NOT NULL
                      CHECK (classification IN ('bug-fix', 'config-fix', 'rejected')),
  -- 'proposed' | 'approved' | 'applied' | 'rejected'
  status            TEXT        NOT NULL DEFAULT 'proposed'
                      CHECK (status IN ('proposed', 'approved', 'applied', 'rejected')),
  -- Claude's reasoning for the proposed fix or rejection
  claude_reasoning  TEXT,
  -- Human explanation when an admin rejects a fix
  rejection_reason  TEXT,
  -- The admin who approved or rejected the fix
  reviewed_by       UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for lookups by scan (main join pattern from the UI)
CREATE INDEX IF NOT EXISTS service_manager_fixes_scan_id_idx
  ON public.service_manager_fixes (scan_id, created_at DESC);

-- Index for status filtering (pending review queue)
CREATE INDEX IF NOT EXISTS service_manager_fixes_status_idx
  ON public.service_manager_fixes (status);

ALTER TABLE public.service_manager_fixes ENABLE ROW LEVEL SECURITY;

-- Admin-only read — same pattern as service_manager_scans
CREATE POLICY "service_manager_fixes: admin read"
  ON public.service_manager_fixes
  FOR SELECT
  USING (
    (
      SELECT (raw_app_meta_data ->> 'isAdmin')::boolean
      FROM auth.users
      WHERE id = auth.uid()
    ) = true
  );

-- All writes via service_role from API routes (bypasses RLS by default).


-- ─── service_manager_activity ─────────────────────────────────────────────────
--
-- Immutable audit log of all Release Agent actions.
-- action values (non-exhaustive, stored as free-text for extensibility):
--   'auto_fix_proposed'   — Claude proposed a fix
--   'fix_approved'        — Admin approved a fix
--   'fix_rejected'        — Admin rejected a fix
--   'hotfix_created'      — Release Agent created a hotfix branch
--   'hotfix_pushed'       — Release Agent pushed branch to remote
--   'pr_created'          — Release Agent opened a PR
--   'deploy_test'         — Vercel preview deployment triggered
--   'promote_prod'        — develop → main merge initiated
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.service_manager_activity (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  action      TEXT        NOT NULL,
  -- Arbitrary JSON details — scan_id, fix_id, branch, pr_url, error, etc.
  details     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_by  UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for recent-first queries (main access pattern in the UI)
CREATE INDEX IF NOT EXISTS service_manager_activity_created_at_idx
  ON public.service_manager_activity (created_at DESC);

ALTER TABLE public.service_manager_activity ENABLE ROW LEVEL SECURITY;

-- Admin-only read
CREATE POLICY "service_manager_activity: admin read"
  ON public.service_manager_activity
  FOR SELECT
  USING (
    (
      SELECT (raw_app_meta_data ->> 'isAdmin')::boolean
      FROM auth.users
      WHERE id = auth.uid()
    ) = true
  );

-- All writes via service_role from API routes.
