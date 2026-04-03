-- ============================================================
-- Migration 015: Link Alternatives
-- BizzAssist — AI-fundne alternative URLs per platform per CVR
-- ============================================================
-- Gemmer alternative sociale medier-links returneret af Claude
-- under artikel-søgning. Ét sæt alternativer per (cvr, platform).
--
-- Adskilt fra link_verifications (som er per-bruger-verdicts).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.link_alternatives (
  id           uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  cvr          text        NOT NULL,
  platform     text        NOT NULL,
  alternatives jsonb       NOT NULL DEFAULT '[]',
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT link_alternatives_cvr_platform_unique UNIQUE (cvr, platform)
);

COMMENT ON TABLE public.link_alternatives IS
  'AI-fundne alternative URLs per platform per CVR. Én række per (cvr, platform).';

CREATE INDEX IF NOT EXISTS idx_link_alt_cvr ON public.link_alternatives (cvr);

-- ── Row Level Security ──────────────────────────────────────

ALTER TABLE public.link_alternatives ENABLE ROW LEVEL SECURITY;

-- Alle autentificerede brugere kan læse alternativer
CREATE POLICY "link_alternatives: read authenticated"
  ON public.link_alternatives FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Alle autentificerede brugere kan indsætte/opdatere alternativer (AI-genererede, ikke personlige)
CREATE POLICY "link_alternatives: upsert authenticated"
  ON public.link_alternatives FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "link_alternatives: update authenticated"
  ON public.link_alternatives FOR UPDATE
  USING (auth.uid() IS NOT NULL);
