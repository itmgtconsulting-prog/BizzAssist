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

// ─── Regnskab phase-2 filtre (BIZZ-822) ──────────────────────────────────
//
// Datakilde: public.regnskab_cache.years[*] (ADR-0006). Ingen nye
// tabel eller ETL — caller enricher FilterableVirksomhed med nøgletal
// fra cache-rowen når regnskab-filtre aktiveres. Null-pass-through
// pattern — virksomheder uden regnskabsdata ekskluderes kun når de
// respektive filtre er eksplicit sat (ikke bare fordi filteret findes
// i schema).

/**
 * Regnskabsklasser fra dansk årsregnskabslov. A er mindst, D er størst.
 * Value = CVR/XBRL-string, label = lokaliseret vis-streng.
 */
export const REGNSKABSKLASSE_OPTIONS: Array<{ value: string; da: string; en: string }> = [
  { value: 'A', da: 'Klasse A (mindst)', en: 'Class A (smallest)' },
  { value: 'B', da: 'Klasse B', en: 'Class B' },
  { value: 'C-lille', da: 'Klasse C — lille', en: 'Class C — small' },
  { value: 'C-mellem', da: 'Klasse C — mellem', en: 'Class C — medium' },
  { value: 'C-stor', da: 'Klasse C — stor', en: 'Class C — large' },
  { value: 'D', da: 'Klasse D (børsnoteret)', en: 'Class D (listed)' },
];

/**
 * Antal ansatte range. Dækker typiske virksomhedsstørrelser (0-1000),
 * 1000+ er sjældent og håndteres som "≥1000" i UI.
 */
export function buildAntalAnsatteSchema(lang: 'da' | 'en'): FilterSchema {
  const da = lang === 'da';
  return {
    type: 'range',
    key: 'antalAnsatte',
    label: da ? 'Antal ansatte' : 'Employees',
    min: 0,
    max: 1000,
    step: 1,
    unit: da ? 'ansatte' : 'employees',
  };
}

/**
 * Omsætning range i DKK. Øvre grænse 1B dækker langt de fleste SMB;
 * store koncerner slår tallet op via /dashboard/companies/[cvr] direkte.
 */
export function buildOmsaetningSchema(lang: 'da' | 'en'): FilterSchema {
  const da = lang === 'da';
  return {
    type: 'range',
    key: 'omsaetning',
    label: da ? 'Omsætning' : 'Revenue',
    min: 0,
    max: 1_000_000_000,
    step: 100_000,
    unit: 'DKK',
  };
}

/**
 * Egenkapital range i DKK. Tillader negative værdier (virksomheder
 * med underskudt egenkapital — "teknisk insolvens"). -100M til 1B.
 */
export function buildEgenkapitalSchema(lang: 'da' | 'en'): FilterSchema {
  const da = lang === 'da';
  return {
    type: 'range',
    key: 'egenkapital',
    label: da ? 'Egenkapital' : 'Equity',
    min: -100_000_000,
    max: 1_000_000_000,
    step: 100_000,
    unit: 'DKK',
  };
}

/**
 * Resultat-dropdown: overskud (>0), underskud (<0), balance (=0), alle.
 * Skiller sig fra range-filtre fordi det er en kvalitativ klassifikation
 * brugeren tænker i termer af, ikke et beløbs-interval.
 */
export function buildResultatSchema(lang: 'da' | 'en'): FilterSchema {
  const da = lang === 'da';
  return {
    type: 'dropdown',
    key: 'resultat',
    label: da ? 'Resultat' : 'Net income',
    options: [
      { value: 'alle', label: da ? 'Alle' : 'All' },
      { value: 'overskud', label: da ? 'Overskud' : 'Profit' },
      { value: 'underskud', label: da ? 'Underskud' : 'Loss' },
      { value: 'balance', label: da ? 'Balance (0 kr)' : 'Break-even (0 kr)' },
    ],
    default: 'alle',
  };
}

/**
 * Regnskabsklasse multi-select. Danish årsregnskabslov klasse A-D.
 */
export function buildRegnskabsklasseSchema(lang: 'da' | 'en'): FilterSchema {
  const da = lang === 'da';
  return {
    type: 'multi-select',
    key: 'regnskabsklasse',
    label: da ? 'Regnskabsklasse' : 'Accounting class',
    options: REGNSKABSKLASSE_OPTIONS.map((k) => ({
      value: k.value,
      label: da ? k.da : k.en,
    })),
  };
}

/**
 * Selskabskapital range i DKK. Typiske tærskel-beløb:
 *   - ApS min 40.000 kr (dog 20.000 for IVS → ApS-konvertering)
 *   - A/S min 400.000 kr
 *   - Børs-noterede ofte 10M+
 * Cap 100M dækker de fleste selskaber; store koncerner slås op direkte.
 */
export function buildSelskabskapitalSchema(lang: 'da' | 'en'): FilterSchema {
  const da = lang === 'da';
  return {
    type: 'range',
    key: 'selskabskapital',
    label: da ? 'Selskabskapital' : 'Share capital',
    min: 0,
    max: 100_000_000,
    step: 10_000,
    unit: 'DKK',
  };
}

/**
 * Byg komplet virksomhed-filter schema med bilingual labels og
 * dynamiske options. Kaldes fra UniversalSearchPageClient.
 *
 * BIZZ-822: Phase-2 regnskab-filtre tilføjes i slutningen så
 * phase-1 filtre beholder deres plads i UI-rækkefølgen.
 */
