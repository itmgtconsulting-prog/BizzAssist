-- ============================================================================
-- Migration 008: Support Chat Analytics
-- ============================================================================
-- Stores questions from the support chatbot for analytics purposes.
-- Used to identify FAQ gaps and improve the knowledge base over time.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.support_questions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  question      TEXT NOT NULL,
  answer        TEXT NOT NULL,
  matched       BOOLEAN NOT NULL DEFAULT false,
  lang          VARCHAR(5) NOT NULL DEFAULT 'da',
  page          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for analytics queries
CREATE INDEX IF NOT EXISTS idx_support_questions_created
  ON public.support_questions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_questions_matched
  ON public.support_questions (matched, created_at DESC);

-- RLS: Only service role can insert (API routes use service key)
ALTER TABLE public.support_questions ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY support_questions_service_all
  ON public.support_questions
  FOR ALL
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.support_questions IS 'Logged support chat questions for analytics and KB improvement';
