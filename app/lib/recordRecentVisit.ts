/**
 * recordRecentVisit — registrerer et besøg på en detalje-side i Supabase recent_entities.
 *
 * Bruges af ejendomme/[id], companies/[cvr] og owners/[enhedsNummer] sider når de loader.
 * Gemmer både i entity-specifik type og i søgehistorik (type=search) så RecentEntityTagBar
 * kan vise tagget uanset hvilken datakilde der er tilgængelig.
 *
 * @module app/lib/recordRecentVisit
 */

type VisitType = 'property' | 'company' | 'person';

/** Mappe fra entity-type til søgehistorik resultType */
const RESULT_TYPE_MAP: Record<VisitType, string> = {
  property: 'address',
  company: 'company',
  person: 'person',
};

/**
 * Registrerer et besøg og opdaterer recent_entities i Supabase.
 * Fire-and-forget — kaster ikke exceptions.
 *
 * @param type   - Entity-type: property | company | person
 * @param id     - Entitetens ID (DAWA UUID, CVR-nummer eller enhedsNummer)
 * @param label  - Visningsnavn (adresse, virksomhedsnavn, personnavn)
 * @param href   - Navigationslink f.eks. /dashboard/ejendomme/abc-123
 * @param extra  - Valgfri ekstra data til entity_data (f.eks. { postnr, by })
 */
export function recordRecentVisit(
  type: VisitType,
  id: string,
  label: string,
  href: string,
  extra: Record<string, string | null> = {}
): void {
  if (typeof window === 'undefined' || !id || !label) return;

  const resultType = RESULT_TYPE_MAP[type];

  // Gem i entity-specifik type (bruges af RecentEntityTagBar direkte)
  fetch('/api/recents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entity_type: type,
      entity_id: id,
      display_name: label,
      entity_data: extra,
    }),
  }).catch(() => {});

  // Gem også i søgehistorik med resultType/resultHref (fallback-kilde for tagbar)
  fetch('/api/recents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entity_type: 'search',
      entity_id: `${type}:${id}`,
      display_name: label,
      entity_data: {
        resultType,
        resultTitle: label,
        resultHref: href,
      },
    }),
  })
    .then(() => {
      // Notificér RecentEntityTagBar om opdatering
      window.dispatchEvent(new Event('ba-recents-updated'));
    })
    .catch(() => {});
}
