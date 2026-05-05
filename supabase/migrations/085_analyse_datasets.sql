-- BIZZ-1040: Analyse datasets — pre-fetchede datasæt per tenant
-- Bruges af Perspective pivot-tabeller til at arbejde med store datasæt
-- uden hundredvis af API-kald.

CREATE TABLE IF NOT EXISTS public.analyse_datasets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  source TEXT NOT NULL CHECK (source IN ('ejendomme', 'virksomheder', 'regnskab', 'custom', 'ai_query')),
  data JSONB NOT NULL DEFAULT '[]'::jsonb,
  columns JSONB NOT NULL DEFAULT '[]'::jsonb,
  row_count INTEGER NOT NULL DEFAULT 0,
  refreshed_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- RLS
ALTER TABLE public.analyse_datasets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "analyse_datasets: service_role full"
  ON public.analyse_datasets FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "analyse_datasets: owner read"
  ON public.analyse_datasets FOR SELECT
  TO authenticated USING (user_id = auth.uid());

CREATE POLICY "analyse_datasets: owner delete"
  ON public.analyse_datasets FOR DELETE
  TO authenticated USING (user_id = auth.uid());

-- Index for hurtig listing per bruger
CREATE INDEX IF NOT EXISTS idx_analyse_datasets_user
  ON public.analyse_datasets (user_id, updated_at DESC);

COMMENT ON TABLE public.analyse_datasets IS 'BIZZ-1040: Pre-fetchede datasæt for Perspective pivot-tabeller';
