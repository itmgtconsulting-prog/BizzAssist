/**
 * VirksomhedshandlerClient — M&A-radar tabel med AI-berigelse.
 *
 * BIZZ-1929: Kandidat-tabel med filter, AI-berig-knap per row,
 * og bulk-berigelse for top 10.
 *
 * @module app/dashboard/analyse/virksomhedshandler/VirksomhedshandlerClient
 */

'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import Link from 'next/link';
import { ChevronDown, X, Download, Building2, User } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import VirksomhedshandelDetailModal from './VirksomhedshandelDetailModal';
import {
  deriveCvrStatusKode,
  CVR_STATUS_INFO,
  CVR_STATUS_KODER,
  type CvrStatusKode,
} from '@/app/lib/cvrStatusMapping';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Kandidat {
  deltager_enhedsnummer: number;
  deltager_navn: string;
  // Klassificering fra API: er deltageren en virksomhed (navne-match i cvr_virksomhed)?
  // deltager_cvr er kun sat ved unikt match → bruges til direkte company-link.
  deltager_er_virksomhed?: boolean;
  deltager_cvr?: string | null;
  virksomhed_cvr: string;
  relation_type: string;
  current_ejerandel_pct: number;
  prev_ejerandel_pct: number;
  gyldig_fra: string;
  gyldig_til: string | null;
  // Reel ejerskabs-ændringsdato = COALESCE(gyldig_til, gyldig_fra), beregnet server-side.
  aendringsdato: string | null;
  sidst_opdateret: string | null;
  signal_type: 'entry' | 'exit' | 'increase' | 'decrease';
  virksomhed_navn: string | null;
  branche_tekst: string | null;
  branche_kode: string | null;
  // Seneste regnskabstal fra regnskab_cache (null = ikke cachet endnu)
  regnskab_aar: number | null;
  omsaetning: number | string | null;
  bruttofortjeneste: number | string | null;
  overskud: number | string | null; // resultat før skat
  // BIZZ-1962: rå CVR-status-JSON + server-udledt kategori for virksomheden.
  // deltager_status_raw er kun sat når deltageren er en virksomhed med entydigt CVR.
  virksomhed_status_raw?: string | null;
  virksomhed_status_kode?: CvrStatusKode | null;
  deltager_status_raw?: string | null;
  // BIZZ-1974: autoritativ ophørsdato (cvr_virksomhed.ophoert) for hhv. virksomheden
  // og deltager-virksomheden — bruges som fallback når status-blobben er NULL.
  virksomhed_ophoert?: string | null;
  deltager_ophoert?: string | null;
  // BIZZ-1967: autoritativ aktiv-markør for deltageren (person ELLER virksomhed),
  // fra cvr_deltager.is_aktiv. true = aktiv/levende, false = ophørt, null = ukendt.
  deltager_is_aktiv?: boolean | null;
}

/**
 * Kompakt status-badge: lille farvet prik + label med hover-tooltip (BIZZ-1962).
 *
 * @param kode - Status-kategori at vise.
 * @param lang - Aktivt sprog (da/en) til label.
 * @returns Inline badge-element.
 */
