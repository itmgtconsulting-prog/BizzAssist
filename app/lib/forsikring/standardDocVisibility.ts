/**
 * BIZZ-2106: Visibility-filter for standard forsikringsbetingelser.
 *
 * Analyse-POST'en modtager standard_doc_ids fra request body og slog dem
 * tidligere op med service-role-client (bypasser RLS) — en bruger kunne
 * dermed angive en fremmed tenants private doc-id og få indholdet brugt i
 * sin egen analyse. Dette modul indeholder den rene filter-funktion;
 * route-laget henter de synlige ids via en RLS-respekterende session-client
 * (samme visibility-regler som BIZZ-1907: egne private + domain-delte +
 * curated docs) og filtrerer de anmodede ids mod dem.
 *
 * @module app/lib/forsikring/standardDocVisibility
 */

/**
 * Filtrerer anmodede standard-doc-ids mod mængden af ids brugeren må se.
 *
 * Ids der ikke er synlige (fremmed privat doc, slettet doc eller opdigtet
 * UUID) droppes — kaldsstedet logger en advarsel med de droppede ids, så
 * misbrugsforsøg kan spores uden at hele analysen fejler.
 *
 * @param requested - Doc-ids fra request body (rå, utrustet input)
 * @param visibleIds - Ids returneret af RLS-scoped opslag for brugeren
 * @returns allowed: ids der må bruges; dropped: ids der blev frasorteret
 */
export function filterAllowedStandardDocIds(
  requested: string[],
  visibleIds: Iterable<string>
): { allowed: string[]; dropped: string[] } {
  const visible = new Set(visibleIds);
  const allowed: string[] = [];
  const dropped: string[] = [];
  // Dedupliker samtidig — samme id to gange i body må ikke give dobbelt-links
  const seen = new Set<string>();
  for (const id of requested) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (visible.has(id)) allowed.push(id);
    else dropped.push(id);
  }
  return { allowed, dropped };
}
