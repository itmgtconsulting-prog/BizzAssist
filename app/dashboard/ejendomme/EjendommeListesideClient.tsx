'use client';

/**
 * Ejendomme listeside med live DAWA-adressesøgning.
 *
 * Søger i alle ~2,8 mio. danske adresser via DAWA autocomplete (gratis).
 * Mock-ejendomme vises som "Populære ejendomme" når ingen søgning er aktiv.
 * Rigtige BBR-data hentes via Datafordeler i Fase 2.
 *
 * Filter-panel (BIZZ-28):
 * - Kommunenavn (select fra unikke kommuner i recent-resultater)
 * - Ejendomstype via BBR-anvendelse (Beboelse / Erhverv / Ubebygget)
 * - "Nulstil filtre" knap
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Search,
  MapPin,
  Navigation,
  Building2,
  ChevronRight,
  X,
  Loader2,
  Clock,
  ArrowRight,
  SlidersHorizontal,
  Filter,
} from 'lucide-react';
import FilterPanel, {
  type EjendomFilterState,
  type EjendomstypeFilter,
  DEFAULT_FILTERS,
  countActiveFilters,
} from './FilterPanel';
import { erDawaId, type DawaAutocompleteResult } from '@/app/lib/dawa';
import { hentRecentEjendomme, type RecentEjendom } from '@/app/lib/recentEjendomme';
import { useLanguage } from '@/app/context/LanguageContext';
import { translations } from '@/app/lib/translations';

const RECENT_KEY = 'ba-ejendomme-recent';
const MAX_RECENT = 5;

// ─── Filter types (importeret fra FilterPanel.tsx) ──────────────────────────

/**
 * Klassificerer en BBR-anvendelsestekst til en grov ejendomstype.
 * Returnerer 'beboelse', 'erhverv', 'ubebygget' eller null for ukendt.
 *
 * @param anvendelse - BBR-anvendelsestekst fra RecentEjendom
 * @returns Kategorinavn eller null
 */
function klassificerAnvendelse(anvendelse: string | null): EjendomstypeFilter | null {
  if (!anvendelse) return null;
  const lower = anvendelse.toLowerCase();
  if (
    lower.includes('bolig') ||
    lower.includes('enfamilie') ||
    lower.includes('villa') ||
    lower.includes('lejlighed') ||
    lower.includes('beboelse') ||
    lower.includes('kollegium') ||
    lower.includes('døgninstitution') ||
    lower.includes('fritidshus') ||
    lower.includes('kolonihave') ||
    lower.includes('sommerhus')
  ) {
    return 'beboelse';
  }
  if (
    lower.includes('erhverv') ||
    lower.includes('kontor') ||
    lower.includes('fabrik') ||
    lower.includes('lager') ||
    lower.includes('værksted') ||
    lower.includes('butik') ||
    lower.includes('hotel') ||
    lower.includes('institution') ||
    lower.includes('undervisning') ||
    lower.includes('hospital')
  ) {
    return 'erhverv';
  }
  if (
    lower.includes('ubebygget') ||
    lower.includes('umatrikuleret') ||
    lower.includes('ukendt') ||
    lower.includes('landbrugsjord') ||
    lower.includes('skov')
  ) {
    return 'ubebygget';
  }
  return null;
}

// ─── Filter translations (minimal — bulk moved to FilterPanel.tsx) ──────────

/** Lokale strings kun for chips og inline filter-tekst */
const filterT = {
  da: {
    filtre: 'Filtre',
    nulstilFiltre: 'Nulstil filtre',
    beboelse: 'Beboelse',
    erhverv: 'Erhverv',
    ubebygget: 'Ubebygget',
    alle: 'Alle',
    visResultater: (n: number) => `Viser ${n} ejendomme`,
    ingenMatch: 'Ingen ejendomme matcher filtrene',
  },
  en: {
    filtre: 'Filters',
    nulstilFiltre: 'Reset filters',
    beboelse: 'Residential',
    erhverv: 'Commercial',
    ubebygget: 'Undeveloped',
    alle: 'All',
    visResultater: (n: number) => `Showing ${n} properties`,
    ingenMatch: 'No properties match the filters',
  },
} as const;

