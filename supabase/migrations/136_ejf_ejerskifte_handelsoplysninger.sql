-- BIZZ-1712 + BIZZ-1709: EJF Ejerskifte + Handelsoplysninger
-- Officielle handelsdata fra Ejendomsfortegnelsen via Datafordeler GraphQL

CREATE TABLE IF NOT EXISTS public.ejf_ejerskifte (
  id_lokal_id       TEXT PRIMARY KEY,
  bfe_nummer        BIGINT NOT NULL,
  overdragelsesmaade TEXT,
  overtagelsesdato  TIMESTAMPTZ,
  handelsoplysninger_lokal_id TEXT,
  virkning_fra      TIMESTAMPTZ,
  virkning_til      TIMESTAMPTZ,
  status            TEXT DEFAULT 'gældende',
  registrering_fra  TIMESTAMPTZ,
  registrering_til  TIMESTAMPTZ,
  sidst_opdateret   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_ejf_ejerskifte_bfe ON public.ejf_ejerskifte (bfe_nummer);
CREATE INDEX IF NOT EXISTS ix_ejf_ejerskifte_handelsoplysninger ON public.ejf_ejerskifte (handelsoplysninger_lokal_id) WHERE handelsoplysninger_lokal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_ejf_ejerskifte_dato ON public.ejf_ejerskifte (overtagelsesdato DESC);

CREATE TABLE IF NOT EXISTS public.ejf_handelsoplysninger (
  id_lokal_id       TEXT PRIMARY KEY,
  kontant_koebesum  BIGINT,
  samlet_koebesum   BIGINT,
  loesoeresum       BIGINT,
  entreprisesum     BIGINT,
  koebsaftale_dato  DATE,
  valutakode        TEXT DEFAULT 'DKK',
  virkning_fra      TIMESTAMPTZ,
  virkning_til      TIMESTAMPTZ,
  status            TEXT DEFAULT 'gældende',
  registrering_fra  TIMESTAMPTZ,
  registrering_til  TIMESTAMPTZ,
  sidst_opdateret   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Convenience view: ejerskifte joined med handelsoplysninger
CREATE OR REPLACE VIEW public.v_ejerskifte_handel AS
SELECT
  e.bfe_nummer,
  e.overdragelsesmaade,
  e.overtagelsesdato,
  e.status,
  h.kontant_koebesum,
  h.samlet_koebesum,
  h.loesoeresum,
  h.entreprisesum,
  h.koebsaftale_dato,
  h.valutakode,
  e.id_lokal_id AS ejerskifte_id,
  h.id_lokal_id AS handelsoplysninger_id
FROM public.ejf_ejerskifte e
LEFT JOIN public.ejf_handelsoplysninger h ON h.id_lokal_id = e.handelsoplysninger_lokal_id;

-- Grant read to ai_query_reader (Data Intelligence)
GRANT SELECT ON public.ejf_ejerskifte TO ai_query_reader;
GRANT SELECT ON public.ejf_handelsoplysninger TO ai_query_reader;
GRANT SELECT ON public.v_ejerskifte_handel TO ai_query_reader;
