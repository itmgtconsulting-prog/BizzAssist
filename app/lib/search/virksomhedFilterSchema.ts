/**
 * BIZZ-804: Placeholder schema for virksomhed-tab i /dashboard/search.
 *
 * MVP indeholder kun "Kun aktive" toggle (migration af eksisterende
 * onlyActiveCompanies state). Fuld filter-katalog kommer med BIZZ-789a
 * som udvider dette schema med Status multi-select, Virksomhedsform,
 * Branche, Kommune, Stiftet år range.
 *
 * Schema eksponeres som builder så labels kan renderes bilingualt.
 */

import type { FilterSchema } from './filterSchema';

/**
 * Byg virksomhed-filter schema. Iter 1 er minimal — KUN kun-aktive toggle.
 *
 * @param lang - 'da' eller 'en'
 */
export function buildVirksomhedFilterSchemas(lang: 'da' | 'en'): FilterSchema[] {
  const da = lang === 'da';
  return [
    {
      type: 'toggle',
      key: 'kunAktive',
      label: da ? 'Kun aktive' : 'Active only',
      description: da
        ? 'Skjul ophørte, slettede og konkurs-virksomheder'
        : 'Hide dissolved, deleted, and bankrupt companies',
      default: true,
    },
  ];
}

export interface VirksomhedFilterState {
  kunAktive?: boolean;
}

export function narrowVirksomhedFilters(raw: Record<string, unknown>): VirksomhedFilterState {
  return {
    kunAktive: typeof raw.kunAktive === 'boolean' ? raw.kunAktive : undefined,
  };
}

/**
 * Shape som caller bruger til match-check. Kun `active` feltet er
 * relevant for iter 1. Iter 789a udvider til fuld Virksomhed-interface.
 */
export interface FilterableVirksomhed {
  active?: boolean;
}

export function matchVirksomhedFilter(
  item: FilterableVirksomhed,
  filters: VirksomhedFilterState
): boolean {
  if (filters.kunAktive && !item.active) return false;
  return true;
}
