-- ============================================================
-- Migration 156: Ejerforening Finder
-- BizzAssist — AI-baseret ejerforenings-lookup + crowdsourced verification
-- ============================================================
-- Adds:
--   1. ai_find_ejerforening_cache — cache for AI reverse-lookup results per BFE
--   2. ejerforening_verifications — per-user verdicts on AI-found ejerforeninger
--   3. ejerforening_verification_counts — aggregated view
-- ============================================================


-- ── 1. AI result cache ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ai_find_ejerforening_cache (
  bfe_nummer    bigint        PRIMARY KEY,
  candidates    jsonb         NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz   NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ai_find_ejerforening_cache IS
  'Cache for AI-evaluated ejerforenings-kandidater per BFE (24h TTL).';

ALTER TABLE public.ai_find_ejerforening_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_find_ejf_cache: read authenticated"
  ON public.ai_find_ejerforening_cache FOR SELECT
  USING (auth.uid() IS NOT NULL);


-- ── 2. Ejerforening verifications ───────────────────────────

CREATE TABLE public.ejerforening_verifications (
  id            uuid          PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  user_id       uuid          NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bfe_nummer    bigint        NOT NULL,
  candidate_cvr text          NOT NULL,
  verdict       text          NOT NULL CHECK (verdict IN ('verified', 'rejected')),
  created_at    timestamptz   NOT NULL DEFAULT now(),

  UNIQUE (user_id, bfe_nummer, candidate_cvr)
);

COMMENT ON TABLE public.ejerforening_verifications IS
  'Per-user verdicts on AI-found ejerforeninger. One vote per user per BFE per candidate CVR.';

CREATE INDEX idx_ev_bfe_cvr   ON public.ejerforening_verifications (bfe_nummer, candidate_cvr);
CREATE INDEX idx_ev_user_bfe  ON public.ejerforening_verifications (user_id, bfe_nummer);

ALTER TABLE public.ejerforening_verifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ejerforening_verifications: read authenticated"
  ON public.ejerforening_verifications FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "ejerforening_verifications: insert own"
  ON public.ejerforening_verifications FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "ejerforening_verifications: update own"
  ON public.ejerforening_verifications FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "ejerforening_verifications: delete own"
  ON public.ejerforening_verifications FOR DELETE
  USING (auth.uid() = user_id);


-- ── 3. Aggregated counts view ───────────────────────────────

CREATE OR REPLACE VIEW public.ejerforening_verification_counts AS
SELECT
  bfe_nummer,
  candidate_cvr,
  COUNT(*) FILTER (WHERE verdict = 'verified')  AS verified_count,
  COUNT(*) FILTER (WHERE verdict = 'rejected')  AS rejected_count
FROM public.ejerforening_verifications
GROUP BY bfe_nummer, candidate_cvr;

COMMENT ON VIEW public.ejerforening_verification_counts IS
  'Aggregated verified/rejected counts per (bfe_nummer, candidate_cvr).';
