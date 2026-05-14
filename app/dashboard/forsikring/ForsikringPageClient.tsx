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

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSetAIPageContext } from '@/app/context/AIPageContext';
import {
  ShieldCheck,
  Upload,
  FileText,
  AlertCircle,
  AlertTriangle,
  Loader2,
  CheckCircle2,
  XCircle,
  Building2,
  Home,
  Briefcase,
  ChevronDown,
  ChevronRight,
  Trash2,
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
  /** BIZZ-1392: Detekteret dokumenttype fra parser */
  documentType?: string;
  /** BIZZ-1392: Antal policer oprettet (for oversigter) */
  policiesCount?: number;
}

/** Aktiv fra analyse-detail API */
interface AnalyseAktiv {
  id: string;
  type: string;
  label: string;
  bfe: number | null;
  cvr: string | null;
  adresse: string | null;
  matched_policy_id: string | null;
  match_score: number | null;
}

/** Gap fra analyse-detail API */
interface AnalyseGap {
  id: string;
  policy_id: string;
  check_id: string;
  severity: string;
  title: string;
  description: string;
  recommendation: string | null;
}

/** Full analyse-detail response */
interface AnalyseDetail {
  analyse: {
    id: string;
    total_aktiver: number;
    insured_count: number;
    uninsured_count: number;
    total_risk_score: number;
  };
  aktiver: AnalyseAktiv[];
  gaps: AnalyseGap[];
}

/** Property grouped with its matched policy and relevant gaps */
interface PropertyGroup {
  aktiv: AnalyseAktiv;
  matchedPolicy: PolicyRow | null;
  gaps: AnalyseGap[];
}

// ─── BIZZ-1389: Samlet ejendomsvisning ──────────────────────────

/**
 * Expandable property row — viser aktiv med matchet police + gaps.
 *
 * @param props.group - Property group med aktiv, police og gaps
 * @param props.da - Dansk sprogflag
 */
