-- ============================================================================
-- 136: tinglysning_brugerformular — BIZZ-1521 BrugerformularSvar callbacks
-- ============================================================================
-- Tinglysning sender BrugerformularSvar callbacks når en bruger har udfyldt
-- en formular i Tinglysningssystemet (typisk underskrift-bekræftelse eller
-- anmodning om yderligere oplysninger). Vi persisterer form-data så vi kan
-- vise det i UI'en og linke det til den oprindelige anmeldelse.
--
-- Idempotency: UNIQUE constraint på tinglysning_message_id.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.tinglysning_brugerformular (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  /** Reference til anmeldelse hvis kan resolves (via kundereference) */
  anmeldelse_id           UUID        REFERENCES public.tinglysning_anmeldelse(id) ON DELETE SET NULL,
  /** Tinglysning's formular-ID */
  formular_id             TEXT,
  /** Formular-type fra Tinglysning (fx 'underskrift-bekraeftelse') */
  formular_type           TEXT,
  /** Kundereference (typisk vores anmeldelse-ID) */
  kundereference          TEXT,
  /** Form-data som JSONB — strukturen varierer per formular-type */
  form_data               JSONB       NOT NULL DEFAULT '{}'::jsonb,
  /** Tinglysning's message-id — UNIQUE for idempotency */
  tinglysning_message_id  TEXT        NOT NULL UNIQUE,
  /** Rå XML body (for audit) */
  raw_xml                 TEXT,
  /** Hvornår vi modtog callback */
  modtaget_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_brugerformular_anmeldelse
  ON public.tinglysning_brugerformular (anmeldelse_id)
  WHERE anmeldelse_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_brugerformular_kundereference
  ON public.tinglysning_brugerformular (kundereference)
  WHERE kundereference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_brugerformular_modtaget
  ON public.tinglysning_brugerformular (modtaget_at DESC);

ALTER TABLE public.tinglysning_brugerformular ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "brugerformular: service_role full" ON public.tinglysning_brugerformular;
CREATE POLICY "brugerformular: service_role full"
  ON public.tinglysning_brugerformular FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- Læse-adgang følger anmeldelse-ejerskab — kun tenant-medlemmer der har
-- adgang til den koblede anmeldelse må læse formularen
DROP POLICY IF EXISTS "brugerformular: anmeldelse-tenant read" ON public.tinglysning_brugerformular;
CREATE POLICY "brugerformular: anmeldelse-tenant read"
  ON public.tinglysning_brugerformular FOR SELECT
  TO authenticated
  USING (
    anmeldelse_id IS NULL OR anmeldelse_id IN (
      SELECT id FROM public.tinglysning_anmeldelse
      WHERE tenant_id IN (
        SELECT tenant_id FROM public.tenant_memberships WHERE user_id = auth.uid()
      )
    )
  );

COMMENT ON TABLE public.tinglysning_brugerformular IS
  'BIZZ-1521: Brugerformular-callbacks fra Tinglysning. Linkes til anmeldelse via kundereference. Idempotent via UNIQUE tinglysning_message_id.';
