/**
 * VirksomhedshandlerClient — M&A-radar tabel med AI-berigelse.
 *
 * BIZZ-1929: Kandidat-tabel med filter, AI-berig-knap per row,
 * og bulk-berigelse for top 10.
 *
 * @module app/dashboard/analyse/virksomhedshandler/VirksomhedshandlerClient
 */

'use client';

import { useState, useCallback, useEffect } from 'react';
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
  signal_type: 'entry' | 'exit' | 'increase' | 'decrease';
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
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [offset, setOffset] = useState(0);
  const [berigResults, setBerigResults] = useState<Record<string, BerigResult>>({});
  const [berigLoading, setBerigLoading] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  // Kolonne-filtre
  const [deltagerFilter, setDeltagerFilter] = useState('');
  const [cvrFilter, setCvrFilter] = useState('');

  const LIMIT = 50;

  // ─── Fetch kandidater ─────────────────────────────────────────────

  const fetchKandidater = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (signalFilters.size > 0) {
      params.set('signal_types', [...signalFilters].join(','));
    }
    if (fromDate) params.set('from_date', fromDate);
    if (toDate) params.set('to_date', toDate);
    params.set('limit', String(LIMIT));
    params.set('offset', String(offset));

    try {
      const res = await fetch(`/api/virksomhedshandler/kandidater?${params}`);
      if (res.ok) {
        const data = await res.json();
        setKandidater(data.kandidater);
        setTotal(data.total);
      }
    } finally {
      setLoading(false);
    }
  }, [signalFilters, fromDate, toDate, offset]);

  useEffect(() => {
    void fetchKandidater();
  }, [fetchKandidater]);

  // ─── Berig single row ─────────────────────────────────────────────

  const berigRow = useCallback(
    async (k: Kandidat) => {
      const key = `${k.deltager_enhedsnummer}-${k.virksomhed_cvr}-${k.gyldig_fra}`;
      if (berigResults[key] || berigLoading.has(key)) return;

      setBerigLoading((prev) => new Set(prev).add(key));
      try {
        const delta = Math.abs(k.current_ejerandel_pct - k.prev_ejerandel_pct);
        const res = await fetch('/api/virksomhedshandler/berig', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kandidat_id: key,
            virksomhed_cvr: k.virksomhed_cvr,
            person_enhedsnummer: k.deltager_enhedsnummer,
            deltager_navn: k.deltager_navn,
            ejerandel_delta_pp: delta,
            aarsresultat_dkk: 0, // Placeholder — real data from CVR regnskab
            branchekode: '70', // Default — real data from CVR branche
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
    <div className="flex-1 bg-[#0a1628] p-6 space-y-6">
      {/* Header */}
      <div>
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
      <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
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
      <div className="flex flex-wrap gap-3 items-end">
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
            {t('Fra dato', 'From date')}
          </label>
          <input
            id="from-date"
            type="date"
            aria-label={t('Filtrer fra dato', 'Filter from date')}
            value={fromDate}
            onChange={(e) => {
              setFromDate(e.target.value);
              setOffset(0);
            }}
            className="bg-slate-800 text-white text-sm rounded-lg px-3 py-2 border border-slate-700"
          />
        </div>

        <div>
          <label htmlFor="to-date" className="block text-xs text-slate-400 mb-1">
            {t('Til dato', 'To date')}
          </label>
          <input
            id="to-date"
            type="date"
            aria-label={t('Filtrer til dato', 'Filter to date')}
            value={toDate}
            onChange={(e) => {
              setToDate(e.target.value);
              setOffset(0);
            }}
            className="bg-slate-800 text-white text-sm rounded-lg px-3 py-2 border border-slate-700"
          />
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

      {/* Results count */}
      <p className="text-slate-500 text-xs">
        {t(
          `${total.toLocaleString('da-DK')} kandidater fundet`,
          `${total.toLocaleString('en')} candidates found`
        )}
      </p>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-slate-700/30">
        <table className="w-full text-sm">
          <thead className="bg-slate-800/60">
            <tr className="text-left text-slate-400 text-xs uppercase tracking-wider">
              <th className="px-4 py-2">{t('Signal', 'Signal')}</th>
              <th className="px-4 py-2">{t('Deltager', 'Participant')}</th>
              <th className="px-4 py-2">{t('Virksomhed (CVR)', 'Company (CVR)')}</th>
              <th className="px-4 py-2">{t('Ændring', 'Change')}</th>
              <th className="px-4 py-2">{t('Dato', 'Date')}</th>
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
                  placeholder={t('Filtrer CVR...', 'Filter CVR...')}
                  aria-label={t('Filtrer CVR', 'Filter CVR')}
                  className="w-full bg-slate-900/60 border border-slate-700/40 rounded px-2 py-0.5 text-[10px] text-white placeholder-slate-600 focus:border-indigo-500/50 focus:outline-none"
                />
              </th>
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
                <td colSpan={8} className="px-4 py-12 text-center text-slate-500">
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
                  if (cvrFilter && !k.virksomhed_cvr.includes(cvrFilter)) return false;
                  return true;
                })
                .map((k) => {
                  const key = `${k.deltager_enhedsnummer}-${k.virksomhed_cvr}-${k.gyldig_fra}`;
                  const berig = berigResults[key];
                  const isBerigLoading = berigLoading.has(key);
                  const signal = SIGNAL_LABELS[k.signal_type];
                  const delta = Math.abs(k.current_ejerandel_pct - k.prev_ejerandel_pct);

                  return (
                    <tr key={key} className="hover:bg-slate-800/30 transition-colors">
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${signal?.color ?? 'text-slate-400'}`}
                        >
                          {signal?.da ?? k.signal_type}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-white text-xs">{k.deltager_navn}</td>
                      <td className="px-4 py-3 text-slate-300 text-xs font-mono">
                        {k.virksomhed_cvr}
                      </td>
                      <td className="px-4 py-3 text-slate-300 text-xs">
                        {k.prev_ejerandel_pct}% → {k.current_ejerandel_pct}%
                        <span className="text-slate-500 ml-1">(Δ{delta} pp)</span>
                      </td>
                      <td className="px-4 py-3 text-slate-400 text-xs">
                        {k.gyldig_fra?.slice(0, 10)}
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
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > LIMIT && (
        <div className="flex items-center justify-between">
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
