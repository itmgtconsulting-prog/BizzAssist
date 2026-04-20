-- ============================================================================
-- 048_ejf_ejerskab_navn_exact_idx.sql — BIZZ-534 follow-up
-- ============================================================================
-- Tilføjer partial btree-index på rå ejer_navn (case-sensitive) så eq-match
-- kan bruge index. Det eksisterende ix_ejf_person_lookup er på lower(ejer_navn)
-- og bruges ikke af PostgreSQL når query har ILIKE uden wildcards eller eq på
-- rå kolonne.
--
-- person-bridge fallback bruger person.navn direkte fra CVR ES, som har
-- konsistent case-stavning der matcher EJF. Derfor er exact-match index OK.
-- ============================================================================

create index if not exists ix_ejf_person_navn_exact
  on public.ejf_ejerskab (ejer_navn)
  where ejer_type = 'person' and status = 'gældende';