// ─── Helper components ───────────────────────────────────────────────────────

/**
 * Kort for én senest set ejendom.
 * Viser adresse, kommune, tidspunkt for besøg og evt. BBR-anvendelse.
 *
 * @param ejendom - Ejendomsdata fra localStorage
 * @param now - Tidsstempel for rendering (undgår impure Date.now() i render)
 * @param p - Oversat strenge fra translations.properties
 */
function RecentEjendomCard({
  ejendom,
  now,
  p,
}: {
  ejendom: RecentEjendom;
  now: number;
  p: typeof translations.da.properties;
}) {
  const minSiden = Math.round((now - ejendom.senestiSet) / 60000);
  const tidTekst =
    minSiden < 1
      ? p.timeJustNow
      : minSiden < 60
        ? `${minSiden} ${p.timeMinAgo}`
        : minSiden < 1440
          ? `${Math.round(minSiden / 60)} ${p.timeHoursAgo}`
          : `${Math.round(minSiden / 1440)} ${p.timeDaysAgo}`;

  return (
    <Link
      href={`/dashboard/ejendomme/${ejendom.id}`}
      className="group bg-slate-800/40 border border-slate-700/40 hover:border-emerald-500/40 rounded-2xl p-5 flex flex-col gap-3 transition-all hover:bg-slate-800/60"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="p-2 rounded-xl text-emerald-400 bg-emerald-400/10">
          <Building2 size={18} />
        </div>
        <div className="flex items-center gap-1 text-slate-500 text-xs">
          <Clock size={11} />
          {tidTekst}
        </div>
      </div>
      <div>
        <p className="text-white font-semibold text-sm leading-snug">{ejendom.adresse}</p>
        <p className="text-slate-400 text-xs mt-0.5">
          {ejendom.postnr} {ejendom.by} · {ejendom.kommune}
        </p>
        {ejendom.anvendelse && <p className="text-slate-500 text-xs mt-1">{ejendom.anvendelse}</p>}
      </div>
      <div className="flex items-center justify-end pt-1 border-t border-slate-700/40">
        <ChevronRight
          size={16}
          className="text-slate-600 group-hover:text-blue-400 transition-colors"
        />
      </div>
    </Link>
  );
}

/**
 * Et enkelt DAWA-resultat i dropdown.
 *
 * @param result - Autocomplete-resultat fra DAWA
 * @param onVælg - Callback ved valg af resultat
 * @param aktiv - Om dette element er tastatur-markeret
 * @param p - Oversat strenge fra translations.properties
 */
