/**
 * BIZZ-2104: Domain-opslag for standard forsikringsbetingelser.
 *
 * RLS-policyen for forsikring_standard_doc (migration 164, BIZZ-1907) deler
 * visibility='domain'-docs via added_by_domain IN (brugerens domain_member-
 * domains). Skrive-routes gemte fejlagtigt auth.tenantId i added_by_domain
 * (tenant_id ≠ domain_id), så delingen aldrig virkede. Disse helpers slår
 * brugerens ÆGTE domain_id op og afgør slet/ret-rettigheder.
 *
 * @module app/lib/forsikring/standardDocDomain
 */

import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Slår brugerens domain-medlemskab op i domain_member.
 *
 * Returnerer det første domain brugeren er medlem af (ordnet efter
 * invited_at, så ældste medlemskab vinder ved multi-domain). Null hvis
 * brugeren ikke er i et domain → dokumentet skal være visibility='private'.
 *
 * @param userId - Supabase auth user UUID
 * @returns domain_id eller null
 */
export async function getUserDomainId(userId: string): Promise<string | null> {
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, no-restricted-syntax
  const { data } = await (admin as any)
    .from('domain_member')
    .select('domain_id')
    .eq('user_id', userId)
    .order('invited_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as { domain_id: string } | null)?.domain_id ?? null;
}

/**
 * Returnerer domain-ids hvor brugeren har rolle 'admin'.
 *
 * Bruges af DELETE/PATCH på standard-docs: kun uploaderen selv eller en
 * admin af dokumentets domain må slette/rette.
 *
 * @param userId - Supabase auth user UUID
 * @returns Liste af domain-ids (tom hvis ingen admin-roller)
 */
export async function getUserAdminDomainIds(userId: string): Promise<string[]> {
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, no-restricted-syntax
  const { data } = await (admin as any)
    .from('domain_member')
    .select('domain_id')
    .eq('user_id', userId)
    .eq('role', 'admin');
  return ((data ?? []) as Array<{ domain_id: string }>).map((r) => r.domain_id);
}

/**
 * Tilbagekalder domain-deling af en brugers standard betingelser (BIZZ-2107).
 *
 * Når et medlem fjernes fra et domain skal delingen revokes BEGGE veje:
 * RLS-policyen klarer selv retning 1 (den fjernede mister adgang til de
 * øvriges docs, da domain_member-rækken er væk), men retning 2 kræver at den
 * fjernedes egne docs demotes til private — ellers ser domainet dem fortsat.
 *
 * @param userId - Den fjernede brugers UUID
 * @param domainId - Domainet brugeren fjernes fra
 * @returns Antal docs der fik delingen tilbagekaldt
 */
export async function revokeStandardDocDomainSharing(
  userId: string,
  domainId: string
): Promise<number> {
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin as any)
    .from('forsikring_standard_doc')
    .update({ visibility: 'private', added_by_domain: null })
    .eq('added_by_user', userId)
    .eq('added_by_domain', domainId)
    .select('id');
  return ((data ?? []) as Array<{ id: string }>).length;
}

/**
 * Ren beslutningsfunktion: må brugeren slette/rette et standard-doc?
 *
 * Regel (BIZZ-2104): uploaderen selv må altid; derudover må en admin af
 * dokumentets domain. Curated docs (uden uploader) kan ingen almindelig
 * bruger ændre.
 *
 * @param doc - Dokumentets ejerskabsfelter
 * @param userId - Den aktuelle brugers UUID
 * @param adminDomainIds - Domain-ids hvor brugeren er admin
 * @returns true hvis sletning/rettelse er tilladt
 */
export function canModifyStandardDoc(
  doc: { added_by_user: string | null; added_by_domain: string | null },
  userId: string,
  adminDomainIds: string[]
): boolean {
  if (doc.added_by_user && doc.added_by_user === userId) return true;
  if (doc.added_by_domain && adminDomainIds.includes(doc.added_by_domain)) return true;
  return false;
}
