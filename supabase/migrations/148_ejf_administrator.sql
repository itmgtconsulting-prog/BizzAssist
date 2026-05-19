-- ============================================================================
-- 148_ejf_administrator.sql — BIZZ-1659
-- ============================================================================
-- Bulk-tabel for EJF ejendomsadministratorer (ejerforeninger, udlejere, advokater).
-- Modelleret efter ejf_ejerskab (046). Data fra EJFCustom_EjendomsadministratorBegraenset.
--
-- Formål:
--   1. Administrator-kort på ejendomssider (erstat live API-kald)
--   2. Portfolio-visning: "hvilke ejendomme administrerer CVR X?"
--   3. Forsikrings cross-check for ejerforeninger
--
-- GDPR: Person-administratorer (sjældne — typisk advokater) er offentlige
-- via tinglysning.dk. Samme databehandling som ejf_ejerskab.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ejf_administrator (
  -- Identity
  id_lokal_id       text          NOT NULL,  -- EJF stabilt record-ID
  bfe_nummer        bigint        NOT NULL,

  -- Administrator-info
  administrator_type text         NOT NULL CHECK (administrator_type IN ('virksomhed', 'person', 'ukendt')),
  virksomhed_cvr    text,                    -- CVR for virksomheder
  person_navn       text,                    -- Navn for person-administratorer
  person_lokal_id   text,                    -- EJF person-ID

  -- Virkningstid
  virkning_fra      timestamptz,
  virkning_til      timestamptz,
  status            text          NOT NULL DEFAULT 'gældende'
    CHECK (status IN ('gældende', 'historisk')),

  -- Metadata
  sidst_opdateret   timestamptz   NOT NULL DEFAULT now(),
  ingest_run_id     text,

  PRIMARY KEY (id_lokal_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS ix_ejf_admin_bfe ON public.ejf_administrator (bfe_nummer)
  WHERE status = 'gældende';
CREATE INDEX IF NOT EXISTS ix_ejf_admin_cvr ON public.ejf_administrator (virksomhed_cvr)
  WHERE status = 'gældende' AND virksomhed_cvr IS NOT NULL;

-- RLS: åben select for autentificerede (offentlig data)
ALTER TABLE public.ejf_administrator ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ejf_administrator' AND policyname = 'ejf_administrator: authenticated read'
  ) THEN
    CREATE POLICY "ejf_administrator: authenticated read"
      ON public.ejf_administrator
      FOR SELECT
      TO authenticated
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ejf_administrator' AND policyname = 'ejf_administrator: service role all'
  ) THEN
    CREATE POLICY "ejf_administrator: service role all"
      ON public.ejf_administrator
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END;
$$;

COMMENT ON TABLE public.ejf_administrator IS
  'BIZZ-1659: EJF ejendomsadministratorer — backfilled fra EJFCustom_EjendomsadministratorBegraenset';
