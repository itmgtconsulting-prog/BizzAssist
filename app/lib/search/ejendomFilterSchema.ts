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

import { isUdfasetStatusCode } from '@/app/lib/bbrKoder';
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

// ─── BIZZ-821 (788c): Phase 2 BBR-berigelses-filtre ────────────────────────
// Data-kilde: bbr_ejendom_status-tabellen (migration 076) — populeres af
// scripts/backfill-bbr-status.mjs med live BBR-query (BIZZ-824).

/**
 * Areal-range-filter. Dækker samlet boligareal (m²). Range 0-500 m² for
 * typiske bygninger; 500+ filtreres ikke (ikke-bolig-ejendomme).
 */
export function buildArealSchema(lang: 'da' | 'en'): FilterSchema {
  const da = lang === 'da';
  return {
    type: 'range',
    key: 'boligareal',
    label: da ? 'Boligareal' : 'Living area',
    min: 0,
    max: 500,
    step: 10,
    unit: 'm²',
  };
}

/**
 * Opførelsesår-range-filter. BBR dækker 1800-nutid; typisk 1850-2025.
 */
export function buildOpfoerelsesaarSchema(lang: 'da' | 'en'): FilterSchema {
  const currentYear = new Date().getFullYear();
  const da = lang === 'da';
  return {
    type: 'range',
    key: 'opfoerelsesaar',
    label: da ? 'Opførelsesår' : 'Year built',
    min: 1850,
    max: currentYear,
    step: 1,
  };
}

/**
 * Energimærke dropdown. Standard A-G skala (2010-) + eksakte bogstaver.
 * A2020/A2015/A2010 normaliseres til A for filter-formål (kan justeres
 * i phase-3 hvis detaljering er krav).
 */
export function buildEnergimaerkeSchema(lang: 'da' | 'en'): FilterSchema {
  const da = lang === 'da';
  return {
    type: 'multi-select',
    key: 'energimaerke',
    label: da ? 'Energimærke' : 'Energy rating',
    options: [
      { value: 'A', label: 'A' },
      { value: 'B', label: 'B' },
      { value: 'C', label: 'C' },
      { value: 'D', label: 'D' },
      { value: 'E', label: 'E' },
      { value: 'F', label: 'F' },
      { value: 'G', label: 'G' },
    ],
  };
}

/**
 * Anvendelse — BBR byg021-kode gruppeperet til makro-kategorier.
 * Value er kategori-nøgle; caller oversætter via bbrKoder ved filter-apply.
 */
export function buildAnvendelseSchema(lang: 'da' | 'en'): FilterSchema {
  const da = lang === 'da';
  return {
    type: 'multi-select',
    key: 'anvendelse',
    label: da ? 'Anvendelse' : 'Use',
    options: [
      { value: 'helaarsbeboelse', label: da ? 'Helårsbeboelse' : 'Year-round residence' },
      { value: 'fritidsbolig', label: da ? 'Fritidsbolig' : 'Holiday home' },
      { value: 'erhverv', label: da ? 'Erhverv' : 'Commercial' },
      { value: 'industri', label: da ? 'Industri & lager' : 'Industry & warehouse' },
      { value: 'offentlig', label: da ? 'Offentlig bygning' : 'Public building' },
      { value: 'landbrug', label: da ? 'Landbrug' : 'Agriculture' },
    ],
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
    // BIZZ-821 phase-2 filtre
    buildArealSchema(lang),
    buildOpfoerelsesaarSchema(lang),
    buildEnergimaerkeSchema(lang),
    buildAnvendelseSchema(lang),
  ];
}

// ─── Filter-application helpers ────────────────────────────────────────────

export interface EjendomFilterState {
  ejendomstype?: string[];
  skjulUdfasede?: boolean;
  kommune?: string[];
  // BIZZ-821 phase-2 filter-state
  boligareal?: { min?: number; max?: number };
  opfoerelsesaar?: { min?: number; max?: number };
  energimaerke?: string[];
  anvendelse?: string[];
}

/**
 * En type-safe shape som caller kan matche filtrer-resultat imod. Vi
 * tager Record<string, unknown> som input fordi useFiltersFromURL
 * returnerer det generiske FilterState.
 */
export function narrowEjendomFilters(raw: Record<string, unknown>): EjendomFilterState {
  // BIZZ-821: range-filtre er { min?, max? } shapes fra filterSchema-encoding
  const isRange = (v: unknown): v is { min?: number; max?: number } =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  return {
    ejendomstype: Array.isArray(raw.ejendomstype) ? (raw.ejendomstype as string[]) : undefined,
    skjulUdfasede: typeof raw.skjulUdfasede === 'boolean' ? raw.skjulUdfasede : undefined,
    kommune: Array.isArray(raw.kommune) ? (raw.kommune as string[]) : undefined,
    boligareal: isRange(raw.boligareal)
      ? (raw.boligareal as { min?: number; max?: number })
      : undefined,
    opfoerelsesaar: isRange(raw.opfoerelsesaar)
      ? (raw.opfoerelsesaar as { min?: number; max?: number })
      : undefined,
    energimaerke: Array.isArray(raw.energimaerke) ? (raw.energimaerke as string[]) : undefined,
    anvendelse: Array.isArray(raw.anvendelse) ? (raw.anvendelse as string[]) : undefined,
  };
}

