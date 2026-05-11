-- ============================================================================
-- 105_analyse_batch_jobs.sql — BIZZ-1224
-- ============================================================================
-- Batch-job queue for forsikrings-gap og fremtidige batch-analyser.
-- Jobs oprettes ved upload, processeres asynkront, og resultater
-- gemmes i JSONB for fleksibel datastruktur.
-- ============================================================================

CREATE TABLE IF NOT EXISTS tenant.analyse_batch_jobs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL,
  user_id       uuid        NOT NULL,
  -- Job-type: 'forsikring-gap', fremtidigt: 'due-diligence', 'aml-kyc'
  job_type      text        NOT NULL,
  -- Status: pending → processing → completed / failed
  status        text        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  -- Input: parsed kunder fra uploadet fil
  input_data    jsonb       NOT NULL,
  -- Antal kunder i batch
  total_items   integer     NOT NULL DEFAULT 0,
  -- Processeret antal (til progress-bar)
  processed_items integer   NOT NULL DEFAULT 0,
  -- Resultater: array af per-kunde gap-analyser
  results       jsonb,
  -- Aggregerede statistikker
  summary       jsonb,
  -- Fejlbesked ved status=failed
  error         text,
  -- Timestamps
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  completed_at  timestamptz
);

COMMENT ON TABLE tenant.analyse_batch_jobs IS
  'BIZZ-1224: Batch-job queue for forsikrings-gap og andre batch-analyser. '
  'Jobs oprettes ved fil-upload, processeres asynkront.';

-- Lookup: brugerens jobs
CREATE INDEX IF NOT EXISTS idx_batch_jobs_user
  ON tenant.analyse_batch_jobs (user_id, created_at DESC);

-- Lookup: pending jobs (worker polling)
CREATE INDEX IF NOT EXISTS idx_batch_jobs_pending
  ON tenant.analyse_batch_jobs (status)
  WHERE status IN ('pending', 'processing');

-- RLS: brugere kan kun se egne jobs inden for deres tenant
ALTER TABLE tenant.analyse_batch_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY batch_jobs_tenant_isolation
  ON tenant.analyse_batch_jobs
  FOR ALL
  TO authenticated
  USING (tenant_id = (current_setting('request.jwt.claims', true)::jsonb->>'tenant_id')::uuid)
  WITH CHECK (tenant_id = (current_setting('request.jwt.claims', true)::jsonb->>'tenant_id')::uuid);

CREATE POLICY batch_jobs_service_role
  ON tenant.analyse_batch_jobs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
