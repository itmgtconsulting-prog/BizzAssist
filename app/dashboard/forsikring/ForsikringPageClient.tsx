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
import { useSubscription } from '@/app/context/SubscriptionContext';
import { translations } from '@/app/lib/translations';
import TokenUsageBar from '@/app/components/TokenUsageBar';

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
 * @param props.onRapport - Callback to download gap-rapport DOCX
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
  onRapport: () => void;
}) {
  const { analyse: _analyse, aktiver, gaps } = detail;

  // Build a policy lookup
  const policyById = new Map(policies.map((p) => [p.id, p]));

  // Group aktiver into PropertyGroups with their gaps — dedup by address
  const seenAddresses = new Set<string>();
  const groups: PropertyGroup[] = [];
  for (const aktiv of aktiver) {
    // BIZZ-1439: Dedup — skip duplikerede adresser (ejerskab kan have flere rækker per BFE)
    // Dedup via BFE (unikt per ejendom) — IKKE adresse (ejerlejligheder har samme adresse men forskellig etage/dør)
    const addrKey = aktiv.bfe ? String(aktiv.bfe) : aktiv.id;
    if (seenAddresses.has(addrKey)) continue;
    seenAddresses.add(addrKey);

    const aktivGaps = aktiv.matched_policy_id
      ? gaps.filter((g) => g.policy_id === aktiv.matched_policy_id)
      : [];
    groups.push({
      aktiv,
      matchedPolicy: aktiv.matched_policy_id
        ? (policyById.get(aktiv.matched_policy_id) ?? null)
        : null,
      gaps: aktivGaps,
    });
  }

  // Sort: uninsured first, then by gap count descending
  groups.sort((a, b) => {
    const aInsured = a.aktiv.matched_policy_id ? 1 : 0;
    const bInsured = b.aktiv.matched_policy_id ? 1 : 0;
    if (aInsured !== bInsured) return aInsured - bInsured;
    return b.gaps.length - a.gaps.length;
  });

  // Compute health score: 0-100 (higher = better)
  // BIZZ-1440: Brug dedupede groups i stedet for rå analyse-tal
  const total = groups.length;
  const insured = groups.filter((g) => g.aktiv.matched_policy_id !== null).length;
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

      {/* Rapport-knap — direkte download som DOCX */}
      <button
        type="button"
        onClick={() => onRapport()}
        className="w-full bg-blue-600 hover:bg-blue-500 text-white px-4 py-2.5 rounded-lg text-sm font-medium flex items-center justify-center gap-2"
      >
        <FileText size={15} />
        {da ? 'Download gap-rapport (Word)' : 'Download gap report (Word)'}
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
  onSagChange,
  onCustomerSelect,
  newDocumentIds,
  addTokenUsage,
}: {
  lang: string;
  policies: PolicyRow[];
  onRefresh: () => void;
  /** BIZZ-1353: Callback med analyse-detail for AI-kontekst */
  onAnalyseDetail: (detail: AnalyseDetail | null, kundeNavn: string | null) => void;
  /** BIZZ-1399: Callback med sag_id når kunde vælges/analyse startes */
  onSagChange: (sagId: string | null) => void;
  /** BIZZ-1404: Callback når kunde vælges — for analyse-historik */
  onCustomerSelect: (
    customer: { type: 'virksomhed' | 'person'; id: string; navn: string } | null
  ) => void;
  /** BIZZ-1404: Document IDs fra nye uploads */
  newDocumentIds: string[];
  /** BIZZ-1447: Token usage callback */
  addTokenUsage: (tokens: number) => void;
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
  /** BIZZ-1404: Dokument-genbrug wizard state */
  const [showDocPicker, setShowDocPicker] = useState(false);
  const [previousDocs, setPreviousDocs] = useState<
    Array<{ id: string; original_name: string; created_at: string; from_analyse_id: string }>
  >([]);
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  /** BIZZ-1439: Upload-state inde i wizard */
  const wizardFileRef = useRef<HTMLInputElement>(null);
  const [wizardUploads, setWizardUploads] = useState<
    Array<{
      id: string;
      fileName: string;
      status: 'uploading' | 'parsing' | 'done' | 'failed';
      docId?: string;
    }>
  >([]);
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

  /** BIZZ-1404: Hent tidligere dokumenter for genbrug-picker */
  useEffect(() => {
    if (!showDocPicker || !selected) {
      setPreviousDocs([]);
      return;
    }
    fetch(`/api/forsikring/documents/for-customer?kunde_id=${encodeURIComponent(selected.id)}`)
      .then((r) => (r.ok ? r.json() : { documents: [] }))
      .then((d) => {
        const docs = d.documents ?? [];
        setPreviousDocs(docs);
        // BIZZ-1442: Auto-check alle tidligere docs som default
        setSelectedDocIds(
          (prev) => new Set([...prev, ...docs.map((doc: { id: string }) => doc.id)])
        );
      })
      .catch(() => setPreviousDocs([]));
  }, [showDocPicker, selected]);

  /** BIZZ-1439: Upload filer inde i wizard — tracker doc IDs */
  const onWizardUpload = useCallback(
    async (files: FileList) => {
      // BIZZ-1439: Parallel upload+parse — alle filer starter samtidigt
      const fileArray = Array.from(files);
      const jobs = fileArray.map((file) => {
        const jobId = `wiz-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        setWizardUploads((prev) => [
          ...prev,
          { id: jobId, fileName: file.name, status: 'uploading' },
        ]);
        return { jobId, file };
      });

      await Promise.allSettled(
        jobs.map(async ({ jobId, file }) => {
          try {
            const formData = new FormData();
            formData.append('file', file);
            const upRes = await fetch('/api/forsikring/upload', { method: 'POST', body: formData });
            if (!upRes.ok) throw new Error('Upload failed');
            const upJson = (await upRes.json()) as { document: { id: string } };
            const docId = upJson.document.id;

            setWizardUploads((prev) =>
              prev.map((j) => (j.id === jobId ? { ...j, status: 'parsing' } : j))
            );
            const parseRes = await fetch('/api/forsikring/parse', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ document_id: docId }),
            });
            if (!parseRes.ok) throw new Error('Parse failed');

            // BIZZ-1447: Opdater token-forbrug i UI
            try {
              const parseData = await parseRes.json();
              if (parseData.tokenUsage) {
                const totalTokens =
                  (parseData.tokenUsage.input ?? 0) + (parseData.tokenUsage.output ?? 0);
                if (totalTokens > 0) addTokenUsage(totalTokens);
              }
            } catch {
              /* non-critical */
            }

            setWizardUploads((prev) =>
              prev.map((j) => (j.id === jobId ? { ...j, status: 'done', docId } : j))
            );
            // BIZZ-1442: Auto-check nye uploads
            setSelectedDocIds((prev) => new Set([...prev, docId]));
          } catch {
            setWizardUploads((prev) =>
              prev.map((j) => (j.id === jobId ? { ...j, status: 'failed' } : j))
            );
          }
        })
      );
      onRefresh();
    },
    [onRefresh]
  );

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
      onSagChange(null);
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
  }, [selected, policies, onAnalyseDetail, onSagChange]);

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
      // BIZZ-1399: Capture sag_id for upload-filtrering
      const sagRes = await fetch('/api/forsikring/sager', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kunde_type: selected.type,
          kunde_id: selected.id,
          kunde_navn: selected.navn,
        }),
      });
      if (sagRes.ok) {
        const sagData = (await sagRes.json()) as { sag?: { id: string } };
        if (sagData.sag?.id) onSagChange(sagData.sag.id);
      }
      // BIZZ-1440: Samle ALLE doc IDs (genbrugte + wizard-uploads + parent-uploads)
      const reusedDocIds = [...selectedDocIds];
      const wizardDocIds = wizardUploads
        .filter((u) => u.status === 'done' && u.docId)
        .map((u) => u.docId!);
      const allNewDocIds = [...wizardDocIds, ...newDocumentIds];
      // Hvis wizard er åben, send altid scoped doc IDs — aldrig fald tilbage til alle policer
      const hasAnyDocs = reusedDocIds.length > 0 || allNewDocIds.length > 0;
      const res = await fetch('/api/forsikring/analyser', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kunde_type: selected.type,
          kunde_id: selected.id,
          kunde_navn: selected.navn,
          ...(asOfDate ? { as_of_date: asOfDate } : {}),
          // BIZZ-1443: Send alle valgte doc IDs samlet — reused + nye
          // Hvis ingen er valgt, send IKKE document_ids → backend bruger alle policer
          ...(hasAnyDocs ? { document_ids: [...reusedDocIds, ...allNewDocIds] } : {}),
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
  }, [
    selected,
    running,
    asOfDate,
    onAnalyseDetail,
    onSagChange,
    newDocumentIds,
    selectedDocIds,
    wizardUploads,
  ]);

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
                  const customer = {
                    type: (r.type === 'company' ? 'virksomhed' : 'person') as
                      | 'virksomhed'
                      | 'person',
                    id: r.id,
                    navn: r.title,
                  };
                  setSelected(customer);
                  onCustomerSelect(customer);
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

      {/* BIZZ-1404: Dokument-genbrug picker */}
      {selected && showDocPicker && (
        <div className="bg-slate-800/50 border border-white/8 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-white text-sm font-semibold">
              {da ? 'Vælg dokumenter til analysen' : 'Select documents for analysis'}
            </h3>
            <button
              type="button"
              onClick={() => {
                setShowDocPicker(false);
                setSelectedDocIds(new Set());
              }}
              className="text-slate-500 hover:text-white text-xs"
            >
              {da ? 'Luk' : 'Close'}
            </button>
          </div>

          {/* BIZZ-1442: Samlet doc-liste — alle docs med checkboxes */}
          {(() => {
            // Merge previous docs + wizard uploads til én liste
            const allDocs = [
              ...previousDocs.map((d) => ({
                id: d.id,
                name: d.original_name,
                source: 'previous' as const,
                done: true,
              })),
              ...wizardUploads
                .filter((u) => u.status === 'done' && u.docId)
                .map((u) => ({
                  id: u.docId!,
                  name: u.fileName,
                  source: 'new' as const,
                  done: true,
                })),
            ];
            // Dedup by id
            const seen = new Set<string>();
            const unique = allDocs.filter((d) => {
              if (seen.has(d.id)) return false;
              seen.add(d.id);
              return true;
            });

            return unique.length > 0 ? (
              <>
                <p className="text-slate-400 text-xs">
                  {da
                    ? 'Dokumenter inkluderet i analysen (uncheck for at ekskludere):'
                    : 'Documents included in analysis (uncheck to exclude):'}
                </p>
                <div className="space-y-1.5">
                  {unique.map((doc) => (
                    <label
                      key={doc.id}
                      className="flex items-center gap-3 px-3 py-2 bg-white/3 hover:bg-white/5 rounded-lg cursor-pointer transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={selectedDocIds.has(doc.id)}
                        onChange={(e) => {
                          setSelectedDocIds((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(doc.id);
                            else next.delete(doc.id);
                            return next;
                          });
                        }}
                        className="rounded border-slate-600 bg-slate-700 text-blue-500 focus:ring-blue-500"
                      />
                      <FileText size={14} className="text-slate-400 shrink-0" />
                      <span className="text-white text-xs flex-1 truncate">{doc.name}</span>
                      <span
                        className={`text-[10px] shrink-0 ${doc.source === 'new' ? 'text-emerald-400' : 'text-slate-500'}`}
                      >
                        {doc.source === 'new' ? (da ? 'ny' : 'new') : da ? 'tidligere' : 'previous'}
                      </span>
                      {/* Slet permanent fra system */}
                      <button
                        type="button"
                        aria-label={da ? `Slet ${doc.name}` : `Delete ${doc.name}`}
                        onClick={async (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (
                            !window.confirm(
                              da ? `Slet ${doc.name} permanent?` : `Delete ${doc.name} permanently?`
                            )
                          )
                            return;
                          try {
                            await fetch(`/api/forsikring/documents/${doc.id}`, {
                              method: 'DELETE',
                            });
                            setPreviousDocs((prev) => prev.filter((d) => d.id !== doc.id));
                            setWizardUploads((prev) => prev.filter((u) => u.docId !== doc.id));
                            setSelectedDocIds((prev) => {
                              const n = new Set(prev);
                              n.delete(doc.id);
                              return n;
                            });
                            onRefresh();
                          } catch {
                            /* silent */
                          }
                        }}
                        className="p-1 text-slate-600 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors shrink-0"
                      >
                        <Trash2 size={12} />
                      </button>
                    </label>
                  ))}
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-blue-400">
                    {selectedDocIds.size} / {unique.length}{' '}
                    {da ? 'dokumenter valgt' : 'documents selected'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedDocIds(new Set(unique.map((d) => d.id)))}
                    className="text-slate-500 hover:text-blue-400 transition-colors"
                  >
                    {da ? 'Vælg alle' : 'Select all'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedDocIds(new Set())}
                    className="text-slate-500 hover:text-red-400 transition-colors"
                  >
                    {da ? 'Fravælg alle' : 'Deselect all'}
                  </button>
                </div>
              </>
            ) : (
              <p className="text-slate-500 text-xs">
                {da
                  ? 'Upload dokumenter nedenfor for at starte.'
                  : 'Upload documents below to begin.'}
              </p>
            );
          })()}

          {/* BIZZ-1439: Upload-zone INDE I wizard */}
          <div className="pt-2 border-t border-white/5">
            <p className="text-slate-400 text-xs mb-2">
              {da
                ? 'Upload nye dokumenter til denne analyse:'
                : 'Upload new documents for this analysis:'}
            </p>
            <div
              className="rounded-xl border-2 border-dashed border-white/10 hover:border-blue-500/40 p-4 text-center cursor-pointer transition-colors"
              onClick={() => wizardFileRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') wizardFileRef.current?.click();
              }}
            >
              <Upload size={20} className="mx-auto text-blue-400 mb-1" />
              <div className="text-xs text-slate-300">
                {da
                  ? 'Klik for at uploade nye forsikringsdokumenter'
                  : 'Click to upload new insurance documents'}
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5">
                PDF, Word, Excel, billeder (max 20 MB)
              </div>
              <input
                ref={wizardFileRef}
                type="file"
                accept=".pdf,.docx,.xlsx,.xls,.pptx,.rtf,.txt,.png,.jpg,.jpeg,.gif,.webp,application/pdf,image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) {
                    onWizardUpload(e.target.files);
                    e.target.value = '';
                  }
                }}
              />
            </div>
            {/* Vis wizard upload-jobs */}
            {wizardUploads.length > 0 && (
              <div className="mt-2 space-y-1">
                {wizardUploads.map((job) => (
                  <div
                    key={job.id}
                    className="flex items-center gap-2 text-xs px-2 py-1 bg-white/3 rounded"
                  >
                    {job.status === 'done' ? (
                      <CheckCircle2 size={12} className="text-emerald-400" />
                    ) : job.status === 'failed' ? (
                      <XCircle size={12} className="text-red-400" />
                    ) : (
                      <Loader2 size={12} className="animate-spin text-blue-400" />
                    )}
                    <span className="text-white truncate">{job.fileName}</span>
                    <span className="text-slate-500 ml-auto">
                      {job.status === 'done' ? '✓' : job.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* BIZZ-1440: Start-knap — wizard åbner altid automatisk */}
      {selected && (
        <div className="flex items-center gap-2">
          {!showDocPicker && (
            <button
              type="button"
              onClick={() => setShowDocPicker(true)}
              disabled={running}
              className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2"
            >
              <ShieldCheck size={14} />
              {lastAnalyse
                ? da
                  ? 'Kør ny analyse'
                  : 'Run new analysis'
                : da
                  ? 'Start gap-analyse'
                  : 'Start gap analysis'}
            </button>
          )}
          {showDocPicker && (
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
                  {da
                    ? `Start analyse${selectedDocIds.size > 0 ? ` (${selectedDocIds.size} genbrugte` + (wizardUploads.filter((u) => u.status === 'done').length > 0 ? ` + ${wizardUploads.filter((u) => u.status === 'done').length} nye)` : ')') : wizardUploads.filter((u) => u.status === 'done').length > 0 ? ` (${wizardUploads.filter((u) => u.status === 'done').length} nye)` : ''}`
                    : `Start analysis${selectedDocIds.size > 0 ? ` (${selectedDocIds.size} reused)` : ''}`}
                </>
              )}
            </button>
          )}
        </div>
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
          onRapport={async () => {
            // BIZZ-1403: Direkte download af gap-rapport DOCX
            try {
              const res = await fetch('/api/forsikring/rapport', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  analyse_id: analyseResult.analyse_id,
                  kunde_navn: selected?.navn ?? 'Ukendt',
                }),
              });
              if (!res.ok) throw new Error('Rapport-generering fejlede');
              const blob = await res.blob();
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `Forsikrings-Gap-Rapport-${selected?.navn ?? 'Kunde'}.docx`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
            } catch {
              // Handled silently — user can retry
            }
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
                  const customer = {
                    type: s.kunde_type as 'virksomhed' | 'person',
                    id: s.kunde_id,
                    navn: s.kunde_navn ?? s.kunde_id,
                  };
                  setSelected(customer);
                  onCustomerSelect(customer);
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

// ─── BIZZ-1440: Analyse-detalje sektion ──────────────────────────

/**
 * Viser en tidligere analyses resultater — ejendomme, gaps, rapport.
 * Henter data fra GET /api/forsikring/analyser/[id].
 */
function AnalyseDetailSection({
  analyseId,
  kundeNavn,
  lang,
  onBack,
}: {
  analyseId: string;
  kundeNavn: string;
  lang: string;
  onBack: () => void;
}) {
  const da = lang === 'da';
  const [detail, setDetail] = useState<AnalyseDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/forsikring/analyser/${analyseId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setDetail(d);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [analyseId]);

  if (loading) {
    return (
      <section className="bg-white/5 border border-white/8 rounded-2xl p-6 text-center">
        <Loader2 size={20} className="animate-spin text-blue-400 mx-auto" />
        <p className="text-slate-400 text-xs mt-2">
          {da ? 'Henter analyse...' : 'Loading analysis...'}
        </p>
      </section>
    );
  }

  if (!detail) {
    return (
      <section className="bg-white/5 border border-white/8 rounded-2xl p-4">
        <p className="text-red-400 text-sm">
          {da ? 'Kunne ikke hente analyse' : 'Could not load analysis'}
        </p>
        <button type="button" onClick={onBack} className="text-blue-400 text-xs mt-2">
          {da ? '← Tilbage' : '← Back'}
        </button>
      </section>
    );
  }

  // Dedup aktiver
  const seenBfe = new Set<string>();
  const uniqueAktiver = detail.aktiver.filter((a) => {
    const key = a.bfe ? String(a.bfe) : a.id;
    if (seenBfe.has(key)) return false;
    seenBfe.add(key);
    return true;
  });
  const total = uniqueAktiver.length;
  const insured = uniqueAktiver.filter((a) => a.matched_policy_id).length;
  const pct = total > 0 ? Math.round((insured / total) * 100) : 0;
  const _gapCount = detail.gaps.length;

  return (
    <section className="space-y-4">
      {/* Header med tilbage-knap */}
      <div className="flex items-center justify-between">
        <h3 className="text-white text-sm font-semibold">
          {da ? 'Analyse-resultater' : 'Analysis results'} — {kundeNavn}
        </h3>
        <button
          type="button"
          onClick={onBack}
          className="text-slate-400 hover:text-white text-xs px-2 py-1 rounded hover:bg-white/5"
        >
          {da ? '← Tilbage til historik' : '← Back to history'}
        </button>
      </div>

      {/* KPI */}
      <div className="bg-white/5 border border-white/8 rounded-xl p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-white text-sm font-semibold">{kundeNavn}</span>
          <span
            className={`text-lg font-bold ${pct >= 71 ? 'text-emerald-400' : pct >= 41 ? 'text-amber-400' : 'text-red-400'}`}
          >
            {pct}%
          </span>
        </div>
        <div className="grid grid-cols-3 gap-3 text-xs text-center">
          <div>
            <div className="text-blue-300 text-xl font-bold">{total}</div>
            <div className="text-slate-500">{da ? 'Ejendomme' : 'Properties'}</div>
          </div>
          <div>
            <div className="text-emerald-300 text-xl font-bold">{insured}</div>
            <div className="text-slate-500">{da ? 'Forsikrede' : 'Insured'}</div>
          </div>
          <div>
            <div className="text-red-300 text-xl font-bold">{total - insured}</div>
            <div className="text-slate-500">{da ? 'Uforsikrede' : 'Uninsured'}</div>
          </div>
        </div>
      </div>

      {/* Ejendomme-liste med expandable gaps (genbruger PropertyRow) */}
      <div className="space-y-2">
        {(() => {
          // Byg policy lookup fra detail.policies (returneret fra analyser/[id])
          const pols = ((detail as unknown as Record<string, unknown>).policies ??
            []) as PolicyRow[];
          const polById = new Map(pols.map((p) => [p.id, p]));

          // Byg PropertyGroups
          const groups: PropertyGroup[] = uniqueAktiver.map((aktiv) => {
            const aktivGaps = aktiv.matched_policy_id
              ? detail.gaps.filter((g) => g.policy_id === aktiv.matched_policy_id)
              : [];
            return {
              aktiv,
              matchedPolicy: aktiv.matched_policy_id
                ? (polById.get(aktiv.matched_policy_id) ?? null)
                : null,
              gaps: aktivGaps,
            };
          });
          groups.sort((a, b) => {
            const aI = a.aktiv.matched_policy_id ? 1 : 0;
            const bI = b.aktiv.matched_policy_id ? 1 : 0;
            if (aI !== bI) return aI - bI;
            return b.gaps.length - a.gaps.length;
          });

          return groups.map((group) => <PropertyRow key={group.aktiv.id} group={group} da={da} />);
        })()}
      </div>

      {/* Download rapport */}
      <button
        type="button"
        onClick={async () => {
          try {
            const res = await fetch('/api/forsikring/rapport', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ analyse_id: analyseId, kunde_navn: kundeNavn }),
            });
            if (!res.ok) return;
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `Gap-Rapport-${kundeNavn}.docx`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          } catch {
            /* silent */
          }
        }}
        className="w-full bg-blue-600 hover:bg-blue-500 text-white px-4 py-2.5 rounded-lg text-sm font-medium flex items-center justify-center gap-2"
      >
        <FileText size={15} />
        {da ? 'Download gap-rapport (Word)' : 'Download gap report (Word)'}
      </button>
    </section>
  );
}

// ─── Component ───────────────────────────────────────────────────

export default function ForsikringPageClient(): React.ReactElement {
  const { lang } = useLanguage();
  const t = translations[lang].forsikring;
  const setAICtx = useSetAIPageContext();
  const { isAdmin, addTokenUsage } = useSubscription();
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploadJobs, setUploadJobs] = useState<UploadJob[]>([]);
  /** BIZZ-1404: Tracked document IDs fra uploads i denne session */
  const [newDocumentIds, setNewDocumentIds] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [resetting, setResetting] = useState(false);
  /** BIZZ-1399: Aktiv sag-ID fra AnalyseSection — bruges til filtrering + upload */
  const [activeSagId, setActiveSagId] = useState<string | null>(null);
  /** BIZZ-1404: Valgt kunde fra AnalyseSection — lifted op for analyse-historik */
  const [selectedCustomer, setSelectedCustomer] = useState<{
    type: 'virksomhed' | 'person';
    id: string;
    navn: string;
  } | null>(null);
  /** BIZZ-1404: Aktiv analyse-ID for detaljevisning */
  const [activeAnalyseId, setActiveAnalyseId] = useState<string | null>(null);
  /** BIZZ-1404: Analyse-historik for valgt kunde */
  const [analyseHistorik, setAnalyseHistorik] = useState<
    Array<{
      id: string;
      created_at: string;
      total_aktiver: number;
      insured_count: number;
      total_risk_score: number;
      summary: { gaps_count?: number; policer_count?: number } | null;
    }>
  >([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** Fetch list data from API */
  const refresh = useCallback(async () => {
    setError(null);
    try {
      // BIZZ-1399: Filtrer per sag hvis aktiv
      const url = activeSagId
        ? `/api/forsikring?sag_id=${encodeURIComponent(activeSagId)}`
        : '/api/forsikring';
      const res = await fetch(url, { cache: 'no-store' });
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
  }, [activeSagId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** BIZZ-1404: Hent analyse-historik når kunde vælges */
  useEffect(() => {
    if (!selectedCustomer) {
      setAnalyseHistorik([]);
      return;
    }
    fetch(`/api/forsikring/analyser?kunde_id=${encodeURIComponent(selectedCustomer.id)}`)
      .then((r) => (r.ok ? r.json() : { analyser: [] }))
      .then((d) => setAnalyseHistorik(d.analyser ?? []))
      .catch(() => setAnalyseHistorik([]));
  }, [selectedCustomer]);

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
        // BIZZ-1399: Link upload til aktiv sag
        if (activeSagId) formData.append('sag_id', activeSagId);
        const upRes = await fetch('/api/forsikring/upload', {
          method: 'POST',
          body: formData,
        });
        if (!upRes.ok) {
          const body = (await upRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? t.uploadFailed);
        }
        const upJson = (await upRes.json()) as { document: { id: string } };
        // BIZZ-1404: Track nye document IDs for analyse-scoping
        setNewDocumentIds((prev) => [...prev, upJson.document.id]);

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
    [refresh, t, activeSagId]
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
    <div className="flex-1 overflow-y-auto p-6 pb-16 space-y-6 bg-[#0a1020] text-slate-100 h-full">
      {/* Heading + nulstil-knap */}
      <header className="flex items-start justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-3 text-2xl font-semibold">
            <ShieldCheck className="text-blue-400" size={28} />
            {t.title}
          </h1>
          <p className="text-sm text-slate-400">{t.subtitle}</p>
          {/* BIZZ-1447: Token-forbrug bar */}
          <TokenUsageBar className="mt-2 max-w-xs" />
        </div>
        {/* BIZZ-1397: Nulstil alt — kun synlig for admin */}
        {isAdmin && (policies.length > 0 || documents.length > 0) && (
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
        onSagChange={setActiveSagId}
        onCustomerSelect={setSelectedCustomer}
        newDocumentIds={newDocumentIds}
        addTokenUsage={addTokenUsage}
      />

      {/* BIZZ-1404: Analyse-historik for valgt kunde */}
      {selectedCustomer && analyseHistorik.length > 0 && !activeAnalyseId && (
        <section className="bg-white/5 border border-white/8 rounded-2xl p-4">
          <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
            <FileText size={16} className="text-blue-400" />
            {lang === 'da'
              ? `Tidligere analyser for ${selectedCustomer.navn}`
              : `Previous analyses for ${selectedCustomer.navn}`}
          </h3>
          <div className="space-y-2">
            {analyseHistorik.map((a) => {
              const gapCount = (a.summary as Record<string, number> | null)?.gaps_count ?? 0;
              const pct =
                a.total_aktiver > 0 ? Math.round((a.insured_count / a.total_aktiver) * 100) : 0;
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setActiveAnalyseId(a.id)}
                  className="w-full text-left px-4 py-3 bg-white/3 hover:bg-white/5 rounded-xl flex items-center justify-between transition-colors"
                >
                  <div>
                    <div className="text-white text-sm font-medium">
                      {new Date(a.created_at).toLocaleDateString('da-DK', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </div>
                    <div className="text-slate-400 text-xs mt-0.5">
                      {a.total_aktiver} {lang === 'da' ? 'ejendomme' : 'properties'} ·{' '}
                      {a.insured_count} {lang === 'da' ? 'forsikrede' : 'insured'} · {gapCount} gaps
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className={`text-lg font-bold ${
                        pct >= 71
                          ? 'text-emerald-400'
                          : pct >= 41
                            ? 'text-amber-400'
                            : 'text-red-400'
                      }`}
                    >
                      {pct}%
                    </span>
                    <ChevronRight size={16} className="text-slate-500" />
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* BIZZ-1440: Analyse-detalje visning når man klikker en historik-række */}
      {activeAnalyseId && selectedCustomer && (
        <AnalyseDetailSection
          analyseId={activeAnalyseId}
          kundeNavn={selectedCustomer.navn}
          lang={lang}
          onBack={() => setActiveAnalyseId(null)}
        />
      )}

      {/* BIZZ-1439: Global upload + police-tabel FJERNET — al data vises kun i analyse-kontekst */}
      {/* Legacy trin 2+3 skjult — erstattet af wizard-upload i AnalyseSection */}
      {false && selectedCustomer && (
        <>
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
          {!loading &&
            policies.length === 0 &&
            documents.length === 0 &&
            uploadJobs.length === 0 && (
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
        </>
      )}
    </div>
  );
}
