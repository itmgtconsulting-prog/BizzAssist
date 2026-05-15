-- ============================================================================
-- 125: Link cache_dar til bbr_ejendom_status via adgangsadresse_id — BIZZ-1467
-- Tilføj index på bbr_ejendom_status(adgangsadresse_id) for joins.
-- ============================================================================

-- Index for adresse-lookup (adgangsadresse_id bruges som FK til cache_dar)
CREATE INDEX IF NOT EXISTS idx_bbr_ejendom_adgangsadresse
  ON public.bbr_ejendom_status (adgangsadresse_id)
  WHERE adgangsadresse_id IS NOT NULL;

-- Bemærk: Vi tilføjer IKKE postnummer/vejnavn til bbr_ejendom_status.
-- I stedet bruger mv_ejendom_master join med cache_dar for adressedata.
-- Dette undgår data-duplikering og holder tabellen slank.

COMMENT ON INDEX idx_bbr_ejendom_adgangsadresse IS 'BIZZ-1467: Muliggør efficient join med cache_dar for adresse-opslag.';
