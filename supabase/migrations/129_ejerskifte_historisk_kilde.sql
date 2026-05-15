-- ============================================================================
-- 129: Tilføj historisk_kilde til ejerskifte_historik — BIZZ-1494 (Trin 3)
-- Skelner mellem priser fra REST (kun aktiv) og XML API (historiske).
-- ============================================================================

ALTER TABLE public.ejerskifte_historik
  ADD COLUMN IF NOT EXISTS historisk_kilde TEXT
  CHECK (historisk_kilde IN ('rest_summarisk', 'xml_historisk_adkomst'));

-- Eksisterende rækker er fra REST/EJF
UPDATE public.ejerskifte_historik
SET historisk_kilde = 'rest_summarisk'
WHERE historisk_kilde IS NULL;

COMMENT ON COLUMN public.ejerskifte_historik.historisk_kilde IS 'BIZZ-1494: rest_summarisk = fra REST API, xml_historisk_adkomst = fra XML S2S API';
