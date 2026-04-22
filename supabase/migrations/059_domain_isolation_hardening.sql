-- BIZZ-722 + BIZZ-698: Domain isolation hardening — email domain guard + AI token metering + anomaly view
-- Defense-in-depth: Adds email-domain whitelist enforcement, AI token tracking,
-- and a suspicious-access detection view on top of the base domain schema (058).

-- ─── 1. Extend public.domain with email guard + AI metering ──────────────
ALTER TABLE public.domain
  ADD COLUMN IF NOT EXISTS email_domain_whitelist    text[]       NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS email_domain_enforcement  text         NOT NULL DEFAULT 'warn'
    CHECK (email_domain_enforcement IN ('off', 'warn', 'hard')),
  ADD COLUMN IF NOT EXISTS ai_tokens_used_current_period  bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_tokens_reset_at        timestamptz;

-- ─── 2. Anomaly detection view ────────────────��───────────────────────────
-- Surfaces domain_audit_log entries where the actor is NOT a current member
-- of the domain they acted on. This catches:
--   - Removed members whose sessions weren't properly invalidated
--   - RLS bypass attempts
--   - Any action that slipped past membership checks
CREATE OR REPLACE VIEW public.domain_suspicious_access AS
SELECT
  dal.id           AS log_id,
  dal.domain_id,
  dal.actor_id,
  dal.action,
  dal.metadata,
  dal.created_at,
  d.name           AS domain_name
FROM public.domain_audit_log dal
JOIN public.domain d ON d.id = dal.domain_id
LEFT JOIN public.domain_member dm
  ON dm.domain_id = dal.domain_id
  AND dm.user_id = dal.actor_id
WHERE dm.id IS NULL
ORDER BY dal.created_at DESC;

-- Only super-admins should query this view
COMMENT ON VIEW public.domain_suspicious_access IS
  'BIZZ-722: Surfaces audit log entries where actor is NOT a current domain member. Super-admin only.';

-- ─── 3. Email domain guard function ───────────────���──────────────────────
-- Called by the member-add API to validate email domains before insert.
CREATE OR REPLACE FUNCTION public.check_domain_email_guard(
  p_domain_id uuid,
  p_email     text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_whitelist   text[];
  v_enforcement text;
  v_email_domain text;
BEGIN
  SELECT email_domain_whitelist, email_domain_enforcement
    INTO v_whitelist, v_enforcement
    FROM public.domain
    WHERE id = p_domain_id;

  IF v_enforcement = 'off' OR array_length(v_whitelist, 1) IS NULL THEN
    RETURN jsonb_build_object('allowed', true, 'enforcement', v_enforcement);
  END IF;

  -- Extract domain from email (everything after @)
  v_email_domain := lower(split_part(p_email, '@', 2));

  IF v_email_domain = ANY(v_whitelist) THEN
    RETURN jsonb_build_object('allowed', true, 'enforcement', v_enforcement);
  ELSE
    RETURN jsonb_build_object(
      'allowed', v_enforcement <> 'hard',
      'enforcement', v_enforcement,
      'warning', format('Email-domæne %s er ikke på whitelist for dette domain', v_email_domain)
    );
  END IF;
END;
$$;

-- ─── 4. AI token increment function ──────────────────────────────────────
-- Called after each generation to meter AI token usage per domain.
CREATE OR REPLACE FUNCTION public.domain_increment_ai_tokens(
  p_domain_id uuid,
  p_tokens    bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.domain
  SET ai_tokens_used_current_period = ai_tokens_used_current_period + p_tokens,
      updated_at = now()
  WHERE id = p_domain_id;
END;
$$;

-- ─── 5. Monthly token reset function (called by cron) ────────────────────
CREATE OR REPLACE FUNCTION public.domain_reset_monthly_tokens()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.domain
  SET ai_tokens_used_current_period = 0,
      ai_tokens_reset_at = now(),
      updated_at = now()
  WHERE ai_tokens_reset_at IS NULL
     OR ai_tokens_reset_at < now() - interval '30 days';
END;
$$;

-- ─── 6. Vector similarity search with mandatory domain_id filter ─────────
-- BIZZ-722 Lag 6: All vector searches go through this function.
-- Direct queries against domain_embedding are forbidden in application code.
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
    de.content,
    1 - (de.embedding <=> p_query_embedding) AS similarity
  FROM public.domain_embedding de
  WHERE de.domain_id = p_domain_id
    AND 1 - (de.embedding <=> p_query_embedding) > p_match_threshold
  ORDER BY de.embedding <=> p_query_embedding
  LIMIT p_match_count;
END;
$$;