function DawaResultItem({
  result,
  onVælg,
  aktiv,
  p,
}: {
  result: DawaAutocompleteResult;
  onVælg: (r: DawaAutocompleteResult) => void;
  aktiv?: boolean;
  p: typeof translations.da.properties;
}) {
  return (
    <button
      type="button"
      onClick={() => onVælg(result)}
      className={`w-full flex items-center gap-3 px-4 py-3 transition-colors text-left group ${
        aktiv ? 'bg-blue-600/20' : 'hover:bg-slate-700/50'
      }`}
    >
      <div
        className={`p-1.5 rounded-lg flex-shrink-0 transition-colors ${aktiv ? 'bg-blue-600/30' : 'bg-slate-700 group-hover:bg-blue-600/20'}`}
      >
        {result.type === 'vejnavn' ? (
          <Navigation
            size={13}
            className={aktiv ? 'text-blue-400' : 'text-slate-400 group-hover:text-blue-400'}
          />
        ) : (
          <MapPin
            size={13}
            className={aktiv ? 'text-blue-400' : 'text-slate-400 group-hover:text-blue-400'}
          />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-white text-sm font-medium truncate">{result.tekst}</p>
        <p className="text-slate-500 text-xs">
          {result.type === 'vejnavn'
            ? p.roadAddNumber
            : result.adresse.postnr
              ? `${result.adresse.postnr} ${result.adresse.postnrnavn}`
              : p.denmark}
        </p>
      </div>
      <ArrowRight
        size={13}
        className={aktiv ? 'text-blue-400' : 'text-slate-600 group-hover:text-blue-400'}
      />
    </button>
  );
}

interface DropdownPos {
  top: number;
  left: number;
  width: number;
}

interface DropdownPortalProps {
  inputRef: React.RefObject<HTMLInputElement | null>;
  dropdownRef: React.RefObject<HTMLDivElement | null>;
  søgning: string;
  resultater: DawaAutocompleteResult[];
  søgerDAWA: boolean;
  søgningFærdig: boolean;
  seneste: DawaAutocompleteResult[];
  markeret: number;
  onVælg: (r: DawaAutocompleteResult) => void;
  p: typeof translations.da.properties;
}

/**
 * Portal-komponent til autocomplete-dropdown.
 *
 * Renderes i document.body for at undgå overflow:hidden klipning fra dashboard.
 * Positionen beregnes i useLayoutEffect (kører synkront efter DOM-mutation, før paint)
 * og gemt i lokal state — overholder React 19-reglen om ingen ref-læsning under render.
 *
 * @param inputRef - Ref til søgeinput — position beregnes relativt hertil
 * @param dropdownRef - Ref til dropdown-div — bruges til klik-uden-for detection
 * @param p - Oversat strenge fra translations.properties
 */
function DropdownPortal({
  inputRef,
  dropdownRef,
  søgning,
  resultater,
  søgerDAWA,
  søgningFærdig,
  seneste,
  markeret,
  onVælg,
  p,
}: DropdownPortalProps) {
  const [pos, setPos] = useState<DropdownPos | null>(null);

  /**
   * Beregn og opdater dropdown-position synkront efter DOM-mutation og ved scroll/resize.
   * useLayoutEffect sikrer at positionen er sat før browseren painter — ingen flash.
   */
  useEffect(() => {
    function opdater() {
      if (!inputRef.current) return;
      const r = inputRef.current.getBoundingClientRect();
      if (r.width > 0) setPos({ top: r.bottom + 8, left: r.left, width: r.width });
    }
    opdater();
    window.addEventListener('resize', opdater);
    window.addEventListener('scroll', opdater, true);
    return () => {
      window.removeEventListener('resize', opdater);
      window.removeEventListener('scroll', opdater, true);
    };
  }, [inputRef]);

  if (!pos) return null;

  return createPortal(
    <div
      ref={dropdownRef}
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        width: pos.width,
        zIndex: 9999,
      }}
      className="bg-slate-800 border border-slate-700/60 rounded-2xl overflow-hidden shadow-2xl"
    >
      {/* Seneste søgninger */}
      {søgning.length < 2 && seneste.length > 0 && (
        <div>
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-700/40">
            <Clock size={12} className="text-slate-500" />
            <span className="text-slate-500 text-xs font-medium uppercase tracking-wide">
              {p.recentSearches}
            </span>
          </div>
          {seneste
            .filter((r) => r.adresse?.id)
            .map((r) => (
              <DawaResultItem key={r.adresse.id} result={r} onVælg={onVælg} p={p} />
            ))}
        </div>
      )}

      {/* DAWA-resultater */}
      {søgning.length >= 2 && (
        <>
          {søgerDAWA && (
            <div className="flex items-center gap-3 px-4 py-3 text-slate-500 text-sm">
              <Loader2 size={14} className="animate-spin" />
              {p.searchingAll}
            </div>
          )}
          {!søgerDAWA && søgningFærdig && resultater.length === 0 && (
            <div className="px-4 py-4 text-slate-500 text-sm text-center">
              {p.noAddressesFound} &ldquo;{søgning}&rdquo;
            </div>
          )}
          {resultater
            .filter((r) => r.adresse?.id)
            .map((r, i) => (
              <DawaResultItem
                key={r.adresse.id}
                result={r}
                onVælg={onVælg}
                aktiv={i === markeret}
                p={p}
              />
            ))}
          {resultater.length === 8 && (
            <div className="px-4 py-2 border-t border-slate-700/40">
              <p className="text-slate-600 text-xs text-center">{p.showingBestResults}</p>
            </div>
          )}
        </>
      )}
    </div>,
    document.body
  );
}

