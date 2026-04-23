-- BIZZ-785 iter 2a: berigelse-tabel for ejendom-status.
--
-- Tidligere var "Skjul udfasede"-filteret klient-side kun: vi pipede
-- DAR_Husnummer.status gennem DawaAutocompleteResult, men det signal
-- er upålideligt (Plandata zone="Udfaset" betyder bare "zone-polygon
-- er historisk", ikke "bygning er nedrevet" — se BIZZ-787). Korrekt
-- signal er BBR bygning-status for BFE'en.
--
-- Denne migration opretter en enrichment-tabel som backfill-scriptet
-- og cron-refresh populerer. `/api/adresse/autocomplete` joiner på
-- adgangsadresse_id så udfasede ejendomme kan filtreres server-side
-- uden at hvert autocomplete-keystroke kalder BBR.
--
-- Access pattern:
--   * Read: JOIN på adgangsadresse_id når DAR autocomplete returnerer
--     et DAR_Husnummer UUID. Missing row = ukendt → vis som aktiv.
--   * Write: UPSERT fra backfill-script / cron / BBR-push-abo.
--
-- Retention: permanent (mirror af live BBR). Ingen user-data — ingen
-- cascade-delete ved tenant-sletning. Ikke PII.

CREATE TABLE IF NOT EXISTS public.bbr_ejendom_status (
  -- BFE-nummer fra BBR (primærnøgle, ikke auto-increment)
  bfe_nummer BIGINT PRIMARY KEY,
  -- DAR adgangsadresse UUID — join-nøgle fra autocomplete-resultater
  adgangsadresse_id UUID,
  -- Konsolideret flag: true hvis alle bygninger på ejendommen har
  -- BBR-status ∈ {4, 10, 11} (Nedrevet/slettet, Bygning nedrevet,
  -- Bygning bortfaldet). Populated af backfill per BIZZ-787-logik.
  is_udfaset BOOLEAN NOT NULL DEFAULT false,
  -- Rå BBR bygning-status-kode for den primære bygning (når der kun
  -- er én). NULL for multi-bygning eller uden BBR-data.
  bbr_status_code SMALLINT,
  -- Kommune-kode (DAWA 4-cifret) til fremtidige kommune-filtre.
  kommune_kode SMALLINT,
  -- Hvornår BBR sidst blev slået op. Cron refresher når rækken er
  -- ældre end ~7 dage (defineret i cron-script).
  status_last_checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Search-filter: WHERE is_udfaset = false (indexeret for <5ms response)
CREATE INDEX IF NOT EXISTS bbr_ejendom_status_is_udfaset_idx
  ON public.bbr_ejendom_status (is_udfaset);

-- Join fra autocomplete-resultater (DAR_Husnummer.id_lokalId → adgangsadresse_id)
CREATE INDEX IF NOT EXISTS bbr_ejendom_status_adresse_idx
  ON public.bbr_ejendom_status (adgangsadresse_id)
  WHERE adgangsadresse_id IS NOT NULL;

-- Geografi-filtre på kommune
CREATE INDEX IF NOT EXISTS bbr_ejendom_status_kommune_idx
  ON public.bbr_ejendom_status (kommune_kode)
  WHERE kommune_kode IS NOT NULL;

-- Stale-detection for cron-refresh: find rækker ældre end X uden
-- allerede-udfaset flag (udfasede opdateres sjældent igen).
CREATE INDEX IF NOT EXISTS bbr_ejendom_status_stale_idx
  ON public.bbr_ejendom_status (status_last_checked_at)
  WHERE is_udfaset = false;

-- RLS: Tabellen indeholder ingen tenant-specifik data og er read-only
-- for klienter. Service-rolen har adgang via SUPABASE_SERVICE_ROLE_KEY
-- (cron + backfill-script). Klienter læser via API-routes der bruger
-- admin client — så tabellen har ingen RLS-policy for anon/authenticated.
ALTER TABLE public.bbr_ejendom_status ENABLE ROW LEVEL SECURITY;

-- Lad service_role få fri adgang (backfill + cron)
CREATE POLICY "Service role full access"
  ON public.bbr_ejendom_status
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Tillad autenticerede brugere at læse (for at kunne vise is_udfaset
-- i klient-side komponenter hvis vi senere vil det)
CREATE POLICY "Authenticated read-only"
  ON public.bbr_ejendom_status
  FOR SELECT
  TO authenticated
  USING (true);

COMMENT ON TABLE public.bbr_ejendom_status IS
  'BIZZ-785 iter 2a: enrichment for ejendom-status. Mirror af live BBR, populated af backfill-script (scripts/backfill-bbr-status.mjs) og cron-refresh. Joines fra autocomplete via adgangsadresse_id så "Skjul udfasede"-filtret kan køre server-side.';
