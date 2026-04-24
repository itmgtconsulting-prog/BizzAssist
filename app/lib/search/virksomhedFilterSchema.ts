/**
 * BIZZ-805 (BIZZ-789a): MVP filter-katalog for virksomheder.
 *
 * 5 filtre per ARCHITECT signoff 2026-04-23:
 *   - Status multi-select (Normal/Under konkurs/Ophørt osv.)
 *   - Virksomhedsform multi-select (ApS/A/S/Enkeltmandsvirksomhed osv.)
 *   - Branche multi-select (dynamisk fra live-resultater)
 *   - Kommune multi-select (dynamisk fra live-resultater)
 *   - Stiftet år range (1900-nu)
 *
 * Legacy `kunAktive` toggle er erstattet af status multi-select hvor
 * default-valg "Normal" giver samme effekt. Filter-resultatet anvendes
 * client-side på CVRSearchResult[] der allerede er hentet fra
 * /api/cvr-search.
 */

import type { FilterOption, FilterSchema } from './filterSchema';

const CURRENT_YEAR = new Date().getFullYear();

/**
 * Statuser fra CVR ES sammensatStatus. Liste er udtømmende efter
 * Erhvervsstyrelsens dokumentation (2026-04-23 check).
 */
export const VIRKSOMHED_STATUS_OPTIONS: Array<{ da: string; en: string }> = [
  { da: 'Normal', en: 'Active' },
  { da: 'Under konkurs', en: 'Bankruptcy' },
  { da: 'Under rekonstruktion', en: 'Reconstruction' },
  { da: 'Under frivillig likvidation', en: 'Voluntary liquidation' },
  { da: 'Under tvangsopløsning', en: 'Forced dissolution' },
  { da: 'Ophørt', en: 'Dissolved' },
  { da: 'Slettet', en: 'Deleted' },
];

export function buildStatusSchema(lang: 'da' | 'en'): FilterSchema {
  const da = lang === 'da';
  return {
    type: 'multi-select',
    key: 'status',
    label: da ? 'Status' : 'Status',
    options: VIRKSOMHED_STATUS_OPTIONS.map((s) => ({
      // Value = dansk navn (matcher CVR ES sammensatStatus), label = lokaliseret
      value: s.da,
      label: da ? s.da : s.en,
    })),
  };
}

/**
 * Almindelige virksomhedsformer ordnet efter frekvens i CVR.
 * Value = CVR ES `kortBeskrivelse` (det felt vi modtager i
 * CVRSearchResult.companyType), label = lokaliseret vis-streng.
 */
const VIRKSOMHEDSFORM_OPTIONS: Array<{ value: string; da: string; en: string }> = [
  { value: 'ApS', da: 'ApS (Anpartsselskab)', en: 'ApS (Private limited)' },
  { value: 'A/S', da: 'A/S (Aktieselskab)', en: 'A/S (Public limited)' },
  { value: 'Enkeltmandsvirksomhed', da: 'Enkeltmandsvirksomhed', en: 'Sole proprietorship' },
  { value: 'I/S', da: 'I/S (Interessentskab)', en: 'I/S (General partnership)' },
  { value: 'K/S', da: 'K/S (Kommanditselskab)', en: 'K/S (Limited partnership)' },
  { value: 'P/S', da: 'P/S (Partnerselskab)', en: 'P/S (Partnership)' },
  { value: 'Andelsselskab', da: 'Andelsselskab', en: 'Cooperative' },
  { value: 'Forening', da: 'Forening', en: 'Association' },
  { value: 'Fond', da: 'Fond', en: 'Foundation' },
  { value: 'Offentlig virksomhed', da: 'Offentlig virksomhed', en: 'Public company' },
  // BIZZ-838: IVS afskaffet i 2019 — historisk markering, sidst i listen
  {
    value: 'IVS',
    da: 'IVS (Iværksætterselskab) (historisk)',
    en: 'IVS (Entrepreneurial) (historical)',
  },
];

export function buildVirksomhedsformSchema(lang: 'da' | 'en'): FilterSchema {
  const da = lang === 'da';
  return {
    type: 'multi-select',
    key: 'virksomhedsform',
    label: da ? 'Virksomhedsform' : 'Company type',
    options: VIRKSOMHEDSFORM_OPTIONS.map((f) => ({
      value: f.value,
      label: da ? f.da : f.en,
    })),
  };
}

/**
 * Dynamisk branche-options bygges fra live-resultater.
 */
export function buildBrancheSchema(lang: 'da' | 'en', options: FilterOption[]): FilterSchema {
  const da = lang === 'da';
  return {
    type: 'multi-select',
    key: 'branche',
    label: da ? 'Branche' : 'Industry',
    options,
  };
}

/**
 * Dynamisk kommune-options bygges fra live-resultater.
 */
export function buildVirksomhedKommuneSchema(
  lang: 'da' | 'en',
  options: FilterOption[]
): FilterSchema {
  const da = lang === 'da';
  return {
    type: 'multi-select',
    key: 'kommune',
    label: da ? 'Kommune' : 'Municipality',
    options,
  };
}

/**
 * Stiftet år range 1900-current. Trin-størrelse 1 år.
 */
