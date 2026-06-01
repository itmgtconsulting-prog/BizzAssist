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
import { ChevronDown } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Kandidat {
  deltager_enhedsnummer: number;
  deltager_navn: string;
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
}

interface BrancheOption {
  branche_kode: string;
  branche_tekst: string;
  antal: number;
}

interface BerigResult {
  estimeret_vaerdi: { lav: number; mid: number; hoej: number; currency: 'DKK' } | null;
  formel_forklaring: string;
  medie_links: Array<{
    title: string;
    url: string;
    publisher: string;
    published_at: string;
    relevance_score: number;
  }>;
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
  const [signalFilters, setSignalFilters] = useState<Set<SignalType>>(
    new Set(['entry', 'exit', 'increase'])
  );
  const [signalDropdownOpen, setSignalDropdownOpen] = useState(false);
  // Default: seneste 3 måneder (baseret på ændringsdato = COALESCE(gyldig_til, gyldig_fra))
  const [fromDate, setFromDate] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 3);
    return d.toISOString().slice(0, 10);
  });
  const [toDate, setToDate] = useState('');
  const [offset, setOffset] = useState(0);
  const [berigResults, setBerigResults] = useState<Record<string, BerigResult>>({});
  const [berigLoading, setBerigLoading] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  // Kolonne-filtre
  const [deltagerFilter, setDeltagerFilter] = useState('');
  const [cvrFilter, setCvrFilter] = useState('');
  // Branche-filter (server-side, multiselect på branche_kode)
  const [brancheOptions, setBrancheOptions] = useState<BrancheOption[]>([]);
  const [selectedBrancher, setSelectedBrancher] = useState<Set<string>>(new Set());
  const [brancheDropdownOpen, setBrancheDropdownOpen] = useState(false);
  const [brancheSearch, setBrancheSearch] = useState('');
  // Regnskabs-range-filtre (server-side, DKK)
  const [minOmsaetning, setMinOmsaetning] = useState('');
  const [maxOmsaetning, setMaxOmsaetning] = useState('');
  const [minOverskud, setMinOverskud] = useState('');
  const [maxOverskud, setMaxOverskud] = useState('');
  // Server-side sortering: kolonne-nøgle + retning (klik på overskrift toggler).
  // Default = ændringsdato (nyeste ejerskabsændringer først); indrapporteret er
  // MV-refresh-dato og dermed ens for alle rækker — ubrugelig som default-sort.
  const [sortKey, setSortKey] = useState('aendringsdato');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const LIMIT = 50;

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
          <span className="text-[9px] text-slate-500">
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
    if (selectedBrancher.size > 0) params.set('brancher', [...selectedBrancher].join(','));
    if (minOmsaetning) params.set('min_omsaetning', minOmsaetning);
    if (maxOmsaetning) params.set('max_omsaetning', maxOmsaetning);
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
    selectedBrancher,
    minOmsaetning,
    maxOmsaetning,
    minOverskud,
    maxOverskud,
    sortKey,
    sortDir,
    offset,
  ]);

  useEffect(() => {
    void fetchKandidater();
  }, [fetchKandidater]);

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

      {/* Filter bar */}
      <div className="shrink-0 flex flex-wrap gap-3 items-end">
        <div className="relative">
          <label className="block text-xs text-slate-400 mb-1">{t('Signal', 'Signal')}</label>
          <button
            type="button"
            onClick={() => setSignalDropdownOpen((v) => !v)}
            aria-label={t('Filtrer på signaltype', 'Filter by signal type')}
            className="bg-slate-800 text-white text-sm rounded-lg px-3 py-2 border border-slate-700 min-w-[160px] text-left flex items-center justify-between gap-2"
          >
            <span className="truncate">
              {signalFilters.size === 0
                ? t('Alle signaler', 'All signals')
                : signalFilters.size === 1
                  ? (SIGNAL_LABELS[[...signalFilters][0]]?.[lang === 'da' ? 'da' : 'en'] ??
                    [...signalFilters][0])
                  : `${signalFilters.size} ${t('signaler', 'signals')}`}
            </span>
            <ChevronDown
              size={14}
              className={`text-slate-500 transition-transform ${signalDropdownOpen ? 'rotate-180' : ''}`}
            />
          </button>
          {signalDropdownOpen && (
            <div className="absolute top-full left-0 mt-1 z-20 bg-slate-800 border border-slate-700 rounded-lg shadow-xl py-1 min-w-[180px]">
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
              {signalFilters.size > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setSignalFilters(new Set());
                    setOffset(0);
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs text-slate-500 hover:text-white border-t border-slate-700/50 mt-1"
                >
                  {t('Nulstil', 'Reset')}
                </button>
              )}
            </div>
          )}
        </div>

        <div>
          <label htmlFor="from-date" className="block text-xs text-slate-400 mb-1">
            {t('Ændringsdato fra', 'Change date from')}
          </label>
          <input
            id="from-date"
            type="date"
            aria-label={t('Filtrer fra ændringsdato', 'Filter from change date')}
            value={fromDate}
            // Åbn dato-vælgeren ved klik hvor som helst i feltet (ikke kun på det
            // lille kalender-ikon) — showPicker() er supporteret i moderne browsere.
            onClick={(e) => e.currentTarget.showPicker?.()}
            onChange={(e) => {
              setFromDate(e.target.value);
              setOffset(0);
            }}
            className="bg-slate-800 text-white text-sm rounded-lg px-3 py-2 border border-slate-700 cursor-pointer"
          />
        </div>

        <div>
          <label htmlFor="to-date" className="block text-xs text-slate-400 mb-1">
            {t('Ændringsdato til', 'Change date to')}
          </label>
          <input
            id="to-date"
            type="date"
            aria-label={t('Filtrer til ændringsdato', 'Filter to change date')}
            value={toDate}
            onClick={(e) => e.currentTarget.showPicker?.()}
            onChange={(e) => {
              setToDate(e.target.value);
              setOffset(0);
            }}
            className="bg-slate-800 text-white text-sm rounded-lg px-3 py-2 border border-slate-700 cursor-pointer"
          />
        </div>

        {/* Branche-multiselect */}
        <div className="relative">
          <label className="block text-xs text-slate-400 mb-1">{t('Branche', 'Industry')}</label>
          <button
            type="button"
            onClick={() => setBrancheDropdownOpen((v) => !v)}
            aria-label={t('Filtrer på branche', 'Filter by industry')}
            className="bg-slate-800 text-white text-sm rounded-lg px-3 py-2 border border-slate-700 min-w-[200px] text-left flex items-center justify-between gap-2"
          >
            <span className="truncate">
              {selectedBrancher.size === 0
                ? t('Alle brancher', 'All industries')
                : `${selectedBrancher.size} ${t('valgt', 'selected')}`}
            </span>
            <ChevronDown
              size={14}
              className={`text-slate-500 transition-transform ${brancheDropdownOpen ? 'rotate-180' : ''}`}
            />
          </button>
          {brancheDropdownOpen && (
            <div className="absolute top-full left-0 mt-1 z-20 bg-slate-800 border border-slate-700 rounded-lg shadow-xl w-[340px] max-h-[360px] flex flex-col">
              <div className="p-2 border-b border-slate-700/60">
                <input
                  type="text"
                  value={brancheSearch}
                  onChange={(e) => setBrancheSearch(e.target.value)}
                  placeholder={t('Søg branche...', 'Search industry...')}
                  aria-label={t('Søg branche', 'Search industry')}
                  className="w-full bg-slate-900/60 border border-slate-700/40 rounded px-2 py-1 text-xs text-white placeholder-slate-600 focus:border-indigo-500/50 focus:outline-none"
                />
              </div>
              <div className="overflow-auto py-1">
                {brancheOptions.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-slate-500">
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
                        <span className="text-slate-500 tabular-nums">
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
                  className="text-left px-3 py-1.5 text-xs text-slate-500 hover:text-white border-t border-slate-700/50"
                >
                  {t('Nulstil branchevalg', 'Reset industry selection')}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Omsætnings-range */}
        <div>
          <label className="block text-xs text-slate-400 mb-1">
            {t('Omsætning (DKK)', 'Revenue (DKK)')}
          </label>
          <div className="flex items-center gap-1">
            <input
              type="number"
              value={minOmsaetning}
              onChange={(e) => {
                setMinOmsaetning(e.target.value);
                setOffset(0);
              }}
              placeholder={t('Min', 'Min')}
              aria-label={t('Minimum omsætning', 'Minimum revenue')}
              className="bg-slate-800 text-white text-sm rounded-lg px-2 py-2 border border-slate-700 w-28"
            />
            <span className="text-slate-600 text-xs">–</span>
            <input
              type="number"
              value={maxOmsaetning}
              onChange={(e) => {
                setMaxOmsaetning(e.target.value);
                setOffset(0);
              }}
              placeholder={t('Max', 'Max')}
              aria-label={t('Maksimum omsætning', 'Maximum revenue')}
              className="bg-slate-800 text-white text-sm rounded-lg px-2 py-2 border border-slate-700 w-28"
            />
          </div>
        </div>

        {/* Overskuds-range */}
        <div>
          <label className="block text-xs text-slate-400 mb-1">
            {t('Overskud (DKK)', 'Profit (DKK)')}
          </label>
          <div className="flex items-center gap-1">
            <input
              type="number"
              value={minOverskud}
              onChange={(e) => {
                setMinOverskud(e.target.value);
                setOffset(0);
              }}
              placeholder={t('Min', 'Min')}
              aria-label={t('Minimum overskud', 'Minimum profit')}
              className="bg-slate-800 text-white text-sm rounded-lg px-2 py-2 border border-slate-700 w-28"
            />
            <span className="text-slate-600 text-xs">–</span>
            <input
              type="number"
              value={maxOverskud}
              onChange={(e) => {
                setMaxOverskud(e.target.value);
                setOffset(0);
              }}
              placeholder={t('Max', 'Max')}
              aria-label={t('Maksimum overskud', 'Maximum profit')}
              className="bg-slate-800 text-white text-sm rounded-lg px-2 py-2 border border-slate-700 w-28"
            />
          </div>
        </div>

        <button
          onClick={bulkBerig}
          disabled={bulkLoading || kandidater.length === 0}
          aria-label={t('Berig top 10 med AI', 'Enrich top 10 with AI')}
          className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-lg transition-colors"
        >
          {bulkLoading
            ? t('Beriger...', 'Enriching...')
            : t('Berig top 10 med AI', 'Enrich top 10 with AI')}
        </button>
      </div>

      {/* Results count + top pagination (altid synlig — nem navigation) */}
      <div className="shrink-0 flex items-center justify-between gap-3 flex-wrap">
        <p className="text-slate-500 text-xs">
          {t(
            `${total.toLocaleString('da-DK')} kandidater fundet`,
            `${total.toLocaleString('en')} candidates found`
          )}
        </p>
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
            <span className="text-xs text-slate-500 tabular-nums">
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
      <div className="flex-1 min-h-0 overflow-auto rounded-xl border border-slate-700/30">
        <table className="w-full text-sm">
          <thead className="bg-slate-800 sticky top-0 z-10 shadow-[0_1px_0_0_rgba(148,163,184,0.2)]">
            <tr className="text-left text-slate-400 text-xs uppercase tracking-wider">
              <th className="px-4 py-2">{t('Signal', 'Signal')}</th>
              {renderSortTh('deltager', t('Deltager', 'Participant'))}
              {renderSortTh('virksomhed', t('Virksomhed', 'Company'))}
              {renderSortTh('branche', t('Branche', 'Industry'))}
              {renderSortTh('omsaetning', t('Omsætning', 'Revenue'), 'right')}
              {renderSortTh('bruttofortjeneste', t('Bruttofortjeneste', 'Gross profit'), 'right')}
              {renderSortTh('overskud', t('Overskud', 'Profit'), 'right')}
              {renderSortTh('aendring', t('Ændring', 'Change'))}
              {renderSortTh('aendringsdato', t('Ændringsdato', 'Change date'))}
              {renderSortTh('indrapporteret', t('Indrapporteret', 'Reported'))}
              <th className="px-4 py-2">{t('Est. værdi', 'Est. value')}</th>
              <th className="px-4 py-2">{t('Confidence', 'Confidence')}</th>
              <th className="px-4 py-2" />
            </tr>
            <tr className="bg-slate-800/30">
              <th className="px-4 py-1" />
              <th className="px-4 py-1">
                <input
                  type="text"
                  value={deltagerFilter}
                  onChange={(e) => setDeltagerFilter(e.target.value)}
                  placeholder={t('Filtrer...', 'Filter...')}
                  aria-label={t('Filtrer deltager', 'Filter participant')}
                  className="w-full bg-slate-900/60 border border-slate-700/40 rounded px-2 py-0.5 text-[10px] text-white placeholder-slate-600 focus:border-indigo-500/50 focus:outline-none"
                />
              </th>
              <th className="px-4 py-1">
                <input
                  type="text"
                  value={cvrFilter}
                  onChange={(e) => setCvrFilter(e.target.value)}
                  placeholder={t('Filtrer virksomhed...', 'Filter company...')}
                  aria-label={t('Filtrer virksomhed', 'Filter company')}
                  className="w-full bg-slate-900/60 border border-slate-700/40 rounded px-2 py-0.5 text-[10px] text-white placeholder-slate-600 focus:border-indigo-500/50 focus:outline-none"
                />
              </th>
              <th className="px-4 py-1" />
              <th className="px-4 py-1" />
              <th className="px-4 py-1" />
              <th className="px-4 py-1" />
              <th className="px-4 py-1" />
              <th className="px-4 py-1" />
              <th className="px-4 py-1" />
              <th className="px-4 py-1" />
              <th className="px-4 py-1" />
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
                <td colSpan={13} className="px-4 py-12 text-center text-slate-500">
                  {t(
                    'Ingen kandidater fundet med de valgte filtre',
                    'No candidates found with selected filters'
                  )}
                </td>
              </tr>
            ) : (
              kandidater
                .filter((k) => {
                  if (
                    deltagerFilter &&
                    !k.deltager_navn.toLowerCase().includes(deltagerFilter.toLowerCase())
                  )
                    return false;
                  if (cvrFilter) {
                    const q = cvrFilter.toLowerCase();
                    if (
                      !k.virksomhed_cvr.includes(q) &&
                      !(k.virksomhed_navn ?? '').toLowerCase().includes(q)
                    )
                      return false;
                  }
                  return true;
                })
                .map((k) => {
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
                        <Link
                          href={`/dashboard/owners/${k.deltager_enhedsnummer}`}
                          className="text-white hover:text-indigo-300 hover:underline transition-colors"
                          aria-label={t(
                            `Åbn person ${k.deltager_navn}`,
                            `Open person ${k.deltager_navn}`
                          )}
                        >
                          {k.deltager_navn}
                        </Link>
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
                          <div className="text-white font-medium truncate max-w-[200px] group-hover:text-indigo-300 group-hover:underline transition-colors">
                            {k.virksomhed_navn ?? k.virksomhed_cvr}
                          </div>
                          <span className="text-slate-500 text-[10px] font-mono">
                            CVR {k.virksomhed_cvr}
                          </span>
                        </Link>
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
                        <span className="text-slate-500 ml-1">(Δ{delta} pp)</span>
                      </td>
                      <td className="px-4 py-3 text-slate-300 text-xs tabular-nums">
                        {(k.aendringsdato ?? k.gyldig_til ?? k.gyldig_fra)?.slice(0, 10) ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-slate-500 text-xs">
                        {k.sidst_opdateret?.slice(0, 10) ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {berig?.estimeret_vaerdi ? (
                          <span className="text-emerald-400">
                            {formatDKK(berig.estimeret_vaerdi.mid)}
                          </span>
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {berig ? (
                          <ConfidenceBadge level={berig.confidence} />
                        ) : (
                          <span className="text-slate-600">—</span>
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
                        {berig && berig.medie_links.length > 0 && (
                          <a
                            href={berig.medie_links[0].url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-blue-400 hover:text-blue-300"
                            aria-label={t('Åbn medielink', 'Open media link')}
                          >
                            {t('Artikel', 'Article')}
                          </a>
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
                  className="px-4 py-3 text-center text-[11px] text-slate-500 bg-slate-800/20"
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
          <span className="text-xs text-slate-500">
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
