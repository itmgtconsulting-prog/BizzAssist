/**
 * BIZZ-823 (BIZZ-790b): Person-filter-katalog phase-2.
 *
 * Data-kilde: cvr_deltager-tabellen efter berigelse (migration 077 + 081):
 *   - is_aktiv (boolean)
 *   - antal_aktive_selskaber (integer)
 *   - senest_indtraadt_dato (date)
 *   - role_typer (text[])
 *   - antal_historiske_virksomheder (integer) — migration 081
 *   - totalt_antal_roller (integer) — migration 081
 *
 * Filtre:
 *   - Rolle multi-select (direktør/bestyrelsesmedlem/stifter/reel_ejer/ejer/suppleant/formand)
 *   - Rollestatus (aktive/ophørte/alle, default: aktive)
 *   - Antal aktive virksomheder (range 0-50)
 *   - Antal historiske virksomheder (range 0-50)
 *   - Totalt antal roller (range 0-100)
 *   - Kommune (dynamisk fra live-resultater)
 *   - Preset-tags (7 forudindstillede profiler)
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
 * Antal aktive virksomheder range. 0-50 dækker typisk interval;
 * >50 er meget sjældent (stråmænd eller professionelle advokater).
 */
export function buildAntalAktiveSchema(lang: 'da' | 'en'): FilterSchema {
  const da = lang === 'da';
  return {
    type: 'range',
    key: 'antalAktiveSelskaber',
    label: da ? 'Antal aktive virksomheder' : 'Active companies count',
    min: 0,
    max: 50,
    step: 1,
  };
}

/**
 * BIZZ-823: Antal historiske (ophørte) virksomheder range.
 */
export function buildAntalHistoriskeSchema(lang: 'da' | 'en'): FilterSchema {
  const da = lang === 'da';
  return {
    type: 'range',
    key: 'antalHistoriskeVirksomheder',
    label: da ? 'Antal historiske virksomheder' : 'Historical companies count',
    min: 0,
    max: 50,
    step: 1,
  };
}

/**
 * BIZZ-823: Totalt antal roller (aktive + ophørte) range.
 */
export function buildTotalRollerSchema(lang: 'da' | 'en'): FilterSchema {
  const da = lang === 'da';
  return {
    type: 'range',
    key: 'totalAntalRoller',
    label: da ? 'Totalt antal roller' : 'Total role count',
    min: 0,
    max: 100,
    step: 1,
  };
}

/**
 * BIZZ-823: Preset-tags for hurtig profilering.
 * Mutually exclusive — klik sætter kombineret filter.
 */
export function buildPresetSchema(lang: 'da' | 'en'): FilterSchema {
  const da = lang === 'da';
  return {
    type: 'multi-select',
    key: 'preset',
    label: da ? 'Profil-presets' : 'Profile presets',
    options: [
      { value: 'kunDirektoerer', label: da ? 'Kun direktører' : 'Directors only' },
      { value: 'kunReelleEjere', label: da ? 'Kun reelle ejere' : 'Beneficial owners only' },
      {
        value: 'kunBestyrelsesmedlemmer',
        label: da ? 'Kun bestyrelsesmedlemmer' : 'Board members only',
      },
      { value: 'kunStiftere', label: da ? 'Kun stiftere' : 'Founders only' },
      {
        value: 'serielIvaerksaetter',
        label: da ? 'Seriel iværksætter (5+)' : 'Serial entrepreneur (5+)',
      },
      {
        value: 'professionelBestyrelse',
        label: da ? 'Professionel bestyrelse (3+)' : 'Professional board (3+)',
      },
      {
        value: 'enkeltvirksomhed',
        label: da ? 'Enkeltvirksomhed' : 'Single company',
      },
    ],
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
    buildPresetSchema(lang),
    buildRolleSchema(lang),
    buildRollestatusSchema(lang),
    buildAntalAktiveSchema(lang),
    buildAntalHistoriskeSchema(lang),
    buildTotalRollerSchema(lang),
    buildPersonKommuneSchema(lang, kommuneOptions),
  ];
}

/**
 * BIZZ-823: Byg dynamisk kommune-options fra person-resultater.
 * Kræver at PersonSearchResult har kommunenavn-felt (fra cvr_deltager
 * enrichment). Null/undefined filtreres fra.
 */
export function buildPersonKommuneOptions(
  people: Array<{ kommunenavn?: string | null }>
): FilterOption[] {
  const seen = new Set<string>();
  for (const p of people) {
    if (p.kommunenavn && p.kommunenavn.length > 0) seen.add(p.kommunenavn);
  }
  return Array.from(seen)
    .sort((a, b) => a.localeCompare(b, 'da'))
    .map((k) => ({ value: k, label: k }));
}

