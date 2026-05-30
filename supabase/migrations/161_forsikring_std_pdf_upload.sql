-- Migration 161: Tilføj pdf_upload som tilladt added_via-værdi
-- BIZZ-1890: Standard betingelser PDF upload feature
-- Brugere kan nu uploade PDF-filer med standard forsikringsbetingelser
-- direkte i stedet for kun at linke til web-URLs.

-- PostgreSQL CHECK constraint kan ikke ændres in-place — vi dropper og recreater.
ALTER TABLE public.forsikring_standard_doc
  DROP CONSTRAINT IF EXISTS forsikring_standard_doc_added_via_check;

ALTER TABLE public.forsikring_standard_doc
  ADD CONSTRAINT forsikring_standard_doc_added_via_check
  CHECK (added_via IN (
    'ai_discovery',
    'manual_link',
    'bizzassist_curated',
    'domain_curated',
    'pdf_upload',
    'auto_detected'
  ));

COMMENT ON COLUMN public.forsikring_standard_doc.added_via IS
  'Kilde: ai_discovery (AI), manual_link (URL), pdf_upload (fil), auto_detected (fra police-docs), bizzassist_curated, domain_curated.';