// ─── Filter panel (sidepanel — importeret fra FilterPanel.tsx) ───────────────

/**
 * Viser aktive filtre som removable chip-piller for ejendomme-listesiden.
 *
 * @param filters - Aktive filtervalg
 * @param onFiltersChange - Callback til opdatering
 * @param lang - Aktuelt sprog
 */
function ActiveFilterChips({
  filters,
  onFiltersChange,
  lang,
}: {
  filters: EjendomFilterState;
  onFiltersChange: (f: EjendomFilterState) => void;
  lang: 'da' | 'en';
}) {
  const ft = filterT[lang];
  const chips: { label: string; onRemove: () => void }[] = [];

  if (filters.kommune) {
    chips.push({
      label: filters.kommune,
      onRemove: () => onFiltersChange({ ...filters, kommune: '' }),
    });
  }
  if (filters.postnummer) {
    chips.push({
      label: filters.postnummer,
      onRemove: () => onFiltersChange({ ...filters, postnummer: '' }),
    });
  }
  if (filters.ejendomstype !== 'alle') {
    const labels: Record<EjendomstypeFilter, string> = {
      alle: ft.alle,
      beboelse: ft.beboelse,
      erhverv: ft.erhverv,
      blandet: lang === 'da' ? 'Blandet' : 'Mixed',
      ubebygget: ft.ubebygget,
    };
    chips.push({
      label: labels[filters.ejendomstype],
      onRemove: () => onFiltersChange({ ...filters, ejendomstype: 'alle' }),
    });
  }
  if (filters.aldersPreset) {
    chips.push({
      label: filters.aldersPreset,
      onRemove: () => onFiltersChange({ ...filters, aldersPreset: '' }),
    });
  }
  if (filters.arealMin || filters.arealMax) {
    const label = `${filters.arealMin || '0'}–${filters.arealMax || '∞'} m²`;
    chips.push({
      label,
      onRemove: () => onFiltersChange({ ...filters, arealMin: '', arealMax: '' }),
    });
  }
  if (filters.ejerType) {
    chips.push({
      label:
        lang === 'da'
          ? filters.ejerType === 'person'
            ? 'Privatperson'
            : 'Virksomhed'
          : filters.ejerType === 'person'
            ? 'Private person'
            : 'Company',
      onRemove: () => onFiltersChange({ ...filters, ejerType: '' }),
    });
  }
  if (filters.vaerdiPreset) {
    chips.push({
      label: `${filters.vaerdiPreset} mio. kr`,
      onRemove: () => onFiltersChange({ ...filters, vaerdiPreset: '' }),
    });
  }

  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 mt-3">
      {chips.map((chip) => (
        <span
          key={chip.label}
          className="inline-flex items-center gap-1.5 bg-blue-900/40 text-blue-300 border border-blue-700/50 rounded-full px-3 py-1 text-xs"
        >
          {chip.label}
          <button
            type="button"
            onClick={chip.onRemove}
            aria-label={`${lang === 'da' ? 'Fjern filter' : 'Remove filter'}: ${chip.label}`}
            className="text-blue-400 hover:text-blue-200 transition-colors"
          >
            <X size={11} />
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={() => onFiltersChange(DEFAULT_FILTERS)}
        className="text-slate-500 hover:text-slate-300 text-xs transition-colors ml-1"
      >
        {ft.nulstilFiltre}
      </button>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

/**
 * Ejendomme listeside.
 * Kombinerer DAWA live-søgning med mock-ejendomme som inspiration.
 * Filtrerer de loadede recent-ejendomme lokalt via filterState (BIZZ-28).
 */
export default function EjendommeListesideClient() {
  const { lang } = useLanguage();
  const p = translations[lang].properties;
  const ft = filterT[lang];
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const [søgning, setSøgning] = useState('');
  const [resultater, setResultater] = useState<DawaAutocompleteResult[]>([]);
  const [søgerDAWA, setSøgerDAWA] = useState(false);
  /** True når DAWA-kaldet er afsluttet — holder dropdown åben selv ved 0 resultater */
  const [søgningFærdig, setSøgningFærdig] = useState(false);
  const [åben, setÅben] = useState(false);
  const [markeret, setMarkeret] = useState(-1);
  /** Seneste sete ejendomme — indlæst fra localStorage ved mount */
  const [senesteEjendomme, setSenesteEjendomme] = useState<RecentEjendom[]>([]);
  /** Timestamp for "tid siden" — sat ved mount for at undgå impure Date.now() i render */
  const [renderNow, setRenderNow] = useState(0);

  /** Om filter-panelet er synligt */
  const [filterOpen, setFilterOpen] = useState(false);

  /** BIZZ-1089: Søgeresultater fra /api/search/ejendomme (UI integration i BIZZ-1090) */
  const [_searchResults, setSearchResults] = useState<Array<{
    bfe_nummer: number;
    kommune_kode: number | null;
    samlet_boligareal: number | null;
    opfoerelsesaar: number | null;
    energimaerke: string | null;
    byg021_anvendelse: string | null;
  }> | null>(null);
  const [_searchTotal, setSearchTotal] = useState(0);
  const [searchPage, _setSearchPage] = useState(1);
  const [_searchLoading, setSearchLoading] = useState(false);
  const [_hasActiveSearch, setHasActiveSearch] = useState(false);

  /** Aktive filtervalg — standard = ingen filter */
  const [filters, setFilters] = useState<EjendomFilterState>(DEFAULT_FILTERS);

  useEffect(() => {
    setSenesteEjendomme(hentRecentEjendomme());
    setRenderNow(Date.now());
    // Re-render when Supabase cache is populated
    const handler = () => setSenesteEjendomme(hentRecentEjendomme());
    window.addEventListener('ba-recents-updated', handler);
    return () => window.removeEventListener('ba-recents-updated', handler);
  }, []);

  /**
   * BIZZ-1089: Kald søge-API når filtre ændres.
   * Debounce 300ms + abort stale requests.
   */
  const searchAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    const hasFilters =
      filters.kommune !== '' ||
      filters.postnummer !== '' ||
      filters.ejendomstype !== 'alle' ||
      filters.arealMin !== '' ||
      filters.arealMax !== '' ||
      filters.aldersPreset !== '' ||
      filters.vaerdiPreset !== '';

    if (!hasFilters) {
      setHasActiveSearch(false);
      setSearchResults(null);
      return;
    }

    setHasActiveSearch(true);
    setSearchLoading(true);
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;

    const timer = setTimeout(async () => {
      const params = new URLSearchParams();
      if (filters.ejendomstype !== 'alle')
        params.set('type', filters.ejendomstype === 'beboelse' ? 'bolig' : filters.ejendomstype);
      if (filters.arealMin) params.set('areal_min', filters.arealMin);
      if (filters.arealMax) params.set('areal_max', filters.arealMax);
      // BIZZ-1090: Wire manglende filtre til API
      if (filters.energimaerke) params.set('energi', filters.energimaerke);
      if (filters.kommune) params.set('kommune', filters.kommune);
      if (filters.aldersPreset) {
        const presetMap: Record<string, [number, number]> = {
          foer1900: [0, 1899],
          '1900-1960': [1900, 1960],
          '1960-2000': [1960, 2000],
          efter2000: [2000, 9999],
        };
        const range = presetMap[filters.aldersPreset];
        if (range) {
          params.set('aar_min', String(range[0]));
          params.set('aar_max', String(range[1]));
        }
      }
      params.set('page', String(searchPage));
      params.set('limit', '20');

      try {
        const res = await fetch(`/api/search/ejendomme?${params}`, { signal: controller.signal });
        if (res.ok && !controller.signal.aborted) {
          const data = await res.json();
          setSearchResults(data.results ?? []);
          setSearchTotal(data.total ?? 0);
        }
      } catch {
        /* abort */
      } finally {
        if (!controller.signal.aborted) setSearchLoading(false);
      }
    }, 300);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [filters, searchPage]);

  /**
   * Unikke kommunenavne fra de loadede recent-ejendomme.
   * Sorteret alfabetisk.
   */
  const uniqueKommuner = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const e of senesteEjendomme) {
      if (e.kommune) set.add(e.kommune);
    }
    return Array.from(set).sort();
  }, [senesteEjendomme]);

  /**
   * BIZZ-1007: Unikke postnumre fra de loadede recent-ejendomme.
   * Sorteret numerisk.
   */
  const uniquePostnumre = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const e of senesteEjendomme) {
      if (e.postnr) set.add(e.postnr);
    }
    return Array.from(set).sort();
  }, [senesteEjendomme]);

  /**
   * Filtreret liste af recent-ejendomme baseret på aktive filtervalg.
   * Kører rent client-side på allerede-loadede data.
   */
  const filteredEjendomme = useMemo<RecentEjendom[]>(() => {
    return senesteEjendomme.filter((e) => {
      // Kommune-filter
      if (filters.kommune && e.kommune !== filters.kommune) return false;
      // BIZZ-1007: Postnummer-filter
      if (filters.postnummer && e.postnr !== filters.postnummer) return false;
      // Ejendomstype-filter baseret på klassificering af anvendelse
      if (filters.ejendomstype !== 'alle') {
        const kategori = klassificerAnvendelse(e.anvendelse);
        if (kategori !== filters.ejendomstype) return false;
      }
      return true;
    });
  }, [senesteEjendomme, filters]);

  /** Om nogen filtre er aktive */
  const hasActiveFilters = useMemo<boolean>(() => {
    return countActiveFilters(filters) > 0;
  }, [filters]);

  /** Lazy initialisering fra localStorage — filtrerer evt. korrupt/forældet data fra */
  const [seneste, setSeneste] = useState<DawaAutocompleteResult[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      const parsed = raw ? (JSON.parse(raw) as DawaAutocompleteResult[]) : [];
      // Bevar kun elementer med gyldig adresse-struktur
      return Array.isArray(parsed) ? parsed.filter((r) => r?.adresse?.id) : [];
    } catch {
      return [];
    }
  });

  /** Gem nyligt valgt adresse i localStorage */
  const gemSeneste = useCallback((result: DawaAutocompleteResult) => {
    setSeneste((prev) => {
      const filtreret = prev.filter((r) => r.adresse?.id !== result.adresse.id);
      const opdateret = [result, ...filtreret].slice(0, MAX_RECENT);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(opdateret));
      } catch {
        /* ignorer */
      }
      return opdateret;
    });
  }, []);

  /** Luk dropdown ved klik udenfor */
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setÅben(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  /**
   * Debounced DAWA-søgning.
   * Nulstiller søgningFærdig ved søgningsændring, sætter den til true når svaret modtages.
   * Dropdown forbliver åben via søgningFærdig selvom resultater er tomme (viser "ingen fundet").
   */
  useEffect(() => {
    setSøgningFærdig(false);
    const timer = setTimeout(async () => {
      if (søgning.trim().length < 2) {
        setResultater([]);
        setSøgerDAWA(false);
        return;
      }
      setSøgerDAWA(true);
      const res = await fetch(`/api/adresse/autocomplete?q=${encodeURIComponent(søgning)}`);
      const data: DawaAutocompleteResult[] = res.ok ? await res.json() : [];
      setResultater(data);
      setSøgerDAWA(false);
      setSøgningFærdig(true);
    }, 220);
    return () => clearTimeout(timer);
  }, [søgning]);

  /**
   * Håndterer valg af et autocomplete-resultat.
   * - vejnavn-type: udfylder søgefeltet med gadenavn + mellemrum så brugeren kan taste husnummer
   * - adresse/adgangsadresse: navigerer til ejendomsdetaljesiden
   */
  function vælgAdresse(result: DawaAutocompleteResult) {
    if (!erDawaId(result.adresse.id)) {
      // Vejnavn — autoudfyld søgefeltet og hold dropdown åben
      setSøgning(result.adresse.vejnavn + ' ');
      setMarkeret(-1);
      inputRef.current?.focus();
      return;
    }
    gemSeneste(result);
    setÅben(false);
    setSøgning('');
    router.push(`/dashboard/ejendomme/${result.adresse.id}`);
  }

  const visDropdown =
    åben &&
    (resultater.length > 0 ||
      søgerDAWA ||
      søgningFærdig || // Behold åben efter DAWA svarer — selvom 0 resultater (viser "ingen fundet")
      (søgning.length < 2 && seneste.length > 0));

  return (
    <div className="flex-1 flex flex-col bg-[#0a1628]">
      {/* ─── Header ─── */}
      <div className="px-8 pt-8 pb-6 border-b border-slate-700/40">
        <h1 className="text-2xl font-bold text-emerald-400 mb-1">{p.title}</h1>
        <p className="text-slate-400 text-sm">{p.subtitle}</p>

        {/* Søgeboks med DAWA autocomplete + Filter toggle */}
        <div className="relative mt-5">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search
                size={18}
                className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
              />
              <input
                ref={inputRef}
                type="text"
                value={søgning}
                onChange={(e) => {
                  setSøgning(e.target.value);
                  setÅben(true);
                  setMarkeret(-1);
                }}
                onFocus={() => setÅben(true)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setMarkeret((m) => Math.min(m + 1, resultater.length - 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setMarkeret((m) => Math.max(m - 1, -1));
                  } else if (e.key === 'Enter') {
                    const valgt = markeret >= 0 ? resultater[markeret] : resultater[0];
                    if (valgt) vælgAdresse(valgt);
                  } else if (e.key === 'Escape') {
                    setÅben(false);
                    setMarkeret(-1);
                  }
                }}
                placeholder={p.searchPlaceholder}
                className="w-full bg-slate-800/60 border border-slate-600/50 focus:border-blue-500/60 rounded-2xl pl-11 pr-12 py-4 text-white placeholder:text-slate-500 outline-none transition-all text-base shadow-lg"
              />
              {/* Loader / Ryd-knap */}
              <div className="absolute right-4 top-1/2 -translate-y-1/2">
                {søgerDAWA ? (
                  <Loader2 size={18} className="text-blue-400 animate-spin" />
                ) : søgning.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSøgning('');
                      setResultater([]);
                      setÅben(false);
                      inputRef.current?.focus();
                    }}
                    className="text-slate-500 hover:text-slate-300 transition-colors"
                  >
                    <X size={18} />
                  </button>
                ) : null}
              </div>
            </div>

            {/* BIZZ-1007: Filter toggle — åbner sidepanel */}
            {senesteEjendomme.length > 0 && (
              <button
                type="button"
                onClick={() => setFilterOpen((o) => !o)}
                aria-label={ft.filtre}
                aria-expanded={filterOpen}
                className={`flex items-center gap-2 px-4 py-2 rounded-2xl border transition-all text-sm font-medium shadow-lg ${
                  hasActiveFilters || filterOpen
                    ? 'bg-emerald-600/20 border-emerald-500/50 text-emerald-300'
                    : 'bg-slate-800/60 border-slate-600/50 text-slate-400 hover:border-slate-500/60 hover:text-slate-300'
                }`}
              >
                <SlidersHorizontal size={16} />
                {ft.filtre}
                {hasActiveFilters && (
                  <span className="bg-emerald-500 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                    {countActiveFilters(filters)}
                  </span>
                )}
              </button>
            )}
          </div>

          {/* Active filter chips */}
          <ActiveFilterChips filters={filters} onFiltersChange={setFilters} lang={lang} />

          {/* Dropdown via Portal — undgår overflow:hidden klipning fra dashboard layout */}
          {visDropdown && typeof document !== 'undefined' && (
            <DropdownPortal
              inputRef={inputRef}
              dropdownRef={dropdownRef}
              søgning={søgning}
              resultater={resultater}
              søgerDAWA={søgerDAWA}
              søgningFærdig={søgningFærdig}
              seneste={seneste}
              markeret={markeret}
              onVælg={vælgAdresse}
              p={p}
            />
          )}
        </div>
      </div>

      {/* ─── Indhold + Filter-sidepanel ─── */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-y-auto px-8 py-6">
          {/* BIZZ-1090: Søgeresultater fra database (når filtre er aktive) */}
          {_hasActiveSearch && (
            <div className="mb-6">
              <div className="flex items-center gap-2 mb-3">
                <Search size={15} className="text-emerald-400" />
                <h2 className="text-white font-semibold text-base">
                  {lang === 'da' ? 'Søgeresultater' : 'Search results'}
                </h2>
                <span className="text-slate-500 text-xs">
                  {_searchTotal.toLocaleString(lang === 'da' ? 'da-DK' : 'en-GB')}{' '}
                  {lang === 'da' ? 'ejendomme' : 'properties'}
                </span>
              </div>
              {_searchLoading ? (
                <div className="flex items-center gap-2 text-slate-500 text-sm py-8">
                  <Loader2 size={14} className="animate-spin" />
                  {lang === 'da' ? 'Søger...' : 'Searching...'}
                </div>
              ) : _searchResults && _searchResults.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {_searchResults.map((r) => (
                    <Link
                      key={r.bfe_nummer}
                      href={`/dashboard/ejendomme/${r.bfe_nummer}`}
                      className="bg-slate-800/40 border border-slate-700/40 hover:border-emerald-500/40 rounded-xl p-4 transition-all hover:bg-slate-800/60"
                    >
                      <p className="text-white text-sm font-medium">BFE {r.bfe_nummer}</p>
                      <div className="flex gap-3 mt-1 text-xs text-slate-400">
                        {r.samlet_boligareal && <span>{r.samlet_boligareal} m²</span>}
                        {r.opfoerelsesaar && (
                          <span>
                            {lang === 'da' ? 'Opf.' : 'Built'} {r.opfoerelsesaar}
                          </span>
                        )}
                        {r.energimaerke && (
                          <span className="text-emerald-400">{r.energimaerke}</span>
                        )}
                        {r.kommune_kode && <span>Komm. {r.kommune_kode}</span>}
                      </div>
                    </Link>
                  ))}
                </div>
              ) : (
                <p className="text-slate-500 text-sm py-4">
                  {lang === 'da' ? 'Ingen resultater' : 'No results'}
                </p>
              )}
            </div>
          )}

          {/* Seneste sete ejendomme */}
          {senesteEjendomme.length > 0 ? (
            <div>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Clock size={15} className="text-slate-400" />
                  <h2 className="text-white font-semibold text-base">{p.recentlyViewed}</h2>
                  {hasActiveFilters && (
                    <span className="text-slate-500 text-xs">
                      — {ft.visResultater(filteredEjendomme.length)}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    fetch('/api/recents?type=property', { method: 'DELETE' }).catch(() => {});
                    setSenesteEjendomme([]);
                  }}
                  className="text-slate-600 hover:text-slate-400 text-xs transition-colors"
                >
                  {p.clearHistory}
                </button>
              </div>

              {filteredEjendomme.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {filteredEjendomme.map((e) => (
                    <RecentEjendomCard key={e.id} ejendom={e} now={renderNow} p={p} />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-12 text-center gap-3">
                  <div className="p-4 bg-slate-800/40 rounded-2xl">
                    <Filter size={24} className="text-slate-600" />
                  </div>
                  <p className="text-slate-400 text-sm font-medium">{ft.ingenMatch}</p>
                  <button
                    type="button"
                    onClick={() => setFilters(DEFAULT_FILTERS)}
                    className="text-emerald-400 hover:text-emerald-300 text-xs transition-colors"
                  >
                    {ft.nulstilFiltre}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
              <div className="p-4 bg-slate-800/40 rounded-2xl">
                <Building2 size={28} className="text-slate-600" />
              </div>
              <p className="text-slate-400 text-sm font-medium">{p.noPropertiesYet}</p>
              <p className="text-slate-600 text-xs max-w-xs leading-relaxed">
                {p.noPropertiesHint}
              </p>
            </div>
          )}
        </div>

        {/* BIZZ-1007: Filter-sidepanel */}
        <FilterPanel
          filters={filters}
          onFiltersChange={setFilters}
          uniqueKommuner={uniqueKommuner}
          uniquePostnumre={uniquePostnumre}
          resultCount={filteredEjendomme.length}
          isOpen={filterOpen}
          onClose={() => setFilterOpen(false)}
          lang={lang}
        />
      </div>
    </div>
  );
}
