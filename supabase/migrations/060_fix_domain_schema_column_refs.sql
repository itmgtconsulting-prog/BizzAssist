-- BIZZ-698 + BIZZ-722: Fix column references in view + RPC
--
-- Two blocking SQL bugs in migration 059:
--   Bug 1: domain_suspicious_access view references dal.actor_id
--          but the column in 058:151 is actor_user_id
--   Bug 2: match_domain_embeddings RPC returns de.content
--          but the column in 058:138 is chunk_text
--
-- This migration replaces the view and RPC with corrected column names.
-- We do NOT edit 059 because it has already been applied in CI.

-- ─── 1. Fix domain_suspicious_access view ──────────────────────────────────
DROP VIEW IF EXISTS public.domain_suspicious_access;

CREATE VIEW public.domain_suspicious_access AS
SELECT
  dal.id           AS log_id,
  dal.domain_id,
  dal.actor_user_id,
  dal.action,
  dal.metadata,
  dal.created_at,
  d.name           AS domain_name
FROM public.domain_audit_log dal
JOIN public.domain d ON d.id = dal.domain_id
LEFT JOIN public.domain_member dm
  ON dm.domain_id = dal.domain_id
  AND dm.user_id = dal.actor_user_id
WHERE dm.id IS NULL
ORDER BY dal.created_at DESC;

COMMENT ON VIEW public.domain_suspicious_access IS
  'BIZZ-722: Surfaces audit log entries where actor is NOT a current domain member. Super-admin only.';

-- ─── 2. Fix match_domain_embeddings RPC ───────────────────────────────────
DROP FUNCTION IF EXISTS public.match_domain_embeddings(uuid, vector, int, float);

CREATE OR REPLACE FUNCTION public.match_domain_embeddings(
  p_domain_id       uuid,
  p_query_embedding vector(1536),
  p_match_count     int DEFAULT 10,
  p_match_threshold float DEFAULT 0.5
)
RETURNS TABLE (
  id          uuid,
  source_type text,
  source_id   uuid,
  content     text,
  similarity  float
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    de.id,
    de.source_type,
    de.source_id,
    de.chunk_text AS content,
    1 - (de.embedding <=> p_query_embedding) AS similarity
  FROM public.domain_embedding de
  WHERE de.domain_id = p_domain_id
    AND 1 - (de.embedding <=> p_query_embedding) > p_match_threshold
  ORDER BY de.embedding <=> p_query_embedding
  LIMIT p_match_count;
END;
$$;

COMMENT ON FUNCTION public.match_domain_embeddings IS
  'BIZZ-722 Lag 6: Vector similarity search with mandatory domain_id filter. Aliases chunk_text AS content for API consistency.';
