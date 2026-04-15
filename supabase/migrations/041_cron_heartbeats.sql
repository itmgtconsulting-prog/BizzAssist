-- BIZZ-305: Cron job heartbeat monitoring table.
-- Records last execution time and status for each cron job.
-- The watchdog cron checks for stale heartbeats and alerts ops.

CREATE TABLE IF NOT EXISTS public.cron_heartbeats (
  job_name                TEXT        PRIMARY KEY,
  last_run_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status             TEXT        NOT NULL DEFAULT 'success'
                                      CHECK (last_status IN ('success', 'error')),
  last_duration_ms        INTEGER,
  expected_interval_minutes INTEGER   NOT NULL DEFAULT 60,
  last_error              TEXT,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS: Only service role can read/write (cron jobs use admin client)
ALTER TABLE public.cron_heartbeats ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY "cron_heartbeats: service role full access"
  ON public.cron_heartbeats
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Index for watchdog queries
CREATE INDEX IF NOT EXISTS cron_heartbeats_status_idx
  ON public.cron_heartbeats (last_status, last_run_at);
