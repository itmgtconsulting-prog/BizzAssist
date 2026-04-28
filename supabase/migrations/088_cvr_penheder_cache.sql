-- BIZZ-1095: Cache CVR P-enheder i cvr_virksomhed tabel
-- Undgår live ES-kald for produktionsenheder per virksomhed.

-- Tjek om tabellen eksisterer (den er oprettet i ældre migration)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'cvr_virksomhed') THEN
    ALTER TABLE public.cvr_virksomhed ADD COLUMN IF NOT EXISTS penheder JSONB;
    ALTER TABLE public.cvr_virksomhed ADD COLUMN IF NOT EXISTS penheder_fetched_at TIMESTAMPTZ;
    COMMENT ON COLUMN public.cvr_virksomhed.penheder IS 'BIZZ-1095: Cached P-enheder (produktionsenheder) som JSONB array';
  END IF;
END $$;
