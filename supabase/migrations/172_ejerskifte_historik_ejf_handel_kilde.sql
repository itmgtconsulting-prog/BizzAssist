-- ============================================================
-- Migration 171: Tillad 'ejf_handel' som historisk_kilde i
-- ejerskifte_historik.
--
-- BIZZ-2053: ejerskifte_historik mangler handler som findes i
-- v_ejerskifte_handel (EJF). Backfill-cron'en
-- /api/cron/backfill-ejerskifte-handel indsætter manglende handler
-- direkte fra ejf_ejerskifte + ejf_handelsoplysninger (DB→DB, ingen
-- ekstern API). De nye rækker tagges med historisk_kilde='ejf_handel'
-- så de kan skelnes fra de Tinglysning-berigede rækker
-- ('rest_summarisk' / 'xml_historisk_adkomst').
--
-- CHECK-constrainten på historisk_kilde tillod kun de to gamle værdier,
-- så et INSERT med 'ejf_handel' ville fejle. Denne migration udvider
-- whitelisten.
-- ============================================================

ALTER TABLE public.ejerskifte_historik
  DROP CONSTRAINT IF EXISTS ejerskifte_historik_historisk_kilde_check;

ALTER TABLE public.ejerskifte_historik
  ADD CONSTRAINT ejerskifte_historik_historisk_kilde_check
  CHECK (historisk_kilde = ANY (ARRAY[
    'rest_summarisk'::text,
    'xml_historisk_adkomst'::text,
    'ejf_handel'::text
  ]));
