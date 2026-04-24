/**
 * BIZZ-823 (BIZZ-790b): Person-filter-katalog phase-2.
 *
 * Data-kilde: cvr_deltager-tabellen efter BIZZ-830 berigelse (migration 077):
 *   - is_aktiv (boolean)
 *   - antal_aktive_selskaber (integer)
 *   - senest_indtraadt_dato (date)
 *   - role_typer (text[])
 *
 * Filtre:
 *   - Rolle multi-select (direktør/bestyrelsesmedlem/stifter/reel_ejer/ejer/suppleant/formand)
 *   - Rollestatus (aktive/ophørte/alle, default: aktive)
 *   - Antal aktive virksomheder (range 0-20)
 *   - Kommune (dynamisk fra live-resultater)
 *
 * Presets-tags (phase-3 parkering) er ikke inkluderet i denne iter —
 * kan tilføjes som dedicated preset-schema senere.
 */

import type { FilterOption, FilterSchema } from './filterSchema';

/**
 * Rolle-typer matcher cvr_deltager.role_typer normaliserede values fra
 * BIZZ-830 backfill-script (direktør/bestyrelsesmedlem/stifter/reel_ejer/
 * ejer/suppleant/formand).
 */
export function buildRolleSchema(lang: 'da' | 'en'): FilterSchema {
  const da = lang === 'da';
  return {
    type: 'multi-select',
    key: 'rolle',
    label: da ? 'Rolle' : 'Role',
    options: [
      { value: 'direktør', label: da ? 'Direktør' : 'Director' },
      { value: 'bestyrelsesmedlem', label: da ? 'Bestyrelsesmedlem' : 'Board member' },
      { value: 'formand', label: da ? 'Formand' : 'Chairman' },
      { value: 'stifter', label: da ? 'Stifter' : 'Founder' },
      { value: 'reel_ejer', label: da ? 'Reel ejer' : 'Beneficial owner' },
      { value: 'ejer', label: da ? 'Ejer' : 'Owner' },
      { value: 'suppleant', label: da ? 'Suppleant' : 'Substitute' },
    ],
  };
}

/**
 * Rollestatus: aktive / ophørte / alle. Default aktive.
 */
export function buildRollestatusSchema(lang: 'da' | 'en'): FilterSchema {
  const da = lang === 'da';
  return {
    type: 'dropdown',
    key: 'rollestatus',
    label: da ? 'Rollestatus' : 'Role status',
    options: [
      { value: 'aktive', label: da ? 'Kun aktive' : 'Active only' },
      { value: 'ophoerte', label: da ? 'Kun ophørte' : 'Retired only' },
      { value: 'alle', label: da ? 'Alle' : 'All' },
    ],
    default: 'aktive',
  };
}

/**
 * Antal aktive virksomheder range. 0-20 dækker typisk interval;
 * >20 er sjældent (stråmænd eller professionelle advokater).
 */
export function buildAntalAktiveSchema(lang: 'da' | 'en'): FilterSchema {
  const da = lang === 'da';
  return {
    type: 'range',
    key: 'antalAktiveSelskaber',
    label: da ? 'Antal aktive virksomheder' : 'Active companies count',
    min: 0,
    max: 20,
    step: 1,
  };
}

/**
 * Kommune-filter med dynamisk options fra live-resultater.
 * Parallel-pattern til ejendoms- og virksomhedsschema.
 */
export function buildPersonKommuneSchema(lang: 'da' | 'en', options: FilterOption[]): FilterSchema {
  const da = lang === 'da';
  return {
    type: 'multi-select',
    key: 'kommune',
    label: da ? 'Kommune' : 'Municipality',
    options,
  };
}

/**
 * Build hele person-schema. Caller sender kommune-options fra live-
 * resultater (unique kommune-navne fra personens registrerede adresser).
 */
export function buildPersonFilterSchemas(
  lang: 'da' | 'en',
  kommuneOptions: FilterOption[]
): FilterSchema[] {
  return [
    buildRolleSchema(lang),
    buildRollestatusSchema(lang),
    buildAntalAktiveSchema(lang),
    buildPersonKommuneSchema(lang, kommuneOptions),
  ];
}

// ─── Filter-state + matching ───────────────────────────────────────────────

export interface PersonFilterState {
  rolle?: string[];
  rollestatus?: string;
  antalAktiveSelskaber?: { min?: number; max?: number };
  kommune?: string[];
}

export function narrowPersonFilters(raw: Record<string, unknown>): PersonFilterState {
  const isRange = (v: unknown): v is { min?: number; max?: number } =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  return {
    rolle: Array.isArray(raw.rolle) ? (raw.rolle as string[]) : undefined,
    rollestatus: typeof raw.rollestatus === 'string' ? raw.rollestatus : undefined,
    antalAktiveSelskaber: isRange(raw.antalAktiveSelskaber)
      ? (raw.antalAktiveSelskaber as { min?: number; max?: number })
      : undefined,
    kommune: Array.isArray(raw.kommune) ? (raw.kommune as string[]) : undefined,
  };
}

/**
 * FilterablePerson shape som caller matcher mod. Kommer typisk fra
 * person-search-resultat eller cvr_deltager enrichment-row.
 */
export interface FilterablePerson {
  /** True hvis person har mindst én aktiv rolle */
  isAktiv?: boolean | null;
  /** Antal virksomheder hvor person har aktiv rolle */
  antalAktiveSelskaber?: number | null;
  /** Normaliserede rolle-typer fra cvr_deltager.role_typer */
  roleTyper?: string[] | null;
  /** Kommune fra personens adresse */
  adresse?: { kommunenavn?: string };
}

/**
 * Match person mod filter-state. Null-felter passer gennem — vi
 * skjuler kun eksplicit hvad filter udelukker.
 */
export function matchPersonFilter(item: FilterablePerson, filters: PersonFilterState): boolean {
  // Rollestatus (aktive default)
  const status = filters.rollestatus ?? 'aktive';
  if (status === 'aktive' && item.isAktiv === false) return false;
  if (status === 'ophoerte' && item.isAktiv === true) return false;
  // Rolle multi-select — match hvis ET overlap mellem valgte og person's role_typer
  if (filters.rolle && filters.rolle.length > 0 && item.roleTyper) {
    const overlap = filters.rolle.some((r) => item.roleTyper!.includes(r));
    if (!overlap) return false;
  }
  // Antal aktive virksomheder range
  if (filters.antalAktiveSelskaber && item.antalAktiveSelskaber != null) {
    const n = item.antalAktiveSelskaber;
    if (filters.antalAktiveSelskaber.min != null && n < filters.antalAktiveSelskaber.min)
      return false;
    if (filters.antalAktiveSelskaber.max != null && n > filters.antalAktiveSelskaber.max)
      return false;
  }
  // Kommune multi-select
  if (filters.kommune && filters.kommune.length > 0) {
    const k = item.adresse?.kommunenavn ?? '';
    if (!filters.kommune.includes(k)) return false;
  }
  return true;
}
