-- ============================================================================
-- 047_ejf_ejerskab_id_text.sql — BIZZ-534
-- ============================================================================
-- Ændrer ejf_ejerskab.ejer_ejf_id fra UUID til TEXT.
--
-- Baggrund: EJFCustom_EjerskabBegraenset.ejendePersonBegraenset.id er UUID,
-- men for virksomheds-ejerskaber har vi kun CVR-nummer. Vi bruger derfor
-- 'virk-{cvr}' som stable ID for virksomheder, hvilket kræver TEXT-kolonne.
-- ============================================================================

alter table public.ejf_ejerskab
  alter column ejer_ejf_id type text using ejer_ejf_id::text;