function StatusBadge({ kode, lang }: { kode: CvrStatusKode; lang: 'da' | 'en' }) {
  const info = CVR_STATUS_INFO[kode];
  const label = lang === 'da' ? info.label : info.labelEn;
  return (
    <span
      title={label}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${info.badgeClass}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${info.dotClass}`} aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * Udleder deltagerens aktiv-status (BIZZ-1967).
 *
 * cvr_deltager.is_aktiv er den autoritative aktiv-markør for BÅDE personer og
 * virksomheder (levende person / aktiv virksomhed = true, ophørt = false). For
 * virksomheds-deltagere med entydigt CVR foretrækkes den rige rå-status (incl.
 * konkurs-undertyper) når den findes; ellers bruges is_aktiv (true→aktiv,
 * false→ophørt). null is_aktiv ⟹ ukendt (returnerer null = filtreres ikke).
 *
 * @param k - Kandidat-rækken.
 * @returns Status-kategori, eller null hvis ukendt.
 */
function deltagerStatusKode(k: Kandidat): CvrStatusKode | null {
  // BIZZ-1974: for virksomheds-deltagere udledes status af status-blobben OG den
  // autoritative ophoert-dato (blobben er NULL for de fleste selskaber).
  if (k.deltager_er_virksomhed && (k.deltager_status_raw != null || k.deltager_ophoert != null)) {
    return deriveCvrStatusKode(k.deltager_status_raw, k.deltager_ophoert);
  }
  if (k.deltager_is_aktiv === true) return 'aktiv';
  if (k.deltager_is_aktiv === false) return 'tvangsoploest';
  return null;
}

interface BrancheOption {
  branche_kode: string;
  branche_tekst: string;
  antal: number;
}

interface BerigResult {
  estimeret_transaktionsvaerdi: { lav: number; mid: number; hoej: number; currency: 'DKK' } | null;
  breakdown: {
    ebitda_used: number;
    multiple: { lav: number; mid: number; hoej: number };
    ev_range: { lav: number; mid: number; hoej: number };
    delta_pct: number;
    transaktionsvaerdi: { lav: number; mid: number; hoej: number };
    branche_label: string;
    kilde: string;
  } | null;
  data_sources: string[];
  caveats: string[];
  confidence: 'low' | 'medium' | 'high';
  confidence_reason: string;
}

type SignalType = 'entry' | 'exit' | 'increase' | 'decrease';

// ─── Helpers ────────────────────────────────────────────────────────────────

const SIGNAL_LABELS: Record<string, { da: string; en: string; color: string }> = {
  entry: { da: 'Ny ejer', en: 'New owner', color: 'bg-emerald-500/20 text-emerald-400' },
  exit: { da: 'Fratrådt', en: 'Exited', color: 'bg-red-500/20 text-red-400' },
  increase: { da: 'Øget andel', en: 'Increased', color: 'bg-blue-500/20 text-blue-400' },
  decrease: { da: 'Reduceret', en: 'Decreased', color: 'bg-amber-500/20 text-amber-400' },
};

/**
 * Formaterer beløb i DKK med tusind-separator.
 *
 * @param amount - Beløb i DKK
 */
function formatDKK(amount: number): string {
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)} mio. DKK`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(0)} t. DKK`;
  return `${amount} DKK`;
}

/**
 * Formaterer et (muligt negativt eller manglende) regnskabsbeløb kompakt.
 *
 * @param amount - Beløb i DKK (number, string fra bigint, eller null)
 * @returns Kompakt streng ("12,3 mio.", "-450 t.", "—" ved manglende data)
 */
function formatRegnskab(amount: number | string | null | undefined): string {
  if (amount == null || amount === '') return '—';
  const n = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)} mio.`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(0)} t.`;
  return `${sign}${abs}`;
}

/** Default-startdato for ændringsdato-filteret: 3 måneder tilbage (ISO YYYY-MM-DD). */
function defaultFromDate(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 3);
  return d.toISOString().slice(0, 10);
}

/** Default signal-filtre (alle undtagen 'decrease'). */
const DEFAULT_SIGNALS: SignalType[] = ['entry', 'exit', 'increase'];

// ─── Component ──────────────────────────────────────────────────────────────

/**
 * VirksomhedshandlerClient — fuld M&A-radar side med tabel og filtre.
 */
export default function VirksomhedshandlerClient() {
  const { lang } = useLanguage();
  const t = (da: string, en: string) => (lang === 'da' ? da : en);

  // State
  const [kandidater, setKandidater] = useState<Kandidat[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [signalFilters, setSignalFilters] = useState<Set<SignalType>>(new Set(DEFAULT_SIGNALS));
  const [signalDropdownOpen, setSignalDropdownOpen] = useState(false);
  // Default: seneste 3 måneder (baseret på ændringsdato = COALESCE(gyldig_til, gyldig_fra))
  const [fromDate, setFromDate] = useState(defaultFromDate);
  const [toDate, setToDate] = useState('');
  // Indrapporterings-dato (server-side range på sidst_opdateret = per-række
  // ingestion-dato). Ingen default — kun aktiv når brugeren sætter en grænse.
  const [indrapFra, setIndrapFra] = useState('');
  const [indrapTil, setIndrapTil] = useState('');
  const [offset, setOffset] = useState(0);
  const [berigResults, setBerigResults] = useState<Record<string, BerigResult>>({});
  const [berigLoading, setBerigLoading] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  // BIZZ-1948: AI-forklaring-popup for en beriget kandidat (transaktionsværdi-breakdown).
  const [detailModal, setDetailModal] = useState<{
    navn: string;
    cvr: string;
    berig: BerigResult;
  } | null>(null);
  // Kolonne-filtre
  const [deltagerFilter, setDeltagerFilter] = useState('');
  const [cvrFilter, setCvrFilter] = useState('');

  // BIZZ-1962: status-filtre. Virksomheds-status filtreres server-side (påvirker
  // total + pagination korrekt); deltager-status filtreres klient-side på den
  // hentede side (konsistent med de øvrige tekst-filtre i denne kolonne-række).
  // Default for begge = kun 'aktiv' → ophørte selskaber skjules som udgangspunkt.
  const [virksomhedStatusFilters, setVirksomhedStatusFilters] = useState<Set<CvrStatusKode>>(
    () => new Set<CvrStatusKode>(['aktiv'])
  );
  const [virksomhedStatusDropdownOpen, setVirksomhedStatusDropdownOpen] = useState(false);
  const [deltagerStatusFilters, setDeltagerStatusFilters] = useState<Set<CvrStatusKode>>(
    () => new Set<CvrStatusKode>(['aktiv'])
  );
  const [deltagerStatusDropdownOpen, setDeltagerStatusDropdownOpen] = useState(false);
  // Branche-filter (server-side, multiselect på branche_kode)
  const [brancheOptions, setBrancheOptions] = useState<BrancheOption[]>([]);
  const [selectedBrancher, setSelectedBrancher] = useState<Set<string>>(new Set());
  const [brancheDropdownOpen, setBrancheDropdownOpen] = useState(false);
  const [brancheSearch, setBrancheSearch] = useState('');
  // Regnskabs-range-filtre (server-side, DKK)
  const [minOmsaetning, setMinOmsaetning] = useState('');
  const [maxOmsaetning, setMaxOmsaetning] = useState('');
  const [minBruttofortjeneste, setMinBruttofortjeneste] = useState('');
  const [maxBruttofortjeneste, setMaxBruttofortjeneste] = useState('');
  const [minOverskud, setMinOverskud] = useState('');
  const [maxOverskud, setMaxOverskud] = useState('');
  // Klient-side filtre på kolonner uden server-støtte:
  // Ændring = ejerandels-delta (pp), Est. værdi + Confidence = AI-berigede felter.
  const [minAendring, setMinAendring] = useState('');
  const [maxAendring, setMaxAendring] = useState('');
  const [minEstVaerdi, setMinEstVaerdi] = useState('');
  const [maxEstVaerdi, setMaxEstVaerdi] = useState('');
  const [confidenceFilter, setConfidenceFilter] = useState<Set<'low' | 'medium' | 'high'>>(
    new Set()
  );
  const [confidenceDropdownOpen, setConfidenceDropdownOpen] = useState(false);
  // Server-side sortering: kolonne-nøgle + retning (klik på overskrift toggler).
  // Default = ændringsdato (nyeste ejerskabsændringer først).
  const [sortKey, setSortKey] = useState('aendringsdato');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  // Persisterede filter-settings: gemmes pr. bruger i public.users.preferences
  // (JSONB) via /api/preferences — IKKE localStorage (jf. CLAUDE.md state-regel),
  // så samme bruger ser sine seneste filtre på tværs af browsere/enheder.
  // prefsLoaded gater både første fetch og auto-gem, så vi ikke overskriver de
  // gemte filtre med default-værdier under den indledende restore.
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  const LIMIT = 50;

  // Er mindst ét filter aktivt (afviger fra default)? Styrer "Nulstil filtre".
  const signalsAreDefault =
    signalFilters.size === DEFAULT_SIGNALS.length &&
    DEFAULT_SIGNALS.every((s) => signalFilters.has(s));
  // Status-default = præcis {aktiv}; alt andet tæller som aktivt filter.
  const statusIsDefault = (s: Set<CvrStatusKode>) => s.size === 1 && s.has('aktiv');
  const anyFilterActive =
    !statusIsDefault(virksomhedStatusFilters) ||
    !statusIsDefault(deltagerStatusFilters) ||
    !signalsAreDefault ||
    selectedBrancher.size > 0 ||
    !!minOmsaetning ||
    !!maxOmsaetning ||
    !!minBruttofortjeneste ||
    !!maxBruttofortjeneste ||
    !!minOverskud ||
    !!maxOverskud ||
    !!minAendring ||
    !!maxAendring ||
    !!minEstVaerdi ||
    !!maxEstVaerdi ||
    confidenceFilter.size > 0 ||
    !!deltagerFilter ||
    !!cvrFilter ||
    !!toDate ||
    !!indrapFra ||
    !!indrapTil ||
    fromDate !== defaultFromDate();

  /** Nulstiller alle filtre til default-tilstand (auto-gem persisterer det bagefter). */
  const resetFilters = useCallback(() => {
    setSignalFilters(new Set(DEFAULT_SIGNALS));
    setFromDate(defaultFromDate());
    setToDate('');
    setIndrapFra('');
    setIndrapTil('');
    setSelectedBrancher(new Set());
    setMinOmsaetning('');
    setMaxOmsaetning('');
    setMinBruttofortjeneste('');
    setMaxBruttofortjeneste('');
    setMinOverskud('');
    setMaxOverskud('');
    setMinAendring('');
    setMaxAendring('');
    setMinEstVaerdi('');
    setMaxEstVaerdi('');
    setConfidenceFilter(new Set());
    setDeltagerFilter('');
    setCvrFilter('');
    setVirksomhedStatusFilters(new Set<CvrStatusKode>(['aktiv']));
    setDeltagerStatusFilters(new Set<CvrStatusKode>(['aktiv']));
    setSortKey('aendringsdato');
    setSortDir('desc');
    setOffset(0);
  }, []);

  /**
   * Toggler sortering på en kolonne. Første klik på en ny kolonne → desc;
   * efterfølgende klik på samme kolonne skifter mellem desc og asc.
   *
   * @param key - Sorteringskolonne-nøgle (matcher route'ens whitelist)
   */
  const toggleSort = useCallback((key: string) => {
    setSortKey((prevKey) => {
      if (prevKey === key) {
        setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
        return key;
      }
      setSortDir('desc');
      return key;
    });
    setOffset(0);
  }, []);

  /**
   * Renderer en klikbar, sorterbar kolonneoverskrift med retnings-indikator.
   *
   * @param key - Sorteringsnøgle (matcher route'ens whitelist)
   * @param label - Vist kolonnenavn
   * @param align - Tekst-justering (left/right)
   */
  const renderSortTh = (key: string, label: string, align: 'left' | 'right' = 'left') => {
    const active = sortKey === key;
    return (
      <th className={`px-4 py-2 ${align === 'right' ? 'text-right' : ''}`}>
        <button
          type="button"
          onClick={() => toggleSort(key)}
          aria-label={t(`Sortér efter ${label}`, `Sort by ${label}`)}
          className={`inline-flex items-center gap-1 uppercase tracking-wider transition-colors hover:text-white ${
            active ? 'text-white' : ''
          } ${align === 'right' ? 'flex-row-reverse' : ''}`}
        >
          {label}
          <span className="text-[9px] text-slate-400">
            {active ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
          </span>
        </button>
      </th>
    );
  };

  // ─── Fetch kandidater ─────────────────────────────────────────────

  // Sekvens-guard: hvert kald får et stigende id; kun det nyeste svar må
  // opdatere tabellen. Forhindrer at et langsomt, mindre-filtreret svar
  // (fx midt i indtastning af et beløb) overskriver et nyere, korrekt svar.
  const reqSeq = useRef(0);

  const fetchKandidater = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    const params = new URLSearchParams();
    if (signalFilters.size > 0) {
      params.set('signal_types', [...signalFilters].join(','));
    }
    if (fromDate) params.set('from_date', fromDate);
    if (toDate) params.set('to_date', toDate);
    if (indrapFra) params.set('indrapporteret_fra', indrapFra);
    if (indrapTil) params.set('indrapporteret_til', indrapTil);
    if (selectedBrancher.size > 0) params.set('brancher', [...selectedBrancher].join(','));
    // Virksomheds-status filtreres server-side. Tom = server-default (kun aktiv).
    if (virksomhedStatusFilters.size > 0)
      params.set('virksomhed_status', [...virksomhedStatusFilters].join(','));
    if (minOmsaetning) params.set('min_omsaetning', minOmsaetning);
    if (maxOmsaetning) params.set('max_omsaetning', maxOmsaetning);
    if (minBruttofortjeneste) params.set('min_bruttofortjeneste', minBruttofortjeneste);
    if (maxBruttofortjeneste) params.set('max_bruttofortjeneste', maxBruttofortjeneste);
    if (minOverskud) params.set('min_overskud', minOverskud);
    if (maxOverskud) params.set('max_overskud', maxOverskud);
    params.set('sort', sortKey);
    params.set('dir', sortDir);
    params.set('limit', String(LIMIT));
    params.set('offset', String(offset));

    try {
      const res = await fetch(`/api/virksomhedshandler/kandidater?${params}`);
      // Ignorér svar hvis et nyere kald er startet i mellemtiden (stale guard).
      if (seq !== reqSeq.current) return;
      if (res.ok) {
        const data = await res.json();
        setKandidater(data.kandidater);
        setTotal(data.total);
      }
    } finally {
      // Lad kun det nyeste kald rydde loading-state.
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [
    signalFilters,
    fromDate,
    toDate,
    indrapFra,
    indrapTil,
    selectedBrancher,
    virksomhedStatusFilters,
    minOmsaetning,
    maxOmsaetning,
    minBruttofortjeneste,
    maxBruttofortjeneste,
    minOverskud,
    maxOverskud,
    sortKey,
    sortDir,
    offset,
  ]);

  // Restore: hent brugerens gemte M&A-radar-filtre én gang ved mount og
  // gendan dem. Sæt prefsLoaded=true uanset udfald, så fetch/auto-gem frigives.
  useEffect(() => {
    let aktiv = true;
    void (async () => {
      try {
        const res = await fetch('/api/preferences');
        if (res.ok && aktiv) {
          const data = await res.json();
          const f = data?.preferences?.maRadarFilters;
          if (f && typeof f === 'object') {
            if (Array.isArray(f.signalFilters))
              setSignalFilters(new Set(f.signalFilters as SignalType[]));
            if (typeof f.fromDate === 'string') setFromDate(f.fromDate);
            if (typeof f.toDate === 'string') setToDate(f.toDate);
            if (typeof f.indrapFra === 'string') setIndrapFra(f.indrapFra);
            if (typeof f.indrapTil === 'string') setIndrapTil(f.indrapTil);
            if (Array.isArray(f.brancher)) setSelectedBrancher(new Set(f.brancher as string[]));
            if (Array.isArray(f.virksomhedStatus))
              setVirksomhedStatusFilters(new Set(f.virksomhedStatus as CvrStatusKode[]));
            if (Array.isArray(f.deltagerStatus))
              setDeltagerStatusFilters(new Set(f.deltagerStatus as CvrStatusKode[]));
            if (typeof f.minOmsaetning === 'string') setMinOmsaetning(f.minOmsaetning);
            if (typeof f.maxOmsaetning === 'string') setMaxOmsaetning(f.maxOmsaetning);
            if (typeof f.minBruttofortjeneste === 'string')
              setMinBruttofortjeneste(f.minBruttofortjeneste);
            if (typeof f.maxBruttofortjeneste === 'string')
              setMaxBruttofortjeneste(f.maxBruttofortjeneste);
            if (typeof f.minOverskud === 'string') setMinOverskud(f.minOverskud);
            if (typeof f.maxOverskud === 'string') setMaxOverskud(f.maxOverskud);
            if (typeof f.minAendring === 'string') setMinAendring(f.minAendring);
            if (typeof f.maxAendring === 'string') setMaxAendring(f.maxAendring);
            if (typeof f.minEstVaerdi === 'string') setMinEstVaerdi(f.minEstVaerdi);
            if (typeof f.maxEstVaerdi === 'string') setMaxEstVaerdi(f.maxEstVaerdi);
            if (Array.isArray(f.confidence))
              setConfidenceFilter(new Set(f.confidence as Array<'low' | 'medium' | 'high'>));
            if (typeof f.sortKey === 'string') setSortKey(f.sortKey);
            if (f.sortDir === 'asc' || f.sortDir === 'desc') setSortDir(f.sortDir);
          }
        }
      } catch {
        // Mislykket restore er ikke kritisk — falder tilbage til defaults
      } finally {
        if (aktiv) setPrefsLoaded(true);
      }
    })();
    return () => {
      aktiv = false;
    };
  }, []);

  // Fetch kører først efter restore, så vi ikke laver et spildt kald med
  // default-filtre inden de gemte filtre er gendannet.
  useEffect(() => {
    if (!prefsLoaded) return;
    void fetchKandidater();
  }, [prefsLoaded, fetchKandidater]);

  // Auto-gem: debounced PUT af de aktuelle filtre til brugerens preferences.
  // Springer over indtil restore er færdig (prefsLoaded), så default-værdier
  // aldrig overskriver de gemte filtre.
  useEffect(() => {
    if (!prefsLoaded) return;
    const handle = setTimeout(() => {
      void fetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preferences: {
            maRadarFilters: {
              signalFilters: [...signalFilters],
              fromDate,
              toDate,
              indrapFra,
              indrapTil,
              brancher: [...selectedBrancher],
              virksomhedStatus: [...virksomhedStatusFilters],
              deltagerStatus: [...deltagerStatusFilters],
              minOmsaetning,
              maxOmsaetning,
              minBruttofortjeneste,
              maxBruttofortjeneste,
              minOverskud,
              maxOverskud,
              minAendring,
              maxAendring,
              minEstVaerdi,
              maxEstVaerdi,
              confidence: [...confidenceFilter],
              sortKey,
              sortDir,
            },
          },
        }),
      }).catch(() => {
        // Gem-fejl er ikke kritisk — filtrene virker stadig i nuværende session
      });
    }, 800);
    return () => clearTimeout(handle);
  }, [
    prefsLoaded,
    signalFilters,
    fromDate,
    toDate,
    indrapFra,
    indrapTil,
    selectedBrancher,
    virksomhedStatusFilters,
    deltagerStatusFilters,
    minOmsaetning,
    maxOmsaetning,
    minBruttofortjeneste,
    maxBruttofortjeneste,
    minOverskud,
    maxOverskud,
    minAendring,
    maxAendring,
    minEstVaerdi,
    maxEstVaerdi,
    confidenceFilter,
    sortKey,
    sortDir,
  ]);

  // Hent branche-optioner til multiselect-filteret (én gang, cachet server-side)
  useEffect(() => {
    let aktiv = true;
    void (async () => {
      try {
        const res = await fetch('/api/virksomhedshandler/brancher');
        if (res.ok && aktiv) {
          const data = await res.json();
          setBrancheOptions(Array.isArray(data.brancher) ? data.brancher : []);
        }
      } catch {
        // Filter-panelet fungerer uden options — ignorér netværksfejl
      }
    })();
    return () => {
      aktiv = false;
    };
  }, []);

  // ─── Berig single row ─────────────────────────────────────────────

  const berigRow = useCallback(
    async (k: Kandidat) => {
      const key = `${k.deltager_enhedsnummer}-${k.virksomhed_cvr}-${k.gyldig_fra}`;
      if (berigResults[key] || berigLoading.has(key)) return;

      setBerigLoading((prev) => new Set(prev).add(key));
      try {
        const delta = Math.abs(k.current_ejerandel_pct - k.prev_ejerandel_pct);
        // Brug reelle regnskabstal: overskud (resultat før skat) som EBITDA-proxy
        // og virksomhedens DB07-branchekode. Falder tilbage til 0/'70' når
        // regnskab endnu ikke er cachet (giver lavere confidence i berig-routen).
        const overskudNum =
          k.overskud == null || k.overskud === ''
            ? 0
            : typeof k.overskud === 'string'
              ? Number(k.overskud)
              : k.overskud;
        // Omsætning sendes med som datakilde/caveat-kontekst (ikke til beregningen).
        const omsaetningNum =
          k.omsaetning == null || k.omsaetning === ''
            ? null
            : typeof k.omsaetning === 'string'
              ? Number(k.omsaetning)
              : k.omsaetning;
        const res = await fetch('/api/virksomhedshandler/berig', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kandidat_id: key,
            virksomhed_cvr: k.virksomhed_cvr,
            person_enhedsnummer: k.deltager_enhedsnummer,
            deltager_navn: k.deltager_navn,
            virksomhed_navn: k.virksomhed_navn ?? undefined,
            ejerandel_delta_pp: delta,
            aarsresultat_dkk: Number.isFinite(overskudNum) ? overskudNum : 0,
            branchekode: k.branche_kode || '70',
            omsaetning_dkk:
              omsaetningNum != null && Number.isFinite(omsaetningNum) ? omsaetningNum : null,
            regnskab_aar: k.regnskab_aar ?? null,
            gyldig_fra: k.gyldig_fra,
          }),
        });
        if (res.ok) {
          const data: BerigResult = await res.json();
          setBerigResults((prev) => ({ ...prev, [key]: data }));
        }
      } finally {
        setBerigLoading((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [berigResults, berigLoading]
  );

  // ─── Bulk berig top 10 ────────────────────────────────────────────

  const bulkBerig = useCallback(async () => {
    setBulkLoading(true);
    const top10 = kandidater.slice(0, 10);
    for (const k of top10) {
      await berigRow(k);
    }
    setBulkLoading(false);
  }, [kandidater, berigRow]);

  // ─── Klient-side filtrering ───────────────────────────────────────
  // Anvendes både af tabellen og Excel-eksporten, så de altid viser
  // præcis det samme udsnit (ingen divergens mellem skærm og fil).
  const filteredKandidater = kandidater.filter((k) => {
    if (deltagerFilter && !k.deltager_navn.toLowerCase().includes(deltagerFilter.toLowerCase()))
      return false;
    if (cvrFilter) {
      const q = cvrFilter.toLowerCase();
      if (!k.virksomhed_cvr.includes(q) && !(k.virksomhed_navn ?? '').toLowerCase().includes(q))
        return false;
    }
    const delta = Math.abs(k.current_ejerandel_pct - k.prev_ejerandel_pct);
    if (minAendring && delta < Number(minAendring)) return false;
    if (maxAendring && delta > Number(maxAendring)) return false;
    const key = `${k.deltager_enhedsnummer}-${k.virksomhed_cvr}-${k.gyldig_fra}`;
    const berig = berigResults[key];
    if (minEstVaerdi || maxEstVaerdi) {
      const mid = berig?.estimeret_transaktionsvaerdi?.mid;
      if (mid == null) return false;
      if (minEstVaerdi && mid < Number(minEstVaerdi)) return false;
      if (maxEstVaerdi && mid > Number(maxEstVaerdi)) return false;
    }
    if (confidenceFilter.size > 0) {
      if (!berig || !confidenceFilter.has(berig.confidence)) return false;
    }
    // BIZZ-1967: deltager-status filtreres nu via den autoritative is_aktiv-markør
    // (gælder BÅDE personer og virksomheder). Ophørte deltagere skjules når kun
    // "Aktiv" er valgt; levende personer regnes som aktive. Ukendt status (null
    // is_aktiv uden entydigt virksomheds-CVR) passerer altid.
    if (deltagerStatusFilters.size > 0) {
      const kode = deltagerStatusKode(k);
      if (kode != null && !deltagerStatusFilters.has(kode)) return false;
    }
    return true;
  });

  // ─── Excel-eksport ────────────────────────────────────────────────

  /**
   * Eksporterer den aktuelt filtrerede liste til en CSV-fil som dansk
   * Excel åbner direkte (UTF-8 BOM + semikolon-separator). Eksporterer
   * præcis de rækker der vises (server-side side + klient-side filtre).
   */
  const exportCsv = useCallback(() => {
    // Semikolon-separator: dansk Excel bruger ';' som standard-delimiter.
    const SEP = ';';
    // Escape: ombrydes i dobbelt-citationstegn hvis værdien indeholder
    // separator, citationstegn eller linjeskift (RFC 4180).
    const esc = (v: string | number | null | undefined): string => {
      const s = v == null ? '' : String(v);
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const headers = [
      t('Signal', 'Signal'),
      t('Ejer', 'Owner'),
      t('Ejer-status', 'Owner status'),
      t('Virksomhed', 'Company'),
      'CVR',
      t('Virksomheds-status', 'Company status'),
      t('Branche', 'Industry'),
      t('Omsætning (DKK)', 'Revenue (DKK)'),
      t('Bruttofortjeneste (DKK)', 'Gross profit (DKK)'),
      t('Overskud (DKK)', 'Profit (DKK)'),
      t('Ændring fra (%)', 'Change from (%)'),
      t('Ændring til (%)', 'Change to (%)'),
      t('Delta (pp)', 'Delta (pp)'),
      t('Ændringsdato', 'Change date'),
      t('Indrapporteret', 'Reported'),
      t('Est. transaktionsværdi (DKK)', 'Est. transaction value (DKK)'),
      'Confidence',
    ];
    const num = (v: number | string | null | undefined): string => {
      if (v == null || v === '') return '';
      const n = typeof v === 'string' ? Number(v) : v;
      return Number.isFinite(n) ? String(n) : '';
    };
    const rows = filteredKandidater.map((k) => {
      const key = `${k.deltager_enhedsnummer}-${k.virksomhed_cvr}-${k.gyldig_fra}`;
      const berig = berigResults[key];
      const delta = Math.abs(k.current_ejerandel_pct - k.prev_ejerandel_pct);
      const fraPct = k.signal_type === 'exit' ? k.current_ejerandel_pct : k.prev_ejerandel_pct;
      const tilPct = k.signal_type === 'exit' ? 0 : k.current_ejerandel_pct;
      // BIZZ-1967: status-label til eksport via autoritativ is_aktiv-udledning.
      const deltagerKode = deltagerStatusKode(k);
      const deltagerStatusLabel =
        deltagerKode != null
          ? CVR_STATUS_INFO[deltagerKode][lang === 'da' ? 'label' : 'labelEn']
          : '';
      const virksomhedStatusLabel =
        CVR_STATUS_INFO[
          k.virksomhed_status_kode ??
            deriveCvrStatusKode(k.virksomhed_status_raw, k.virksomhed_ophoert)
        ][lang === 'da' ? 'label' : 'labelEn'];
      return [
        SIGNAL_LABELS[k.signal_type]?.[lang === 'da' ? 'da' : 'en'] ?? k.signal_type,
        k.deltager_navn,
        deltagerStatusLabel,
        k.virksomhed_navn ?? k.virksomhed_cvr,
        k.virksomhed_cvr,
        virksomhedStatusLabel,
        k.branche_tekst ?? '',
        num(k.omsaetning),
        num(k.bruttofortjeneste),
        num(k.overskud),
        num(fraPct),
        num(tilPct),
        num(delta),
        (k.aendringsdato ?? k.gyldig_til ?? k.gyldig_fra)?.slice(0, 10) ?? '',
        k.sidst_opdateret?.slice(0, 10) ?? '',
        num(berig?.estimeret_transaktionsvaerdi?.mid),
        berig?.confidence ?? '',
      ]
        .map(esc)
        .join(SEP);
    });
    const csv = '\uFEFF' + [headers.map(esc).join(SEP), ...rows].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ma-radar-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [filteredKandidater, berigResults, lang, t]);

  /**
   * Renderer en kompakt multi-select status-dropdown til en kolonne-filterrække
   * (BIZZ-1962). Genbruges af både Deltager- og Virksomheds-kolonnen.
   *
   * @param filters - Aktuelt valgte status-kategorier.
   * @param setFilters - State-setter for kategorierne.
   * @param open - Er dropdownen åben?
   * @param setOpen - State-setter for åben/lukket.
   * @param ariaLabel - Tilgængeligheds-label for knappen.
   */
  const renderStatusDropdown = (
    filters: Set<CvrStatusKode>,
    setFilters: React.Dispatch<React.SetStateAction<Set<CvrStatusKode>>>,
    open: boolean,
    setOpen: React.Dispatch<React.SetStateAction<boolean>>,
    ariaLabel: string
  ) => (
    <div className="relative mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={ariaLabel}
        className="w-full bg-slate-900/60 border border-slate-700/40 rounded px-2 py-0.5 text-[10px] text-white flex items-center justify-between gap-1"
      >
        <span className="truncate">
          {filters.size === 0
            ? t('Alle', 'All')
            : filters.size === 1
              ? lang === 'da'
                ? CVR_STATUS_INFO[[...filters][0]].label
                : CVR_STATUS_INFO[[...filters][0]].labelEn
              : `${filters.size} ${t('valgt', 'selected')}`}
        </span>
        <ChevronDown
          size={11}
          className={`text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-30 bg-slate-800 border border-slate-700 rounded-lg shadow-xl py-1 min-w-[190px]">
          {CVR_STATUS_KODER.map((kode) => {
            const info = CVR_STATUS_INFO[kode];
            return (
              <label
                key={kode}
                className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-700/50 cursor-pointer text-sm text-white"
              >
                <input
                  type="checkbox"
                  checked={filters.has(kode)}
                  onChange={() => {
                    setFilters((prev) => {
                      const next = new Set(prev);
                      if (next.has(kode)) next.delete(kode);
                      else next.add(kode);
                      return next;
                    });
                    setOffset(0);
                  }}
                  className="accent-indigo-500 w-3.5 h-3.5"
                />
                <span
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium ${info.badgeClass}`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${info.dotClass}`}
                    aria-hidden="true"
                  />
                  {lang === 'da' ? info.label : info.labelEn}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );

  // ─── Render ───────────────────────────────────────────────────────

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-[#0a1628] p-6 gap-6">
      {/* Header */}
      <div className="shrink-0">
        <h1 className="text-white text-2xl font-bold">
          {t('Virksomhedshandler — M&A-radar', 'Corporate Transactions — M&A Radar')}
        </h1>
        <p className="text-slate-400 text-sm mt-1">
          {t(
            'AI-drevet detektion af ejerskabsændringer med værdiansættelse',
            'AI-driven ownership change detection with valuation'
          )}
        </p>
      </div>

      {/* Info banner */}
      <div className="shrink-0 bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
        <p className="text-amber-300 text-sm font-medium mb-1">
          {t('Vigtige begrænsninger', 'Important limitations')}
        </p>
        <ul className="text-amber-200/80 text-xs space-y-1 list-disc list-inside">
          <li>
            {t(
              'Ejerskabsændring ≠ handel — kan være arv, fusion, eller omstrukturering',
              'Ownership change ≠ trade — may be inheritance, merger, or restructuring'
            )}
          </li>
          <li>
            {t(
              'Ejerandels-interval (25-50%, 50-75% osv.) giver usikre delta-beregninger',
              'Ownership interval ranges (25-50%, 50-75% etc.) create uncertain delta calculations'
            )}
          </li>
          <li>
            {t(
              'Ingen tinglysningsdata — pris ved handel er ukendt',
              'No land registry data — transaction price is unknown'
            )}
          </li>
        </ul>
      </div>

      {/* Toolbar: resultat-tæller, nulstil-filtre, berig + top-pagination.
          Selve filtrene bor nu i tabel-headeren (per-kolonne, lige over data). */}
      <div className="shrink-0 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-4">
          <p className="text-slate-400 text-xs">
            {t(
              `${total.toLocaleString('da-DK')} kandidater fundet`,
              `${total.toLocaleString('en')} candidates found`
            )}
          </p>
          {anyFilterActive && (
            <button
              type="button"
              onClick={resetFilters}
              aria-label={t('Nulstil alle filtre', 'Reset all filters')}
              className="text-xs text-slate-400 hover:text-white underline-offset-2 hover:underline transition-colors"
            >
              {t('Nulstil filtre', 'Reset filters')}
            </button>
          )}
          {/* BIZZ-1962: hurtig-toggle — sætter begge status-filtre til kun Aktiv. */}
          <button
            type="button"
            onClick={() => {
              setVirksomhedStatusFilters(new Set<CvrStatusKode>(['aktiv']));
              setDeltagerStatusFilters(new Set<CvrStatusKode>(['aktiv']));
              setOffset(0);
            }}
            aria-label={t('Skjul alle ophørte selskaber', 'Hide all ceased companies')}
            title={t(
              'Skjuler konkursramte, opløste og fusionerede selskaber (både deltager og virksomhed).',
              'Hides bankrupt, dissolved and merged companies (both participant and company).'
            )}
            className="inline-flex items-center gap-1.5 bg-slate-700 hover:bg-slate-600 text-white text-xs px-3 py-1.5 rounded-lg transition-colors"
          >
            {t('Skjul alle ophørte', 'Hide all ceased')}
          </button>
          <button
            onClick={exportCsv}
            disabled={filteredKandidater.length === 0}
            aria-label={t('Eksporter til Excel', 'Export to Excel')}
            className="inline-flex items-center gap-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg transition-colors"
          >
            <Download size={13} />
            {t('Eksporter til Excel', 'Export to Excel')}
          </button>
          <button
            onClick={bulkBerig}
            disabled={bulkLoading || kandidater.length === 0}
            aria-label={t('Berig top 10 med AI', 'Enrich top 10 with AI')}
            title={t(
              'Estimerer transaktionsværdi for de 10 største ejerandels-ændringer baseret på regnskabsdata og branche-multiples.',
              'Estimates transaction value for the 10 largest ownership changes based on financials and industry multiples.'
            )}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg transition-colors"
          >
            {bulkLoading
              ? t('Beriger...', 'Enriching...')
              : t('Berig top 10 med AI', 'Enrich top 10 with AI')}
          </button>
        </div>
        {total > LIMIT && (
          <div className="flex items-center gap-3">
            <button
              onClick={() => setOffset(Math.max(0, offset - LIMIT))}
              disabled={offset === 0}
              aria-label={t('Forrige side', 'Previous page')}
              className="text-sm text-slate-400 hover:text-white disabled:opacity-30 transition-colors"
            >
              ← {t('Forrige', 'Previous')}
            </button>
            <span className="text-xs text-slate-400 tabular-nums">
              {offset + 1}–{Math.min(offset + LIMIT, total)} / {total.toLocaleString('da-DK')}
            </span>
            <button
              onClick={() => setOffset(offset + LIMIT)}
              disabled={offset + LIMIT >= total}
              aria-label={t('Næste side', 'Next page')}
              className="text-sm text-slate-400 hover:text-white disabled:opacity-30 transition-colors"
            >
              {t('Næste', 'Next')} →
            </button>
          </div>
        )}
      </div>

      {/* Table — flex-1 så den udfylder resten af højden og er det ENESTE
          vertikale scroll-område (ingen dobbelt-scrollbar, bund altid nåelig) */}
      <div className="thick-scroll flex-1 min-h-0 overflow-auto rounded-xl border border-slate-700/30">
        <table className="w-full text-sm">
          <thead className="bg-slate-800 sticky top-0 z-10 shadow-[0_1px_0_0_rgba(148,163,184,0.2)]">
            <tr className="text-left text-slate-400 text-xs uppercase tracking-wider">
              <th className="px-4 py-2">{t('Signal', 'Signal')}</th>
              {renderSortTh('deltager', t('Ejer', 'Owner'))}
              {renderSortTh('virksomhed', t('Virksomhed', 'Company'))}
              {renderSortTh('branche', t('Branche', 'Industry'))}
              {renderSortTh('omsaetning', t('Omsætning', 'Revenue'), 'right')}
              {renderSortTh('bruttofortjeneste', t('Bruttofortjeneste', 'Gross profit'), 'right')}
              {renderSortTh('overskud', t('Overskud', 'Profit'), 'right')}
              {renderSortTh('aendring', t('Ændring', 'Change'))}
              {renderSortTh('aendringsdato', t('Ændringsdato', 'Change date'))}
              {renderSortTh('indrapporteret', t('Indrapporteret', 'Reported'))}
              <th className="px-4 py-2">{t('Est. transaktionsværdi', 'Est. transaction value')}</th>
              <th className="px-4 py-2">{t('Confidence', 'Confidence')}</th>
              <th className="px-4 py-2" />
            </tr>
            {/* Per-kolonne filter-række — hvert filter sidder lige over sin egen
                kolonne (signal, deltager, virksomhed, branche, beløb, ændringsdato). */}
            <tr className="bg-slate-800/30 align-top normal-case tracking-normal">
              {/* Signal-multiselect */}
              <th className="px-2 py-1 relative font-normal">
                <button
                  type="button"
                  onClick={() => setSignalDropdownOpen((v) => !v)}
                  aria-label={t('Filtrer på signaltype', 'Filter by signal type')}
                  className="w-full bg-slate-900/60 border border-slate-700/40 rounded px-2 py-0.5 text-[10px] text-white flex items-center justify-between gap-1"
                >
                  <span className="truncate">
                    {signalFilters.size === 0
                      ? t('Alle', 'All')
                      : signalFilters.size === 1
                        ? (SIGNAL_LABELS[[...signalFilters][0]]?.[lang === 'da' ? 'da' : 'en'] ??
                          [...signalFilters][0])
                        : `${signalFilters.size} ${t('valgt', 'selected')}`}
                  </span>
                  <ChevronDown
                    size={11}
                    className={`text-slate-400 transition-transform ${signalDropdownOpen ? 'rotate-180' : ''}`}
                  />
                </button>
                {signalDropdownOpen && (
                  <div className="absolute top-full left-0 mt-1 z-30 bg-slate-800 border border-slate-700 rounded-lg shadow-xl py-1 min-w-[170px]">
                    {(['entry', 'exit', 'increase', 'decrease'] as SignalType[]).map((sig) => (
                      <label
                        key={sig}
                        className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-700/50 cursor-pointer text-sm text-white"
                      >
                        <input
                          type="checkbox"
                          checked={signalFilters.has(sig)}
                          onChange={() => {
                            setSignalFilters((prev) => {
                              const next = new Set(prev);
                              if (next.has(sig)) next.delete(sig);
                              else next.add(sig);
                              return next;
                            });
                            setOffset(0);
                          }}
                          className="accent-indigo-500 w-3.5 h-3.5"
                        />
                        <span
                          className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${SIGNAL_LABELS[sig]?.color ?? ''}`}
                        >
                          {SIGNAL_LABELS[sig]?.[lang === 'da' ? 'da' : 'en'] ?? sig}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </th>
              {/* Deltager-tekstfilter + status-multiselect (BIZZ-1962) */}
              <th className="px-2 py-1 relative font-normal">
                <input
                  type="text"
                  value={deltagerFilter}
                  onChange={(e) => setDeltagerFilter(e.target.value)}
                  placeholder={t('Filtrer...', 'Filter...')}
                  aria-label={t('Filtrer ejer', 'Filter owner')}
                  className="w-full bg-slate-900/60 border border-slate-700/40 rounded px-2 py-0.5 text-[11px] text-white placeholder-slate-400 focus:border-indigo-500/50 focus:outline-none"
                />
                {renderStatusDropdown(
                  deltagerStatusFilters,
                  setDeltagerStatusFilters,
                  deltagerStatusDropdownOpen,
                  setDeltagerStatusDropdownOpen,
                  t('Filtrer på ejer-status', 'Filter by owner status')
                )}
              </th>
              {/* Virksomhed-tekstfilter + status-multiselect (BIZZ-1962) */}
              <th className="px-2 py-1 relative font-normal">
                <input
                  type="text"
                  value={cvrFilter}
                  onChange={(e) => setCvrFilter(e.target.value)}
                  placeholder={t('Filtrer...', 'Filter...')}
                  aria-label={t('Filtrer virksomhed', 'Filter company')}
                  className="w-full bg-slate-900/60 border border-slate-700/40 rounded px-2 py-0.5 text-[11px] text-white placeholder-slate-400 focus:border-indigo-500/50 focus:outline-none"
                />
                {renderStatusDropdown(
                  virksomhedStatusFilters,
                  setVirksomhedStatusFilters,
                  virksomhedStatusDropdownOpen,
                  setVirksomhedStatusDropdownOpen,
                  t('Filtrer på virksomheds-status', 'Filter by company status')
                )}
              </th>
              {/* Branche-multiselect */}
              <th className="px-2 py-1 relative font-normal">
                <button
                  type="button"
                  onClick={() => setBrancheDropdownOpen((v) => !v)}
                  aria-label={t('Filtrer på branche', 'Filter by industry')}
                  className="w-full bg-slate-900/60 border border-slate-700/40 rounded px-2 py-0.5 text-[10px] text-white flex items-center justify-between gap-1"
                >
                  <span className="truncate">
                    {selectedBrancher.size === 0
                      ? t('Alle', 'All')
                      : `${selectedBrancher.size} ${t('valgt', 'selected')}`}
                  </span>
                  <ChevronDown
                    size={11}
                    className={`text-slate-400 transition-transform ${brancheDropdownOpen ? 'rotate-180' : ''}`}
                  />
                </button>
                {brancheDropdownOpen && (
                  <div className="absolute top-full left-0 mt-1 z-30 bg-slate-800 border border-slate-700 rounded-lg shadow-xl w-[320px] max-h-[340px] flex flex-col">
                    <div className="p-2 border-b border-slate-700/60">
                      <input
                        type="text"
                        value={brancheSearch}
                        onChange={(e) => setBrancheSearch(e.target.value)}
                        placeholder={t('Søg branche...', 'Search industry...')}
                        aria-label={t('Søg branche', 'Search industry')}
                        className="w-full bg-slate-900/60 border border-slate-700/40 rounded px-2 py-1 text-xs text-white placeholder-slate-400 focus:border-indigo-500/50 focus:outline-none"
                      />
                    </div>
                    <div className="overflow-auto py-1">
                      {brancheOptions.length === 0 ? (
                        <p className="px-3 py-2 text-xs text-slate-400">
                          {t('Indlæser brancher...', 'Loading industries...')}
                        </p>
                      ) : (
                        brancheOptions
                          .filter(
                            (b) =>
                              !brancheSearch ||
                              b.branche_tekst.toLowerCase().includes(brancheSearch.toLowerCase()) ||
                              b.branche_kode.includes(brancheSearch)
                          )
                          .slice(0, 200)
                          .map((b) => (
                            <label
                              key={b.branche_kode}
                              className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-700/50 cursor-pointer text-xs text-white"
                            >
                              <input
                                type="checkbox"
                                checked={selectedBrancher.has(b.branche_kode)}
                                onChange={() => {
                                  setSelectedBrancher((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(b.branche_kode)) next.delete(b.branche_kode);
                                    else next.add(b.branche_kode);
                                    return next;
                                  });
                                  setOffset(0);
                                }}
                                className="accent-indigo-500 w-3.5 h-3.5 shrink-0"
                              />
                              <span className="truncate flex-1">{b.branche_tekst}</span>
                              <span className="text-slate-400 tabular-nums">
                                {b.antal.toLocaleString('da-DK')}
                              </span>
                            </label>
                          ))
                      )}
                    </div>
                    {selectedBrancher.size > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedBrancher(new Set());
                          setOffset(0);
                        }}
                        className="text-left px-3 py-1.5 text-xs text-slate-400 hover:text-white border-t border-slate-700/50"
                      >
                        {t('Nulstil branchevalg', 'Reset industry selection')}
                      </button>
                    )}
                  </div>
                )}
              </th>
              {/* Omsætning min/max */}
              <th className="px-2 py-1 font-normal">
                <div className="flex flex-col gap-0.5">
                  <input
                    type="number"
                    value={minOmsaetning}
                    onChange={(e) => {
                      setMinOmsaetning(e.target.value);
                      setOffset(0);
                    }}
                    placeholder={t('Min', 'Min')}
                    aria-label={t('Minimum omsætning', 'Minimum revenue')}
                    className="w-full bg-slate-900/60 border border-slate-700/40 rounded px-2 py-0.5 text-[11px] text-white text-right tabular-nums placeholder-slate-400 focus:border-indigo-500/50 focus:outline-none"
                  />
                  <input
                    type="number"
                    value={maxOmsaetning}
                    onChange={(e) => {
                      setMaxOmsaetning(e.target.value);
                      setOffset(0);
                    }}
                    placeholder={t('Max', 'Max')}
                    aria-label={t('Maksimum omsætning', 'Maximum revenue')}
                    className="w-full bg-slate-900/60 border border-slate-700/40 rounded px-2 py-0.5 text-[11px] text-white text-right tabular-nums placeholder-slate-400 focus:border-indigo-500/50 focus:outline-none"
                  />
                </div>
              </th>
              {/* Bruttofortjeneste min/max */}
              <th className="px-2 py-1 font-normal">
                <div className="flex flex-col gap-0.5">
                  <input
                    type="number"
                    value={minBruttofortjeneste}
                    onChange={(e) => {
                      setMinBruttofortjeneste(e.target.value);
                      setOffset(0);
                    }}
                    placeholder={t('Min', 'Min')}
                    aria-label={t('Minimum bruttofortjeneste', 'Minimum gross profit')}
                    className="w-full bg-slate-900/60 border border-slate-700/40 rounded px-2 py-0.5 text-[11px] text-white text-right tabular-nums placeholder-slate-400 focus:border-indigo-500/50 focus:outline-none"
                  />
                  <input
                    type="number"
                    value={maxBruttofortjeneste}
                    onChange={(e) => {
                      setMaxBruttofortjeneste(e.target.value);
                      setOffset(0);
                    }}
                    placeholder={t('Max', 'Max')}
                    aria-label={t('Maksimum bruttofortjeneste', 'Maximum gross profit')}
                    className="w-full bg-slate-900/60 border border-slate-700/40 rounded px-2 py-0.5 text-[11px] text-white text-right tabular-nums placeholder-slate-400 focus:border-indigo-500/50 focus:outline-none"
                  />
                </div>
              </th>
              {/* Overskud min/max */}
              <th className="px-2 py-1 font-normal">
                <div className="flex flex-col gap-0.5">
                  <input
                    type="number"
                    value={minOverskud}
                    onChange={(e) => {
                      setMinOverskud(e.target.value);
                      setOffset(0);
                    }}
                    placeholder={t('Min', 'Min')}
                    aria-label={t('Minimum overskud', 'Minimum profit')}
                    className="w-full bg-slate-900/60 border border-slate-700/40 rounded px-2 py-0.5 text-[11px] text-white text-right tabular-nums placeholder-slate-400 focus:border-indigo-500/50 focus:outline-none"
                  />
                  <input
                    type="number"
                    value={maxOverskud}
                    onChange={(e) => {
                      setMaxOverskud(e.target.value);
                      setOffset(0);
                    }}
                    placeholder={t('Max', 'Max')}
                    aria-label={t('Maksimum overskud', 'Maximum profit')}
                    className="w-full bg-slate-900/60 border border-slate-700/40 rounded px-2 py-0.5 text-[11px] text-white text-right tabular-nums placeholder-slate-400 focus:border-indigo-500/50 focus:outline-none"
                  />
                </div>
              </th>
              {/* Ændring min/max (ejerandels-delta i procentpoint, klient-side) */}
              <th className="px-2 py-1 font-normal">
                <div className="flex flex-col gap-0.5">
                  <input
                    type="number"
                    value={minAendring}
                    onChange={(e) => setMinAendring(e.target.value)}
                    placeholder={t('Min pp', 'Min pp')}
                    aria-label={t(
                      'Minimum ændring i procentpoint',
                      'Minimum change in percentage points'
                    )}
                    className="w-full bg-slate-900/60 border border-slate-700/40 rounded px-2 py-0.5 text-[11px] text-white text-right tabular-nums placeholder-slate-400 focus:border-indigo-500/50 focus:outline-none"
                  />
                  <input
                    type="number"
                    value={maxAendring}
                    onChange={(e) => setMaxAendring(e.target.value)}
                    placeholder={t('Max pp', 'Max pp')}
                    aria-label={t(
                      'Maksimum ændring i procentpoint',
                      'Maximum change in percentage points'
                    )}
                    className="w-full bg-slate-900/60 border border-slate-700/40 rounded px-2 py-0.5 text-[11px] text-white text-right tabular-nums placeholder-slate-400 focus:border-indigo-500/50 focus:outline-none"
                  />
                </div>
              </th>
              {/* Ændringsdato fra/til. Den native kalender-knap er skjult (ma-date)
                  fordi klik på feltet allerede åbner kalenderen via showPicker — den
                  frigjorte plads bruges til en ×-knap der rydder den enkelte dato. */}
              <th className="px-2 py-1 font-normal">
                <div className="flex flex-col gap-0.5">
                  <div className="relative">
                    <input
                      id="from-date"
                      type="date"
                      value={fromDate}
                      aria-label={t('Ændringsdato fra', 'Change date from')}
                      onClick={(e) => e.currentTarget.showPicker?.()}
                      onChange={(e) => {
                        setFromDate(e.target.value);
                        setOffset(0);
                      }}
                      className="ma-date w-full bg-slate-900/60 border border-slate-700/40 rounded pl-2 pr-5 py-0.5 text-[11px] text-white cursor-pointer focus:border-indigo-500/50 focus:outline-none"
                    />
                    {fromDate && (
                      <button
                        type="button"
                        onClick={() => {
                          setFromDate('');
                          setOffset(0);
                        }}
                        aria-label={t('Ryd fra-dato', 'Clear from date')}
                        className="absolute right-1 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <input
                      id="to-date"
                      type="date"
                      value={toDate}
                      aria-label={t('Ændringsdato til', 'Change date to')}
                      onClick={(e) => e.currentTarget.showPicker?.()}
                      onChange={(e) => {
                        setToDate(e.target.value);
                        setOffset(0);
                      }}
                      className="ma-date w-full bg-slate-900/60 border border-slate-700/40 rounded pl-2 pr-5 py-0.5 text-[11px] text-white cursor-pointer focus:border-indigo-500/50 focus:outline-none"
                    />
                    {toDate && (
                      <button
                        type="button"
                        onClick={() => {
                          setToDate('');
                          setOffset(0);
                        }}
                        aria-label={t('Ryd til-dato', 'Clear to date')}
                        className="absolute right-1 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                </div>
              </th>
              {/* Indrapporteret fra/til — server-side range på sidst_opdateret
                  (per-række ingestion-dato). Samme ma-date + ×-ryd-mønster som
                  ændringsdato-kolonnen. */}
              <th className="px-2 py-1 font-normal">
                <div className="flex flex-col gap-0.5">
                  <div className="relative">
                    <input
                      id="indrap-from-date"
                      type="date"
                      value={indrapFra}
                      aria-label={t('Indrapporteret fra', 'Reported from')}
                      onClick={(e) => e.currentTarget.showPicker?.()}
                      onChange={(e) => {
                        setIndrapFra(e.target.value);
                        setOffset(0);
                      }}
                      className="ma-date w-full bg-slate-900/60 border border-slate-700/40 rounded pl-2 pr-5 py-0.5 text-[11px] text-white cursor-pointer focus:border-indigo-500/50 focus:outline-none"
                    />
                    {indrapFra && (
                      <button
                        type="button"
                        onClick={() => {
                          setIndrapFra('');
                          setOffset(0);
                        }}
                        aria-label={t('Ryd indrapporteret fra', 'Clear reported from')}
                        className="absolute right-1 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <input
                      id="indrap-to-date"
                      type="date"
                      value={indrapTil}
                      aria-label={t('Indrapporteret til', 'Reported to')}
                      onClick={(e) => e.currentTarget.showPicker?.()}
                      onChange={(e) => {
                        setIndrapTil(e.target.value);
                        setOffset(0);
                      }}
                      className="ma-date w-full bg-slate-900/60 border border-slate-700/40 rounded pl-2 pr-5 py-0.5 text-[11px] text-white cursor-pointer focus:border-indigo-500/50 focus:outline-none"
                    />
                    {indrapTil && (
                      <button
                        type="button"
                        onClick={() => {
                          setIndrapTil('');
                          setOffset(0);
                        }}
                        aria-label={t('Ryd indrapporteret til', 'Clear reported to')}
                        className="absolute right-1 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                </div>
              </th>
              {/* Est. værdi min/max (kun AI-berigede rækker, klient-side) */}
              <th className="px-2 py-1 font-normal">
                <div className="flex flex-col gap-0.5">
                  <input
                    type="number"
                    value={minEstVaerdi}
                    onChange={(e) => setMinEstVaerdi(e.target.value)}
                    placeholder={t('Min', 'Min')}
                    aria-label={t(
                      'Minimum estimeret transaktionsværdi',
                      'Minimum estimated transaction value'
                    )}
                    className="w-full bg-slate-900/60 border border-slate-700/40 rounded px-2 py-0.5 text-[11px] text-white text-right tabular-nums placeholder-slate-400 focus:border-indigo-500/50 focus:outline-none"
                  />
                  <input
                    type="number"
                    value={maxEstVaerdi}
                    onChange={(e) => setMaxEstVaerdi(e.target.value)}
                    placeholder={t('Max', 'Max')}
                    aria-label={t(
                      'Maksimum estimeret transaktionsværdi',
                      'Maximum estimated transaction value'
                    )}
                    className="w-full bg-slate-900/60 border border-slate-700/40 rounded px-2 py-0.5 text-[11px] text-white text-right tabular-nums placeholder-slate-400 focus:border-indigo-500/50 focus:outline-none"
                  />
                </div>
              </th>
              {/* Confidence-multiselect (kun AI-berigede rækker, klient-side) */}
              <th className="px-2 py-1 relative font-normal">
                <button
                  type="button"
                  onClick={() => setConfidenceDropdownOpen((v) => !v)}
                  aria-label={t('Filtrer på confidence', 'Filter by confidence')}
                  className="w-full bg-slate-900/60 border border-slate-700/40 rounded px-2 py-0.5 text-[10px] text-white flex items-center justify-between gap-1"
                >
                  <span className="truncate">
                    {confidenceFilter.size === 0
                      ? t('Alle', 'All')
                      : `${confidenceFilter.size} ${t('valgt', 'selected')}`}
                  </span>
                  <ChevronDown
                    size={11}
                    className={`text-slate-400 transition-transform ${confidenceDropdownOpen ? 'rotate-180' : ''}`}
                  />
                </button>
                {confidenceDropdownOpen && (
                  <div className="absolute top-full right-0 mt-1 z-30 bg-slate-800 border border-slate-700 rounded-lg shadow-xl py-1 min-w-[140px]">
                    {(['high', 'medium', 'low'] as const).map((lvl) => (
                      <label
                        key={lvl}
                        className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-700/50 cursor-pointer text-sm text-white"
                      >
                        <input
                          type="checkbox"
                          checked={confidenceFilter.has(lvl)}
                          onChange={() => {
                            setConfidenceFilter((prev) => {
                              const next = new Set(prev);
                              if (next.has(lvl)) next.delete(lvl);
                              else next.add(lvl);
                              return next;
                            });
                          }}
                          className="accent-indigo-500 w-3.5 h-3.5"
                        />
                        <ConfidenceBadge level={lvl} />
                      </label>
                    ))}
                  </div>
                )}
              </th>
              {/* Handlinger — intet filter */}
              <th className="px-2 py-1" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/30">
            {loading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={i} className="animate-pulse">
                  <td className="px-4 py-3">
                    <div className="h-4 bg-slate-700/40 rounded w-16" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="h-4 bg-slate-700/40 rounded w-32" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="h-4 bg-slate-700/40 rounded w-24" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="h-4 bg-slate-700/40 rounded w-20" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="h-4 bg-slate-700/40 rounded w-20 ml-auto" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="h-4 bg-slate-700/40 rounded w-20 ml-auto" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="h-4 bg-slate-700/40 rounded w-20 ml-auto" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="h-4 bg-slate-700/40 rounded w-20" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="h-4 bg-slate-700/40 rounded w-20" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="h-4 bg-slate-700/40 rounded w-24" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="h-4 bg-slate-700/40 rounded w-16" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="h-4 bg-slate-700/40 rounded w-12" />
                  </td>
                </tr>
              ))
            ) : kandidater.length === 0 ? (
              <tr>
                <td colSpan={13} className="px-4 py-12 text-center text-slate-400">
                  {t(
                    'Ingen kandidater fundet med de valgte filtre',
                    'No candidates found with selected filters'
                  )}
                </td>
              </tr>
            ) : (
              filteredKandidater.map((k) => {
                const key = `${k.deltager_enhedsnummer}-${k.virksomhed_cvr}-${k.gyldig_fra}`;
                const berig = berigResults[key];
                const isBerigLoading = berigLoading.has(key);
                const signal = SIGNAL_LABELS[k.signal_type];
                const delta = Math.abs(k.current_ejerandel_pct - k.prev_ejerandel_pct);
                // For 'exit' holder current_ejerandel_pct den andel deltageren HAVDE
                // (prev er en COALESCE(0)-artefakt fordi der ingen forudgående LAG-række er).
                // Vis derfor "havde% → 0%" så pilen peger rigtig vej (de er fratrådt).
                const fraPct =
                  k.signal_type === 'exit' ? k.current_ejerandel_pct : k.prev_ejerandel_pct;
                const tilPct = k.signal_type === 'exit' ? 0 : k.current_ejerandel_pct;

                return (
                  <tr key={key} className="hover:bg-slate-800/30 transition-colors">
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${signal?.color ?? 'text-slate-400'}`}
                      >
                        {signal?.da ?? k.signal_type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {k.deltager_er_virksomhed ? (
                        k.deltager_cvr ? (
                          // Virksomheds-deltager med entydigt CVR → link til virksomhedssiden.
                          <Link
                            href={`/dashboard/companies/${k.deltager_cvr}`}
                            className="group inline-flex items-center gap-1.5 text-white hover:text-blue-300 hover:underline transition-colors"
                            aria-label={t(
                              `Åbn virksomhed ${k.deltager_navn}`,
                              `Open company ${k.deltager_navn}`
                            )}
                          >
                            <Building2
                              size={13}
                              className="flex-shrink-0 text-slate-400 group-hover:text-blue-400 transition-colors"
                            />
                            {k.deltager_navn}
                          </Link>
                        ) : (
                          // Virksomhed, men flertydigt navn (flere CVR-match) → vis som
                          // virksomhed uden link frem for at sende brugeren til en forkert side.
                          <span
                            className="inline-flex items-center gap-1.5 text-white"
                            title={t(
                              'Virksomhed — flere selskaber har dette navn',
                              'Company — multiple companies share this name'
                            )}
                          >
                            <Building2 size={13} className="flex-shrink-0 text-slate-400" />
                            {k.deltager_navn}
                          </span>
                        )
                      ) : (
                        // Person-deltager → link til person-/ejer-siden.
                        <Link
                          href={`/dashboard/owners/${k.deltager_enhedsnummer}`}
                          className="group inline-flex items-center gap-1.5 text-white hover:text-indigo-300 hover:underline transition-colors"
                          aria-label={t(
                            `Åbn person ${k.deltager_navn}`,
                            `Open person ${k.deltager_navn}`
                          )}
                        >
                          <User
                            size={13}
                            className="flex-shrink-0 text-slate-400 group-hover:text-indigo-400 transition-colors"
                          />
                          {k.deltager_navn}
                        </Link>
                      )}
                      {/* BIZZ-1979: status-badge vises ALTID for ejer/deltager (aktiv,
                          ophørt, konkurs osv.) så brugeren kan se selskabets status
                          direkte i kolonnen — på linje med virksomheds-kolonnen.
                          Kun ukendt status (null kode) skjules. */}
                      {(() => {
                        const dKode = deltagerStatusKode(k);
                        return dKode != null ? (
                          <div className="mt-1">
                            <StatusBadge kode={dKode} lang={lang === 'da' ? 'da' : 'en'} />
                          </div>
                        ) : null;
                      })()}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <Link
                        href={`/dashboard/companies/${k.virksomhed_cvr}`}
                        className="group block"
                        aria-label={t(
                          `Åbn virksomhed ${k.virksomhed_navn ?? k.virksomhed_cvr}`,
                          `Open company ${k.virksomhed_navn ?? k.virksomhed_cvr}`
                        )}
                      >
                        {/* BIZZ-1968: ombryd lange virksomhedsnavne (break-words) i
                            stedet for at afkorte med ellipsis, saa hele navnet ses. */}
                        <div className="text-white font-medium break-words max-w-[220px] group-hover:text-indigo-300 group-hover:underline transition-colors">
                          {k.virksomhed_navn ?? k.virksomhed_cvr}
                        </div>
                        <span className="text-slate-400 text-[10px] font-mono">
                          CVR {k.virksomhed_cvr}
                        </span>
                      </Link>
                      {/* BIZZ-1962: virksomheds-status vises altid (det er altid en virksomhed). */}
                      <div className="mt-1">
                        <StatusBadge
                          kode={
                            k.virksomhed_status_kode ??
                            deriveCvrStatusKode(k.virksomhed_status_raw, k.virksomhed_ophoert)
                          }
                          lang={lang === 'da' ? 'da' : 'en'}
                        />
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-400 text-[10px] truncate max-w-[150px]">
                      {k.branche_tekst ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-300 text-xs tabular-nums">
                      {formatRegnskab(k.omsaetning)}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-300 text-xs tabular-nums">
                      {formatRegnskab(k.bruttofortjeneste)}
                    </td>
                    <td
                      className={`px-4 py-3 text-right text-xs tabular-nums ${
                        k.overskud != null && Number(k.overskud) < 0
                          ? 'text-red-400'
                          : 'text-slate-300'
                      }`}
                    >
                      {formatRegnskab(k.overskud)}
                    </td>
                    <td className="px-4 py-3 text-slate-300 text-xs">
                      {fraPct}% → {tilPct}%
                      <span className="text-slate-400 ml-1">(Δ{delta} pp)</span>
                    </td>
                    <td className="px-4 py-3 text-slate-300 text-xs tabular-nums">
                      {(k.aendringsdato ?? k.gyldig_til ?? k.gyldig_fra)?.slice(0, 10) ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-slate-400 text-xs">
                      {k.sidst_opdateret?.slice(0, 10) ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {berig?.estimeret_transaktionsvaerdi ? (
                        <button
                          onClick={() =>
                            setDetailModal({
                              navn: k.virksomhed_navn ?? k.virksomhed_cvr,
                              cvr: k.virksomhed_cvr,
                              berig,
                            })
                          }
                          aria-label={t(
                            `Se beregning for ${k.virksomhed_navn ?? k.virksomhed_cvr}`,
                            `View calculation for ${k.virksomhed_navn ?? k.virksomhed_cvr}`
                          )}
                          className="text-emerald-400 hover:text-emerald-300 hover:underline transition-colors tabular-nums"
                        >
                          {formatDKK(berig.estimeret_transaktionsvaerdi.lav)}–
                          {formatDKK(berig.estimeret_transaktionsvaerdi.hoej)}
                        </button>
                      ) : berig ? (
                        <button
                          onClick={() =>
                            setDetailModal({
                              navn: k.virksomhed_navn ?? k.virksomhed_cvr,
                              cvr: k.virksomhed_cvr,
                              berig,
                            })
                          }
                          aria-label={t('Se forklaring', 'View explanation')}
                          className="text-slate-400 hover:text-slate-200 hover:underline transition-colors"
                        >
                          {t('Ingen estimat', 'No estimate')}
                        </button>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {berig ? (
                        <ConfidenceBadge level={berig.confidence} />
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {!berig && (
                        <button
                          onClick={() => berigRow(k)}
                          disabled={isBerigLoading}
                          aria-label={t(
                            `Berig ${k.virksomhed_cvr} med AI`,
                            `Enrich ${k.virksomhed_cvr} with AI`
                          )}
                          className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50 transition-colors"
                        >
                          {isBerigLoading ? '...' : t('Berig', 'Enrich')}
                        </button>
                      )}
                      {berig && (
                        <button
                          onClick={() =>
                            setDetailModal({
                              navn: k.virksomhed_navn ?? k.virksomhed_cvr,
                              cvr: k.virksomhed_cvr,
                              berig,
                            })
                          }
                          aria-label={t('Se detaljer', 'View details')}
                          className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                        >
                          {t('Detaljer', 'Details')}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
            {!loading && kandidater.length > 0 && (
              <tr>
                <td
                  colSpan={13}
                  className="px-4 py-3 text-center text-[11px] text-slate-400 bg-slate-800/20"
                >
                  {offset + LIMIT >= total
                    ? t(
                        `● Slut på listen — ${total.toLocaleString('da-DK')} kandidater i alt`,
                        `● End of list — ${total.toLocaleString('en')} candidates total`
                      )
                    : t(
                        `Viser ${offset + 1}–${Math.min(offset + LIMIT, total)} af ${total.toLocaleString('da-DK')} — brug "Næste" for flere`,
                        `Showing ${offset + 1}–${Math.min(offset + LIMIT, total)} of ${total.toLocaleString('en')} — use "Next" for more`
                      )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > LIMIT && (
        <div className="shrink-0 flex items-center justify-between">
          <button
            onClick={() => setOffset(Math.max(0, offset - LIMIT))}
            disabled={offset === 0}
            aria-label={t('Forrige side', 'Previous page')}
            className="text-sm text-slate-400 hover:text-white disabled:opacity-30 transition-colors"
          >
            ← {t('Forrige', 'Previous')}
          </button>
          <span className="text-xs text-slate-400">
            {offset + 1}–{Math.min(offset + LIMIT, total)} / {total}
          </span>
          <button
            onClick={() => setOffset(offset + LIMIT)}
            disabled={offset + LIMIT >= total}
            aria-label={t('Næste side', 'Next page')}
            className="text-sm text-slate-400 hover:text-white disabled:opacity-30 transition-colors"
          >
            {t('Næste', 'Next')} →
          </button>
        </div>
      )}

      {/* BIZZ-1948: AI-forklaring-popup for beriget kandidat */}
      <VirksomhedshandelDetailModal
        open={detailModal !== null}
        onClose={() => setDetailModal(null)}
        virksomhedNavn={detailModal?.navn ?? ''}
        virksomhedCvr={detailModal?.cvr ?? ''}
        berig={detailModal?.berig ?? null}
      />
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

/**
 * Confidence badge — viser AI-confidence som farvet label.
 *
 * @param level - Confidence level (low/medium/high)
 */
function ConfidenceBadge({ level }: { level: 'low' | 'medium' | 'high' }) {
  const styles: Record<string, string> = {
    low: 'bg-slate-600/30 text-slate-400',
    medium: 'bg-amber-500/20 text-amber-400',
    high: 'bg-emerald-500/20 text-emerald-400',
  };

  return (
    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${styles[level]}`}>
      {level}
    </span>
  );
}
