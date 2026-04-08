-- ============================================================
-- Migration 037: sitemap_entries — SEO sitemap cache
-- BizzAssist — BIZZ-XXX: Sitemap generation cron
--
-- Stores pre-generated slug + entity_id pairs for:
--   /ejendom/[slug]/[bfe]    (type = 'ejendom')
--   /virksomhed/[slug]/[cvr] (type = 'virksomhed')
--
-- Populated by /api/cron/generate-sitemap (weekly Sunday cron).
-- Served by app/sitemap.ts via generateSitemaps() pagination.
--
-- Retention: permanent (sitemap data has no PII, no user association).
-- No tenant_id: this is a global public-facing index.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.sitemap_entries (
  id          uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  type        text        NOT NULL CHECK (type IN ('ejendom', 'virksomhed')),
  slug        text        NOT NULL,
  entity_id   text        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (type, entity_id)
);

-- Index for paginated sitemap reads ordered by updated_at DESC
CREATE INDEX IF NOT EXISTS sitemap_entries_type_updated_idx
  ON public.sitemap_entries (type, updated_at DESC);

-- RLS: public read-only (sitemap data is public by nature)
ALTER TABLE public.sitemap_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sitemap_entries_select_all"
  ON public.sitemap_entries FOR SELECT
  TO anon, authenticated
  USING (true);

-- Write access only via service-role (cron routes) — no user-level insert/update
