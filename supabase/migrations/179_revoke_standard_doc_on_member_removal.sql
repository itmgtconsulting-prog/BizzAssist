-- BIZZ-2107: Revoke domain-deling af standard betingelser når et medlemskab
-- fjernes fra domain_member — uanset HVORDAN det fjernes (route-DELETE,
-- ON DELETE CASCADE ved domain-sletning, manuel SQL). Route-hooks dækker kun
-- API-stien, så en DB-trigger sikrer invarianten alle veje:
-- den fjernedes docs demotes til private, så domainets øvrige medlemmer
-- ikke længere ser dem.
CREATE OR REPLACE FUNCTION revoke_standard_doc_on_member_removal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE forsikring_standard_doc
     SET visibility = 'private',
         added_by_domain = NULL
   WHERE added_by_user = OLD.user_id
     AND added_by_domain = OLD.domain_id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_revoke_standard_doc_on_member_removal ON domain_member;
CREATE TRIGGER trg_revoke_standard_doc_on_member_removal
  AFTER DELETE ON domain_member
  FOR EACH ROW
  EXECUTE FUNCTION revoke_standard_doc_on_member_removal();