function PropertyRow({ group, da }: { group: PropertyGroup; da: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const isInsured = group.aktiv.matched_policy_id !== null;
  const gapCritical = group.gaps.filter((g) => g.severity === 'critical').length;
  const gapWarning = group.gaps.filter((g) => g.severity === 'warning').length;

  /** Ikon for aktiv-type */
  const typeIcon =
    group.aktiv.type === 'ejendom' ? (
      <Home size={14} className="text-emerald-400" />
    ) : group.aktiv.type === 'virksomhed' ? (
      <Building2 size={14} className="text-blue-400" />
    ) : group.aktiv.type === 'bestyrelsespost' ? (
      <Briefcase size={14} className="text-purple-400" />
    ) : (
      <ShieldCheck size={14} className="text-slate-400" />
    );

  return (
    <div
      className={`border rounded-xl overflow-hidden ${
        isInsured ? 'border-white/8 bg-white/3' : 'border-red-500/30 bg-red-500/5'
      }`}
    >
      {/* Header row — klikbar for toggle */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-white/3 transition-colors"
        aria-expanded={expanded}
        aria-label={`${expanded ? (da ? 'Luk' : 'Collapse') : da ? 'Udvid' : 'Expand'} ${group.aktiv.label}`}
      >
        {/* Status ikon */}
        {isInsured ? (
          <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />
        ) : (
          <XCircle size={16} className="text-red-400 shrink-0" />
        )}

        {/* Type ikon + label */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {typeIcon}
          <span className="text-white text-sm font-medium truncate">{group.aktiv.label}</span>
        </div>

        {/* Police-info hvis matchet */}
        {group.matchedPolicy && (
          <span className="text-slate-400 text-xs shrink-0 hidden sm:block">
            {group.matchedPolicy.insurer_name} — {group.matchedPolicy.policy_number}
          </span>
        )}

        {/* Gap badges */}
        {(gapCritical > 0 || gapWarning > 0) && (
          <div className="flex items-center gap-1 shrink-0">
            {gapCritical > 0 && (
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-red-500/20 text-red-300">
                {gapCritical}
              </span>
            )}
            {gapWarning > 0 && (
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/20 text-amber-300">
                {gapWarning}
              </span>
            )}
          </div>
        )}

        {/* Uforsikret label */}
        {!isInsured && (
          <span className="text-red-300 text-[10px] uppercase font-bold shrink-0">
            {da ? 'Uforsikret' : 'Uninsured'}
          </span>
        )}

        {/* Chevron */}
        {expanded ? (
          <ChevronDown size={14} className="text-slate-500 shrink-0" />
        ) : (
          <ChevronRight size={14} className="text-slate-500 shrink-0" />
        )}
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-white/5 px-4 py-3 space-y-2">
          {/* Police metadata */}
          {group.matchedPolicy && (
            <div className="text-xs text-slate-400 space-y-0.5">
              <div>
                <span className="text-slate-500">{da ? 'Police:' : 'Policy:'}</span>{' '}
                <Link
                  href={`/dashboard/forsikring/${group.matchedPolicy.id}`}
                  className="text-blue-300 hover:text-blue-200"
                >
                  {group.matchedPolicy.policy_number}
                </Link>{' '}
                ({group.matchedPolicy.insurer_name})
              </div>
              {group.matchedPolicy.annual_premium_dkk && (
                <div>
                  <span className="text-slate-500">{da ? 'Præmie:' : 'Premium:'}</span>{' '}
                  {group.matchedPolicy.annual_premium_dkk.toLocaleString('da-DK')} kr
                </div>
              )}
              {group.matchedPolicy.effective_to && (
                <div>
                  <span className="text-slate-500">{da ? 'Udløber:' : 'Expires:'}</span>{' '}
                  {new Date(group.matchedPolicy.effective_to).toLocaleDateString('da-DK', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                </div>
              )}
            </div>
          )}

          {/* Gaps for this property */}
          {group.gaps.length > 0 ? (
            <div className="space-y-1.5 mt-2">
              {group.gaps.map((g) => (
                <div
                  key={g.id}
                  className={`rounded-lg px-3 py-2 text-xs ${
                    g.severity === 'critical'
                      ? 'bg-red-500/10 border border-red-500/20'
                      : g.severity === 'warning'
                        ? 'bg-amber-500/10 border border-amber-500/20'
                        : 'bg-slate-500/10 border border-slate-500/20'
                  }`}
                >
                  <div className="flex items-center gap-1.5 mb-0.5">
                    {g.severity === 'critical' ? (
                      <AlertTriangle size={11} className="text-red-400" />
                    ) : g.severity === 'warning' ? (
                      <AlertCircle size={11} className="text-amber-400" />
                    ) : (
                      <ShieldCheck size={11} className="text-slate-400" />
                    )}
                    <span
                      className={
                        g.severity === 'critical'
                          ? 'text-red-300 font-medium'
                          : g.severity === 'warning'
                            ? 'text-amber-300 font-medium'
                            : 'text-slate-300 font-medium'
                      }
                    >
                      {g.title}
                    </span>
                  </div>
                  <p className="text-slate-400 ml-4">{g.description}</p>
                  {g.recommendation && (
                    <p className="text-slate-500 ml-4 mt-0.5 italic">{g.recommendation}</p>
                  )}
                </div>
              ))}
            </div>
          ) : isInsured ? (
            <div className="text-emerald-400 text-xs flex items-center gap-1 mt-1">
              <CheckCircle2 size={12} />
              {da ? 'Ingen gaps — dækningen er i orden' : 'No gaps — coverage is in order'}
            </div>
          ) : (
            <div className="text-red-300 text-xs mt-1">
              {da
                ? 'Ingen police fundet — aktivet er ikke forsikret.'
                : 'No policy found — asset is not insured.'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Unified analyse result view — BIZZ-1389.
 * Groups assets by property and shows merged gaps from both systems.
 *
 * @param props.detail - Full analyse detail from API
 * @param props.policies - Policy list for cross-reference
 * @param props.da - Danish language flag
 * @param props.kundeNavn - Customer name for header
 * @param props.onRapport - Callback to trigger AI rapport generation
 */
function UnifiedAnalyseView({
  detail,
  policies,
  da,
  kundeNavn,
  onRapport,
}: {
  detail: AnalyseDetail;
  policies: PolicyRow[];
  da: boolean;
  kundeNavn: string;
  onRapport: (pct: number) => void;
}) {
  const { analyse, aktiver, gaps } = detail;

  // Build a policy lookup
  const policyById = new Map(policies.map((p) => [p.id, p]));

  // Group aktiver into PropertyGroups with their gaps
  const groups: PropertyGroup[] = aktiver.map((aktiv) => {
    // Gaps for this aktiv's matched policy
    const aktivGaps = aktiv.matched_policy_id
      ? gaps.filter((g) => g.policy_id === aktiv.matched_policy_id)
      : [];
    return {
      aktiv,
      matchedPolicy: aktiv.matched_policy_id
        ? (policyById.get(aktiv.matched_policy_id) ?? null)
        : null,
      gaps: aktivGaps,
    };
  });

  // Sort: uninsured first, then by gap count descending
  groups.sort((a, b) => {
    const aInsured = a.aktiv.matched_policy_id ? 1 : 0;
    const bInsured = b.aktiv.matched_policy_id ? 1 : 0;
    if (aInsured !== bInsured) return aInsured - bInsured;
    return b.gaps.length - a.gaps.length;
  });

  // Compute health score: 0-100 (higher = better)
  const total = analyse.total_aktiver;
  const insured = analyse.insured_count;
  const pct = total > 0 ? Math.round((insured / total) * 100) : 0;
  const totalGaps = gaps.length;
  const critGaps = gaps.filter((g) => g.severity === 'critical').length;

  // Health: base on coverage%, penalise for critical gaps
  const healthBase = pct;
  const gapPenalty = Math.min(30, critGaps * 5 + Math.min(totalGaps, 20));
  const healthScore = Math.max(0, Math.min(100, healthBase - gapPenalty));
  const healthColor = healthScore >= 71 ? 'emerald' : healthScore >= 41 ? 'amber' : 'red';

  return (
    <div className="space-y-4">
      {/* Niveau 1: Kundeoverblik — én KPI-række */}
      <div className="bg-white/5 border border-white/8 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-white text-sm font-semibold">{kundeNavn}</h3>
          <span
            className={`text-lg font-bold ${
              healthColor === 'emerald'
                ? 'text-emerald-400'
                : healthColor === 'amber'
                  ? 'text-amber-400'
                  : 'text-red-400'
            }`}
          >
            {healthScore}/100
          </span>
        </div>
        <div className="grid grid-cols-4 gap-2">
          <div className="text-center">
            <div className="text-blue-300 text-xl font-bold">{total}</div>
            <div className="text-slate-500 text-[10px]">{da ? 'Ejendomme' : 'Properties'}</div>
          </div>
          <div className="text-center">
            <div className="text-emerald-300 text-xl font-bold">{insured}</div>
            <div className="text-slate-500 text-[10px]">{da ? 'Forsikrede' : 'Insured'}</div>
          </div>
          <div className="text-center">
            <div className="text-red-300 text-xl font-bold">{total - insured}</div>
            <div className="text-slate-500 text-[10px]">{da ? 'Uforsikrede' : 'Uninsured'}</div>
          </div>
          <div className="text-center">
            <div
              className={`text-xl font-bold ${
                healthColor === 'emerald'
                  ? 'text-emerald-400'
                  : healthColor === 'amber'
                    ? 'text-amber-400'
                    : 'text-red-400'
              }`}
            >
              {healthScore}
            </div>
            <div className="text-slate-500 text-[10px]">
              {da ? 'Sundhedsscore' : 'Health score'}
            </div>
          </div>
        </div>
        {/* Health bar */}
        <div className="mt-3 h-1.5 bg-slate-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              healthColor === 'emerald'
                ? 'bg-emerald-500'
                : healthColor === 'amber'
                  ? 'bg-amber-500'
                  : 'bg-red-500'
            }`}
            style={{ width: `${healthScore}%` }}
          />
        </div>
      </div>

      {/* Niveau 2: Ejendomsliste med expandable rows */}
      <div className="space-y-2">
        {groups.map((group) => (
          <PropertyRow key={group.aktiv.id} group={group} da={da} />
        ))}
      </div>

      {/* Rapport-knap */}
      <button
        type="button"
        onClick={() => onRapport(pct)}
        className="w-full bg-blue-600 hover:bg-blue-500 text-white px-4 py-2.5 rounded-lg text-sm font-medium flex items-center justify-center gap-2"
      >
        <ShieldCheck size={15} />
        {da ? 'Lav rapport via AI Chat' : 'Generate report via AI Chat'}
      </button>
    </div>
  );
}

// ─── BIZZ-1367: Analyse-sektion med customer picker ─────────────

/**
 * Gap-analyse sektion med CVR/person-søgning + start-knap.
 * BIZZ-1389: Viser nu unified property-centric view efter analyse.
 *
 * @param props.lang - Sprogkode
 * @param props.policies - Policy list for cross-referencing in unified view
 */
function AnalyseSection({
  lang,
  policies,
  onRefresh,
  onAnalyseDetail,
}: {
  lang: string;
  policies: PolicyRow[];
  onRefresh: () => void;
  /** BIZZ-1353: Callback med analyse-detail for AI-kontekst */
  onAnalyseDetail: (detail: AnalyseDetail | null, kundeNavn: string | null) => void;
}) {
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
  /** BIZZ-1389: Full analyse detail for unified view */
  const [analyseDetail, setAnalyseDetail] = useState<AnalyseDetail | null>(null);
  /** BIZZ-1355: Snapshot-dato for historisk analyse */
  const [asOfDate, setAsOfDate] = useState('');
  /** BIZZ-1394: Eksisterende policer for valgt kunde */
  const [kundePolicer, setKundePolicer] = useState<PolicyRow[]>([]);
  /** BIZZ-1394: Tidligere analyse for sammenligning */
  const [lastAnalyse, setLastAnalyse] = useState<{
    total_aktiver: number;
    insured_count: number;
    total_risk_score: number;
    created_at: string;
  } | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** BIZZ-1384: Sagsliste */
  const [sager, setSager] = useState<
    Array<{
      id: string;
      kunde_type: string;
      kunde_id: string;
      kunde_navn: string | null;
      status: string;
      police_count: number;
      analyse_count: number;
      updated_at: string;
    }>
  >([]);

  /** Hent sagsliste ved mount */
  useEffect(() => {
    fetch('/api/forsikring/sager')
      .then((r) => (r.ok ? r.json() : { sager: [] }))
      .then((d) => setSager(d.sager ?? []))
      .catch(() => {});
  }, []);

  /** BIZZ-1394: Hent eksisterende policer + forrige analyse når kunde vælges */
  useEffect(() => {
    if (!selected) {
      setKundePolicer([]);
      setLastAnalyse(null);
      setAnalyseResult(null);
      setAnalyseDetail(null);
      onAnalyseDetail(null, null);
      return;
    }
    // Match policies by CVR (for virksomhed) or name (for person)
    const matchedPolicer = policies.filter((p) => {
      if (selected.type === 'virksomhed' && selected.id) {
        return p.policyholder_name
          ?.toLowerCase()
          .includes(selected.navn.toLowerCase().split(' ')[0]);
      }
      return p.policyholder_name?.toLowerCase().includes(selected.navn.toLowerCase().split(' ')[0]);
    });
    setKundePolicer(matchedPolicer);

    // Hent seneste analyse for denne kunde
    fetch(`/api/forsikring/analyser`)
      .then((r) => (r.ok ? r.json() : { analyser: [] }))
      .then((d) => {
        const analyser = d.analyser ?? [];
        const match = analyser.find((a: { kunde_id: string }) => a.kunde_id === selected.id);
        if (match) {
          setLastAnalyse({
            total_aktiver: match.total_aktiver,
            insured_count: match.insured_count,
            total_risk_score: match.total_risk_score,
            created_at: match.created_at,
          });
        } else {
          setLastAnalyse(null);
        }
      })
      .catch(() => setLastAnalyse(null));
  }, [selected, policies]);

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

  /** Start gap-analyse + opret/find sag */
  const startAnalyse = useCallback(async () => {
    if (!selected || running) return;
    setRunning(true);
    setAnalyseResult(null);
    try {
      // BIZZ-1384: Auto-opret sag ved analyse
      await fetch('/api/forsikring/sager', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kunde_type: selected.type,
          kunde_id: selected.id,
          kunde_navn: selected.navn,
        }),
      });
      // Kør analyse
      const res = await fetch('/api/forsikring/analyser', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kunde_type: selected.type,
          kunde_id: selected.id,
          kunde_navn: selected.navn,
          ...(asOfDate ? { as_of_date: asOfDate } : {}),
        }),
      });
      if (res.ok) {
        const result = await res.json();
        setAnalyseResult(result);
        // BIZZ-1389: Fetch full detail for unified property view
        try {
          const detailRes = await fetch(`/api/forsikring/analyser/${result.analyse_id}`);
          if (detailRes.ok) {
            const detail = await detailRes.json();
            setAnalyseDetail(detail);
            // Notify parent to update AI context with gaps
            onAnalyseDetail(detail, selected?.navn ?? null);
          }
        } catch {
          // Best-effort — fallback to old view if detail fails
        }
        // Refresh sagsliste
        fetch('/api/forsikring/sager')
          .then((r) => (r.ok ? r.json() : { sager: [] }))
          .then((d) => setSager(d.sager ?? []))
          .catch(() => {});
      }
    } catch {
      // Handled silently
    } finally {
      setRunning(false);
    }
  }, [selected, running, asOfDate]);

  return (
    <section className="bg-white/5 border border-white/8 rounded-2xl p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-white font-semibold text-sm flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold">
            1
          </span>
          {da ? 'Vælg kunde' : 'Select customer'}
        </h2>
        {/* BIZZ-1395: Reset/ny kunde-knap */}
        {selected && (
          <button
            type="button"
            onClick={() => {
              setSelected(null);
              setQuery('');
              setAnalyseResult(null);
              setAnalyseDetail(null);
              setKundePolicer([]);
              setLastAnalyse(null);
              setAsOfDate('');
            }}
            className="text-slate-400 hover:text-white text-xs px-2 py-1 rounded hover:bg-white/5 transition-colors"
          >
            {da ? '← Ny kunde' : '← New customer'}
          </button>
        )}
      </div>
      <p className="text-slate-400 text-xs">
        {da
          ? 'Vælg den virksomhed eller person du vil analysere forsikringsdækning for.'
          : 'Select the company or person to analyse insurance coverage for.'}
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

      {/* BIZZ-1355: Snapshot-dato for historisk analyse */}
      {selected && !analyseResult && (
        <div className="flex items-center gap-3 text-xs">
          <label htmlFor="as-of-date" className="text-slate-400 whitespace-nowrap">
            {da ? 'Snapshot-dato:' : 'Snapshot date:'}
          </label>
          <input
            id="as-of-date"
            type="date"
            value={asOfDate}
            onChange={(e) => setAsOfDate(e.target.value)}
            max={new Date().toISOString().slice(0, 10)}
            className="bg-slate-800 border border-slate-700/60 rounded px-2 py-1 text-white text-xs outline-none focus:border-blue-500/60"
          />
          {asOfDate && (
            <button
              type="button"
              onClick={() => setAsOfDate('')}
              className="text-slate-500 hover:text-slate-300 text-[10px]"
              aria-label={da ? 'Ryd dato' : 'Clear date'}
            >
              {da ? 'ryd' : 'clear'}
            </button>
          )}
          {!asOfDate && (
            <span className="text-slate-500">
              {da ? '(tom = aktuel dato)' : '(empty = current date)'}
            </span>
          )}
        </div>
      )}

      {/* BIZZ-1394: Eksisterende policer + forrige analyse for valgt kunde */}
      {selected && !analyseResult && (kundePolicer.length > 0 || lastAnalyse) && (
        <div className="space-y-2">
          {/* Eksisterende policer */}
          {kundePolicer.length > 0 && (
            <div className="bg-white/3 border border-white/5 rounded-lg p-3">
              <div className="text-slate-300 text-xs font-medium mb-1.5 flex items-center gap-1.5">
                <FileText size={12} />
                {da
                  ? `${kundePolicer.length} eksisterende policer`
                  : `${kundePolicer.length} existing policies`}
              </div>
              <div className="space-y-1">
                {kundePolicer.slice(0, 5).map((p) => (
                  <div key={p.id} className="flex items-center justify-between text-xs">
                    <span className="text-slate-400">
                      {p.policy_number} — {p.insurer_name}
                    </span>
                    <div className="flex items-center gap-1">
                      {p.gap_counts.critical > 0 && (
                        <span className="px-1 py-0.5 rounded bg-red-500/20 text-red-300 text-[10px]">
                          {p.gap_counts.critical}
                        </span>
                      )}
                      {p.gap_counts.warning > 0 && (
                        <span className="px-1 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px]">
                          {p.gap_counts.warning}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
                {kundePolicer.length > 5 && (
                  <div className="text-slate-500 text-[10px]">
                    +{kundePolicer.length - 5} {da ? 'flere' : 'more'}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Forrige analyse (sammenligning) */}
          {lastAnalyse && (
            <div className="bg-blue-500/5 border border-blue-500/20 rounded-lg p-3">
              <div className="text-blue-300 text-xs font-medium mb-1">
                {da ? 'Forrige analyse' : 'Previous analysis'} —{' '}
                {new Date(lastAnalyse.created_at).toLocaleDateString('da-DK', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })}
              </div>
              <div className="flex gap-4 text-xs text-slate-400">
                <span>
                  {lastAnalyse.total_aktiver} {da ? 'aktiver' : 'assets'}
                </span>
                <span>
                  {lastAnalyse.insured_count} {da ? 'forsikrede' : 'insured'}
                </span>
                <span>
                  {da ? 'Score' : 'Score'}: {lastAnalyse.total_risk_score}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

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
              {lastAnalyse
                ? da
                  ? 'Kør ny analyse (sammenlign)'
                  : 'Run new analysis (compare)'
                : da
                  ? 'Start gap-analyse'
                  : 'Start gap analysis'}
            </>
          )}
        </button>
      )}

      {/* BIZZ-1394: Sammenligning med forrige analyse */}
      {analyseResult && lastAnalyse && (
        <div className="bg-slate-800/50 border border-white/5 rounded-lg p-3">
          <div className="text-slate-400 text-[10px] uppercase tracking-wide mb-2">
            {da ? 'Ændringer siden forrige analyse' : 'Changes since previous analysis'}
          </div>
          <div className="grid grid-cols-3 gap-3 text-xs">
            <div>
              <div className="text-slate-500 mb-0.5">{da ? 'Aktiver' : 'Assets'}</div>
              <div className="text-white font-medium">
                {lastAnalyse.total_aktiver} → {analyseResult.total_aktiver}
                {analyseResult.total_aktiver !== lastAnalyse.total_aktiver && (
                  <span
                    className={`ml-1 ${analyseResult.total_aktiver > lastAnalyse.total_aktiver ? 'text-blue-400' : 'text-amber-400'}`}
                  >
                    ({analyseResult.total_aktiver > lastAnalyse.total_aktiver ? '+' : ''}
                    {analyseResult.total_aktiver - lastAnalyse.total_aktiver})
                  </span>
                )}
              </div>
            </div>
            <div>
              <div className="text-slate-500 mb-0.5">{da ? 'Forsikrede' : 'Insured'}</div>
              <div className="text-white font-medium">
                {lastAnalyse.insured_count} → {analyseResult.insured_count}
                {analyseResult.insured_count !== lastAnalyse.insured_count && (
                  <span
                    className={`ml-1 ${analyseResult.insured_count > lastAnalyse.insured_count ? 'text-emerald-400' : 'text-red-400'}`}
                  >
                    ({analyseResult.insured_count > lastAnalyse.insured_count ? '+' : ''}
                    {analyseResult.insured_count - lastAnalyse.insured_count})
                  </span>
                )}
              </div>
            </div>
            <div>
              <div className="text-slate-500 mb-0.5">Gaps</div>
              <div className="text-white font-medium">
                → {analyseResult.gaps_count}
                {analyseResult.gaps_count > 0 && (
                  <span className="text-amber-400 ml-1">({analyseResult.gaps_count})</span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* BIZZ-1389: Samlet ejendomsvisning efter analyse */}
      {analyseResult && analyseDetail && (
        <UnifiedAnalyseView
          detail={analyseDetail}
          policies={policies}
          da={da}
          kundeNavn={selected?.navn ?? (da ? 'Kunden' : 'Customer')}
          onRapport={(pct) => {
            const prompt = da
              ? `Lav en mæglerrapport i Word-format for ${selected?.navn ?? 'kunden'}. Brug forsikringsdata fra konteksten. Inkluder: 1) Executive summary med sundhedsscore ${pct}/100, 2) Ejendomsoversigt med forsikringsstatus, 3) Forsikringsgap-tabel med alle ${analyseResult.gaps_count} gaps, 4) Anbefalinger prioriteret efter risiko, 5) Handlingsplan. Generér dokumentet direkte uden at spørge om mere info.`
              : `Create a broker report in Word format for ${selected?.navn ?? 'the customer'}. Use insurance data from context. Include: 1) Executive summary with health score ${pct}/100, 2) Property overview with insurance status, 3) Gap table with all ${analyseResult.gaps_count} gaps, 4) Prioritized recommendations, 5) Action plan. Generate the document directly.`;
            const displayText = da
              ? `Lav mæglerrapport for ${selected?.navn ?? 'kunden'} (score ${pct}/100)`
              : `Generate broker report for ${selected?.navn ?? 'the customer'} (score ${pct}/100)`;
            window.dispatchEvent(
              new CustomEvent('bizz:ai-open-with-prompt', {
                detail: { prompt, displayText },
              })
            );
          }}
        />
      )}
      {/* Fallback: vis simple stats hvis detail ikke kan hentes */}
      {analyseResult && !analyseDetail && (
        <div className="bg-white/5 border border-white/8 rounded-xl p-4 text-sm text-slate-400">
          {da ? 'Analyse gennemført' : 'Analysis complete'} — {analyseResult.total_aktiver}{' '}
          {da ? 'aktiver' : 'assets'}, {analyseResult.gaps_count} gaps
        </div>
      )}
      {/* BIZZ-1384: Sagsliste — tidligere kunder */}
      {sager.length > 0 && !selected && (
        <div className="mt-3 space-y-1">
          <div className="text-slate-500 text-[10px] uppercase tracking-wide">
            {da ? 'Tidligere kunder' : 'Previous customers'}
          </div>
          {sager.slice(0, 5).map((s) => (
            <div key={s.id} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  setSelected({
                    type: s.kunde_type as 'virksomhed' | 'person',
                    id: s.kunde_id,
                    navn: s.kunde_navn ?? s.kunde_id,
                  });
                }}
                className="flex-1 text-left px-3 py-2 bg-white/3 hover:bg-white/5 rounded-lg text-xs flex items-center justify-between"
              >
                <span className="text-white font-medium">{s.kunde_navn ?? s.kunde_id}</span>
                <span className="text-slate-500">
                  {s.police_count} {da ? 'policer' : 'policies'} · {s.analyse_count}{' '}
                  {da ? 'analyser' : 'analyses'}
                </span>
              </button>
              {/* BIZZ-1395: Slet sag-knap */}
              <button
                type="button"
                aria-label={
                  da
                    ? `Slet sag for ${s.kunde_navn ?? s.kunde_id}`
                    : `Delete case for ${s.kunde_navn ?? s.kunde_id}`
                }
                onClick={async (e) => {
                  e.stopPropagation();
                  if (
                    !window.confirm(
                      da
                        ? `Slet sag for ${s.kunde_navn ?? s.kunde_id}? Alle policer, dokumenter og analyser slettes permanent.`
                        : `Delete case for ${s.kunde_navn ?? s.kunde_id}? All policies, documents and analyses will be permanently deleted.`
                    )
                  )
                    return;
                  try {
                    const res = await fetch(`/api/forsikring/sager/${s.id}`, { method: 'DELETE' });
                    if (res.ok) {
                      setSager((prev) => prev.filter((x) => x.id !== s.id));
                      onRefresh();
                    }
                  } catch {
                    // Handled silently
                  }
                }}
                className="p-2 text-slate-600 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors shrink-0"
              >
                <XCircle size={14} />
              </button>
            </div>
          ))}
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
  const setAICtx = useSetAIPageContext();
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploadJobs, setUploadJobs] = useState<UploadJob[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [resetting, setResetting] = useState(false);
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

  /** Analyse-detail og kundenavn fra AnalyseSection (for AI-kontekst) */
  const [aiAnalyseDetail, setAiAnalyseDetail] = useState<AnalyseDetail | null>(null);
  const [aiKundeNavn, setAiKundeNavn] = useState<string | null>(null);

  /** Callback fra AnalyseSection når analyse er kørt */
  const handleAnalyseDetail = useCallback(
    (detail: AnalyseDetail | null, kundeNavn: string | null) => {
      setAiAnalyseDetail(detail);
      setAiKundeNavn(kundeNavn);
    },
    []
  );

  /** BIZZ-1388: Sæt AI-kontekst med forsikringsdata + gaps så chat kan generere rapporter */
  useEffect(() => {
    if (!data) return;
    const totals = data.totals;
    const analyse = aiAnalyseDetail?.analyse;
    setAICtx({
      pageType: 'domain',
      forsikringPolicer: data.policies.map((p) => ({
        policenummer: p.policy_number,
        selskab: p.insurer_name,
        adresse: p.property_address,
        praemie: p.annual_premium_dkk,
        udloeber: p.effective_to,
        gapsCritical: p.gap_counts.critical,
        gapsWarning: p.gap_counts.warning,
        gapsInfo: p.gap_counts.info,
      })),
      forsikringAnalyse: analyse
        ? {
            kundeNavn: aiKundeNavn,
            totalAktiver: analyse.total_aktiver,
            forsikrede: analyse.insured_count,
            uforsikrede: analyse.uninsured_count,
            riskScore: analyse.total_risk_score,
            gapsCount: aiAnalyseDetail?.gaps.length ?? 0,
          }
        : {
            kundeNavn: null,
            totalAktiver: 0,
            forsikrede: 0,
            uforsikrede: 0,
            riskScore: 0,
            gapsCount: totals.gaps_critical + totals.gaps_warning + totals.gaps_info,
          },
      // Inkluder individuelle gaps med detaljer til AI-rapporten
      forsikringGaps: aiAnalyseDetail?.gaps.map((g) => ({
        severity: g.severity,
        title: g.title,
        description: g.description,
        recommendation: g.recommendation,
        policyAddress: null,
      })),
    });
    return () => setAICtx(null);
  }, [data, setAICtx, aiAnalyseDetail, aiKundeNavn]);

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
        // BIZZ-1392: Vis dokumenttype + antal policer fra parse-response
        const parseJson = (await parseRes.json().catch(() => ({}))) as {
          document_type?: string;
          policies_count?: number;
        };
        setUploadJobs((prev) =>
          prev.map((j) =>
            j.id === jobId
              ? {
                  ...j,
                  status: 'done',
                  documentType: parseJson.document_type,
                  policiesCount: parseJson.policies_count,
                }
              : j
          )
        );
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

  const _totals = data?.totals;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-[#0a1020] text-slate-100">
      {/* Heading + nulstil-knap */}
      <header className="flex items-start justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-3 text-2xl font-semibold">
            <ShieldCheck className="text-blue-400" size={28} />
            {t.title}
          </h1>
          <p className="text-sm text-slate-400">{t.subtitle}</p>
        </div>
        {/* BIZZ-1397: Nulstil alt — sletter alle dokumenter, policer og analyser */}
        {(policies.length > 0 || documents.length > 0) && (
          <button
            type="button"
            disabled={resetting}
            onClick={async () => {
              const da = lang === 'da';
              if (
                !window.confirm(
                  da
                    ? 'Slet ALLE forsikringsdata? Alle policer, dokumenter, gaps og analyser slettes permanent. Denne handling kan ikke fortrydes.'
                    : 'Delete ALL insurance data? All policies, documents, gaps and analyses will be permanently deleted. This action cannot be undone.'
                )
              )
                return;
              setResetting(true);
              try {
                const res = await fetch('/api/forsikring/reset', { method: 'DELETE' });
                if (res.ok) {
                  setUploadJobs([]);
                  await refresh();
                }
              } catch {
                // Handled silently
              } finally {
                setResetting(false);
              }
            }}
            className="flex items-center gap-2 px-3 py-2 text-xs rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300 transition-colors disabled:opacity-50"
          >
            {resetting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            {lang === 'da' ? 'Nulstil alt' : 'Reset all'}
          </button>
        )}
      </header>

      {/* TRIN 1: Vælg kunde */}
      <AnalyseSection
        lang={lang}
        policies={policies}
        onRefresh={refresh}
        onAnalyseDetail={handleAnalyseDetail}
      />

      {/* TRIN 2: Upload dokumenter */}
      <div className="flex items-center gap-2 text-sm font-semibold text-white">
        <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold">
          2
        </span>
        {lang === 'da' ? 'Upload forsikringsdokumenter' : 'Upload insurance documents'}
      </div>
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
                {job.status === 'done' &&
                  (job.documentType === 'oversigt'
                    ? `✓ Oversigt → ${job.policiesCount ?? '?'} policer`
                    : job.documentType === 'tillaeg'
                      ? '✓ Tillæg'
                      : '✓')}
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
                {/* BIZZ-1397: Slet individuelt dokument */}
                <button
                  type="button"
                  aria-label={
                    lang === 'da' ? `Slet ${doc.original_name}` : `Delete ${doc.original_name}`
                  }
                  onClick={async () => {
                    try {
                      const res = await fetch(`/api/forsikring/documents/${doc.id}`, {
                        method: 'DELETE',
                      });
                      if (res.ok) await refresh();
                    } catch {
                      // Handled silently
                    }
                  }}
                  className="p-1 text-slate-600 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors shrink-0"
                >
                  <XCircle size={14} />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Uploadede policer — compact header med rapport-link */}
      {policies.length > 0 && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold">
              3
            </span>
            {lang === 'da'
              ? `${policies.length} policer — ${(data?.totals?.gaps_critical ?? 0) + (data?.totals?.gaps_warning ?? 0)} gaps fundet`
              : `${policies.length} policies — ${(data?.totals?.gaps_critical ?? 0) + (data?.totals?.gaps_warning ?? 0)} gaps found`}
          </div>
        </div>
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

      {/* Empty state — kun når ingen policer OG ingen dokumenter */}
      {!loading && policies.length === 0 && documents.length === 0 && uploadJobs.length === 0 && (
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
