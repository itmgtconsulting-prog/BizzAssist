-- ============================================================================
-- 150: Udvid ejf_ejerskifte med nye felter fra EJF GraphQL (BIZZ-1726)
-- ============================================================================

ALTER TABLE public.ejf_ejerskifte
  ADD COLUMN IF NOT EXISTS overdragelsesmaade text,
  ADD COLUMN IF NOT EXISTS betinget boolean,
  ADD COLUMN IF NOT EXISTS frist_dato timestamptz,
  ADD COLUMN IF NOT EXISTS anmeldelses_dato timestamptz,
  ADD COLUMN IF NOT EXISTS handelsoplysninger_lokal_id text;

CREATE INDEX IF NOT EXISTS ix_ejf_ejerskifte_overdragelse
  ON public.ejf_ejerskifte (overdragelsesmaade)
  WHERE status = 'gældende';

CREATE INDEX IF NOT EXISTS ix_ejf_ejerskifte_handelsoplys
  ON public.ejf_ejerskifte (handelsoplysninger_lokal_id)
  WHERE handelsoplysninger_lokal_id IS NOT NULL;

COMMENT ON COLUMN public.ejf_ejerskifte.overdragelsesmaade IS
  'Handelstype: Almindelig fri handel, Familieoverdragelse, Arv, Gave, Tvangsauktion, Interessesammenfald';
