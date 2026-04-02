-- ============================================================
-- Migration 013: Verified social/web links for entities
-- BizzAssist — Crowdsourced link verification
-- ============================================================
-- Adds:
--   1. verified_links — stores discovered links for companies/persons
--   2. link_verifications — tracks which users verified which links
--
-- Links are auto-discovered (LinkedIn, Facebook, website etc.)
-- and can be verified by users. Verification count shows confidence.
-- ============================================================

-- ── 1. Verified links table ─────────────────────────────────
-- One row per discovered link for an entity (company or person).

CREATE TABLE IF NOT EXISTS public.verified_links (
  id            uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  entity_type   text        NOT NULL CHECK (entity_type IN ('company', 'person')),
  entity_id     text        NOT NULL,  -- CVR number for companies, enhedsNummer for persons
  entity_name   text        NOT NULL,  -- Display name (for reference)
  platform      text        NOT NULL,  -- 'linkedin', 'facebook', 'instagram', 'website', 'twitter', 'virk'
  url           text        NOT NULL,
  verify_count  integer     NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- Prevent duplicate links for same entity+platform+url
  UNIQUE (entity_type, entity_id, platform, url)
);

COMMENT ON TABLE public.verified_links IS
  'Crowdsourced social/web links for companies and persons. Users verify correctness.';

ALTER TABLE public.verified_links ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can read links
CREATE POLICY "verified_links: read all"
  ON public.verified_links FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Anyone authenticated can insert new links
CREATE POLICY "verified_links: insert"
  ON public.verified_links FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- Only service_role can update (verify_count incremented via API)
CREATE POLICY "verified_links: update service"
  ON public.verified_links FOR UPDATE
  USING (true);

-- Index for fast entity lookups
CREATE INDEX IF NOT EXISTS idx_verified_links_entity
  ON public.verified_links (entity_type, entity_id);


-- ── 2. Link verifications table ─────────────────────────────
-- Tracks which user verified which link (prevents double-voting).

CREATE TABLE IF NOT EXISTS public.link_verifications (
  id          uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  link_id     uuid        NOT NULL REFERENCES public.verified_links(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),

  -- Each user can only verify a link once
  UNIQUE (link_id, user_id)
);

COMMENT ON TABLE public.link_verifications IS
  'Tracks which users have verified which links. Prevents duplicate votes.';

ALTER TABLE public.link_verifications ENABLE ROW LEVEL SECURITY;

-- Users can read their own verifications
CREATE POLICY "link_verifications: read own"
  ON public.link_verifications FOR SELECT
  USING (auth.uid() = user_id);

-- Users can insert their own verifications
CREATE POLICY "link_verifications: insert own"
  ON public.link_verifications FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Index for fast lookup
CREATE INDEX IF NOT EXISTS idx_link_verifications_user
  ON public.link_verifications (user_id, link_id);
