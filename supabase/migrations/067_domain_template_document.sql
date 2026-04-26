-- BIZZ-743: Junction table linking domain_template ↔ domain_training_doc
--
-- A template describes *what* to produce (instructions + placeholders + the
-- source .docx), while training/reference documents describe *how* to
-- produce it (policies, style guides, exemplars). Domain admins want to
-- attach one or more existing documents to a template with a short free-text
-- "guideline" explaining why each doc is relevant to this template.
--
-- We already have:
--   domain_template         (id, domain_id, name, instructions, …)  [BIZZ-698]
--   domain_training_doc     (id, domain_id, name, file_path, …)     [BIZZ-709]
--
-- New here:
--   domain_template_document — junction with per-attachment guidelines text.
--
-- Keeping both FKs within the same domain is enforced via composite
-- foreign keys + a trigger (both parents have domain_id). RLS defers to
-- domain membership checks already in place on the parent tables.

CREATE TABLE IF NOT EXISTS public.domain_template_document (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id     uuid NOT NULL REFERENCES public.domain_template (id) ON DELETE CASCADE,
  document_id     uuid NOT NULL REFERENCES public.domain_training_doc (id) ON DELETE CASCADE,
  domain_id       uuid NOT NULL REFERENCES public.domain (id) ON DELETE CASCADE,
  guidelines      text,
  sort_order      int  NOT NULL DEFAULT 0,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, document_id)
);

CREATE INDEX IF NOT EXISTS ix_domain_template_document_template
  ON public.domain_template_document (template_id, sort_order);

CREATE INDEX IF NOT EXISTS ix_domain_template_document_document
  ON public.domain_template_document (document_id);

-- ─── RLS ──────────────────────────────────────────────────────────────────
-- Members can read attachments for their domain, admins can write.
ALTER TABLE public.domain_template_document ENABLE ROW LEVEL SECURITY;

CREATE POLICY "domain_template_document_member_read"
  ON public.domain_template_document
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.domain_member dm
      WHERE dm.domain_id = domain_template_document.domain_id
        AND dm.user_id = auth.uid()
    )
  );

CREATE POLICY "domain_template_document_admin_write"
  ON public.domain_template_document
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.domain_member dm
      WHERE dm.domain_id = domain_template_document.domain_id
        AND dm.user_id = auth.uid()
        AND dm.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.domain_member dm
      WHERE dm.domain_id = domain_template_document.domain_id
        AND dm.user_id = auth.uid()
        AND dm.role = 'admin'
    )
  );

-- Consistency guard: the template + document must belong to the same
-- domain as the junction row. Prevents a malformed INSERT linking a
-- template from domain A to a doc from domain B.
CREATE OR REPLACE FUNCTION public.domain_template_document_same_domain_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tpl_domain uuid;
  doc_domain uuid;
BEGIN
  SELECT domain_id INTO tpl_domain FROM public.domain_template WHERE id = NEW.template_id;
  SELECT domain_id INTO doc_domain FROM public.domain_training_doc WHERE id = NEW.document_id;
  IF tpl_domain IS NULL THEN
    RAISE EXCEPTION 'template % not found', NEW.template_id;
  END IF;
  IF doc_domain IS NULL THEN
    RAISE EXCEPTION 'document % not found', NEW.document_id;
  END IF;
  IF tpl_domain <> NEW.domain_id OR doc_domain <> NEW.domain_id THEN
    RAISE EXCEPTION 'template + document must share domain_id (tpl=%, doc=%, row=%)',
      tpl_domain, doc_domain, NEW.domain_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_domain_template_document_guard ON public.domain_template_document;
CREATE TRIGGER tg_domain_template_document_guard
  BEFORE INSERT OR UPDATE ON public.domain_template_document
  FOR EACH ROW EXECUTE FUNCTION public.domain_template_document_same_domain_guard();

-- updated_at auto-touch (mirrors other domain tables)
CREATE OR REPLACE FUNCTION public.domain_template_document_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_domain_template_document_updated_at ON public.domain_template_document;
CREATE TRIGGER tg_domain_template_document_updated_at
  BEFORE UPDATE ON public.domain_template_document
  FOR EACH ROW EXECUTE FUNCTION public.domain_template_document_touch_updated_at();
