-- ============================================================
-- Migration 192: Cron & Data-Observability v2
-- BIZZ-2209 (epic): Enterprise-grade cron/data-pipeline observability.
--
-- Indhold:
--   1. cron_heartbeats  — udvid med arbejds-metrikker + 'degraded'-status
--   2. cron_run_history — tidsserie pr. kørsel (trends + "0 arbejde i N dage")
--   3. job_queue        — durable kø til >300s jobs (chunked/resume-worker)
--   4. dar_sync_cursor  — manglende cursor-tabel for pull-dar-aendringer
--
-- Design: alt i public-schema (delt data, ikke tenant-isoleret), RLS on,
-- kun service_role (crons/admin) har adgang. Idempotent.
-- ============================================================

-- ── 1. cron_heartbeats: metrikker + degraded-status ─────────

ALTER TABLE public.cron_heartbeats
  ADD COLUMN IF NOT EXISTS last_items_processed INTEGER,
  ADD COLUMN IF NOT EXISTS last_items_written   INTEGER,
  ADD COLUMN IF NOT EXISTS last_degraded_reason TEXT;

-- Udvid status-domænet til success|error|degraded.
-- 'degraded' = kørte uden exception, men lavede intet nyttigt arbejde når
-- arbejde var forventet, eller en ekstern afhængighed fejlede.
ALTER TABLE public.cron_heartbeats
  DROP CONSTRAINT IF EXISTS cron_heartbeats_last_status_check;
ALTER TABLE public.cron_heartbeats
  ADD CONSTRAINT cron_heartbeats_last_status_check
  CHECK (last_status IN ('success', 'error', 'degraded'));

-- ── 2. cron_run_history: tidsserie pr. kørsel ───────────────

CREATE TABLE IF NOT EXISTS public.cron_run_history (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_name         TEXT        NOT NULL,
  run_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  status           TEXT        NOT NULL
                               CHECK (status IN ('success', 'error', 'degraded')),
  duration_ms      INTEGER,
  items_processed  INTEGER,
  items_written    INTEGER,
  degraded_reason  TEXT,
  error            TEXT
);

CREATE INDEX IF NOT EXISTS cron_run_history_job_run_idx
  ON public.cron_run_history (job_name, run_at DESC);

ALTER TABLE public.cron_run_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "cron_run_history: service role full access" ON public.cron_run_history;
CREATE POLICY "cron_run_history: service role full access"
  ON public.cron_run_history FOR ALL USING (true) WITH CHECK (true);

-- ── 3. job_queue: durable kø til lange jobs ─────────────────

CREATE TABLE IF NOT EXISTS public.job_queue (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_type      TEXT        NOT NULL,          -- fx 'knowledge-topic'
  payload       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'running', 'done', 'error')),
  attempts      INTEGER     NOT NULL DEFAULT 0,
  max_attempts  INTEGER     NOT NULL DEFAULT 3,
  scheduled_for TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at     TIMESTAMPTZ,
  locked_by     TEXT,
  result        JSONB,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Claim-index: worker henter pending/retry-klare jobs i planlagt rækkefølge.
CREATE INDEX IF NOT EXISTS job_queue_claim_idx
  ON public.job_queue (status, scheduled_for)
  WHERE status IN ('pending', 'error');

-- Undgå dublet-enqueue af samme logiske enhed (fx samme topic samme dag):
-- en unik nøgle kan sættes i payload->>'dedupe_key' hvis ønsket.
CREATE UNIQUE INDEX IF NOT EXISTS job_queue_dedupe_idx
  ON public.job_queue (job_type, (payload->>'dedupe_key'))
  WHERE status IN ('pending', 'running') AND payload->>'dedupe_key' IS NOT NULL;

ALTER TABLE public.job_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "job_queue: service role full access" ON public.job_queue;
CREATE POLICY "job_queue: service role full access"
  ON public.job_queue FOR ALL USING (true) WITH CHECK (true);

-- ── 4. dar_sync_cursor: manglende cursor for pull-dar-aendringer ──
-- Singleton (PK = 'default'), holder sidst-hentet DAWA-sekvensnummer.
-- pull-dar-aendringer har refereret denne tabel uden at den blev migreret,
-- så DAR-delta-syncen har no-op'et siden ~2026-05 (cache_dar frøs).

CREATE TABLE IF NOT EXISTS public.dar_sync_cursor (
  id            TEXT        PRIMARY KEY DEFAULT 'default'
                            CHECK (id = 'default'),
  sekvensnummer BIGINT      NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.dar_sync_cursor (id) VALUES ('default')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.dar_sync_cursor ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dar_sync_cursor: service role full access" ON public.dar_sync_cursor;
CREATE POLICY "dar_sync_cursor: service role full access"
  ON public.dar_sync_cursor FOR ALL USING (true) WITH CHECK (true);
