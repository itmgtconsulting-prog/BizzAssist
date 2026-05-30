-- ============================================================
-- Migration 157: Forsikring Standard Dokumenter
-- BizzAssist — Delte standard forsikringsbetingelser på tværs af tenants
-- BIZZ-1833
-- ============================================================
-- Adds:
--   1. forsikring_standard_doc — delt tabel for standard betingelser
--   2. forsikring_analyse_standard_docs — junction til analyser
-- ============================================================


-- ── 1. Standard forsikringsbetingelser (delt på tværs af tenants) ───

CREATE TABLE IF NOT EXISTS public.forsikring_standard_doc (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  selskab         text        NOT NULL,
  kategori        text        NOT NULL,
  titel           text        NOT NULL,
  source_url      text        NOT NULL,
  content_hash    text        NOT NULL,
  raw_content     text,
  parsed_at       timestamptz,
  added_via       text        NOT NULL CHECK (added_via IN (
    'ai_discovery', 'manual_link', 'bizzassist_curated', 'domain_curated'
  )),
  added_by_user   uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  added_by_domain uuid,
  verified        boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (content_hash)
);

COMMENT ON TABLE public.forsikring_standard_doc IS
  'Delte standard forsikringsbetingelser. Genbruges på tværs af tenants og domains.';

CREATE INDEX idx_fsd_selskab ON public.forsikring_standard_doc (selskab, kategori);
CREATE INDEX idx_fsd_added_via ON public.forsikring_standard_doc (added_via);

ALTER TABLE public.forsikring_standard_doc ENABLE ROW LEVEL SECURITY;

-- Alle authenticated brugere kan læse standard-docs (delt ressource)
CREATE POLICY "forsikring_standard_doc: read authenticated"
  ON public.forsikring_standard_doc FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Brugere kan tilføje nye standard-docs
CREATE POLICY "forsikring_standard_doc: insert authenticated"
  ON public.forsikring_standard_doc FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);


-- ── 2. Junction: standard-docs valgt til en analyse ─────────────

CREATE TABLE IF NOT EXISTS public.forsikring_analyse_standard_docs (
  analyse_id      uuid        NOT NULL,
  standard_doc_id uuid        NOT NULL REFERENCES public.forsikring_standard_doc(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (analyse_id, standard_doc_id)
);

COMMENT ON TABLE public.forsikring_analyse_standard_docs IS
  'Junction: hvilke standard-docs er valgt til en forsikringsanalyse.';

ALTER TABLE public.forsikring_analyse_standard_docs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "forsikring_analyse_std: read authenticated"
  ON public.forsikring_analyse_standard_docs FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "forsikring_analyse_std: insert authenticated"
  ON public.forsikring_analyse_standard_docs FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "forsikring_analyse_std: delete authenticated"
  ON public.forsikring_analyse_standard_docs FOR DELETE
  USING (auth.uid() IS NOT NULL);