// ─── Filter-state + matching ───────────────────────────────────────────────

export interface PersonFilterState {
  preset?: string[];
  rolle?: string[];
  rollestatus?: string;
  antalAktiveSelskaber?: { min?: number; max?: number };
  antalHistoriskeVirksomheder?: { min?: number; max?: number };
  totalAntalRoller?: { min?: number; max?: number };
  kommune?: string[];
}

export function narrowPersonFilters(raw: Record<string, unknown>): PersonFilterState {
  const isRange = (v: unknown): v is { min?: number; max?: number } =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  return {
    preset: Array.isArray(raw.preset) ? (raw.preset as string[]) : undefined,
    rolle: Array.isArray(raw.rolle) ? (raw.rolle as string[]) : undefined,
    rollestatus: typeof raw.rollestatus === 'string' ? raw.rollestatus : undefined,
    antalAktiveSelskaber: isRange(raw.antalAktiveSelskaber)
      ? (raw.antalAktiveSelskaber as { min?: number; max?: number })
      : undefined,
    antalHistoriskeVirksomheder: isRange(raw.antalHistoriskeVirksomheder)
      ? (raw.antalHistoriskeVirksomheder as { min?: number; max?: number })
      : undefined,
    totalAntalRoller: isRange(raw.totalAntalRoller)
      ? (raw.totalAntalRoller as { min?: number; max?: number })
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
  /** BIZZ-823: Antal virksomheder med ophørte roller */
  antalHistoriskeVirksomheder?: number | null;
  /** BIZZ-823: Total antal roller (aktive + ophørte) */
  totalAntalRoller?: number | null;
}

/**
 * Hjælper til range-check med null-pass-through.
 */
function matchRange(
  value: number | null | undefined,
  range: { min?: number; max?: number } | undefined
): boolean {
  if (!range || value == null) return true;
  if (range.min != null && value < range.min) return false;
  if (range.max != null && value > range.max) return false;
  return true;
}

/**
 * Match person mod filter-state. Null-felter passer gennem — vi
 * skjuler kun eksplicit hvad filter udelukker.
 *
 * Preset-tags fungerer som genveje der matcher mod eksisterende felter.
 */
export function matchPersonFilter(item: FilterablePerson, filters: PersonFilterState): boolean {
  // ── Preset-tags (mutually exclusive, maps til kombineret filter) ──
  if (filters.preset && filters.preset.length > 0) {
    const p = filters.preset[0];
    switch (p) {
      case 'kunDirektoerer':
        if (!item.roleTyper?.includes('direktør')) return false;
        break;
      case 'kunReelleEjere':
        if (!item.roleTyper?.includes('reel_ejer')) return false;
        break;
      case 'kunBestyrelsesmedlemmer':
        if (!item.roleTyper?.includes('bestyrelsesmedlem')) return false;
        break;
      case 'kunStiftere':
        if (!item.roleTyper?.includes('stifter')) return false;
        break;
      case 'serielIvaerksaetter':
        if ((item.antalAktiveSelskaber ?? 0) < 5) return false;
        break;
      case 'professionelBestyrelse':
        if (!item.roleTyper?.includes('bestyrelsesmedlem') && !item.roleTyper?.includes('formand'))
          return false;
        if ((item.antalAktiveSelskaber ?? 0) < 3) return false;
        break;
      case 'enkeltvirksomhed':
        if (item.antalAktiveSelskaber !== 1) return false;
        break;
    }
  }

  // ── Rollestatus (aktive default) ──
  const status = filters.rollestatus ?? 'aktive';
  if (status === 'aktive' && item.isAktiv === false) return false;
  if (status === 'ophoerte' && item.isAktiv === true) return false;

  // ── Rolle multi-select ──
  if (filters.rolle && filters.rolle.length > 0 && item.roleTyper) {
    const overlap = filters.rolle.some((r) => item.roleTyper!.includes(r));
    if (!overlap) return false;
  }

  // ── Range-filtre ──
  if (!matchRange(item.antalAktiveSelskaber, filters.antalAktiveSelskaber)) return false;
  if (!matchRange(item.antalHistoriskeVirksomheder, filters.antalHistoriskeVirksomheder))
    return false;
  if (!matchRange(item.totalAntalRoller, filters.totalAntalRoller)) return false;

  // ── Kommune multi-select ──
  if (filters.kommune && filters.kommune.length > 0) {
    const k = item.adresse?.kommunenavn ?? '';
    if (!filters.kommune.includes(k)) return false;
  }

  return true;
}
