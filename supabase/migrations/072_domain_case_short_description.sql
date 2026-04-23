-- BIZZ-809: short_description column på domain_case.
--
-- Kort beskrivelse af sagen (2-3 linjer preview, max 200 tegn) der vises
-- på sagskort i listen + editable i detail-panelet og CreateCaseModal.
-- Gør sagslisten mere informativ uden at skulle klikke ind i detaljer.
--
-- Iter 2 (parkeret): entity-tags på cards (personer/virksomheder/ejendomme)
-- kræver enten normalisering (ny join-tabel) eller JSONB-array. Denne
-- migration touches ikke det scope.

ALTER TABLE public.domain_case
  ADD COLUMN IF NOT EXISTS short_description TEXT;

-- Check constraint: max 200 tegn matcher UI-truncate + form-validation
ALTER TABLE public.domain_case
  DROP CONSTRAINT IF EXISTS domain_case_short_description_length_check;
ALTER TABLE public.domain_case
  ADD CONSTRAINT domain_case_short_description_length_check
  CHECK (short_description IS NULL OR char_length(short_description) <= 200);

COMMENT ON COLUMN public.domain_case.short_description IS
  'BIZZ-809: Kort beskrivelse (max 200 tegn) vist som preview på sagskort. Null = ingen beskrivelse.';
