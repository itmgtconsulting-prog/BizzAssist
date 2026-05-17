-- ============================================================================
-- 134: Tilføj 'fejl' status til tinglysning_anmeldelse — BIZZ-1522
-- ============================================================================
-- FejlService callback fra Tinglysningsretten markerer en anmeldelse som fejlet.
-- Vi tilføjer 'fejl' til status-enum + dedikerede fejl-felter (fejl_modtaget_at,
-- fejl_kode) ud over den eksisterende error_message.
-- ============================================================================

-- Hop forbi hvis tabellen ikke findes (migration 130 ikke applied i dev)
DO $$
BEGIN
  IF to_regclass('public.tinglysning_anmeldelse') IS NULL THEN
    RAISE NOTICE 'tinglysning_anmeldelse findes ikke — skipper migration 134';
    RETURN;
  END IF;
END $$;

-- Drop existing check + recreate med 'fejl' tilføjet
ALTER TABLE IF EXISTS public.tinglysning_anmeldelse
  DROP CONSTRAINT IF EXISTS tinglysning_anmeldelse_status_check;

ALTER TABLE IF EXISTS public.tinglysning_anmeldelse
  ADD CONSTRAINT tinglysning_anmeldelse_status_check
  CHECK (status IN (
    'draft',
    'preview',
    'pending_signature',
    'submitted',
    'accepted',
    'rejected',
    'cancelled',
    'fejl'
  ));

-- Tilføj fejl-specifikke felter hvis ikke allerede til stede
ALTER TABLE IF EXISTS public.tinglysning_anmeldelse
  ADD COLUMN IF NOT EXISTS fejl_modtaget_at TIMESTAMPTZ;

ALTER TABLE IF EXISTS public.tinglysning_anmeldelse
  ADD COLUMN IF NOT EXISTS fejl_kode TEXT;

COMMENT ON COLUMN public.tinglysning_anmeldelse.fejl_modtaget_at IS
  'BIZZ-1522: Tidspunkt for modtaget FejlService callback fra Tinglysning.';
COMMENT ON COLUMN public.tinglysning_anmeldelse.fejl_kode IS
  'BIZZ-1522: Fejlkode fra Tinglysning FejlSvar (fx VAL-001).';
