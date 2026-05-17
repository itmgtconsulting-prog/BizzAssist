-- ============================================================================
-- 132: Intel Chat Sessions + Turns — BIZZ-1560 (L1.2)
-- ============================================================================
-- Persisterer Data Intelligence chat-konversationer så brugere kan reload
-- siden uden at miste konteksten, og så agentic-loop kan bruge sidste 4-6
-- turns som few-shot context i nye queries.
--
-- Tenant-isolation via RLS: hver bruger ser kun egne sessions inden for
-- deres tenant.
-- ============================================================================

-- ─── Sessions ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.intel_chat_session (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL,
  user_id         UUID        NOT NULL,
  title           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_intel_chat_session_tenant_user
  ON public.intel_chat_session (tenant_id, user_id, last_activity DESC);

ALTER TABLE public.intel_chat_session ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "intel_chat_session: service_role full" ON public.intel_chat_session;
CREATE POLICY "intel_chat_session: service_role full"
  ON public.intel_chat_session FOR ALL
  TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "intel_chat_session: tenant member read" ON public.intel_chat_session;
CREATE POLICY "intel_chat_session: tenant member read"
  ON public.intel_chat_session FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    AND tenant_id IN (
      SELECT tenant_id FROM public.tenant_memberships WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "intel_chat_session: own insert" ON public.intel_chat_session;
CREATE POLICY "intel_chat_session: own insert"
  ON public.intel_chat_session FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND tenant_id IN (
      SELECT tenant_id FROM public.tenant_memberships WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "intel_chat_session: own update" ON public.intel_chat_session;
CREATE POLICY "intel_chat_session: own update"
  ON public.intel_chat_session FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "intel_chat_session: own delete" ON public.intel_chat_session;
CREATE POLICY "intel_chat_session: own delete"
  ON public.intel_chat_session FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

COMMENT ON TABLE public.intel_chat_session IS
  'BIZZ-1560: Data Intelligence chat-sessions. 12 mdr retention. Tenant-scoped.';

-- ─── Turns ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.intel_chat_turn (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       UUID        NOT NULL REFERENCES public.intel_chat_session(id) ON DELETE CASCADE,
  role             TEXT        NOT NULL CHECK (role IN ('user', 'assistant')),
  content          TEXT        NOT NULL,
  sql              TEXT,
  result_json      JSONB,
  chart_hint       TEXT,
  routing_layer    TEXT        CHECK (routing_layer IS NULL OR routing_layer IN ('scorecard', 'mv', 'redis', 'semantic', 'generative', 'clarify', 'decline', 'failed')),
  attempts         INTEGER     NOT NULL DEFAULT 1,
  duration_ms      INTEGER,
  feedback         TEXT        CHECK (feedback IS NULL OR feedback IN ('helpful', 'not_helpful')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_intel_chat_turn_session
  ON public.intel_chat_turn (session_id, created_at);

ALTER TABLE public.intel_chat_turn ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "intel_chat_turn: service_role full" ON public.intel_chat_turn;
CREATE POLICY "intel_chat_turn: service_role full"
  ON public.intel_chat_turn FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- Læse-adgang følger session-ejerskab
DROP POLICY IF EXISTS "intel_chat_turn: own session read" ON public.intel_chat_turn;
CREATE POLICY "intel_chat_turn: own session read"
  ON public.intel_chat_turn FOR SELECT
  TO authenticated
  USING (
    session_id IN (SELECT id FROM public.intel_chat_session WHERE user_id = auth.uid())
  );

-- Insert via service_role (server-side from /api/intel/ask)
-- Authenticated users må update feedback-feltet på egne turns
DROP POLICY IF EXISTS "intel_chat_turn: own feedback update" ON public.intel_chat_turn;
CREATE POLICY "intel_chat_turn: own feedback update"
  ON public.intel_chat_turn FOR UPDATE
  TO authenticated
  USING (
    session_id IN (SELECT id FROM public.intel_chat_session WHERE user_id = auth.uid())
  )
  WITH CHECK (
    session_id IN (SELECT id FROM public.intel_chat_session WHERE user_id = auth.uid())
  );

COMMENT ON TABLE public.intel_chat_turn IS
  'BIZZ-1560: Individuelle turns i en Data Intelligence chat-session. Indeholder sql, resultat-snapshot og routing-lag for sporbarhed.';

-- ─── Auto-opdater last_activity ved nye turns ──────────────────────────────
CREATE OR REPLACE FUNCTION public.intel_chat_turn_bump_session()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.intel_chat_session
    SET last_activity = now()
    WHERE id = NEW.session_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_intel_chat_turn_bump ON public.intel_chat_turn;
CREATE TRIGGER trg_intel_chat_turn_bump
  AFTER INSERT ON public.intel_chat_turn
  FOR EACH ROW
  EXECUTE FUNCTION public.intel_chat_turn_bump_session();