export function buildVirksomhedFilterSchemas(
  lang: 'da' | 'en',
  options?: { brancheOptions?: FilterOption[]; kommuneOptions?: FilterOption[] }
): FilterSchema[] {
  return [
    // Phase 1 (BIZZ-805)
    buildStatusSchema(lang),
    buildVirksomhedsformSchema(lang),
    buildBrancheSchema(lang, options?.brancheOptions ?? []),
    buildVirksomhedKommuneSchema(lang, options?.kommuneOptions ?? []),
    buildStiftetSchema(lang),
    // Phase 2 — regnskab (BIZZ-822)
    buildAntalAnsatteSchema(lang),
    buildOmsaetningSchema(lang),
    buildEgenkapitalSchema(lang),
    buildResultatSchema(lang),
    buildRegnskabsklasseSchema(lang),
    buildSelskabskapitalSchema(lang),
  ];
}

// ─── Filter-application helpers ────────────────────────────────────────────

export interface VirksomhedFilterState {
  // Phase 1
  status?: string[];
  virksomhedsform?: string[];
  branche?: string[];
  kommune?: string[];
  stiftet?: { min?: number; max?: number };
  // Phase 2 regnskab (BIZZ-822)
  antalAnsatte?: { min?: number; max?: number };
  omsaetning?: { min?: number; max?: number };
  egenkapital?: { min?: number; max?: number };
  /** 'alle' | 'overskud' | 'underskud' | 'balance'. 'alle' er no-op. */
  resultat?: string;
  regnskabsklasse?: string[];
  selskabskapital?: { min?: number; max?: number };
}

export function narrowVirksomhedFilters(raw: Record<string, unknown>): VirksomhedFilterState {
  const isRange = (v: unknown): v is { min?: number; max?: number } =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  return {
    status: Array.isArray(raw.status) ? (raw.status as string[]) : undefined,
    virksomhedsform: Array.isArray(raw.virksomhedsform)
      ? (raw.virksomhedsform as string[])
      : undefined,
    branche: Array.isArray(raw.branche) ? (raw.branche as string[]) : undefined,
    kommune: Array.isArray(raw.kommune) ? (raw.kommune as string[]) : undefined,
    stiftet: isRange(raw.stiftet) ? (raw.stiftet as { min?: number; max?: number }) : undefined,
    // Phase 2
    antalAnsatte: isRange(raw.antalAnsatte)
      ? (raw.antalAnsatte as { min?: number; max?: number })
      : undefined,
    omsaetning: isRange(raw.omsaetning)
      ? (raw.omsaetning as { min?: number; max?: number })
      : undefined,
    egenkapital: isRange(raw.egenkapital)
      ? (raw.egenkapital as { min?: number; max?: number })
      : undefined,
    resultat: typeof raw.resultat === 'string' ? raw.resultat : undefined,
    regnskabsklasse: Array.isArray(raw.regnskabsklasse)
      ? (raw.regnskabsklasse as string[])
      : undefined,
    selskabskapital: isRange(raw.selskabskapital)
      ? (raw.selskabskapital as { min?: number; max?: number })
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
  // BIZZ-822: regnskab-nøgletal (seneste år fra regnskab_cache.years[0]).
  // Null pass-through — caller enricher kun når regnskab-filtre er aktive.
  /** Antal ansatte (gennemsnit eller ultimo). */
  antalAnsatte?: number | null;
  /** Omsætning i DKK (ikke tusinde). */
  omsaetning?: number | null;
  /** Egenkapital i DKK (kan være negativ). */
  egenkapital?: number | null;
  /** Årets resultat i DKK (kan være negativ). */
  aaretsResultat?: number | null;
  /** Regnskabsklasse A/B/C-lille/C-mellem/C-stor/D. */
  regnskabsklasse?: string | null;
  /** Selskabskapital i DKK. */
  selskabskapital?: number | null;
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
  // ─── BIZZ-822: regnskab-filtre ────────────────────────────────────────
  // Null pass-through: når caller ikke har enriched regnskab-felter,
  // lader vi items passere. Filter udelukker kun når felt er eksplicit
  // populated OG filteret er sat — samme pattern som personFilterSchema.
  if (filters.antalAnsatte && item.antalAnsatte != null) {
    const n = item.antalAnsatte;
    if (filters.antalAnsatte.min != null && n < filters.antalAnsatte.min) return false;
    if (filters.antalAnsatte.max != null && n > filters.antalAnsatte.max) return false;
  }
  if (filters.omsaetning && item.omsaetning != null) {
    const v = item.omsaetning;
    if (filters.omsaetning.min != null && v < filters.omsaetning.min) return false;
    if (filters.omsaetning.max != null && v > filters.omsaetning.max) return false;
  }
  if (filters.egenkapital && item.egenkapital != null) {
    const v = item.egenkapital;
    if (filters.egenkapital.min != null && v < filters.egenkapital.min) return false;
    if (filters.egenkapital.max != null && v > filters.egenkapital.max) return false;
  }
  if (filters.resultat && filters.resultat !== 'alle' && item.aaretsResultat != null) {
    const r = item.aaretsResultat;
    if (filters.resultat === 'overskud' && r <= 0) return false;
    if (filters.resultat === 'underskud' && r >= 0) return false;
    if (filters.resultat === 'balance' && r !== 0) return false;
  }
  if (
    filters.regnskabsklasse &&
    filters.regnskabsklasse.length > 0 &&
    item.regnskabsklasse != null
  ) {
    if (!filters.regnskabsklasse.includes(item.regnskabsklasse)) return false;
  }
  if (filters.selskabskapital && item.selskabskapital != null) {
    const v = item.selskabskapital;
    if (filters.selskabskapital.min != null && v < filters.selskabskapital.min) return false;
    if (filters.selskabskapital.max != null && v > filters.selskabskapital.max) return false;
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
