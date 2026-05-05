-- ============================================================
-- Migration 082: Data cache infrastruktur
-- BIZZ-912: Cache-tabeller for lokal kopi af eksterne datakilder.
--
-- Tabeller:
--   data_sync_status — monitorering af sync-jobs
--   cache_bbr        — BBR bygninger + enheder (JSONB)
--   cache_cvr        — CVR virksomheder (JSONB)
--   cache_dar        — DAR adresser (JSONB)
--   cache_vur        — VUR ejendomsvurderinger (JSONB)
--
-- Design:
--   - JSONB raw_data med GIN-index for fleksibel søgning
--   - source_id som primærnøgle (BFE, CVR, adresse-UUID)
--   - synced_at + source_hash for incremental sync
--   - Public schema (delt data, ikke tenant-isoleret)
--   - Partitionering parkeret til BIZZ-921 (hosting-beslutning)
-- ============================================================

-- ── Sync status (monitorering) ──────────────────────────────

CREATE TABLE IF NOT EXISTS public.data_sync_status (
  source_name   TEXT PRIMARY KEY,  -- fx 'bbr', 'cvr', 'dar', 'vur'
  last_sync_at  TIMESTAMPTZ,
  last_success  TIMESTAMPTZ,
  rows_synced   BIGINT DEFAULT 0,
  rows_total    BIGINT DEFAULT 0,
  last_error    TEXT,
  sync_duration_ms INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.data_sync_status IS
  'BIZZ-912: Monitoreringstabel for data-sync jobs. Én row per datakilde.';

-- ── BBR cache (bygninger + enheder) ─────────────────────────

CREATE TABLE IF NOT EXISTS public.cache_bbr (
  bfe_nummer    BIGINT PRIMARY KEY,
  raw_data      JSONB NOT NULL,
  source_hash   TEXT,            -- SHA-256 af raw_data for change-detection
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cache_bbr_synced
  ON public.cache_bbr (synced_at DESC);
CREATE INDEX IF NOT EXISTS idx_cache_bbr_gin
  ON public.cache_bbr USING gin(raw_data jsonb_path_ops);

COMMENT ON TABLE public.cache_bbr IS
  'BIZZ-912: Lokal BBR-cache. Nøgle: BFE-nummer. Data: bygninger, enheder, etager.';

-- ── CVR cache (virksomheder) ────────────────────────────────

CREATE TABLE IF NOT EXISTS public.cache_cvr (
  cvr_nummer    INTEGER PRIMARY KEY,
  raw_data      JSONB NOT NULL,
  source_hash   TEXT,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cache_cvr_synced
  ON public.cache_cvr (synced_at DESC);
CREATE INDEX IF NOT EXISTS idx_cache_cvr_gin
  ON public.cache_cvr USING gin(raw_data jsonb_path_ops);
-- Navn-søgning via GIN trigram (kræver pg_trgm extension)
CREATE INDEX IF NOT EXISTS idx_cache_cvr_name
  ON public.cache_cvr USING gin(((raw_data->>'name')::text) gin_trgm_ops);

COMMENT ON TABLE public.cache_cvr IS
  'BIZZ-912: Lokal CVR-cache. Nøgle: CVR-nummer. Data: virksomhed, ejere, produktionsenheder.';

-- ── DAR cache (adresser) ────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.cache_dar (
  adresse_id    UUID PRIMARY KEY,  -- DAWA/DAR adgangsadresse UUID
  raw_data      JSONB NOT NULL,
  source_hash   TEXT,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cache_dar_synced
  ON public.cache_dar (synced_at DESC);
CREATE INDEX IF NOT EXISTS idx_cache_dar_gin
  ON public.cache_dar USING gin(raw_data jsonb_path_ops);

COMMENT ON TABLE public.cache_dar IS
  'BIZZ-912: Lokal DAR-adresse-cache. Nøgle: DAWA adgangsadresse UUID.';

-- ── VUR cache (ejendomsvurderinger) ─────────────────────────

CREATE TABLE IF NOT EXISTS public.cache_vur (
  bfe_nummer    BIGINT PRIMARY KEY,
  raw_data      JSONB NOT NULL,    -- Alle vurderingsår + fordeling + loft + fritagelser
  source_hash   TEXT,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cache_vur_synced
  ON public.cache_vur (synced_at DESC);
CREATE INDEX IF NOT EXISTS idx_cache_vur_gin
  ON public.cache_vur USING gin(raw_data jsonb_path_ops);

COMMENT ON TABLE public.cache_vur IS
  'BIZZ-912: Lokal VUR-cache. Nøgle: BFE-nummer. Data: alle vurderingsår + skattekomponenter.';

-- ── Initial sync status rows ────────────────────────────────

INSERT INTO public.data_sync_status (source_name)
VALUES ('bbr'), ('cvr'), ('dar'), ('vur'), ('ejf')
ON CONFLICT (source_name) DO NOTHING;
