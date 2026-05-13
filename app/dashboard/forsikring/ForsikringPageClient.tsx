'use client';

/**
 * Forsikrings-modul liste-side — /dashboard/forsikring
 *
 * Sektioner:
 *   1. Heading + KPI-tiles (policer, kritiske gaps, advarsler, info)
 *   2. Upload-zone (drag-and-drop + fil-vælger, multi-fil)
 *   3. Pending documents (uploaded men ikke parset endnu)
 *   4. Police-tabel med inline gap-badges
 *
 * Data fetches fra GET /api/forsikring. Upload kalder
 * POST /api/forsikring/upload, derefter POST /api/forsikring/parse
 * for hvert dokument. Status vises pr. dokument under upload.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ShieldCheck,
  Upload,
  FileText,
  AlertTriangle,
  AlertCircle,
  Info,
  Loader2,
  CheckCircle2,
  XCircle,
  Building2,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { translations } from '@/app/lib/translations';

// ─── Types ───────────────────────────────────────────────────────

interface PolicyRow {
  id: string;
  policy_number: string;
  insurer_name: string;
  policyholder_name: string;
  property_address: string | null;
  annual_premium_dkk: number | null;
  effective_to: string | null;
  main_renewal_date: string | null;
  gap_counts: { critical: number; warning: number; info: number };
  created_at: string;
}

interface PendingDocument {
  id: string;
  original_name: string;
  parse_status: 'pending' | 'parsing' | 'parsed' | 'failed';
  parse_error: string | null;
  created_at: string;
}

interface ListResponse {
  policies: PolicyRow[];
  documents: PendingDocument[];
  totals: {
    policies: number;
    gaps_critical: number;
    gaps_warning: number;
    gaps_info: number;
  };
}

interface UploadJob {
  id: string; // local UUID for React-key
  fileName: string;
  status: 'uploading' | 'parsing' | 'done' | 'failed';
  error?: string;
}

// ─── BIZZ-1367: Analyse-sektion med customer picker ─────────────

/**
 * Gap-analyse sektion med CVR/person-søgning + start-knap.
 * Viser også liste over tidligere analyser.
 *
 * @param props.lang - Sprogkode
 */
