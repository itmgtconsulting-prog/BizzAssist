-- ============================================================================
-- 130: Tinglysning anmeldelse audit table — BIZZ-1519
-- Tracker alle S2S anmeldelser med status, dokumenter, underskrifter.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.tinglysning_anmeldelse (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL,
  user_id         UUID        NOT NULL,
  -- Ejendom
  bfe_nummer      BIGINT      NOT NULL,
  -- Anmeldelsestype
  anmeldelse_type TEXT        NOT NULL CHECK (anmeldelse_type IN ('skoede', 'pantebrev', 'servitut')),
  -- Status
  status          TEXT        NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft', 'preview', 'pending_signature', 'submitted', 'accepted', 'rejected', 'cancelled')),
  -- XML request/response (for audit)
  request_xml     TEXT,
  response_xml    TEXT,
  tinglysning_message_id TEXT,
  -- Fejl
  error_message   TEXT,
  -- Timestamps
  created_at      TIMESTAMPTZ DEFAULT now(),
  submitted_at    TIMESTAMPTZ,
  resolved_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tl_anmeldelse_tenant ON public.tinglysning_anmeldelse (tenant_id);
CREATE INDEX IF NOT EXISTS idx_tl_anmeldelse_bfe ON public.tinglysning_anmeldelse (bfe_nummer);
CREATE INDEX IF NOT EXISTS idx_tl_anmeldelse_status ON public.tinglysning_anmeldelse (status);

ALTER TABLE public.tinglysning_anmeldelse ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tl_anmeldelse: service_role full"
  ON public.tinglysning_anmeldelse FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "tl_anmeldelse: tenant read own"
  ON public.tinglysning_anmeldelse FOR SELECT
  TO authenticated USING (tenant_id = (current_setting('request.jwt.claims', true)::jsonb->>'tenant_id')::uuid);

COMMENT ON TABLE public.tinglysning_anmeldelse IS 'BIZZ-1519: Audit trail for alle S2S anmeldelser mod Tinglysningsretten.';
