-- Migration 177: Genopret korrekt scoped read-policy (BIZZ-2104)
-- Live-DB'erne var driftet: policyen havde et ekstra "OR visibility='domain'"
-- som gjorde ALLE domain-delte docs synlige for enhver authenticated bruger
-- (en workaround fra dengang added_by_domain indeholdt tenant_id og deling
-- derfor aldrig matchede). Efter migration 176 indeholder added_by_domain
-- ægte domain_id, så policyen skal være domain-scoped som i migration 164.

DROP POLICY IF EXISTS "forsikring_standard_doc: read scoped" ON forsikring_standard_doc;
CREATE POLICY "forsikring_standard_doc: read scoped"
  ON forsikring_standard_doc FOR SELECT TO authenticated
  USING (
    visibility = 'curated'
    OR added_by_user = auth.uid()
    OR (visibility = 'domain' AND added_by_domain IN (
      SELECT domain_id FROM domain_member WHERE user_id = auth.uid()
    ))
  );