function AnalyseSection({ lang }: { lang: string }) {
  const da = lang === 'da';
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<
    Array<{ id: string; title: string; type: string; subtitle?: string }>
  >([]);
  const [selected, setSelected] = useState<{
    type: 'virksomhed' | 'person';
    id: string;
    navn: string;
  } | null>(null);
  const [running, setRunning] = useState(false);
  const [analyseResult, setAnalyseResult] = useState<{
    analyse_id: string;
    total_aktiver: number;
    insured_count: number;
    gaps_count: number;
    total_risk_score: number;
  } | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Debounced søgning via /api/search */
  const handleSearch = useCallback((value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.trim().length < 2) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(value.trim())}`);
        if (res.ok) {
          const data = await res.json();
          const filtered = (
            data as Array<{ id: string; title: string; type: string; subtitle?: string }>
          )
            .filter((r) => r.type === 'company' || r.type === 'person')
            .slice(0, 8);
          setResults(filtered);
        }
      } catch {
        setResults([]);
      }
    }, 300);
  }, []);

  /** Start gap-analyse */
  const startAnalyse = useCallback(async () => {
    if (!selected || running) return;
    setRunning(true);
    setAnalyseResult(null);
    try {
      const res = await fetch('/api/forsikring/analyser', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kunde_type: selected.type,
          kunde_id: selected.id,
          kunde_navn: selected.navn,
        }),
      });
      if (res.ok) {
        setAnalyseResult(await res.json());
      }
    } catch {
      // Handled silently
    } finally {
      setRunning(false);
    }
  }, [selected, running]);

  return (
    <section className="bg-white/5 border border-white/8 rounded-2xl p-5 space-y-3">
      <h2 className="text-white font-semibold text-sm flex items-center gap-2">
        <ShieldCheck size={16} className="text-blue-400" />
        {da ? 'Koncern gap-analyse' : 'Corporate gap analysis'}
      </h2>
      <p className="text-slate-400 text-xs">
        {da
          ? 'Vælg en virksomhed eller person og kør automatisk gap-analyse mod uploadede policer.'
          : 'Select a company or person and run automatic gap analysis against uploaded policies.'}
      </p>

      {/* Customer picker */}
      <div className="relative">
        <input
          type="text"
          value={selected ? selected.navn : query}
          onChange={(e) => {
            setSelected(null);
            handleSearch(e.target.value);
          }}
          placeholder={
            da ? 'Søg CVR, virksomhed eller person...' : 'Search CVR, company or person...'
          }
          className="w-full px-3 py-2 bg-slate-800 border border-slate-700/60 rounded-lg text-sm text-white placeholder:text-slate-500 outline-none focus:border-blue-500/60"
        />
        {results.length > 0 && !selected && (
          <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-slate-800 border border-slate-700 rounded-lg shadow-xl max-h-60 overflow-y-auto">
            {results.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => {
                  setSelected({
                    type: r.type === 'company' ? 'virksomhed' : 'person',
                    id: r.id,
                    navn: r.title,
                  });
                  setResults([]);
                  setQuery('');
                }}
                className="w-full text-left px-3 py-2 hover:bg-slate-700/50 text-sm"
              >
                <span className="text-white">{r.title}</span>
                {r.subtitle && <span className="text-slate-400 ml-2 text-xs">{r.subtitle}</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Start knap */}
      {selected && (
        <button
          type="button"
          onClick={startAnalyse}
          disabled={running}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2"
        >
          {running ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              {da ? 'Analyserer...' : 'Analyzing...'}
            </>
          ) : (
            <>
              <ShieldCheck size={14} />
              {da ? 'Start gap-analyse' : 'Start gap analysis'}
            </>
          )}
        </button>
      )}

      {/* Resultat */}
      {analyseResult && (
        <div className="grid grid-cols-4 gap-3 mt-2">
          <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-3 text-center">
            <div className="text-blue-300 text-xl font-bold">{analyseResult.total_aktiver}</div>
            <div className="text-slate-400 text-xs">{da ? 'Aktiver' : 'Assets'}</div>
          </div>
          <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-3 text-center">
            <div className="text-emerald-300 text-xl font-bold">{analyseResult.insured_count}</div>
            <div className="text-slate-400 text-xs">{da ? 'Forsikrede' : 'Insured'}</div>
          </div>
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-center">
            <div className="text-red-300 text-xl font-bold">{analyseResult.gaps_count}</div>
            <div className="text-slate-400 text-xs">{da ? 'Gaps' : 'Gaps'}</div>
          </div>
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-center">
            <div className="text-amber-300 text-xl font-bold">{analyseResult.total_risk_score}</div>
            <div className="text-slate-400 text-xs">{da ? 'Risk score' : 'Risk score'}</div>
          </div>
        </div>
      )}
    </section>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Format DKK amount with Danish thousand separators.
 *
 * @param n - Amount in DKK or null
 * @returns Formatted string like "33.998 kr" or "—"
 */
function formatDkk(n: number | null): string {
  if (n === null) return '—';
  return `${n.toLocaleString('da-DK')} kr`;
}

/**
 * Format ISO date as Danish locale (e.g. "31. mar. 2028").
 *
 * @param iso - ISO date string or null
 * @returns Formatted date string or "—"
 */
function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('da-DK', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Generate a local UUID for tracking upload jobs in React state.
 * Crypto-safe — falls back to timestamp if crypto unavailable.
 *
 * @returns Random ID string
 */
function localId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ─── Component ───────────────────────────────────────────────────

export default function ForsikringPageClient(): React.ReactElement {
  const { lang } = useLanguage();
  const t = translations[lang].forsikring;

  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploadJobs, setUploadJobs] = useState<UploadJob[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** Fetch list data from API */
  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/forsikring', { cache: 'no-store' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
        throw new Error(
          body.detail ? `${body.error}: ${body.detail}` : (body.error ?? `HTTP ${res.status}`)
        );
      }
      const json = (await res.json()) as ListResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ukendt fejl');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Upload + parse pipeline for a single file.
   * Updates uploadJobs state synchronously so UI shows progress.
   */
  const processFile = useCallback(
    async (file: File) => {
      const jobId = localId();
      setUploadJobs((prev) => [...prev, { id: jobId, fileName: file.name, status: 'uploading' }]);

      try {
        const formData = new FormData();
        formData.append('file', file);
        const upRes = await fetch('/api/forsikring/upload', {
          method: 'POST',
          body: formData,
        });
        if (!upRes.ok) {
          const body = (await upRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? t.uploadFailed);
        }
        const upJson = (await upRes.json()) as { document: { id: string } };

        // Trigger parse
        setUploadJobs((prev) =>
          prev.map((j) => (j.id === jobId ? { ...j, status: 'parsing' } : j))
        );
        const parseRes = await fetch('/api/forsikring/parse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ document_id: upJson.document.id }),
        });
        if (!parseRes.ok) {
          const body = (await parseRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? t.parseFailed);
        }
        setUploadJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, status: 'done' } : j)));
        await refresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        setUploadJobs((prev) =>
          prev.map((j) => (j.id === jobId ? { ...j, status: 'failed', error: msg } : j))
        );
      }
    },
    [refresh, t]
  );

  /** Handle file picker / drop event */
  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      Array.from(files).forEach((f) => {
        void processFile(f);
      });
    },
    [processFile]
  );

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(true);
  }, []);
  const onDragLeave = useCallback(() => setDragOver(false), []);
  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      handleFiles(e.dataTransfer.files);
    },
    [handleFiles]
  );

  const policies = data?.policies ?? [];
  const documents = data?.documents ?? [];

  // ── Render ─────────────────────────────────────────────────

  const kpis = useMemo(() => {
    const totals = data?.totals ?? {
      policies: 0,
      gaps_critical: 0,
      gaps_warning: 0,
      gaps_info: 0,
    };
    return [
      {
        label: t.totalPolicies,
        value: totals.policies,
        icon: ShieldCheck,
        color: 'text-blue-300',
        bg: 'from-blue-600/20 to-blue-900/10',
      },
      {
        label: t.gapCritical,
        value: totals.gaps_critical,
        icon: AlertCircle,
        color: 'text-red-300',
        bg: 'from-red-600/20 to-red-900/10',
      },
      {
        label: t.gapWarning,
        value: totals.gaps_warning,
        icon: AlertTriangle,
        color: 'text-amber-300',
        bg: 'from-amber-600/20 to-amber-900/10',
      },
      {
        label: t.gapInfo,
        value: totals.gaps_info,
        icon: Info,
        color: 'text-slate-300',
        bg: 'from-slate-600/20 to-slate-900/10',
      },
    ];
  }, [t, data?.totals]);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-[#0a1020] text-slate-100 min-h-screen">
      {/* Heading */}
      <header className="space-y-1">
        <h1 className="flex items-center gap-3 text-2xl font-semibold">
          <ShieldCheck className="text-blue-400" size={28} />
          {t.title}
        </h1>
        <p className="text-sm text-slate-400">{t.subtitle}</p>
      </header>

      {/* KPI tiles */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {kpis.map((kpi) => (
          <div
            key={kpi.label}
            className={`bg-gradient-to-br ${kpi.bg} border border-white/8 rounded-2xl p-5 space-y-2`}
          >
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-400">
              <kpi.icon size={14} className={kpi.color} />
              <span>{kpi.label}</span>
            </div>
            <div className={`text-3xl font-semibold ${kpi.color}`}>{kpi.value}</div>
          </div>
        ))}
      </div>

      {/* BIZZ-1382: Kundevælger FØRST — giver kontekst til gap-analysen */}
      <AnalyseSection lang={lang} />

      {/* Upload-zone */}
      <section
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`rounded-2xl border-2 border-dashed transition-colors p-8 text-center cursor-pointer ${
          dragOver
            ? 'border-blue-400 bg-blue-500/5'
            : 'border-white/10 bg-white/5 hover:border-blue-500/40'
        }`}
        onClick={() => fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        aria-label={t.uploadCta}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
      >
        <Upload className="mx-auto text-blue-400 mb-2" size={28} />
        <div className="font-medium">{t.uploadCta}</div>
        <div className="text-sm text-slate-400 mt-1">{t.uploadHelp}</div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.docx,.xlsx,.xls,.pptx,.rtf,.txt,.md,.html,.csv,.tsv,.json,.xml,.yaml,.eml,.png,.jpg,.jpeg,.gif,.webp,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.ms-excel,image/*,text/*,application/json,application/xml,message/rfc822"
          multiple
          className="hidden"
          aria-hidden="true"
          onChange={(e) => {
            handleFiles(e.target.files);
            // reset så samme fil kan vælges igen
            e.target.value = '';
          }}
        />
      </section>

      {/* Upload-jobs (live status) */}
      {uploadJobs.length > 0 && (
        <section className="bg-white/5 border border-white/8 rounded-2xl divide-y divide-white/5">
          {uploadJobs.map((job) => (
            <div key={job.id} className="flex items-center gap-3 p-3 text-sm">
              {job.status === 'uploading' && (
                <Loader2 size={16} className="animate-spin text-blue-400" />
              )}
              {job.status === 'parsing' && (
                <Loader2 size={16} className="animate-spin text-amber-400" />
              )}
              {job.status === 'done' && <CheckCircle2 size={16} className="text-emerald-400" />}
              {job.status === 'failed' && <XCircle size={16} className="text-red-400" />}
              <span className="font-medium">{job.fileName}</span>
              <span className="text-slate-400 text-xs">
                {job.status === 'uploading' && t.uploading}
                {job.status === 'parsing' && t.parsing}
                {job.status === 'done' && '✓'}
                {job.status === 'failed' && (job.error ?? t.parseFailed)}
              </span>
            </div>
          ))}
        </section>
      )}

      {/* Pending documents (server-side) */}
      {documents.length > 0 && (
        <section className="bg-white/5 border border-white/8 rounded-2xl">
          <header className="px-4 py-3 border-b border-white/5 text-sm font-medium text-slate-300 flex items-center gap-2">
            <FileText size={16} />
            {t.pendingDocuments} ({documents.length})
          </header>
          <div className="divide-y divide-white/5 text-sm">
            {documents.map((doc) => (
              <div key={doc.id} className="px-4 py-2 flex items-center gap-3">
                <FileText size={14} className="text-slate-400" />
                <span>{doc.original_name}</span>
                <span className="text-xs text-slate-500 ml-auto">
                  {doc.parse_status === 'failed'
                    ? (doc.parse_error ?? t.parseFailed)
                    : doc.parse_status}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Error banner */}
      {error && (
        <div className="rounded-xl bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm text-red-200 flex items-center gap-2">
          <AlertCircle size={16} />
          {error}
        </div>
      )}

      {/* Loading state */}
      {loading && !data && (
        <div className="text-sm text-slate-400">{translations[lang].common.loading}</div>
      )}

      {/* Empty state */}
      {!loading && policies.length === 0 && documents.length === 0 && (
        <div className="bg-white/5 border border-white/8 rounded-2xl p-10 text-center">
          <Building2 className="mx-auto text-slate-600 mb-3" size={36} />
          <h2 className="text-lg font-medium mb-1">{t.noPolicies}</h2>
          <p className="text-sm text-slate-400">{t.noPoliciesDesc}</p>
        </div>
      )}

      {/* Police-tabel */}
      {policies.length > 0 && (
        <section className="bg-white/5 border border-white/8 rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-900/40 text-slate-400 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-3">{t.colPolicy}</th>
                <th className="text-left px-4 py-3">{t.colInsurer}</th>
                <th className="text-left px-4 py-3">{t.colHolder}</th>
                <th className="text-left px-4 py-3">{t.colAddress}</th>
                <th className="text-right px-4 py-3">{t.colPremium}</th>
                <th className="text-left px-4 py-3">{t.colExpires}</th>
                <th className="text-center px-4 py-3">{t.colGaps}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {policies.map((p) => (
                <tr key={p.id} className="hover:bg-white/5 transition-colors">
                  <td className="px-4 py-3">
                    <Link
                      href={`/dashboard/forsikring/${p.id}`}
                      className="text-blue-300 hover:text-blue-200 font-medium"
                    >
                      {p.policy_number}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-slate-300">{p.insurer_name}</td>
                  <td className="px-4 py-3 text-slate-300">{p.policyholder_name}</td>
                  <td className="px-4 py-3 text-slate-300">{p.property_address ?? '—'}</td>
                  <td className="px-4 py-3 text-right text-slate-300">
                    {formatDkk(p.annual_premium_dkk)}
                  </td>
                  <td className="px-4 py-3 text-slate-300">{formatDate(p.effective_to)}</td>
                  <td className="px-4 py-3 text-center">
                    <div className="inline-flex items-center gap-1 text-xs">
                      {p.gap_counts.critical > 0 && (
                        <span className="px-1.5 py-0.5 rounded bg-red-500/20 text-red-300">
                          {p.gap_counts.critical}
                        </span>
                      )}
                      {p.gap_counts.warning > 0 && (
                        <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">
                          {p.gap_counts.warning}
                        </span>
                      )}
                      {p.gap_counts.info > 0 && (
                        <span className="px-1.5 py-0.5 rounded bg-slate-500/20 text-slate-300">
                          {p.gap_counts.info}
                        </span>
                      )}
                      {p.gap_counts.critical === 0 &&
                        p.gap_counts.warning === 0 &&
                        p.gap_counts.info === 0 && (
                          <CheckCircle2 size={14} className="text-emerald-400" />
                        )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
