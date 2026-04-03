-- ============================================================
-- Migration 014: Link Verification Verdicts
-- BizzAssist — Per-user verdicts (verified / rejected) on links
-- ============================================================
-- Replaces the old link_verifications table (which used link_id FK)
-- with a new schema that references links by (cvr, link_url) directly
-- and stores explicit verdicts ("verified" or "rejected").
--
-- Adds:
--   1. DROP old link_verifications (was FK-based, no verdicts)
--   2. New link_verifications — user_id + cvr + link_url + verdict
--   3. View link_verification_counts — aggregated per (cvr, link_url)
-- ============================================================

-- ── 1. Drop old link_verifications ──────────────────────────
-- The old table used link_id FK to verified_links and had no verdict.
-- It is safe to drop: fresh install, no production votes stored yet.

DROP TABLE IF EXISTS public.link_verifications CASCADE;


-- ── 2. New link_verifications table ─────────────────────────
-- One row per user per link per entity (CVR or enhedsNummer).
-- verdict: 'verified' = link is correct, 'rejected' = link is wrong.
-- UNIQUE (user_id, cvr, link_url) ensures one vote per user per link.

CREATE TABLE public.link_verifications (
  id         uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cvr        text        NOT NULL,           -- CVR or enhedsNummer (entity identifier)
  link_url   text        NOT NULL,
  link_type  text        CHECK (link_type IN ('social', 'article')),
  platform   text,                           -- 'linkedin', 'facebook', 'article', etc.
  verdict    text        NOT NULL CHECK (verdict IN ('verified', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, cvr, link_url)
);

COMMENT ON TABLE public.link_verifications IS
  'Per-user verdicts on social/article links. One vote per user per link per entity.';

-- Fast lookup: all verdicts for a given entity
CREATE INDEX idx_lv_cvr_url   ON public.link_verifications (cvr, link_url);
-- Fast lookup: all votes by a user
CREATE INDEX idx_lv_user_cvr  ON public.link_verifications (user_id, cvr);


-- ── 3. Row Level Security ────────────────────────────────────

ALTER TABLE public.link_verifications ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read all verdicts (needed for aggregate counts)
CREATE POLICY "link_verifications: read authenticated"
  ON public.link_verifications FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Users can only insert their own verdicts
CREATE POLICY "link_verifications: insert own"
  ON public.link_verifications FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can update their own verdict (change verified ↔ rejected)
CREATE POLICY "link_verifications: update own"
  ON public.link_verifications FOR UPDATE
  USING (auth.uid() = user_id);

-- Users can delete (retract) their own verdict
CREATE POLICY "link_verifications: delete own"
  ON public.link_verifications FOR DELETE
  USING (auth.uid() = user_id);


-- ── 4. Aggregated counts view ────────────────────────────────
-- Returns verified_count and rejected_count per (cvr, link_url).
-- Consumed by GET /api/link-verification to build the UI state.

CREATE OR REPLACE VIEW public.link_verification_counts AS
SELECT
  cvr,
  link_url,
  platform,
  link_type,
  COUNT(*) FILTER (WHERE verdict = 'verified')  AS verified_count,
  COUNT(*) FILTER (WHERE verdict = 'rejected')  AS rejected_count
FROM public.link_verifications
GROUP BY cvr, link_url, platform, link_type;

COMMENT ON VIEW public.link_verification_counts IS
  'Aggregated verified/rejected counts per (cvr, link_url).';
