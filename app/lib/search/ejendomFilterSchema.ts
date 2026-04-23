/**
 * BIZZ-804 (BIZZ-788b): Ejendoms-filter-katalog MVP schema.
 *
 * 3 filtre per ARCHITECT signoff:
 *   - Ejendomstype (multi-select, chips)
 *   - Skjul udfasede (toggle, default=true)
 *   - Kommune (multi-select, dynamisk options)
 *
 * Options for ejendomstype er statiske. Options for kommune bygges
 * dynamisk af caller fra live search-resultater (`buildKommuneOptions`
 * helper) så vi ikke hardkoder 98 kommuner i MVP.
 *
 * Schema genbruges af /dashboard/search og (senere) /dashboard/ejendomme
 * lister. Samme Filter State pattern som BIZZ-789a/790a for konsistens.
 */

import type { FilterSchema, FilterOption } from './filterSchema';

/**
 * Byg et Ejendomstype-filter schema bilingualt. Labels kommer fra
 * caller's language-context så schema selv er lang-agnostisk.
 *
 * @param lang - 'da' eller 'en'
 */
export function buildEjendomstypeSchema(lang: 'da' | 'en'): FilterSchema {
  const da = lang === 'da';
  return {
    type: 'multi-select',
    key: 'ejendomstype',
    label: da ? 'Ejendomstype' : 'Property type',
    options: [
      { value: 'bygning', label: da ? 'Bygning' : 'Building' },
      { value: 'ejerlejlighed', label: da ? 'Ejerlejlighed' : 'Condominium' },
      { value: 'sfe', label: da ? 'SFE (hovedejendom)' : 'SFE (main property)' },
    ],
  };
}

/**
 * Skjul udfasede toggle. Default=true — vi skjuler udfasede som standard
 * så brugere ikke ser nedrevne ejendomme med mindre de aktivt beder om det.
 */
export function buildSkjulUdfasedeSchema(lang: 'da' | 'en'): FilterSchema {
  const da = lang === 'da';
  return {
    type: 'toggle',
    key: 'skjulUdfasede',
    label: da ? 'Skjul udfasede' : 'Hide retired',
    description: da
      ? 'Ejendomme med alle bygninger markeret nedrevet/bortfaldet'
      : 'Properties with all buildings demolished/withdrawn',
    default: true,
  };
}

/**
 * Kommune-filter med dynamisk options-liste. Caller bygger options-
 * arrayet fra unique `adresse.kommunenavn` i current search-resultater.
 *
 * @param options - Unique kommuner fra live-resultater
 */
export function buildKommuneSchema(lang: 'da' | 'en', options: FilterOption[]): FilterSchema {
  const da = lang === 'da';
  return {
    type: 'multi-select',
    key: 'kommune',
    label: da ? 'Kommune' : 'Municipality',
    options,
  };
}

/**
 * Build hele ejendoms-schema med bilingual labels. Kaldes fra
 * UniversalSearchPageClient med dynamiske kommune-options.
 *
 * @param lang - 'da' eller 'en'
 * @param kommuneOptions - Unique kommuner fra current resultater
 */
export function buildEjendomFilterSchemas(
  lang: 'da' | 'en',
  kommuneOptions: FilterOption[]
): FilterSchema[] {
  return [
    buildEjendomstypeSchema(lang),
    buildSkjulUdfasedeSchema(lang),
    buildKommuneSchema(lang, kommuneOptions),
  ];
}

// ─── Filter-application helpers ────────────────────────────────────────────

export interface EjendomFilterState {
  ejendomstype?: string[];
  skjulUdfasede?: boolean;
  kommune?: string[];
}

/**
 * En type-safe shape som caller kan matche filtrer-resultat imod. Vi
 * tager Record<string, unknown> som input fordi useFiltersFromURL
 * returnerer det generiske FilterState.
 */
export function narrowEjendomFilters(raw: Record<string, unknown>): EjendomFilterState {
  return {
    ejendomstype: Array.isArray(raw.ejendomstype) ? (raw.ejendomstype as string[]) : undefined,
    skjulUdfasede: typeof raw.skjulUdfasede === 'boolean' ? raw.skjulUdfasede : undefined,
    kommune: Array.isArray(raw.kommune) ? (raw.kommune as string[]) : undefined,
  };
}

/**
 * Shape som bruges af ejendoms-filter-match. Generisk fordi schema'et
 * skal kunne applies uanset hvilken kilde ejendommen kommer fra
 * (autocomplete, enhedsliste, recent).
 */
export interface FilterableEjendom {
  status?: string | null;
  ejendomstype?: 'sfe' | 'bygning' | 'ejerlejlighed' | null;
  adresse?: { kommunenavn?: string };
}

/**
 * Applier ejendoms-filters til en single-item. Returnerer true hvis
 * item skal vises. Ukendte felter (null/undefined) tæller som
 * "passer igennem" — vi skjuler kun eksplicit hvad filter udelukker.
 */
export function matchEjendomFilter(item: FilterableEjendom, filters: EjendomFilterState): boolean {
  // Skjul udfasede
  if (filters.skjulUdfasede) {
    const s = item.status;
    // Samme logik som BIZZ-785 iter 1: "Nedlagt" / "Nedrevet" filtreres
    // væk; Gældende/Foreløbig/null/undefined passer igennem.
    if (s === 'Nedlagt' || s === 'Nedrevet' || s === 'Henlagt') return false;
  }
  // Ejendomstype multi-select
  if (filters.ejendomstype && filters.ejendomstype.length > 0) {
    const t = item.ejendomstype;
    if (!t) return false; // ukendt type matches ikke ekspliciet valgte typer
    if (!filters.ejendomstype.includes(t)) return false;
  }
  // Kommune multi-select
  if (filters.kommune && filters.kommune.length > 0) {
    const k = item.adresse?.kommunenavn ?? '';
    if (!filters.kommune.includes(k)) return false;
  }
  return true;
}

/**
 * Udtræk unique kommunenavne fra en liste ejendomme til dynamisk
 * kommune-dropdown options.
 */
export function buildKommuneOptions(items: FilterableEjendom[], lang: 'da' | 'en'): FilterOption[] {
  const seen = new Set<string>();
  for (const item of items) {
    const k = item.adresse?.kommunenavn;
    if (k && k.length > 0) seen.add(k);
  }
  return Array.from(seen)
    .sort((a, b) => a.localeCompare(b, 'da'))
    .map((k) => ({ value: k, label: k }));
  // lang-parameter er ikke aktivt brugt endnu (kommuner har samme navn
  // i begge sprog), men beholdes for fremtidig i18n-udvidelse.
  void lang;
}
