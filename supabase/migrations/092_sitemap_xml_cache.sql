-- ============================================================
-- Migration 092: sitemap_xml_cache — pre-rendered sitemap XML
-- BizzAssist — BIZZ-890: Fix Google indexing (sitemap timeout)
--
-- Stores pre-generated XML for each sitemap page (0.xml, 1.xml, …).
-- Populated by /api/cron/generate-sitemap?phase=render-xml.
-- Served by /sitemap/[id] route for instant responses to crawlers.
--
-- Retention: permanent (public sitemap data, no PII).
-- No tenant_id: global public-facing index.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.sitemap_xml_cache (
  page_id       int          PRIMARY KEY,
  xml           text         NOT NULL,
  entry_count   int          NOT NULL DEFAULT 0,
  generated_at  timestamptz  NOT NULL DEFAULT now()
);

-- RLS: public read-only (sitemap XML is public by nature)
ALTER TABLE public.sitemap_xml_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sitemap_xml_cache_select_all"
  ON public.sitemap_xml_cache FOR SELECT
  TO anon, authenticated
  USING (true);

-- Write access only via service-role (cron routes)
