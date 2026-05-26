-- BIZZ-1855: Normaliser empty strings i etage/doer til NULL i bfe_adresse_cache.
-- VP returnerer ofte '' i stedet for NULL, hvilket bryder filtre som
-- WHERE etage IS NOT NULL (matcher '' = falsk filtrering af SFE-records).

UPDATE public.bfe_adresse_cache SET etage = NULL WHERE etage = '';
UPDATE public.bfe_adresse_cache SET doer = NULL WHERE doer = '';

-- Tilføj CHECK constraint så fremtidige inserts ikke kan have empty strings
ALTER TABLE public.bfe_adresse_cache
  ADD CONSTRAINT bfe_adresse_cache_etage_not_empty
  CHECK (etage IS NULL OR etage <> '');

ALTER TABLE public.bfe_adresse_cache
  ADD CONSTRAINT bfe_adresse_cache_doer_not_empty
  CHECK (doer IS NULL OR doer <> '');
