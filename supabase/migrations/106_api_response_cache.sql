-- ============================================================
-- Migration 106: API response cache tables
-- BIZZ-1319/1321/1322/1325/1326: Cache for langsomme eksterne API-kald
-- med 24h TTL. Bruges som read-through cache i API-routes.
--
-- Pattern: cache-first → live API fallback → write-back til cache.
-- Stale entries ryddes automatisk via /api/cron/purge-old-data.
-- ============================================================

-- ── 1. CVR adresse-cache (BIZZ-1319+1325) ────────────────────────────
-- Cacher CVR virksomheder fundet på en given adresse.
-- Key: adresse-hash (vejnavn+husnr+postnr). TTL: 24h.
CREATE TABLE IF NOT EXISTS public.cache_cvr_adresse (
  adresse_key   TEXT PRIMARY KEY,
  virksomheder  JSONB NOT NULL DEFAULT '[]',
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stale_after   TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_cache_cvr_adresse_stale
  ON public.cache_cvr_adresse (stale_after);

COMMENT ON TABLE public.cache_cvr_adresse IS
  'BIZZ-1319: Cache for CVR virksomheder per adresse. 24h TTL.';

-- ── 2. Plandata-cache (BIZZ-1321) ─────────────────────────────────────
-- Cacher lokalplan/kommuneplan/zone data per koordinat/adresse.
CREATE TABLE IF NOT EXISTS public.cache_plandata (
  bfe_nummer    INTEGER PRIMARY KEY,
  plandata      JSONB NOT NULL DEFAULT '{}',
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stale_after   TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_cache_plandata_stale
  ON public.cache_plandata (stale_after);

COMMENT ON TABLE public.cache_plandata IS
  'BIZZ-1321: Cache for plandata (lokalplan, zone) per BFE. 24h TTL.';

-- ── 3. Jordforurenings-cache (BIZZ-1322) ──────────────────────────────
-- Cacher jordforureningsdata per BFE/matrikel.
CREATE TABLE IF NOT EXISTS public.cache_jordforurening (
  bfe_nummer    INTEGER PRIMARY KEY,
  forurening    JSONB NOT NULL DEFAULT '{}',
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stale_after   TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_cache_jordforurening_stale
  ON public.cache_jordforurening (stale_after);

COMMENT ON TABLE public.cache_jordforurening IS
  'BIZZ-1322: Cache for jordforureningsdata per BFE. 24h TTL.';

-- ── 4. Ejerlejligheds-cache (BIZZ-1326) ──────────────────────────────
-- Cacher ejerlejligheder per moderejendom BFE.
CREATE TABLE IF NOT EXISTS public.cache_ejerlejligheder (
  bfe_nummer    INTEGER PRIMARY KEY,
  lejligheder   JSONB NOT NULL DEFAULT '[]',
  antal         INTEGER NOT NULL DEFAULT 0,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stale_after   TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_cache_ejerlejligheder_stale
  ON public.cache_ejerlejligheder (stale_after);

COMMENT ON TABLE public.cache_ejerlejligheder IS
  'BIZZ-1326: Cache for ejerlejligheder per moderejendom BFE. 24h TTL.';