/**
 * Shape som bruges af ejendoms-filter-match. Generisk fordi schema'et
 * skal kunne applies uanset hvilken kilde ejendommen kommer fra
 * (autocomplete, enhedsliste, recent).
 *
 * BIZZ-825: Udfaset-signal er nu numerisk bbrStatusCode via centraliseret
 * isUdfasetStatusCode. is_udfaset-flag (fra bbr_ejendom_status-berigelse)
 * accepteres også som direkte signal.
 */
export interface FilterableEjendom {
  /** BBR bygning-status-kode (BYG_STATUS). 4/10/11 = udfaset. */
  bbrStatusCode?: number | string | null;
  /** Direkte udfaset-flag fra bbr_ejendom_status (migration 069). */
  isUdfaset?: boolean | null;
  ejendomstype?: 'sfe' | 'bygning' | 'ejerlejlighed' | null;
  adresse?: { kommunenavn?: string };
  // BIZZ-821 phase-2: BBR-berigelses-felter fra bbr_ejendom_status (migration 076)
  /** Samlet boligareal i m² */
  boligareal?: number | null;
  /** Opførelsesår */
  opfoerelsesaar?: number | null;
  /** Energimærke som bogstav (A-G), eller A2020/B2015 osv. */
  energimaerke?: string | null;
  /** BBR byg021 anvendelses-kode (numerisk) */
  anvendelseskode?: number | null;
}

/**
 * Applier ejendoms-filters til en single-item. Returnerer true hvis
 * item skal vises. Ukendte felter (null/undefined) tæller som
 * "passer igennem" — vi skjuler kun eksplicit hvad filter udelukker.
 *
 * BIZZ-825: String-fallback (s === 'Nedrevet' etc.) fjernet — var dead
 * code (matchede aldrig DAR-værdier). Primær signal er bbrStatusCode via
 * isUdfasetStatusCode, sekundær er isUdfaset-flag fra berigelse-tabel.
 */
export function matchEjendomFilter(item: FilterableEjendom, filters: EjendomFilterState): boolean {
  // Skjul udfasede
  if (filters.skjulUdfasede) {
    if (item.isUdfaset === true) return false;
    if (isUdfasetStatusCode(item.bbrStatusCode)) return false;
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
  // BIZZ-821 phase-2 filtre. Null-felter passes gennem (vi skjuler ikke
  // rows med manglende data — kun eksplicit ekskluderer).
  if (filters.boligareal && item.boligareal != null) {
    if (filters.boligareal.min != null && item.boligareal < filters.boligareal.min) return false;
    if (filters.boligareal.max != null && item.boligareal > filters.boligareal.max) return false;
  }
  if (filters.opfoerelsesaar && item.opfoerelsesaar != null) {
    if (filters.opfoerelsesaar.min != null && item.opfoerelsesaar < filters.opfoerelsesaar.min)
      return false;
    if (filters.opfoerelsesaar.max != null && item.opfoerelsesaar > filters.opfoerelsesaar.max)
      return false;
  }
  if (filters.energimaerke && filters.energimaerke.length > 0 && item.energimaerke) {
    // Normaliser A2020/A2015/A2010 → A for matching
    const letter = item.energimaerke.charAt(0).toUpperCase();
    if (!filters.energimaerke.includes(letter)) return false;
  }
  if (filters.anvendelse && filters.anvendelse.length > 0 && item.anvendelseskode != null) {
    // BBR byg021 gruppering:
    //   110-190 → helaarsbeboelse
    //   510-590 → fritidsbolig
    //   210-216, 220-239, 290 → industri
    //   320-390 → erhverv
    //   410-490 → offentlig
    //   211-215 → landbrug
    const kode = item.anvendelseskode;
    const kategori =
      kode >= 110 && kode <= 190
        ? 'helaarsbeboelse'
        : kode >= 510 && kode <= 590
          ? 'fritidsbolig'
          : kode >= 211 && kode <= 215
            ? 'landbrug'
            : (kode >= 210 && kode <= 216) || (kode >= 220 && kode <= 239) || kode === 290
              ? 'industri'
              : kode >= 320 && kode <= 390
                ? 'erhverv'
                : kode >= 410 && kode <= 490
                  ? 'offentlig'
                  : null;
    if (!kategori || !filters.anvendelse.includes(kategori)) return false;
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
