-- BIZZ-788: Expand file_type support to all formats Claude can consume.
--
-- Original CHECK constraints were narrow:
--   domain_template.file_type IN ('docx','pdf','txt')
--   domain_case_doc.file_type IN ('docx','pdf','txt','eml','msg')
--
-- We now support the full Claude-readable surface: docx, xlsx, pptx, rtf,
-- pdf, txt, md, html, csv, tsv, json, xml, yaml, log, code, eml, msg, image.
-- Mapping is enforced at the API layer via resolveFileType() in
-- app/lib/domainFileTypes.ts — this migration simply relaxes the DB
-- constraint so the insert doesn't reject valid types.
--
-- Safe to run multiple times: we DROP the constraint if it exists and then
-- recreate with the broader set.

-- ─── domain_template ─────────────────────────────────────────────────────
ALTER TABLE public.domain_template
  DROP CONSTRAINT IF EXISTS domain_template_file_type_check;

ALTER TABLE public.domain_template
  ADD CONSTRAINT domain_template_file_type_check
  CHECK (file_type IN (
    'docx','xlsx','pptx','rtf',
    'pdf',
    'txt','md','html','csv','tsv','json','xml','yaml','log','code',
    'eml','msg',
    'image'
  ));

-- ─── domain_case_doc ─────────────────────────────────────────────────────
ALTER TABLE public.domain_case_doc
  DROP CONSTRAINT IF EXISTS domain_case_doc_file_type_check;

ALTER TABLE public.domain_case_doc
  ADD CONSTRAINT domain_case_doc_file_type_check
  CHECK (file_type IN (
    'docx','xlsx','pptx','rtf',
    'pdf',
    'txt','md','html','csv','tsv','json','xml','yaml','log','code',
    'eml','msg',
    'image'
  ));

-- domain_training_doc does not have a file_type column (extracted_text is
-- the only content-bearing field), so no change needed there.

COMMENT ON CONSTRAINT domain_template_file_type_check ON public.domain_template
  IS 'BIZZ-788: expanded to full Claude-readable surface';
COMMENT ON CONSTRAINT domain_case_doc_file_type_check ON public.domain_case_doc
  IS 'BIZZ-788: expanded to full Claude-readable surface';