export function buildStiftetSchema(lang: 'da' | 'en'): FilterSchema {
  const da = lang === 'da';
  return {
    type: 'range',
    key: 'stiftet',
    label: da ? 'Stiftet år' : 'Founded year',
    min: 1900,
    max: CURRENT_YEAR,
    step: 1,
    unit: da ? 'år' : 'year',
  };
}

/**
 * Byg komplet virksomhed-filter schema med bilingual labels og
 * dynamiske options. Kaldes fra UniversalSearchPageClient.
 */
export function buildVirksomhedFilterSchemas(
  lang: 'da' | 'en',
  options?: { brancheOptions?: FilterOption[]; kommuneOptions?: FilterOption[] }
): FilterSchema[] {
  return [
    buildStatusSchema(lang),
    buildVirksomhedsformSchema(lang),
    buildBrancheSchema(lang, options?.brancheOptions ?? []),
    buildVirksomhedKommuneSchema(lang, options?.kommuneOptions ?? []),
    buildStiftetSchema(lang),
  ];
}

// ─── Filter-application helpers ────────────────────────────────────────────

export interface VirksomhedFilterState {
  status?: string[];
  virksomhedsform?: string[];
  branche?: string[];
  kommune?: string[];
  stiftet?: { min?: number; max?: number };
}

export function narrowVirksomhedFilters(raw: Record<string, unknown>): VirksomhedFilterState {
  return {
    status: Array.isArray(raw.status) ? (raw.status as string[]) : undefined,
    virksomhedsform: Array.isArray(raw.virksomhedsform)
      ? (raw.virksomhedsform as string[])
      : undefined,
    branche: Array.isArray(raw.branche) ? (raw.branche as string[]) : undefined,
    kommune: Array.isArray(raw.kommune) ? (raw.kommune as string[]) : undefined,
    stiftet:
      typeof raw.stiftet === 'object' && raw.stiftet !== null && !Array.isArray(raw.stiftet)
        ? (raw.stiftet as { min?: number; max?: number })
        : undefined,
  };
}

/**
 * Shape som filter-match arbejder mod. Matches CVRSearchResult-felter
 * men er løst koblet for at undgå cirkulær type-import fra API-route.
 */
export interface FilterableVirksomhed {
  active?: boolean;
  status?: string | null;
  companyType?: string | null;
  industry?: string | null;
  kommuneNavn?: string | null;
  stiftetAar?: number | null;
}

export function matchVirksomhedFilter(
  item: FilterableVirksomhed,
  filters: VirksomhedFilterState
): boolean {
  // Status multi-select. "Normal" matcher også legacy `active=true`
  // fallback når status-feltet mangler (ES-svar uden sammensatStatus).
  if (filters.status && filters.status.length > 0) {
    const s = item.status;
    if (s == null) {
      const approx = item.active === true ? 'Normal' : 'Ophørt';
      if (!filters.status.includes(approx)) return false;
    } else if (!filters.status.includes(s)) {
      return false;
    }
  }
  if (filters.virksomhedsform && filters.virksomhedsform.length > 0) {
    const t = item.companyType;
    if (!t) return false;
    // CVR ES companyType varierer mellem fulde navn ("Anpartsselskab")
    // og kortbeskrivelse ("ApS") — match skal være robust begge veje
    // via bidirectional substring-check (case-insensitive).
    const tl = t.toLowerCase();
    if (
      !filters.virksomhedsform.some((f) => {
        const fl = f.toLowerCase();
        return tl === fl || tl.includes(fl) || fl.includes(tl);
      })
    ) {
      return false;
    }
  }
  if (filters.branche && filters.branche.length > 0) {
    const b = item.industry;
    if (!b) return false;
    if (!filters.branche.includes(b)) return false;
  }
  if (filters.kommune && filters.kommune.length > 0) {
    const k = item.kommuneNavn ?? '';
    if (!filters.kommune.includes(k)) return false;
  }
  if (filters.stiftet) {
    const year = item.stiftetAar;
    if (year == null) return false;
    if (filters.stiftet.min !== undefined && year < filters.stiftet.min) return false;
    if (filters.stiftet.max !== undefined && year > filters.stiftet.max) return false;
  }
  return true;
}

/**
 * Udtræk unique brancher fra live-resultater til dynamisk branche-dropdown.
 */
export function buildVirksomhedBrancheOptions(items: FilterableVirksomhed[]): FilterOption[] {
  const seen = new Set<string>();
  for (const item of items) {
    const b = item.industry;
    if (b && b.length > 0) seen.add(b);
  }
  return Array.from(seen)
    .sort((a, b) => a.localeCompare(b, 'da'))
    .map((b) => ({ value: b, label: b }));
}

/**
 * Udtræk unique kommuner til dynamisk kommune-dropdown.
 */
export function buildVirksomhedKommuneOptions(items: FilterableVirksomhed[]): FilterOption[] {
  const seen = new Set<string>();
  for (const item of items) {
    const k = item.kommuneNavn;
    if (k && k.length > 0) seen.add(k);
  }
  return Array.from(seen)
    .sort((a, b) => a.localeCompare(b, 'da'))
    .map((k) => ({ value: k, label: k }));
}
