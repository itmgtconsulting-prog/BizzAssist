-- ============================================================================
-- 151: EJF Handelsoplysninger — salgspriser fra Datafordeler (BIZZ-1727)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ejf_handelsoplysninger (
  id_lokal_id           text PRIMARY KEY,
  samlet_koebesum       bigint,
  kontant_koebesum      bigint,
  loesoeressum          bigint,
  entreprisesum         bigint,
  husdyrbesaetningsum   bigint,
  koebsaftale_dato      date,
  afstaaelses_dato      date,
  valutakode            text,
  forretningshaendelse  text,
  virkning_fra          timestamptz,
  virkning_til          timestamptz,
  status                text NOT NULL DEFAULT 'gældende',
  sidst_opdateret       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_ejf_handelsoplys_koebesum
  ON public.ejf_handelsoplysninger (samlet_koebesum)
  WHERE samlet_koebesum IS NOT NULL AND status = 'gældende';

CREATE INDEX IF NOT EXISTS ix_ejf_handelsoplys_dato
  ON public.ejf_handelsoplysninger (koebsaftale_dato)
  WHERE status = 'gældende';

ALTER TABLE public.ejf_handelsoplysninger ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ejf_handelsoplysninger' AND policyname = 'ejf_handelsoplysninger: authenticated read'
  ) THEN
    CREATE POLICY "ejf_handelsoplysninger: authenticated read"
      ON public.ejf_handelsoplysninger FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ejf_handelsoplysninger' AND policyname = 'ejf_handelsoplysninger: service role all'
  ) THEN
    CREATE POLICY "ejf_handelsoplysninger: service role all"
      ON public.ejf_handelsoplysninger FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END;
$$;

COMMENT ON TABLE public.ejf_handelsoplysninger IS
  'BIZZ-1727: EJF Handelsoplysninger — salgspriser fra Datafordeler. Kobles til ejf_ejerskifte via handelsoplysninger_lokal_id.';
