-- BIZZ-1850: Tilføj 'unresolvable' marker til bfe_adresse_cache for at undgå
-- evig cron-retry-loop på BFE'er hvor alle 3 fallbacks (DAWA /bfe, VP, jordstykke) fejler.
--
-- ─ Hvorfor ─
-- sync-bfe-adresse cron filtrerer "missing" BFE'er som dem der enten
-- (a) ikke har en cache-row, eller (b) har postnr=NULL.
-- BFE'er der permanent ikke kan resolves (typisk slettede/aldrig-eksisterede)
-- bliver retried hver dag for evigt og spiser af de 50 daglige slots.
--
-- ─ Strategi ─
-- Backfill-script og cron indsætter en row med postnr=NULL og kilde='unresolvable'
-- når alle 3 fallbacks fejler. Cron'en udelukker derefter rows med kilde='unresolvable'
-- (med en quarterly opt-in retry via column 'next_retry_after').
--
-- @migration 158
-- @bizz 1850

-- 1. Tilføj next_retry_after kolonne — bruges til at re-try unresolvable BFE'er hver 90 dage
ALTER TABLE bfe_adresse_cache
ADD COLUMN IF NOT EXISTS next_retry_after timestamp with time zone;

-- 2. Index til hurtig opslag i cron — finder rows klar til retry
CREATE INDEX IF NOT EXISTS idx_bfe_adresse_cache_unresolvable_retry
ON bfe_adresse_cache (next_retry_after)
WHERE kilde = 'unresolvable';

COMMENT ON COLUMN bfe_adresse_cache.next_retry_after IS
'BIZZ-1850: For kilde=unresolvable, hvornår cron må forsøge igen (default +90d). NULL for alle andre kilder.';
