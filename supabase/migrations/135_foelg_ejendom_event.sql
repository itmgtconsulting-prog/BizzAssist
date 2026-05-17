-- ============================================================================
-- 135: foelg_ejendom_event — AbonnementSvar callbacks fra Tinglysning (BIZZ-1520)
-- ============================================================================
-- Når en bruger har abonneret på ændringer for en ejendom (BFE), sender
-- Tinglysning AbonnementSvar callbacks når der sker ændringer. Vi
-- persisterer hver hændelse i denne tabel så UI'en kan vise
-- ændringshistorik + advare brugeren via NotifikationsDropdown.
--
-- Idempotency: UNIQUE constraint på tinglysning_message_id forhindrer
-- duplikater hvis Tinglysning retryer.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.foelg_ejendom_event (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID,
  user_id                 UUID,
  /** Tinglysnings objekt-UUID (typisk ejendom/akt) */
  objekt_uuid             TEXT        NOT NULL,
  /** Type af ændring (fx 'Tinglyst', 'Aflyst', 'Påtegnet') */
  aendring_type           TEXT        NOT NULL,
  /** Tidspunkt for ændringen jf Tinglysning */
  aendring_tid            TIMESTAMPTZ NOT NULL,
  /** Kundereference vi sendte med abonnementet — typisk vores bfe_nummer */
  kundereference          TEXT,
  /** Tinglysning's message-id — UNIQUE for idempotency */
  tinglysning_message_id  TEXT        NOT NULL UNIQUE,
  /** Rå XML body (for audit + debugging) */
  raw_xml                 TEXT,
  /** Hvornår vi modtog callback */
  modtaget_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  /** Hvornår brugeren har set hændelsen (NULL = uread) */
  set_af_bruger_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_foelg_event_tenant_user
  ON public.foelg_ejendom_event (tenant_id, user_id, modtaget_at DESC);

CREATE INDEX IF NOT EXISTS idx_foelg_event_objekt
  ON public.foelg_ejendom_event (objekt_uuid, modtaget_at DESC);

CREATE INDEX IF NOT EXISTS idx_foelg_event_kundereference
  ON public.foelg_ejendom_event (kundereference)
  WHERE kundereference IS NOT NULL;

ALTER TABLE public.foelg_ejendom_event ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "foelg_event: service_role full" ON public.foelg_ejendom_event;
CREATE POLICY "foelg_event: service_role full"
  ON public.foelg_ejendom_event FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- Brugere må læse egne hændelser (eller hele tenant'ets — pt valgt tenant-wide
-- så team-medlemmer kan se hinandens followed properties)
DROP POLICY IF EXISTS "foelg_event: tenant member read" ON public.foelg_ejendom_event;
CREATE POLICY "foelg_event: tenant member read"
  ON public.foelg_ejendom_event FOR SELECT
  TO authenticated
  USING (
    tenant_id IN (
      SELECT tenant_id FROM public.tenant_memberships WHERE user_id = auth.uid()
    )
  );

-- Brugere må markere som "set" via update på set_af_bruger_at
DROP POLICY IF EXISTS "foelg_event: own mark as seen" ON public.foelg_ejendom_event;
CREATE POLICY "foelg_event: own mark as seen"
  ON public.foelg_ejendom_event FOR UPDATE
  TO authenticated
  USING (
    tenant_id IN (
      SELECT tenant_id FROM public.tenant_memberships WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    tenant_id IN (
      SELECT tenant_id FROM public.tenant_memberships WHERE user_id = auth.uid()
    )
  );

COMMENT ON TABLE public.foelg_ejendom_event IS
  'BIZZ-1520: Tinglysning AbonnementSvar callback events. Idempotent via UNIQUE tinglysning_message_id. Retention 24 mdr (purge-old-data cron).';
