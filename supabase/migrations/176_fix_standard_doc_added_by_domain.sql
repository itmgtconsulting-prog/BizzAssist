-- Migration 176: Ret added_by_domain på forsikring_standard_doc (BIZZ-2104)
-- Skrive-routes gemte auth.tenantId i added_by_domain, men RLS-policyen
-- (migration 164) matcher mod domain_member.domain_id — så domain-deling
-- virkede aldrig. Remap eksisterende rækker til uploaderens ægte domain_id;
-- rækker hvor uploaderen ikke (længere) er domain-medlem bliver private.

-- 1) Remap: added_by_domain → uploaderens domain_id hvor kolonnen i dag
--    indeholder et id der IKKE er et rigtigt domain (dvs. et tenant_id).
--    Ved multi-domain-medlemskab vælges ældste medlemskab (invited_at).
UPDATE forsikring_standard_doc d
SET added_by_domain = sub.domain_id
FROM (
  SELECT DISTINCT ON (user_id) user_id, domain_id
  FROM domain_member
  ORDER BY user_id, invited_at
) sub
WHERE d.added_by_user = sub.user_id
  AND (
    d.added_by_domain IS NULL
    OR NOT EXISTS (SELECT 1 FROM domain dom WHERE dom.id = d.added_by_domain)
  );

-- 2) Ryd op: NULL i added_by_domain hvor værdien stadig ikke er et rigtigt
--    domain (uploader uden domain-medlemskab eller ukendt uploader).
UPDATE forsikring_standard_doc d
SET added_by_domain = NULL
WHERE d.added_by_domain IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM domain dom WHERE dom.id = d.added_by_domain);

-- 3) Demote: domain-delte rækker uden gyldig domain-reference bliver private.
UPDATE forsikring_standard_doc d
SET visibility = 'private'
WHERE d.visibility = 'domain'
  AND d.added_by_domain IS NULL;
