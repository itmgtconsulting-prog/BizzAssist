-- ============================================================
-- Migration 108: Forsikrings-modul accepterer alle filtyper
-- ============================================================
-- Migration 107 begrænsede storage bucket `forsikring-documents`
-- til application/pdf only. Vi udvider nu til alle filtyper Claude
-- og vores domainTextExtraction-pipeline kan håndtere:
--
--   - PDF        (pdf-parse)
--   - DOCX       (mammoth)
--   - XLSX/XLS   (exceljs)
--   - PPTX       (jszip + xml-parser)
--   - RTF        (regex-strip)
--   - HTML       (regex-strip)
--   - Plain text (txt, md, csv, tsv, json, xml, yaml, log)
--   - EML        (mailparser)
--   - Images     (Claude vision: png, jpg, gif, webp)
--
-- Begrænsninger der bevares:
--   - private bucket (kun service_role)
--   - max 20 MB pr. fil
--
-- Idempotent: ON CONFLICT DO UPDATE.
-- ============================================================

UPDATE storage.buckets
SET
  allowed_mime_types = ARRAY[
    -- Documents
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', -- docx
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       -- xlsx
    'application/vnd.openxmlformats-officedocument.presentationml.presentation', -- pptx
    'application/vnd.ms-excel',                                                 -- xls
    'application/msword',                                                       -- doc
    'application/rtf',
    'text/rtf',
    -- Plain text family
    'text/plain',
    'text/markdown',
    'text/html',
    'text/csv',
    'text/tab-separated-values',
    'application/json',
    'application/xml',
    'text/xml',
    'application/yaml',
    'text/yaml',
    -- Email
    'message/rfc822',
    'application/vnd.ms-outlook',
    -- Images (Claude vision)
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp'
  ]::text[]
WHERE id = 'forsikring-documents';

COMMENT ON TABLE storage.buckets IS
  'BIZZ-FORSIKRING: forsikring-documents bucket udvidet i migration 108 til '
  'at acceptere alle filtyper domainTextExtraction kan håndtere + Claude '
  'vision-supportede billeder. Max 20MB pr. fil.';
