-- BIZZ-275: GDPR consent tracking table.
-- Records every consent decision (accept/decline) with timestamp.
-- Required by GDPR Article 7(1): "the controller shall be able to
-- demonstrate that the data subject has consented."

CREATE TABLE IF NOT EXISTS public.consent_log (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id      TEXT,
  consent_value   TEXT        NOT NULL CHECK (consent_value IN ('accepted', 'declined')),
  categories      JSONB       NOT NULL DEFAULT '["necessary"]'::jsonb,
  ip_hash         TEXT,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS: Users can read their own consent records, service role can write
ALTER TABLE public.consent_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "consent_log: users read own"
  ON public.consent_log FOR SELECT
  USING (user_id = auth.uid() OR user_id IS NULL);

CREATE POLICY "consent_log: service role write"
  ON public.consent_log FOR INSERT
  WITH CHECK (true);

-- Index for lookup by user
CREATE INDEX IF NOT EXISTS consent_log_user_idx
  ON public.consent_log (user_id, created_at DESC);
