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
  Sparkles,
  ExternalLink,
  Plus,
  FilePlus,
  ScanSearch,
  BookOpen,
  Info,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { useSubscription } from '@/app/context/SubscriptionContext';
import { translations } from '@/app/lib/translations';
import TokenUsageBar from '@/app/components/TokenUsageBar';
import { gapScope, shouldFoldOwnerIntoCompany } from '@/app/lib/forsikring/types';
import { getMatchBegrundelse } from '@/app/lib/forsikring/matchBegrundelse';

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

/**
 * BIZZ-1973: En police hvis dækkede adresse ikke matcher nogen ejet/administreret
 * ejendom i forsikringssejerens portefølje.
 */
interface AddressMismatch {
  policy_id: string;
  document_id: string | null;
  policy_number: string;
  insurer_name: string;
  property_address: string | null;
  /** true når adressen er forsikringstagers egen adresse (typisk hovedkontor) */
  is_policyholder_address: boolean;
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
  /**
   * Rå koncernwalk-metadata. For ejendomme indeholder den
   * `ejer_cvr` så ejendommen kan grupperes under den virksomhed
   * der ejer den. For virksomheder indeholder den branche-info.
   */
  raw_data: Record<string, unknown> | null;
}

/** Gap fra analyse-detail API */
interface AnalyseGap {
  id: string;
  policy_id: string;
  check_id: string;
  severity: string;
  /** BIZZ-1833 Fase 6: gap-kategori — 'standard_betingelser' for baseline-gaps */
  category?: string | null;
  title: string;
  description: string;
  recommendation: string | null;
  /** BIZZ-1833 Fase 6: kildedata — standard_betingelser-gaps indeholder source_url + selskab */
  source_data?: Record<string, string> | null;
}

/** BIZZ-2084: Dækning fra analyse-detail API — bruges til grøn "Dækket"-visning */
interface AnalyseCoverage {
  policy_id: string;
  coverage_code: string;
  coverage_label: string;
  is_covered: boolean;
  sum_dkk: number | null;
  deductible_dkk: number | null;
}

/** Full analyse-detail response */
interface AnalyseDetail {
  analyse: {
    id: string;
    total_aktiver: number;
    insured_count: number;
    uninsured_count: number;
    total_risk_score: number;
    /**
     * BIZZ-1972: Kunde-type/-id for forsikringssejeren. For en virksomheds-
     * kunde er `kunde_id` selve forsikringssejerens CVR — bruges til at folde
     * forsikringsejer-niveau-findings ind under virksomheden når sejeren ER
     * den eneste virksomhed i porteføljen (samme entitet).
     */
    kunde_type?: string;
    kunde_id?: string;
  };
  aktiver: AnalyseAktiv[];
  gaps: AnalyseGap[];
  /** BIZZ-2084: Dækninger for matchede policer — grøn "Dækket"-visning */
  coverages?: AnalyseCoverage[];
}

/** Property grouped with its matched policy and relevant gaps */
interface PropertyGroup {
  aktiv: AnalyseAktiv;
  matchedPolicy: PolicyRow | null;
  gaps: AnalyseGap[];
  /** BIZZ-2084: Aktive dækninger (is_covered=true) på den matchede police */
  coverages: AnalyseCoverage[];
}

// ─── BIZZ-1389: Samlet ejendomsvisning ──────────────────────────

/**
 * BIZZ-1941: Dedup en liste af gaps på check_id (fallback titel).
 * Identiske findings vises kun én gang.
 *
 * @param list - Rå gaps
 * @returns Gaps uden duplikater på check_id
 */
function dedupGaps(list: AnalyseGap[]): AnalyseGap[] {
  const seen = new Set<string>();
  return list.filter((g) => {
    const key = g.check_id ?? g.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * BIZZ-1941: Genbrugelig liste af gap-kort. Bruges af både forsikringsejer-/
 * virksomheds-sektionerne og de enkelte ejendomsrækker, så markup er ens.
 *
 * @param props.gaps - Gaps der skal vises
 * @param props.da - Dansk sprogflag
 */
function GapList({ gaps, da }: { gaps: AnalyseGap[]; da: boolean }) {
  return (
    <div className="space-y-1.5">
      {gaps.map((g) => (
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
            <p className="text-slate-400 ml-4 mt-0.5 italic">{g.recommendation}</p>
          )}
          {/* BIZZ-1833 Fase 6: vis baseline-kilde for standard_betingelser-gaps */}
          {g.category === 'standard_betingelser' && g.source_data?.source_url && (
            <a
              href={g.source_data.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-teal-400 hover:text-teal-300 text-[10px] ml-4 mt-0.5 flex items-center gap-1 underline-offset-2 hover:underline"
              aria-label={`Åbn standard betingelse: ${g.source_data.source_url}`}
            >
              <ExternalLink size={9} />
              {da ? 'Se standard betingelse' : 'View standard terms'}
            </a>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Expandable property row — viser aktiv med matchet police + gaps.
 *
 * @param props.group - Property group med aktiv, police og gaps
 * @param props.da - Dansk sprogflag
 * @param props.foldedNote - BIZZ-1972: når true folder denne virksomheds-række
 *   forsikringsejer-/virksomheds-niveau-findings ind (sejeren ER den eneste
 *   virksomhed). Viser et samlet findings-badge + en info-label i collapse.
 */
function PropertyRow({
  group,
  da,
  foldedNote = false,
}: {
  group: PropertyGroup;
  da: boolean;
  foldedNote?: boolean;
}) {
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
          {/* BIZZ-2068: BFE-badge på ejendoms-aktiver — to reelle ejendomme kan
              dele adresse (fx Gefionsvej 47A = BFE 5322356 + 5322350), og uden
              BFE-nummeret ligner rækkerne duplikater. */}
          {group.aktiv.type === 'ejendom' && group.aktiv.bfe != null && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-slate-500/20 text-slate-300 border border-slate-500/30 shrink-0">
              BFE {group.aktiv.bfe}
            </span>
          )}
          {/* BIZZ-1829: AI-foreslået badge */}
          {!!(group.aktiv.raw_data as Record<string, unknown> | null)?.aiForeslaaet && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30 shrink-0">
              AI
            </span>
          )}
        </div>

        {/* Police-info hvis matchet */}
        {group.matchedPolicy && (
          <span className="text-slate-400 text-xs shrink-0 hidden sm:block">
            {group.matchedPolicy.insurer_name} — {group.matchedPolicy.policy_number}
          </span>
        )}

        {/* Gap badges */}
        {foldedNote
          ? // BIZZ-1972: Foldet virksomheds-række viser ÉT samlet findings-badge
            // (alle severities) — så forsikringsejer-niveau-findings tælles med,
            // også rene info-findings der ellers ikke vises som rød/gul pille.
            group.gaps.length > 0 && (
              <span
                className="px-1.5 py-0.5 rounded text-[10px] bg-slate-500/25 text-slate-200 shrink-0"
                title={
                  da
                    ? 'Samlet antal findings (inkl. forsikringsejer-niveau)'
                    : 'Total findings (incl. insurance owner level)'
                }
              >
                {group.gaps.length} {da ? 'findings' : 'findings'}
              </span>
            )
          : (gapCritical > 0 || gapWarning > 0 || group.coverages.length > 0) && (
              <div className="flex items-center gap-1 shrink-0">
                {/* BIZZ-2084: Grøn pille = antal aktive dækninger på matchet police */}
                {group.coverages.length > 0 && (
                  <span
                    className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/20 text-emerald-300"
                    title={da ? 'Aktive dækninger' : 'Active coverages'}
                  >
                    {group.coverages.length}
                  </span>
                )}
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
          <ChevronDown size={14} className="text-slate-400 shrink-0" />
        ) : (
          <ChevronRight size={14} className="text-slate-400 shrink-0" />
        )}
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-white/5 px-4 py-3 space-y-2">
          {/* Police metadata */}
          {group.matchedPolicy && (
            <div className="text-xs text-slate-400 space-y-0.5">
              <div>
                <span className="text-slate-400">{da ? 'Police:' : 'Policy:'}</span>{' '}
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
                  <span className="text-slate-400">{da ? 'Præmie:' : 'Premium:'}</span>{' '}
                  {group.matchedPolicy.annual_premium_dkk.toLocaleString('da-DK')} kr
                </div>
              )}
              {group.matchedPolicy.effective_to && (
                <div>
                  <span className="text-slate-400">{da ? 'Udløber:' : 'Expires:'}</span>{' '}
                  {new Date(group.matchedPolicy.effective_to).toLocaleDateString('da-DK', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                </div>
              )}
            </div>
          )}

          {/* BIZZ-2080: Match-begrundelse — vis HVORFOR policen blev koblet til
              aktivet, så brugeren kan vurdere om konklusionen er rigtig.
              Baseret på matched_policy_id (ikke matchedPolicy-objektet), da
              policen kan være matchet i analysen uden at indgå i den aktuelt
              indlæste police-liste. */}
          {group.aktiv.matched_policy_id && group.aktiv.match_score != null && (
            <div className="text-xs">
              <span className="text-slate-400">{da ? 'Match:' : 'Match:'}</span>{' '}
              <span className="text-slate-300">
                {getMatchBegrundelse(group.aktiv.type, group.aktiv.match_score, da)}
              </span>{' '}
              <span className="text-slate-400">({group.aktiv.match_score}/100)</span>
              {!group.matchedPolicy && (
                <span className="text-slate-400">
                  {' '}
                  —{' '}
                  {da
                    ? 'matchet police indgår ikke i den viste police-liste'
                    : 'matched policy is not in the displayed policy list'}
                </span>
              )}
            </div>
          )}

          {/* BIZZ-2080: Eksplicit forklaring når INGEN police er matchet */}
          {!group.aktiv.matched_policy_id && (
            <div className="text-xs text-slate-400">
              {da
                ? 'Ingen police matchet — aktivet fremgår ikke af de parsede policers BFE-numre, adresser eller CVR/forsikringstager.'
                : 'No policy matched — the asset does not appear in the parsed policies (BFE, address or CVR/policyholder).'}
            </div>
          )}

          {/* BIZZ-2084: Grøn "Dækket"-sektion — vis hvad der ER dækket inkl.
              dækningssum + selvrisiko, så dækningsniveauet kan reviewes med kunden */}
          {group.coverages.length > 0 && (
            <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2">
              <div className="flex items-center gap-1.5 mb-1">
                <CheckCircle2 size={12} className="text-emerald-400 shrink-0" />
                <span className="text-emerald-300 text-xs font-medium">
                  {da ? 'Dækket' : 'Covered'} ({group.coverages.length})
                </span>
              </div>
              <div className="space-y-0.5">
                {group.coverages.map((cov) => (
                  <div
                    key={`${cov.policy_id}-${cov.coverage_code}`}
                    className="flex items-baseline justify-between gap-2 text-xs"
                  >
                    <span className="text-emerald-200">✓ {cov.coverage_label}</span>
                    <span className="text-slate-300 shrink-0">
                      {cov.sum_dkk != null
                        ? `${cov.sum_dkk.toLocaleString('da-DK')} kr`
                        : da
                          ? 'sum ikke angivet'
                          : 'sum not stated'}
                      {cov.deductible_dkk != null && (
                        <span className="text-slate-400">
                          {' '}
                          · {da ? 'selvrisiko' : 'deductible'}{' '}
                          {cov.deductible_dkk.toLocaleString('da-DK')} kr
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* BIZZ-1972: Info-label når forsikringsejer-niveau er foldet ind */}
          {foldedNote && group.gaps.length > 0 && (
            <div className="flex items-start gap-1.5 text-[11px] text-slate-400 bg-white/3 border border-white/8 rounded-lg px-2.5 py-1.5">
              <Briefcase size={12} className="text-purple-400 shrink-0 mt-0.5" />
              <span>
                {da
                  ? 'Inkluderer findings på forsikringsejer-niveau (samme entitet som virksomheden).'
                  : 'Includes insurance-owner-level findings (same entity as the company).'}
              </span>
            </div>
          )}

          {/* Gaps for this property */}
          {group.gaps.length > 0 ? (
            <div className="mt-2">
              <GapList gaps={group.gaps} da={da} />
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

  // BIZZ-2084: Aktive dækninger grupperet per police — til grøn "Dækket"-visning
  const coveragesByPolicy = new Map<string, AnalyseCoverage[]>();
  for (const cov of detail.coverages ?? []) {
    if (!cov.is_covered) continue;
    const list = coveragesByPolicy.get(cov.policy_id) ?? [];
    list.push(cov);
    coveragesByPolicy.set(cov.policy_id, list);
  }

  // Group aktiver into PropertyGroups with their gaps — dedup by address
  const seenAddresses = new Set<string>();
  const allGroups: PropertyGroup[] = [];
  for (const aktiv of aktiver) {
    // BIZZ-1439: Dedup — skip duplikerede adresser (ejerskab kan have flere rækker per BFE)
    // Dedup via BFE (unikt per ejendom) — IKKE adresse (ejerlejligheder har samme adresse men forskellig etage/dør)
    const addrKey = aktiv.bfe
      ? String(aktiv.bfe)
      : aktiv.type === 'virksomhed' && aktiv.cvr
        ? `cvr:${aktiv.cvr}`
        : aktiv.id;
    if (seenAddresses.has(addrKey)) continue;
    seenAddresses.add(addrKey);

    // BIZZ-1792: Dedup gaps per check_id — identiske gaps vises kun 1 gang.
    // BIZZ-1941: Ejendomsrækker viser KUN ejendomsspecifikke gaps (scope='property').
    // Forsikringsejer-/virksomheds-gaps løftes op i dedikerede sektioner (se nedenfor),
    // så de ikke gentages under hver ejendom.
    // BIZZ-1957: Bygnings-/ejendomsspecifikke gaps (scope='property', fx 'Udvidet
    // vandskade') hører KUN til under ejendoms-rækker. Samme police kan være matchet
    // til BÅDE virksomheds-aktivet og selve ejendommen; uden type-guarden lækkede
    // bygnings-gaps op på virksomheds-niveau. Virksomheds-/ejer-scopede gaps vises
    // alene i de dedikerede company-/owner-sektioner.
    const rawGaps =
      aktiv.matched_policy_id && aktiv.type === 'ejendom'
        ? gaps.filter(
            (g) => g.policy_id === aktiv.matched_policy_id && gapScope(g.check_id) === 'property'
          )
        : [];
    const aktivGaps = dedupGaps(rawGaps);
    allGroups.push({
      aktiv,
      matchedPolicy: aktiv.matched_policy_id
        ? (policyById.get(aktiv.matched_policy_id) ?? null)
        : null,
      gaps: aktivGaps,
      coverages: aktiv.matched_policy_id
        ? (coveragesByPolicy.get(aktiv.matched_policy_id) ?? [])
        : [],
    });
  }

  // BIZZ-1941: Løft forsikringsejer- og virksomheds-niveau findings ud i dedikerede
  // sektioner — deduppet på check_id på tværs af hele porteføljen, så de vises præcis
  // én gang i stedet for gentaget under hver ejendom/police.
  const ownerGaps = dedupGaps(gaps.filter((g) => gapScope(g.check_id) === 'owner'));
  const companyGaps = dedupGaps(gaps.filter((g) => gapScope(g.check_id) === 'company'));

  // Split into companies and properties for tree-grouping
  const virksomhedGroups = allGroups.filter((g) => g.aktiv.type === 'virksomhed');
  const ejendomGroups = allGroups.filter((g) => g.aktiv.type === 'ejendom');
  const otherGroups = allGroups.filter(
    (g) => g.aktiv.type !== 'virksomhed' && g.aktiv.type !== 'ejendom'
  );

  // BIZZ-1972: Når forsikringssejeren ER den eneste virksomhed i porteføljen
  // (samme entitet), giver en separat "Forsikringsejer-niveau"-sektion ingen
  // mening — den dublerer reelt virksomheden. Vi folder så forsikringsejer- og
  // virksomheds-findings ind under selve virksomheds-rækken. For holding-cases
  // med 2+ virksomheder under én sejer bevares de separate sektioner.
  const foldOwnerIntoCompany = shouldFoldOwnerIntoCompany(
    detail.analyse.kunde_type,
    detail.analyse.kunde_id,
    virksomhedGroups.map((v) => v.aktiv.cvr)
  );

  /**
   * Build company-tree: hver virksomhed med sine ejendomme grupperet under.
   * En ejendom matches til en virksomhed via `raw_data.ejer_cvr`.
   * Ejendomme uden matchende virksomhed havner i en "andre"-bucket.
   */
  const ejendommeByCvr = new Map<string, PropertyGroup[]>();
  const orphanEjendomme: PropertyGroup[] = [];
  for (const eg of ejendomGroups) {
    const ejerCvr = (eg.aktiv.raw_data as { ejer_cvr?: string } | null)?.ejer_cvr;
    if (ejerCvr && virksomhedGroups.some((v) => v.aktiv.cvr === ejerCvr)) {
      const list = ejendommeByCvr.get(ejerCvr) ?? [];
      list.push(eg);
      ejendommeByCvr.set(ejerCvr, list);
    } else {
      orphanEjendomme.push(eg);
    }
  }

  /**
   * Parse address string into sortable parts: postnr (numeric), vejnavn, husnr (numeric + suffix).
   *
   * @param addr - e.g. "Fenrisvej 23, 3000 Helsingør"
   * @returns Sortable tuple [postnr, vejnavn, husnrNum, husnrSuffix]
   */
  function parseAddrSort(addr: string | null): [number, string, number, string] {
    if (!addr) return [99999, '', 0, ''];
    // Extract postnr: look for 4-digit number after comma
    const postnrMatch = addr.match(/,\s*(\d{4})\s/);
    const postnr = postnrMatch ? parseInt(postnrMatch[1], 10) : 99999;
    // Extract vejnavn + husnr before the comma
    const beforeComma = addr.split(',')[0]?.trim() ?? '';
    const husnrMatch = beforeComma.match(/^(.+?)\s+(\d+)(\S*)$/);
    const vejnavn = husnrMatch ? husnrMatch[1] : beforeComma;
    const husnrNum = husnrMatch ? parseInt(husnrMatch[2], 10) : 0;
    const husnrSuffix = husnrMatch ? (husnrMatch[3] ?? '') : '';
    return [postnr, vejnavn.toLowerCase(), husnrNum, husnrSuffix.toLowerCase()];
  }

  /** Sort properties: postnr ASC → vejnavn ASC → husnr ASC. Uforsikrede først inden for gruppen. */
  function sortProperties(list: PropertyGroup[]): PropertyGroup[] {
    return [...list].sort((a, b) => {
      const [aPostnr, aVej, aHusnr, aSuf] = parseAddrSort(a.aktiv.adresse);
      const [bPostnr, bVej, bHusnr, bSuf] = parseAddrSort(b.aktiv.adresse);
      // Primary: postnr ascending
      if (aPostnr !== bPostnr) return aPostnr - bPostnr;
      // Secondary: vejnavn alphabetical (Danish locale)
      const vejCmp = aVej.localeCompare(bVej, 'da');
      if (vejCmp !== 0) return vejCmp;
      // Tertiary: husnr numeric
      if (aHusnr !== bHusnr) return aHusnr - bHusnr;
      // Quaternary: husnr suffix (A, B, C...)
      if (aSuf !== bSuf) return aSuf.localeCompare(bSuf, 'da');
      // Tiebreaker: uforsikrede først
      const aIns = a.aktiv.matched_policy_id ? 1 : 0;
      const bIns = b.aktiv.matched_policy_id ? 1 : 0;
      return aIns - bIns;
    });
  }

  /** Tree-node: en virksomhed + dens ejendomme */
  interface VirksomhedsTree {
    virksomhed: PropertyGroup;
    ejendomme: PropertyGroup[];
  }

  // Sortér virksomheder: hovedvirksomheden (flest egne ejendomme) først
  const virksomhedsTraeer: VirksomhedsTree[] = virksomhedGroups
    .map((v) => ({
      // BIZZ-1972: I fold-casen får den eneste virksomhed forsikringsejer- og
      // virksomheds-findings injiceret i sin egen række (så badge + collapse
      // afspejler totalen) — i stedet for at vise dem i separate sektioner.
      virksomhed: foldOwnerIntoCompany ? { ...v, gaps: [...ownerGaps, ...companyGaps] } : v,
      ejendomme: sortProperties(ejendommeByCvr.get(v.aktiv.cvr ?? '') ?? []),
    }))
    .sort((a, b) => b.ejendomme.length - a.ejendomme.length);

  // Compute health score: 0-100 (higher = better)
  // BIZZ-1440: Brug dedupede groups i stedet for rå analyse-tal
  // KPI'er regnes på EJENDOMME (ikke virksomheder) for at matche "X af 17 forsikrede"
  const total = ejendomGroups.length;
  const insured = ejendomGroups.filter((g) => g.aktiv.matched_policy_id !== null).length;
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
        <div className="grid grid-cols-5 gap-2">
          <div className="text-center">
            <div className="text-purple-300 text-xl font-bold">{virksomhedGroups.length}</div>
            <div className="text-slate-400 text-[10px]">{da ? 'Virksomheder' : 'Companies'}</div>
          </div>
          <div className="text-center">
            <div className="text-blue-300 text-xl font-bold">{total}</div>
            <div className="text-slate-400 text-[10px]">{da ? 'Ejendomme' : 'Properties'}</div>
          </div>
          <div className="text-center">
            <div className="text-emerald-300 text-xl font-bold">{insured}</div>
            <div className="text-slate-400 text-[10px]">{da ? 'Forsikrede' : 'Insured'}</div>
          </div>
          <div className="text-center">
            <div className="text-red-300 text-xl font-bold">{total - insured}</div>
            <div className="text-slate-400 text-[10px]">{da ? 'Uforsikrede' : 'Uninsured'}</div>
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
            <div className="text-slate-400 text-[10px]">
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

      {/* BIZZ-1941: Forsikringsejer-niveau — generelle findings for hele ejeren.
          Vises kun her, ikke gentaget under virksomhed/ejendom.
          BIZZ-1972: Skjules når forsikringssejeren ER den eneste virksomhed —
          findings foldes da ind under virksomheds-rækken nedenfor. */}
      {!foldOwnerIntoCompany && ownerGaps.length > 0 && (
        <div className="bg-white/5 border border-white/8 rounded-xl p-4 space-y-2">
          <div className="flex items-center gap-2">
            <Briefcase size={14} className="text-purple-400" />
            <h4 className="text-white text-sm font-semibold">
              {da ? 'Forsikringsejer-niveau' : 'Insurance owner level'}
            </h4>
            <span className="text-slate-400 text-[11px]">
              {da
                ? `${ownerGaps.length} generelle findings`
                : `${ownerGaps.length} general findings`}
            </span>
          </div>
          <p className="text-slate-400 text-[11px]">
            {da
              ? 'Gælder hele forsikringsejeren — ikke en enkelt virksomhed eller ejendom.'
              : 'Applies to the entire insurance owner — not a single company or property.'}
          </p>
          <GapList gaps={ownerGaps} da={da} />
        </div>
      )}

      {/* BIZZ-1941: Virksomheds-niveau — gælder porteføljen/virksomheden, ikke per ejendom.
          BIZZ-1972: Skjules i fold-casen — findings foldes ind under virksomheds-rækken. */}
      {!foldOwnerIntoCompany && companyGaps.length > 0 && (
        <div className="bg-white/5 border border-white/8 rounded-xl p-4 space-y-2">
          <div className="flex items-center gap-2">
            <Building2 size={14} className="text-blue-400" />
            <h4 className="text-white text-sm font-semibold">
              {da ? 'Virksomheds-niveau' : 'Company level'}
            </h4>
            <span className="text-slate-400 text-[11px]">
              {da ? `${companyGaps.length} findings` : `${companyGaps.length} findings`}
            </span>
          </div>
          <p className="text-slate-400 text-[11px]">
            {da
              ? 'Dæknings-overlap, kollektiv forsikring og standard-betingelser — på tværs af policer.'
              : 'Coverage overlap, collective insurance and standard terms — across policies.'}
          </p>
          <GapList gaps={companyGaps} da={da} />
        </div>
      )}

      {/* Niveau 2: Virksomheds-træer med ejendomme grupperet under */}
      <div className="space-y-4">
        {virksomhedsTraeer.map((tree) => (
          <div key={tree.virksomhed.aktiv.id} className="space-y-2">
            {/* Virksomheds-række (header) */}
            <PropertyRow group={tree.virksomhed} da={da} foldedNote={foldOwnerIntoCompany} />

            {/* Ejendomme under denne virksomhed — indrykket */}
            {tree.ejendomme.length > 0 && (
              <div className="ml-6 pl-3 border-l border-white/8 space-y-2">
                <div className="text-slate-400 text-[11px] uppercase tracking-wide py-1">
                  {da
                    ? `${tree.ejendomme.length} ${tree.ejendomme.length === 1 ? 'ejendom' : 'ejendomme'} ejet af ${tree.virksomhed.aktiv.label}`
                    : `${tree.ejendomme.length} ${tree.ejendomme.length === 1 ? 'property' : 'properties'} owned by ${tree.virksomhed.aktiv.label}`}
                </div>
                {tree.ejendomme.map((eg) => (
                  <PropertyRow key={eg.aktiv.id} group={eg} da={da} />
                ))}
              </div>
            )}
          </div>
        ))}

        {/* Ejendomme uden ejer-virksomhed (orphans) — personligt ejede eller manglende kæde */}
        {orphanEjendomme.length > 0 && (
          <div className="space-y-2">
            <div className="text-slate-400 text-[11px] uppercase tracking-wide py-1">
              {da
                ? `${orphanEjendomme.length} ${orphanEjendomme.length === 1 ? 'ejendom' : 'ejendomme'} uden virksomheds-tilknytning`
                : `${orphanEjendomme.length} ${orphanEjendomme.length === 1 ? 'property' : 'properties'} without company link`}
            </div>
            {sortProperties(orphanEjendomme).map((eg) => (
              <PropertyRow key={eg.aktiv.id} group={eg} da={da} />
            ))}
          </div>
        )}

        {/* Øvrige aktiver (bestyrelsesposter, biler) */}
        {otherGroups.length > 0 && (
          <div className="space-y-2">
            <div className="text-slate-400 text-[11px] uppercase tracking-wide py-1">
              {da ? 'Øvrige aktiver' : 'Other assets'}
            </div>
            {otherGroups.map((eg) => (
              <PropertyRow key={eg.aktiv.id} group={eg} da={da} />
            ))}
          </div>
        )}
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
      status: 'uploading' | 'parsing' | 'done' | 'failed' | 'skipped_duplicate';
      docId?: string;
    }>
  >([]);
  const [analyseResult, setAnalyseResult] = useState<{
    analyse_id: string;
    total_aktiver: number;
    insured_count: number;
    gaps_count: number;
    total_risk_score: number;
    /** BIZZ-1973: Policer der dækker en adresse uden for porteføljen */
    address_mismatches?: AddressMismatch[];
    /** BIZZ-2067: Sikrede-/korrespondance-adresser uden for porteføljen (info) */
    sikrede_adresser_uden_for_portefoelje?: Array<{
      adresse: string;
      dokument_navn: string | null;
      policy_number: string | null;
    }>;
    /** Advarsel når standard betingelser ikke matcher policens selskab */
    std_betingelser_advarsel?: string | null;
  } | null>(null);
  /**
   * BIZZ-1973: Preflight-advarsel — sættes når adresse-tjek finder policer der
   * dækker en ejendom uden for kundens portefølje. Vises som modal med 3 valg.
   */
  const [mismatchWarning, setMismatchWarning] = useState<AddressMismatch[] | null>(null);
  /** BIZZ-1973: Dokument-IDs med adresse-mismatch — bruges til ⚠-badge i doc-listen */
  const [mismatchDocIds, setMismatchDocIds] = useState<Set<string>>(new Set());
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
  /** BIZZ-1833: Standard forsikringsbetingelser — AI-fundne + manuelt tilføjede */
  const [stdDiscovering, setStdDiscovering] = useState(false);
  const [stdDiscovered, setStdDiscovered] = useState<
    Array<{ titel: string; source_url: string; kategori: string; confidence: string }>
  >([]);
  const [stdSelectedIds, setStdSelectedIds] = useState<Set<string>>(new Set());
  /** Kort (source_url → DB id) efter POST /api/forsikring/standard-docs */
  const [stdSavedIds, setStdSavedIds] = useState<Map<string, string>>(new Map());
  const [stdManualUrl, setStdManualUrl] = useState('');
  const [stdManualTitel, setStdManualTitel] = useState('');
  const [stdAddingManual, setStdAddingManual] = useState(false);
  const stdSelskabRef = useRef<HTMLInputElement>(null);
  /** BIZZ-1890: PDF-upload af standard betingelser */
  const [stdPdfUploading, setStdPdfUploading] = useState(false);
  /** BIZZ-1932: Upload-progress (filnavn + status) */
  const [stdUploadProgress, setStdUploadProgress] = useState<string | null>(null);
  /** BIZZ-1932: Senest uploaded standard betingelse (til bekræftelse) */
  const [stdUploadDone, setStdUploadDone] = useState<string | null>(null);
  const stdPdfRef = useRef<HTMLInputElement>(null);
  /** BIZZ-1890: AI auto-detektion fra police-dokumenter */
  const [stdDetecting, setStdDetecting] = useState(false);
  /** BIZZ-1919: Tidligere gemte standard betingelser (delt i domain) */
  const [stdSavedLibrary, setStdSavedLibrary] = useState<
    Array<{
      id: string;
      titel: string;
      source_url: string;
      selskab: string;
      kategori: string;
      added_via: string;
      added_by_user: string | null;
      is_valid_standard?: boolean;
      omraade?: string | null;
      gyldig_fra?: string | null;
    }>
  >([]);
  /** BIZZ-2078: Std betingelser tidligere brugt i analyser for den valgte kunde
   *  — inline-listen viser KUN disse (blank for ny kunde uden analyser);
   *  hele biblioteket er fortsat tilgængeligt via Bibliotek-modalen. */
  const [stdKundeUsed, setStdKundeUsed] = useState<
    Array<{
      id: string;
      titel: string;
      source_url: string;
      selskab: string;
      kategori: string;
      added_via: string;
      added_by_user: string | null;
      is_valid_standard?: boolean;
      omraade?: string | null;
      gyldig_fra?: string | null;
    }>
  >([]);
  /** BIZZ-1921: Bibliotek-modal åben/lukket */
  const [stdLibraryOpen, setStdLibraryOpen] = useState(false);
  /** BIZZ-1921: Filter i bibliotek */
  const [stdLibraryFilter, setStdLibraryFilter] = useState('');
  const [stdLibrarySelskabFilter, setStdLibrarySelskabFilter] = useState('');
  const [stdLibraryKategoriFilter, setStdLibraryKategoriFilter] = useState('');

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // BIZZ-1919: Hent eksisterende delte standard betingelser ved page-load
  useEffect(() => {
    fetch('/api/forsikring/standard-docs')
      .then((r) => (r.ok ? r.json() : []))
      .then(
        (
          data: Array<{
            id: string;
            titel: string;
            source_url: string;
            selskab: string;
            kategori: string;
            added_via: string;
            added_by_user: string | null;
            is_valid_standard?: boolean;
            omraade?: string | null;
            gyldig_fra?: string | null;
          }>
        ) => {
          setStdSavedLibrary(data);
        }
      )
      .catch(() => {
        /* non-fatal */
      });
  }, []);

  // BIZZ-2078: Ved kundeskift nulstilles std-valg, og inline-listen genindlæses
  // med kun de betingelser der tidligere er brugt i analyser for denne kunde.
  // En ny kunde uden analyser får en blank sektion — betingelser tilvælges via
  // Bibliotek-knappen i stedet for at hele domain-biblioteket vises som default.
  useEffect(() => {
    setStdKundeUsed([]);
    setStdSelectedIds(new Set());
    setStdDiscovered([]);
    if (!selected) return;
    fetch(`/api/forsikring/standard-docs?kunde_id=${encodeURIComponent(selected.id)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setStdKundeUsed(Array.isArray(data) ? data : []))
      .catch(() => {
        /* non-fatal — sektionen forbliver blank */
      });
  }, [selected]);
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
    // BIZZ-1631: Nulstil state STRAKS ved kundeskift — forhindrer at forrige
    // kundes docs/analyser vises mens ny data hentes.
    setPreviousDocs([]);
    setSelectedDocIds(new Set());
    if (!showDocPicker || !selected) {
      return;
    }
    fetch(`/api/forsikring/documents/for-customer?kunde_id=${encodeURIComponent(selected.id)}`)
      .then((r) => (r.ok ? r.json() : { documents: [] }))
      .then((d) => {
        const docs = d.documents ?? [];
        setPreviousDocs(docs);
        // BIZZ-1442: Auto-check alle tidligere docs som default
        setSelectedDocIds(new Set(docs.map((doc: { id: string }) => doc.id)));
      })
      .catch(() => setPreviousDocs([]));
  }, [showDocPicker, selected]);

  /** BIZZ-1439: Upload filer inde i wizard — tracker doc IDs */
  const onWizardUpload = useCallback(
    async (files: FileList) => {
      // Duplikat-detektion: byg map fra filnavn → existing doc_id baseret på
      // previousDocs (kundens tidligere uploadede dokumenter). Vi normaliserer
      // til lowercase + trim så små variationer i filnavn ikke spoiler match.
      const existingByName = new Map<string, string>();
      for (const doc of previousDocs) {
        existingByName.set(doc.original_name.toLowerCase().trim(), doc.id);
      }

      // BIZZ-1439: Parallel upload+parse — alle filer starter samtidigt
      const fileArray = Array.from(files);
      const jobs = fileArray.map((file) => {
        const jobId = `wiz-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const existingDocId = existingByName.get(file.name.toLowerCase().trim());

        if (existingDocId) {
          // Duplikat fundet — auto-vælg den eksisterende og spring upload over.
          // Sparer Claude-tokens + undgår duplikate policer i analysen.
          setWizardUploads((prev) => [
            ...prev,
            {
              id: jobId,
              fileName: file.name,
              status: 'skipped_duplicate',
              docId: existingDocId,
            },
          ]);
          setSelectedDocIds((prev) => new Set([...prev, existingDocId]));
          return { jobId, file, skipped: true };
        }

        setWizardUploads((prev) => [
          ...prev,
          { id: jobId, fileName: file.name, status: 'uploading' },
        ]);
        return { jobId, file, skipped: false };
      });

      await Promise.allSettled(
        jobs
          .filter((j) => !j.skipped)
          .map(async ({ jobId, file }) => {
            // BIZZ-2076: docId løftes ud af try, så et parse-fejlet dokument
            // (upload OK, parse fejlet) stadig tæller med i "Slet alle"-antallet
            // — dokumentet eksisterer i DB og slettes af bulk-delete.
            let docId: string | undefined;
            try {
              const formData = new FormData();
              formData.append('file', file);
              // BIZZ-1632: Link dokument til valgt kunde
              if (selected?.id) formData.append('kunde_id', selected.id);
              const upRes = await fetch('/api/forsikring/upload', {
                method: 'POST',
                body: formData,
              });
              if (!upRes.ok) throw new Error('Upload failed');
              const upJson = (await upRes.json()) as { document: { id: string } };
              const uploadedId = upJson.document.id;
              docId = uploadedId;

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
                prev.map((j) => (j.id === jobId ? { ...j, status: 'done', docId: uploadedId } : j))
              );
              // BIZZ-1442: Auto-check nye uploads
              setSelectedDocIds((prev) => new Set([...prev, uploadedId]));
            } catch {
              setWizardUploads((prev) =>
                prev.map((j) => (j.id === jobId ? { ...j, status: 'failed', docId } : j))
              );
            }
          })
      );
      onRefresh();
    },
    [onRefresh, previousDocs]
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

  // BIZZ-1890: Kriterium 3 — auto-udfyld forsikringsselskab-feltet ud fra
  // matchede policer, så AI kan finde relevante standard-betingelser automatisk.
  // Sættes når kunden vælges og har policer med et forsikringsselskabsnavn.
  useEffect(() => {
    if (!stdSelskabRef.current) return;
    const insurers = [...new Set(kundePolicer.map((p) => p.insurer_name).filter(Boolean))];
    if (insurers.length > 0 && !stdSelskabRef.current.value) {
      stdSelskabRef.current.value = insurers[0];
    }
  }, [kundePolicer]);

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

  /**
   * Start gap-analyse + opret/find sag.
   *
   * BIZZ-1973: Kører først et adresse-preflight. Hvis en uploadet police dækker
   * en ejendom uden for kundens portefølje, vises en advarsels-modal og analysen
   * pauses indtil brugeren tager stilling. `opts.skipPreflight` springer tjekket
   * over (sættes når brugeren har valgt "Ja, fortsæt" i modalen).
   *
   * @param opts - { skipPreflight } for at omgå preflight efter brugerbekræftelse
   */
  const startAnalyse = useCallback(
    async (opts?: { skipPreflight?: boolean }) => {
      if (!selected || running) return;

      // BIZZ-2019: Pre-flight subscription check before AI analysis
      try {
        const subRes = await fetch('/api/subscription');
        if (subRes.ok) {
          const subData = await subRes.json();
          if (!subData.isFunctional && !subData.isAdmin) return;
        }
      } catch {
        /* non-fatal */
      }

      setRunning(true);
      setAnalyseResult(null);
      try {
        // BIZZ-1440: Samle ALLE doc IDs (genbrugte + wizard-uploads + parent-uploads).
        // Dedup via Set så samme doc_id ikke sendes to gange — duplikat-detektion
        // i wizard-upload (skipped_duplicate) auto-tilføjer existing doc_id til
        // selectedDocIds, hvilket kan overlappe med wizardDocIds for almindelige
        // uploads. Junction-tabellen forsikring_analyse_documents har unique
        // constraint, så duplikerede inserts ville fejle.
        const reusedDocIds = [...selectedDocIds];
        const wizardDocIds = wizardUploads
          .filter((u) => u.status === 'done' && u.docId)
          .map((u) => u.docId!);
        const allDocIds = Array.from(
          new Set<string>([...reusedDocIds, ...wizardDocIds, ...newDocumentIds])
        );
        // BIZZ-2065: Send ALTID document_ids — også som tom liste. En tom
        // liste betyder "brugeren har fravalgt alle dokumenter" og skal give
        // 0 policer i analysen. Udelades feltet, falder backend tilbage til
        // alle policer fra tidligere analyser (BIZZ-1776), hvilket fejlagtigt
        // viste dækning selvom 0/3 dokumenter var valgt.
        // BIZZ-1833: Saml standard doc DB-IDs for valgte standard-betingelser
        const stdDocIds = [...stdSelectedIds]
          .map((url) => stdSavedIds.get(url))
          .filter((id): id is string => !!id);

        // BIZZ-1973: Preflight — advar hvis en police dækker en adresse uden for
        // porteføljen. Best-effort: ved fejl fortsætter vi til den rigtige analyse.
        if (!opts?.skipPreflight) {
          try {
            const pf = await fetch('/api/forsikring/analyser', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                kunde_type: selected.type,
                kunde_id: selected.id,
                kunde_navn: selected.navn,
                ...(asOfDate ? { as_of_date: asOfDate } : {}),
                document_ids: allDocIds,
                preflight: true,
              }),
            });
            if (pf.ok) {
              const pfData = (await pf.json()) as { mismatches?: AddressMismatch[] };
              const mismatches = pfData.mismatches ?? [];
              if (mismatches.length > 0) {
                setMismatchWarning(mismatches);
                setMismatchDocIds(
                  new Set(mismatches.map((m) => m.document_id).filter((id): id is string => !!id))
                );
                setRunning(false);
                return; // vent på brugerens valg i modalen
              }
            }
          } catch {
            // Preflight er best-effort — fortsæt til den rigtige analyse
          }
        }

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

        const res = await fetch('/api/forsikring/analyser', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kunde_type: selected.type,
            kunde_id: selected.id,
            kunde_navn: selected.navn,
            ...(asOfDate ? { as_of_date: asOfDate } : {}),
            // BIZZ-1443: Send alle valgte doc IDs samlet — reused + nye, dedupet
            // BIZZ-2065: Send altid (også tom) — tom liste = bevidst fravalg
            document_ids: allDocIds,
            // BIZZ-1833: Standard betingelser
            ...(stdDocIds.length > 0 ? { standard_doc_ids: stdDocIds } : {}),
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
    },
    [
      selected,
      running,
      asOfDate,
      onAnalyseDetail,
      onSagChange,
      newDocumentIds,
      selectedDocIds,
      wizardUploads,
      stdSelectedIds,
      stdSavedIds,
    ]
  );

  return (
    <section className="bg-white/5 border border-white/8 rounded-2xl p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-white font-semibold text-sm flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold">
            1
          </span>
          {da ? 'Vælg forsikringsejer' : 'Select policyholder'}
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
              setMismatchWarning(null);
              setMismatchDocIds(new Set());
              onCustomerSelect(null);
            }}
            className="text-slate-400 hover:text-white text-xs px-2 py-1 rounded hover:bg-white/5 transition-colors"
          >
            {da ? '← Ny forsikringsejer' : '← New insurance owner'}
          </button>
        )}
      </div>
      <p className="text-slate-400 text-xs">
        {da
          ? 'Vælg den virksomhed eller person du vil analysere forsikringsdækning for (forsikringsejer).'
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
                  // BIZZ-1791: Auto-vis doc picker ved kundevalg
                  setShowDocPicker(true);
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
              className="text-slate-400 hover:text-slate-300 text-[10px]"
              aria-label={da ? 'Ryd dato' : 'Clear date'}
            >
              {da ? 'ryd' : 'clear'}
            </button>
          )}
          {!asOfDate && (
            <span className="text-slate-400">
              {da ? '(tom = aktuel dato)' : '(empty = current date)'}
            </span>
          )}
        </div>
      )}

      {/* BIZZ-1394: Eksisterende policer + forrige analyse for valgt kunde */}
      {selected && !analyseResult && (kundePolicer.length > 0 || lastAnalyse) && (
        <div className="space-y-2">
          {/* BIZZ-1485: Eksisterende policer boks fjernet — unødvendig visning */}

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
              className="text-slate-400 hover:text-white text-xs"
            >
              {da ? 'Luk' : 'Close'}
            </button>
          </div>

          {/* BIZZ-1833: 2-kolonne grid — dokumenter (venstre) + standard betingelser (højre) */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="space-y-3">
              {/* BIZZ-1632: Slet alle dokumenter for denne kunde.
                  BIZZ-2076: Tæl unikke docs fra previousDocs + nye wizard-uploads
                  (samme merge som dokumentlisten), så antallet opdaterer når der
                  uploades flere filer i samme session. */}
              {(() => {
                // Tæl alle uploads med docId — også parse-fejlede, da dokumentet
                // findes i DB (og slettes af bulk-delete) selvom parsing fejlede.
                const deletableCount = new Set([
                  ...previousDocs.map((d) => d.id),
                  ...wizardUploads.filter((u) => u.docId).map((u) => u.docId!),
                ]).size;
                if (deletableCount === 0) return null;
                return (
                  <button
                    type="button"
                    onClick={async () => {
                      if (
                        !selected?.id ||
                        !confirm(
                          da
                            ? `Slet alle ${deletableCount} dokumenter for ${selected.navn}?`
                            : `Delete all ${deletableCount} documents for ${selected.navn}?`
                        )
                      )
                        return;
                      try {
                        const r = await fetch(
                          `/api/forsikring/documents/bulk?kunde_id=${encodeURIComponent(selected.id)}`,
                          { method: 'DELETE' }
                        );
                        if (r.ok) {
                          setPreviousDocs([]);
                          // Server-sletningen rammer ALLE kundens docs — ryd også
                          // wizard-uploads så listen ikke viser slettede filer
                          setWizardUploads([]);
                          setSelectedDocIds(new Set());
                        }
                      } catch {
                        /* non-fatal */
                      }
                    }}
                    className="text-xs text-red-400 hover:text-red-300 underline"
                  >
                    {da
                      ? `Slet alle ${deletableCount} dokumenter for ${selected.navn}`
                      : `Delete all ${deletableCount} documents for ${selected.navn}`}
                  </button>
                );
              })()}

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
                    {/* BIZZ-1551: Master-checkbox header — erstatter separate
                    Vælg-alle/Fravælg-alle knapper. Stater: alle valgt → checked,
                    ingen valgt → unchecked, blandet → indeterminate (visuel mellem-state). */}
                    {(() => {
                      const total = unique.length;
                      const sel = unique.filter((d) => selectedDocIds.has(d.id)).length;
                      const allChecked = sel === total;
                      const noneChecked = sel === 0;
                      return (
                        <label className="flex items-center gap-3 px-3 py-2 bg-blue-500/5 border border-blue-500/20 rounded-lg cursor-pointer">
                          <input
                            type="checkbox"
                            checked={allChecked}
                            ref={(el) => {
                              if (el) el.indeterminate = !allChecked && !noneChecked;
                            }}
                            onChange={(e) => {
                              if (e.target.checked)
                                setSelectedDocIds(new Set(unique.map((d) => d.id)));
                              else setSelectedDocIds(new Set());
                            }}
                            className="rounded border-slate-600 bg-slate-700 text-blue-500 focus:ring-blue-500"
                          />
                          <span className="text-blue-300 text-xs font-medium flex-1">
                            {da
                              ? `${sel} / ${total} dokumenter valgt`
                              : `${sel} / ${total} documents selected`}
                          </span>
                          <span className="text-slate-400 text-[10px]">
                            {da
                              ? 'Klik for at vælge/fravælge alle'
                              : 'Click to select/deselect all'}
                          </span>
                        </label>
                      );
                    })()}
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
                          {/* BIZZ-1973: ⚠-badge når dokumentets police dækker en adresse uden for porteføljen */}
                          {mismatchDocIds.has(doc.id) && (
                            <span
                              className="text-[10px] shrink-0 flex items-center gap-1 text-amber-300 bg-amber-500/15 border border-amber-500/30 rounded px-1.5 py-0.5"
                              title={
                                da
                                  ? 'Police dækker en adresse uden for porteføljen'
                                  : 'Policy covers an address outside the portfolio'
                              }
                            >
                              <AlertTriangle size={10} className="text-amber-400" />
                              {da ? 'adresse-mismatch' : 'address mismatch'}
                            </span>
                          )}
                          <span
                            className={`text-[10px] shrink-0 ${doc.source === 'new' ? 'text-emerald-400' : 'text-slate-400'}`}
                          >
                            {doc.source === 'new'
                              ? da
                                ? 'ny'
                                : 'new'
                              : da
                                ? 'tidligere'
                                : 'previous'}
                          </span>
                          {/* Slet permanent fra system */}
                          <button
                            type="button"
                            aria-label={da ? `Slet ${doc.name}` : `Delete ${doc.name}`}
                            onClick={async (e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              if (!window.confirm(da ? `Slet ${doc.name}?` : `Delete ${doc.name}?`))
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
                            className="p-1 text-slate-400 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors shrink-0"
                          >
                            <Trash2 size={12} />
                          </button>
                        </label>
                      ))}
                    </div>
                    {/* BIZZ-1551: Vælg-alle/Fravælg-alle knapper fjernet — master-checkbox
                    øverst håndterer det nu i standard UX-mønster. */}
                  </>
                ) : (
                  <p className="text-slate-400 text-xs">
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
                  // BIZZ-1774: Drag-and-drop handlers
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.currentTarget.classList.add('border-blue-500/60', 'bg-blue-500/5');
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault();
                    e.currentTarget.classList.remove('border-blue-500/60', 'bg-blue-500/5');
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.currentTarget.classList.remove('border-blue-500/60', 'bg-blue-500/5');
                    if (e.dataTransfer.files.length > 0) {
                      onWizardUpload(e.dataTransfer.files);
                    }
                  }}
                >
                  <Upload size={20} className="mx-auto text-blue-400 mb-1" />
                  <div className="text-xs text-slate-300">
                    {da
                      ? 'Træk filer hertil eller klik for at uploade'
                      : 'Drag files here or click to upload'}
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5">
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
                        className={`flex items-center gap-2 text-xs px-2 py-1 rounded ${
                          job.status === 'skipped_duplicate'
                            ? 'bg-amber-500/10 border border-amber-500/20'
                            : 'bg-white/3'
                        }`}
                      >
                        {job.status === 'done' ? (
                          <CheckCircle2 size={12} className="text-emerald-400" />
                        ) : job.status === 'skipped_duplicate' ? (
                          <AlertCircle size={12} className="text-amber-400" />
                        ) : job.status === 'failed' ? (
                          <XCircle size={12} className="text-red-400" />
                        ) : (
                          <Loader2 size={12} className="animate-spin text-blue-400" />
                        )}
                        <span className="text-white truncate">{job.fileName}</span>
                        <span
                          className={`ml-auto ${
                            job.status === 'skipped_duplicate' ? 'text-amber-300' : 'text-slate-400'
                          }`}
                        >
                          {job.status === 'done'
                            ? '✓'
                            : job.status === 'skipped_duplicate'
                              ? da
                                ? 'Findes allerede — bruger eksisterende'
                                : 'Already exists — using existing'
                              : job.status}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {/* end venstre kolonne */}

            {/* Højre kolonne: standard forsikringsbetingelser */}
            <div className="space-y-2 border-t border-white/5 pt-3 lg:border-t-0 lg:pt-0 lg:border-l lg:border-l-white/5 lg:pl-4">
              <div className="flex items-center justify-between">
                <h4 className="text-slate-300 text-xs font-semibold uppercase tracking-wide">
                  {da ? 'Standard forsikringsbetingelser' : 'Standard insurance terms'}
                  {stdSelectedIds.size > 0 && (
                    <span className="ml-2 text-teal-400 normal-case font-normal">
                      ({stdSelectedIds.size} {da ? 'valgt' : 'selected'})
                    </span>
                  )}
                </h4>
              </div>
              <p className="text-slate-400 text-[10px]">
                {da
                  ? 'Tilføj generelle vilkår fra forsikringsselskabet til analysen. AI kan finde dem automatisk.'
                  : 'Add general terms from the insurance company to the analysis. AI can find them automatically.'}
              </p>

              {/* BIZZ-1919: Gemte betingelser — BIZZ-2078: kun betingelser
                  tidligere brugt i analyser for den valgte kunde. Ny kunde =
                  blank sektion; hele biblioteket findes i Bibliotek-modalen. */}
              {stdKundeUsed.length > 0 && (
                <div className="space-y-1">
                  <div className="text-slate-400 text-[10px] mb-1">
                    {da
                      ? `${stdKundeUsed.length} betingelser tidligere brugt for denne kunde:`
                      : `${stdKundeUsed.length} terms previously used for this customer:`}
                  </div>
                  <div className="max-h-32 overflow-y-auto space-y-0.5">
                    {stdKundeUsed.map((doc) => {
                      const isSelected = stdSelectedIds.has(doc.source_url);
                      const alreadyInDiscovered = stdDiscovered.some(
                        (d) => d.source_url === doc.source_url
                      );
                      return (
                        <label
                          key={doc.id}
                          className={`flex items-center gap-2 px-2 py-1 rounded-lg cursor-pointer transition-colors text-[11px] ${
                            isSelected
                              ? 'bg-teal-900/30 border border-teal-500/30'
                              : 'bg-slate-800/40 border border-slate-700/20 hover:border-slate-600/40'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => {
                              // Tilføj til discovered-listen hvis ikke allerede der
                              if (!alreadyInDiscovered) {
                                setStdDiscovered((prev) => [
                                  ...prev,
                                  {
                                    titel: doc.titel,
                                    source_url: doc.source_url,
                                    kategori: doc.kategori,
                                    confidence: 'high',
                                  },
                                ]);
                                setStdSavedIds((prev) => new Map(prev).set(doc.source_url, doc.id));
                              }
                              setStdSelectedIds((prev) => {
                                const next = new Set(prev);
                                if (isSelected) next.delete(doc.source_url);
                                else next.add(doc.source_url);
                                return next;
                              });
                            }}
                            className="accent-teal-500 w-3 h-3"
                          />
                          <span className="text-slate-300 truncate flex-1">{doc.titel}</span>
                          <span className="text-slate-400 text-[9px] shrink-0">
                            {doc.selskab.length > 20 ? doc.selskab.slice(0, 20) + '…' : doc.selskab}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* AI discovery row */}
              <div className="flex gap-2 items-end">
                <div className="flex-1">
                  <label
                    htmlFor="std-selskab-input"
                    className="text-slate-400 text-[10px] block mb-1"
                  >
                    {da ? 'Forsikringsselskab' : 'Insurance company'}
                  </label>
                  <input
                    ref={stdSelskabRef}
                    id="std-selskab-input"
                    type="text"
                    placeholder={
                      da ? 'Fx Topdanmark, Tryg, Codan...' : 'E.g. Topdanmark, Tryg, Codan...'
                    }
                    className="w-full bg-slate-900/60 border border-slate-700/50 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-600 focus:border-teal-500/50 focus:outline-none"
                  />
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    const selskab = stdSelskabRef.current?.value?.trim();
                    if (!selskab) {
                      stdSelskabRef.current?.focus();
                      return;
                    }
                    setStdDiscovering(true);
                    try {
                      const res = await fetch('/api/forsikring/standard-docs/discover', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ selskab, kategori: 'ejendom' }),
                      });
                      if (res.ok) {
                        const data = (await res.json()) as {
                          results: Array<{
                            titel: string;
                            source_url: string;
                            kategori: string;
                            confidence: string;
                          }>;
                        };
                        const newDocs = data.results ?? [];
                        // Dedup mod allerede viste docs
                        const existingUrls = new Set(stdDiscovered.map((d) => d.source_url));
                        const merged = [
                          ...stdDiscovered,
                          ...newDocs.filter((d) => !existingUrls.has(d.source_url)),
                        ];
                        setStdDiscovered(merged);
                        // Auto-vælg high-confidence fundne
                        if (newDocs.length > 0) {
                          setStdSelectedIds((prev) => {
                            const next = new Set(prev);
                            for (const d of newDocs) {
                              if (d.confidence === 'high') next.add(d.source_url);
                            }
                            return next;
                          });
                          // Gem i DB
                          for (const doc of newDocs) {
                            fetch('/api/forsikring/standard-docs', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                selskab,
                                kategori: doc.kategori ?? 'ejendom',
                                titel: doc.titel,
                                source_url: doc.source_url,
                                added_via: 'ai_discovery',
                              }),
                            })
                              .then((r) => (r.ok ? r.json() : null))
                              .then((d) => {
                                if (d?.id) {
                                  setStdSavedIds((prev) => new Map(prev).set(doc.source_url, d.id));
                                }
                              })
                              .catch(() => {});
                          }
                        }
                      }
                    } catch {
                      /* non-fatal */
                    } finally {
                      setStdDiscovering(false);
                    }
                  }}
                  disabled={stdDiscovering || running}
                  aria-label={
                    da ? 'Find standard betingelser via AI' : 'Find standard terms via AI'
                  }
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal-600/20 hover:bg-teal-600/30 border border-teal-500/30 text-teal-300 text-xs font-medium transition-colors disabled:opacity-40 shrink-0"
                >
                  {stdDiscovering ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Sparkles size={12} />
                  )}
                  {da ? 'Find via AI' : 'Find via AI'}
                </button>
              </div>

              {/* BIZZ-1890: Detect from uploaded police documents */}
              {wizardUploads.filter((u) => u.status === 'done' && u.docId).length > 0 && (
                <button
                  type="button"
                  aria-label={
                    da
                      ? 'Find standard betingelser baseret på uploadede police-dokumenter'
                      : 'Find standard terms from uploaded policy documents'
                  }
                  onClick={async () => {
                    const docIds = wizardUploads
                      .filter((u) => u.status === 'done' && u.docId)
                      .map((u) => u.docId!)
                      .slice(0, 20);
                    if (docIds.length === 0) return;
                    setStdDetecting(true);
                    try {
                      const res = await fetch('/api/forsikring/standard-docs/detect', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ document_ids: docIds }),
                      });
                      if (res.ok) {
                        const data = (await res.json()) as {
                          results: Array<{
                            titel: string;
                            source_url: string;
                            kategori: string;
                            selskab: string;
                            confidence: string;
                            existing_id?: string;
                          }>;
                        };
                        const newDocs = data.results ?? [];
                        const existingUrls = new Set(stdDiscovered.map((d) => d.source_url));
                        const merged = [
                          ...stdDiscovered,
                          ...newDocs.filter((d) => !existingUrls.has(d.source_url)),
                        ];
                        setStdDiscovered(merged);
                        // Auto-vælg high-confidence og gem i DB
                        if (newDocs.length > 0) {
                          setStdSelectedIds((prev) => {
                            const next = new Set(prev);
                            for (const d of newDocs) {
                              if (d.confidence === 'high') next.add(d.source_url);
                            }
                            return next;
                          });
                          for (const doc of newDocs.filter((d) => !d.existing_id)) {
                            fetch('/api/forsikring/standard-docs', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                selskab: doc.selskab,
                                kategori: doc.kategori ?? 'ejendom',
                                titel: doc.titel,
                                source_url: doc.source_url,
                                added_via: 'auto_detected',
                              }),
                            })
                              .then((r) => (r.ok ? r.json() : null))
                              .then((d) => {
                                if (d?.id)
                                  setStdSavedIds((prev) => new Map(prev).set(doc.source_url, d.id));
                              })
                              .catch(() => {});
                          }
                          // Registrer allerede-kendte docs i savedIds
                          for (const doc of newDocs.filter((d) => d.existing_id)) {
                            setStdSavedIds((prev) =>
                              new Map(prev).set(doc.source_url, doc.existing_id!)
                            );
                          }
                        }
                      }
                    } catch {
                      /* non-fatal */
                    } finally {
                      setStdDetecting(false);
                    }
                  }}
                  disabled={stdDetecting || running}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600/20 hover:bg-violet-600/30 border border-violet-500/30 text-violet-300 text-xs font-medium transition-colors disabled:opacity-40 w-full justify-center"
                >
                  {stdDetecting ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <ScanSearch size={12} />
                  )}
                  {da
                    ? `Find fra ${wizardUploads.filter((u) => u.status === 'done').length} uploadede dokumenter`
                    : `Detect from ${wizardUploads.filter((u) => u.status === 'done').length} uploaded documents`}
                </button>
              )}

              {/* Discovered docs list.
                  BIZZ-2073: Gemte betingelser tilføjes til stdDiscovered når de
                  vælges (eller genfindes via AI), men de vises allerede i
                  "tidligere brugt for denne kunde"-listen ovenfor — filtrér dem
                  fra her så samme vilkår ikke renderes dobbelt. Valg-state deles
                  via stdSelectedIds (source_url), så checkboxen ovenfor virker.
                  BIZZ-2078: dedup mod stdKundeUsed (ikke hele biblioteket) så
                  Bibliotek-valg for en ny kunde stadig vises her. */}
              {stdDiscovered.some(
                (d) => !stdKundeUsed.some((s) => s.source_url === d.source_url)
              ) && (
                <div className="space-y-1">
                  {stdDiscovered
                    .filter((d) => !stdKundeUsed.some((s) => s.source_url === d.source_url))
                    .map((doc) => {
                      const isSelected = stdSelectedIds.has(doc.source_url);
                      return (
                        <label
                          key={doc.source_url}
                          className={`flex items-start gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-colors ${
                            isSelected
                              ? 'bg-teal-600/15 border border-teal-500/30'
                              : 'bg-white/3 border border-white/5 hover:bg-white/5'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={(e) => {
                              setStdSelectedIds((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(doc.source_url);
                                else next.delete(doc.source_url);
                                return next;
                              });
                            }}
                            className="mt-0.5 accent-teal-500 shrink-0"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-white text-[11px] font-medium truncate">
                              {doc.titel}
                            </div>
                            <div className="flex items-center gap-1 mt-0.5">
                              <a
                                href={doc.source_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-blue-400 text-[10px] hover:underline truncate flex items-center gap-0.5"
                              >
                                <ExternalLink size={9} />
                                {doc.source_url.length > 50
                                  ? doc.source_url.slice(0, 50) + '…'
                                  : doc.source_url}
                              </a>
                              <span
                                className={`shrink-0 text-[9px] px-1 py-0.5 rounded-full ${
                                  doc.confidence === 'high'
                                    ? 'bg-emerald-500/20 text-emerald-300'
                                    : doc.confidence === 'medium'
                                      ? 'bg-amber-500/20 text-amber-300'
                                      : 'bg-slate-600/30 text-slate-400'
                                }`}
                              >
                                {doc.confidence}
                              </span>
                            </div>
                          </div>
                        </label>
                      );
                    })}
                </div>
              )}

              {/* Manuel URL tilføjelse */}
              <div className="pt-1">
                <div className="text-slate-400 text-[10px] mb-1.5">
                  {da ? 'Eller tilføj manuelt med URL:' : 'Or add manually by URL:'}
                </div>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={stdManualTitel}
                    onChange={(e) => setStdManualTitel(e.target.value)}
                    placeholder={da ? 'Titel' : 'Title'}
                    className="w-28 bg-slate-900/60 border border-slate-700/50 rounded-lg px-2 py-1.5 text-xs text-white placeholder-slate-600 focus:border-teal-500/50 focus:outline-none"
                  />
                  <input
                    type="url"
                    value={stdManualUrl}
                    onChange={(e) => setStdManualUrl(e.target.value)}
                    placeholder="https://..."
                    className="flex-1 bg-slate-900/60 border border-slate-700/50 rounded-lg px-2 py-1.5 text-xs text-white placeholder-slate-600 focus:border-teal-500/50 focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={!stdManualUrl.trim() || !stdManualTitel.trim() || stdAddingManual}
                    aria-label={
                      da ? 'Tilføj manuel standard betingelse' : 'Add manual standard term'
                    }
                    onClick={async () => {
                      const url = stdManualUrl.trim();
                      const titel = stdManualTitel.trim();
                      if (!url || !titel) return;
                      setStdAddingManual(true);
                      try {
                        const res = await fetch('/api/forsikring/standard-docs', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            selskab: stdSelskabRef.current?.value?.trim() ?? 'Ukendt',
                            kategori: 'ejendom',
                            titel,
                            source_url: url,
                            added_via: 'manual_link',
                          }),
                        });
                        if (res.ok) {
                          const data = (await res.json()) as { id?: string };
                          const newDoc = {
                            titel,
                            source_url: url,
                            kategori: 'ejendom',
                            confidence: 'medium' as const,
                          };
                          setStdDiscovered((prev) =>
                            prev.find((d) => d.source_url === url) ? prev : [...prev, newDoc]
                          );
                          setStdSelectedIds((prev) => new Set(prev).add(url));
                          if (data.id) {
                            setStdSavedIds((prev) => new Map(prev).set(url, data.id!));
                          }
                          setStdManualUrl('');
                          setStdManualTitel('');
                        }
                      } catch {
                        /* non-fatal */
                      } finally {
                        setStdAddingManual(false);
                      }
                    }}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-700/50 hover:bg-slate-600/50 border border-slate-600/50 text-slate-300 text-xs font-medium transition-colors disabled:opacity-40 shrink-0"
                  >
                    {stdAddingManual ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      <Plus size={11} />
                    )}
                    {da ? 'Tilføj' : 'Add'}
                  </button>
                </div>
              </div>

              {/* BIZZ-1921: Åbn bibliotek + BIZZ-1890: PDF upload */}
              <div className="pt-1 flex items-end gap-2">
                <div className="flex-1">
                  <div className="text-slate-400 text-[10px] mb-1.5">
                    {da
                      ? 'Eller upload PDF med standard betingelser:'
                      : 'Or upload a PDF with standard terms:'}
                  </div>
                  <button
                    type="button"
                    aria-label={
                      da
                        ? 'Upload PDF med standard forsikringsbetingelser'
                        : 'Upload PDF with standard insurance terms'
                    }
                    onClick={() => stdPdfRef.current?.click()}
                    disabled={stdPdfUploading || running}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700/50 hover:bg-slate-600/50 border border-slate-600/50 text-slate-300 text-xs font-medium transition-colors disabled:opacity-40"
                  >
                    {stdPdfUploading ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      <FilePlus size={11} />
                    )}
                    {stdPdfUploading
                      ? da
                        ? 'Uploader…'
                        : 'Uploading…'
                      : da
                        ? 'Upload PDF(er)'
                        : 'Upload PDF(s)'}
                  </button>
                  <input
                    ref={stdPdfRef}
                    type="file"
                    accept=".pdf,application/pdf"
                    multiple
                    className="hidden"
                    aria-label={
                      da
                        ? 'Vælg PDF-filer til standard betingelser'
                        : 'Select PDF files for standard terms'
                    }
                    onChange={async (e) => {
                      const files = Array.from(e.target.files ?? []);
                      if (files.length === 0) return;
                      e.target.value = '';
                      setStdPdfUploading(true);
                      setStdUploadDone(null);
                      try {
                        const selskab = stdSelskabRef.current?.value?.trim();
                        let lastTitle = '';
                        // Upload filer sekventielt for at undgå rate-limit
                        for (const file of files) {
                          setStdUploadProgress(
                            da ? `Analyserer ${file.name}...` : `Analyzing ${file.name}...`
                          );
                          const form = new FormData();
                          form.append('file', file);
                          if (selskab) form.append('selskab', selskab);
                          const res = await fetch('/api/forsikring/standard-docs/upload', {
                            method: 'POST',
                            body: form,
                          });
                          if (res.ok) {
                            const data = (await res.json()) as {
                              id?: string;
                              titel?: string;
                              source_url?: string;
                              kategori?: string;
                              selskab?: string;
                            };
                            if (data.id && data.source_url && data.titel) {
                              const newDoc = {
                                titel: data.titel,
                                source_url: data.source_url,
                                kategori: data.kategori ?? 'ejendom',
                                confidence: 'high' as const,
                              };
                              setStdDiscovered((prev) =>
                                prev.find((d) => d.source_url === data.source_url)
                                  ? prev
                                  : [...prev, newDoc]
                              );
                              setStdSelectedIds((prev) => new Set([...prev, data.source_url!]));
                              setStdSavedIds((prev) =>
                                new Map(prev).set(data.source_url!, data.id!)
                              );
                              // Tilføj til bibliotek-listen
                              setStdSavedLibrary((prev) => [
                                {
                                  id: data.id!,
                                  titel: data.titel!,
                                  source_url: data.source_url!,
                                  selskab: data.selskab ?? selskab ?? 'Ukendt',
                                  kategori: data.kategori ?? 'ejendom',
                                  added_via: 'manual_upload',
                                  added_by_user: null,
                                },
                                ...prev,
                              ]);
                              lastTitle = data.titel!;
                            }
                          }
                        }
                        if (lastTitle) {
                          setStdUploadDone(
                            da
                              ? `Tilføjet til bibliotek: ${lastTitle}`
                              : `Added to library: ${lastTitle}`
                          );
                          setTimeout(() => setStdUploadDone(null), 5000);
                        }
                      } catch {
                        /* non-fatal */
                      } finally {
                        setStdPdfUploading(false);
                        setStdUploadProgress(null);
                      }
                    }}
                  />
                </div>
                {/* BIZZ-1932: Upload progress + bekræftelse */}
                {stdUploadProgress && (
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-indigo-900/20 border border-indigo-500/20 text-xs text-indigo-300">
                    <Loader2 size={11} className="animate-spin shrink-0" />
                    {stdUploadProgress}
                  </div>
                )}
                {stdUploadDone && (
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-900/20 border border-emerald-500/20 text-xs text-emerald-300">
                    <CheckCircle2 size={11} className="shrink-0" />
                    {stdUploadDone}
                  </div>
                )}

                {/* BIZZ-1921: Åbn bibliotek-knap */}
                <button
                  type="button"
                  onClick={() => setStdLibraryOpen(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/30 text-indigo-300 text-xs font-medium transition-colors whitespace-nowrap"
                  aria-label={da ? 'Åbn betingelsesbibliotek' : 'Open terms library'}
                >
                  <BookOpen size={11} />
                  {da ? 'Bibliotek' : 'Library'}
                  {stdSavedLibrary.length > 0 && (
                    <span className="text-indigo-400/70 text-[9px]">
                      ({stdSavedLibrary.length})
                    </span>
                  )}
                </button>
              </div>

              {/* BIZZ-1921: Bibliotek-modal */}
              {stdLibraryOpen && (
                <div
                  className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
                  onClick={() => setStdLibraryOpen(false)}
                >
                  <div
                    className="bg-slate-900 border border-slate-700/50 rounded-2xl w-full max-w-5xl max-h-[85vh] overflow-hidden shadow-2xl"
                    onClick={(e) => e.stopPropagation()}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="std-library-title"
                  >
                    {/* Header */}
                    <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700/50">
                      <h3 id="std-library-title" className="text-white font-semibold text-sm">
                        {da ? 'Standard forsikringsbetingelser' : 'Standard insurance terms'}
                      </h3>
                      <button
                        type="button"
                        onClick={() => setStdLibraryOpen(false)}
                        className="text-slate-400 hover:text-white text-lg"
                        aria-label={da ? 'Luk' : 'Close'}
                      >
                        ×
                      </button>
                    </div>

                    {/* Filter */}
                    <div className="px-5 py-2 border-b border-slate-800/50 space-y-2">
                      <input
                        type="text"
                        value={stdLibraryFilter}
                        onChange={(e) => setStdLibraryFilter(e.target.value)}
                        placeholder={
                          da
                            ? 'Søg i titel, selskab eller område...'
                            : 'Search title, company or area...'
                        }
                        className="w-full bg-slate-800/60 border border-slate-700/40 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-indigo-500/50 focus:outline-none"
                      />
                      <div className="flex gap-2">
                        <select
                          value={stdLibrarySelskabFilter}
                          onChange={(e) => setStdLibrarySelskabFilter(e.target.value)}
                          aria-label={da ? 'Filtrer på selskab' : 'Filter by company'}
                          className="flex-1 bg-slate-800/60 border border-slate-700/40 rounded-lg px-2 py-1 text-[10px] text-slate-300"
                        >
                          <option value="">{da ? 'Alle selskaber' : 'All companies'}</option>
                          {[...new Set(stdSavedLibrary.map((d) => d.selskab).filter(Boolean))]
                            .sort()
                            .map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                        </select>
                        <select
                          value={stdLibraryKategoriFilter}
                          onChange={(e) => setStdLibraryKategoriFilter(e.target.value)}
                          aria-label={da ? 'Filtrer på kategori' : 'Filter by category'}
                          className="flex-1 bg-slate-800/60 border border-slate-700/40 rounded-lg px-2 py-1 text-[10px] text-slate-300"
                        >
                          <option value="">{da ? 'Alle typer' : 'All types'}</option>
                          {[...new Set(stdSavedLibrary.map((d) => d.kategori).filter(Boolean))]
                            .sort()
                            .map((k) => (
                              <option key={k} value={k}>
                                {k}
                              </option>
                            ))}
                        </select>
                      </div>
                      {stdSavedLibrary.length > 0 && (
                        <p className="text-slate-400 text-[9px]">
                          {da
                            ? `${stdSavedLibrary.length} betingelser i biblioteket`
                            : `${stdSavedLibrary.length} terms in library`}
                        </p>
                      )}
                    </div>

                    {/* Tabel */}
                    <div className="overflow-auto max-h-[60vh]">
                      {stdSavedLibrary.length === 0 ? (
                        <p className="text-slate-400 text-xs py-8 text-center">
                          {da
                            ? 'Ingen gemte betingelser endnu. Upload PDF eller find via AI.'
                            : 'No saved terms yet. Upload PDF or find via AI.'}
                        </p>
                      ) : (
                        <table className="w-full text-xs">
                          <thead className="bg-slate-800/60 sticky top-0">
                            <tr className="text-left text-slate-400 uppercase tracking-wider text-[10px]">
                              <th className="px-4 py-2 w-8" />
                              <th className="px-4 py-2">{da ? 'Selskab' : 'Company'}</th>
                              <th className="px-4 py-2">{da ? 'Betingelser' : 'Terms'}</th>
                              <th className="px-4 py-2">{da ? 'Type' : 'Type'}</th>
                              <th className="px-4 py-2">{da ? 'Gyldig fra' : 'Valid from'}</th>
                              <th className="px-4 py-2 w-8" />
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-700/20">
                            {stdSavedLibrary
                              .filter((doc) => {
                                if (
                                  stdLibrarySelskabFilter &&
                                  doc.selskab !== stdLibrarySelskabFilter
                                )
                                  return false;
                                if (
                                  stdLibraryKategoriFilter &&
                                  doc.kategori !== stdLibraryKategoriFilter
                                )
                                  return false;
                                if (!stdLibraryFilter) return true;
                                const q = stdLibraryFilter.toLowerCase();
                                return (
                                  doc.titel.toLowerCase().includes(q) ||
                                  doc.selskab.toLowerCase().includes(q) ||
                                  (doc.omraade ?? '').toLowerCase().includes(q)
                                );
                              })
                              .map((doc) => {
                                const isSelected = stdSelectedIds.has(doc.source_url);
                                return (
                                  <tr
                                    key={doc.id}
                                    onClick={() => {
                                      const alreadyInDiscovered = stdDiscovered.some(
                                        (d) => d.source_url === doc.source_url
                                      );
                                      if (!alreadyInDiscovered) {
                                        setStdDiscovered((prev) => [
                                          ...prev,
                                          {
                                            titel: doc.titel,
                                            source_url: doc.source_url,
                                            kategori: doc.kategori,
                                            confidence: 'high',
                                          },
                                        ]);
                                        setStdSavedIds((prev) =>
                                          new Map(prev).set(doc.source_url, doc.id)
                                        );
                                      }
                                      setStdSelectedIds((prev) => {
                                        const next = new Set(prev);
                                        if (isSelected) next.delete(doc.source_url);
                                        else next.add(doc.source_url);
                                        return next;
                                      });
                                    }}
                                    className={`cursor-pointer transition-colors ${
                                      isSelected ? 'bg-teal-900/20' : 'hover:bg-slate-800/30'
                                    }`}
                                  >
                                    <td className="px-4 py-2.5">
                                      <input
                                        type="checkbox"
                                        checked={isSelected}
                                        readOnly
                                        className="accent-teal-500 w-3.5 h-3.5"
                                      />
                                    </td>
                                    <td className="px-4 py-2.5 text-blue-400 font-medium whitespace-nowrap">
                                      {doc.selskab}
                                    </td>
                                    <td className="px-4 py-2.5">
                                      <div className="text-white font-medium">{doc.titel}</div>
                                      {doc.is_valid_standard === false && (
                                        <span className="text-amber-400 text-[9px]">
                                          ⚠ {da ? 'Ikke standard' : 'Not standard'}
                                        </span>
                                      )}
                                    </td>
                                    <td className="px-4 py-2.5">
                                      <span className="text-slate-400 px-1.5 py-0.5 bg-slate-700/40 rounded text-[10px]">
                                        {doc.kategori}
                                      </span>
                                      {doc.omraade && (
                                        <span className="text-indigo-400/70 px-1.5 py-0.5 bg-indigo-500/10 rounded text-[10px] ml-1">
                                          {doc.omraade}
                                        </span>
                                      )}
                                    </td>
                                    <td className="px-4 py-2.5 text-slate-400 whitespace-nowrap">
                                      {doc.gyldig_fra ?? '—'}
                                    </td>
                                    <td className="px-4 py-2.5">
                                      <a
                                        href={doc.source_url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-slate-400 hover:text-blue-400"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        ↗
                                      </a>
                                    </td>
                                  </tr>
                                );
                              })}
                          </tbody>
                        </table>
                      )}
                    </div>

                    {/* Footer */}
                    <div className="flex items-center justify-between px-5 py-3 border-t border-slate-700/50">
                      <span className="text-slate-400 text-[10px]">
                        {stdSelectedIds.size} {da ? 'valgt' : 'selected'}
                      </span>
                      <button
                        type="button"
                        onClick={() => setStdLibraryOpen(false)}
                        className="px-4 py-1.5 bg-teal-600 hover:bg-teal-500 text-white text-xs font-medium rounded-lg transition-colors"
                      >
                        {da ? 'Anvend' : 'Apply'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
            {/* end højre kolonne */}
          </div>
          {/* end grid */}
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
              onClick={() => startAnalyse()}
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
                    ? `Start analyse${selectedDocIds.size > 0 ? ` (${selectedDocIds.size} dokument${selectedDocIds.size === 1 ? '' : 'er'})` : ''}`
                    : `Start analysis${selectedDocIds.size > 0 ? ` (${selectedDocIds.size} document${selectedDocIds.size === 1 ? '' : 's'})` : ''}`}
                </>
              )}
            </button>
          )}
        </div>
      )}

      {/* BIZZ-1973: Advarsels-modal — police dækker ejendom uden for porteføljen */}
      {mismatchWarning && mismatchWarning.length > 0 && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mismatch-title"
        >
          <div className="bg-slate-900 border border-amber-500/40 rounded-2xl max-w-lg w-full p-5 space-y-4 shadow-2xl">
            <div className="flex items-start gap-3">
              <AlertTriangle size={22} className="text-amber-400 shrink-0 mt-0.5" />
              <div>
                <h3 id="mismatch-title" className="text-white font-semibold text-sm">
                  {da
                    ? 'Police dækker en adresse uden for porteføljen'
                    : 'Policy covers an address outside the portfolio'}
                </h3>
                <p className="text-slate-300 text-xs mt-1">
                  {da
                    ? `${mismatchWarning.length === 1 ? 'Følgende police' : `${mismatchWarning.length} policer`} dækker en ejendom der hverken ejes eller administreres af ${selected?.navn ?? 'forsikringssejeren'}. Kontrollér at dokumentet hører til denne forsikringssejer.`
                    : `${mismatchWarning.length === 1 ? 'The following policy' : `${mismatchWarning.length} policies`} cover a property neither owned nor administered by ${selected?.navn ?? 'the policyholder'}. Verify the document belongs to this policyholder.`}
                </p>
              </div>
            </div>
            <ul className="space-y-1.5 max-h-40 overflow-y-auto">
              {mismatchWarning.map((m) => (
                <li
                  key={m.policy_id}
                  className="bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2 text-xs"
                >
                  <div className="text-amber-200 font-medium">
                    {m.property_address ?? (da ? 'Ukendt adresse' : 'Unknown address')}
                  </div>
                  <div className="text-slate-400">
                    {m.insurer_name} · {da ? 'Police' : 'Policy'} {m.policy_number}
                    {m.is_policyholder_address && (
                      <span className="text-amber-300">
                        {' '}
                        · {da ? 'forsikringstagers egen adresse' : "policyholder's own address"}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => {
                  setMismatchWarning(null);
                  startAnalyse({ skipPreflight: true });
                }}
                className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium"
              >
                {da ? 'Ja, fortsæt analysen' : 'Yes, continue analysis'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMismatchWarning(null);
                  setSelected(null);
                  setQuery('');
                  setAnalyseResult(null);
                  setAnalyseDetail(null);
                  setKundePolicer([]);
                  setLastAnalyse(null);
                  setAsOfDate('');
                }}
                className="bg-slate-700 hover:bg-slate-600 text-slate-100 px-4 py-2 rounded-lg text-sm font-medium"
              >
                {da ? 'Skift forsikringssejer' : 'Change policyholder'}
              </button>
              <button
                type="button"
                onClick={async () => {
                  // Slet de mismatchede dokumenter så de ikke indgår i analysen
                  const docIds = [
                    ...new Set(
                      mismatchWarning.map((m) => m.document_id).filter((id): id is string => !!id)
                    ),
                  ];
                  await Promise.allSettled(
                    docIds.map((id) =>
                      fetch(`/api/forsikring/documents/${id}`, { method: 'DELETE' })
                    )
                  );
                  // Fjern fra valgte docs + tidligere docs så UI er konsistent
                  setSelectedDocIds((prev) => {
                    const next = new Set(prev);
                    for (const id of docIds) next.delete(id);
                    return next;
                  });
                  setPreviousDocs((prev) => prev.filter((d) => !docIds.includes(d.id)));
                  setMismatchDocIds(new Set());
                  setMismatchWarning(null);
                }}
                className="text-red-400 hover:text-red-300 px-4 py-2 rounded-lg text-sm font-medium"
              >
                {da ? 'Fjern dokument(er)' : 'Remove document(s)'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* BIZZ-1973: Inline advarsels-banner når analyse blev kørt trods mismatch */}
      {analyseResult?.address_mismatches && analyseResult.address_mismatches.length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 flex items-start gap-2">
          <AlertTriangle size={15} className="text-amber-400 shrink-0 mt-0.5" />
          <div className="text-xs">
            <div className="text-amber-200 font-medium">
              {da
                ? `${analyseResult.address_mismatches.length} police${analyseResult.address_mismatches.length === 1 ? '' : 'r'} dækker en adresse uden for porteføljen`
                : `${analyseResult.address_mismatches.length} polic${analyseResult.address_mismatches.length === 1 ? 'y' : 'ies'} cover an address outside the portfolio`}
            </div>
            <div className="text-slate-400 mt-0.5">
              {analyseResult.address_mismatches
                .map((m) => m.property_address)
                .filter(Boolean)
                .join(' · ')}
            </div>
          </div>
        </div>
      )}

      {/* BIZZ-2067: Info — policer stilet til en adresse uden for porteføljen.
          Det er typisk virksomhedens lejede hovedkontor (sikrede-/korrespondance-
          adresse, ikke et forsikringssted) — vises som info, ikke advarsel. */}
      {analyseResult?.sikrede_adresser_uden_for_portefoelje &&
        analyseResult.sikrede_adresser_uden_for_portefoelje.length > 0 && (
          <div className="bg-sky-500/10 border border-sky-500/30 rounded-lg p-3 flex items-start gap-2">
            <Info size={15} className="text-sky-400 shrink-0 mt-0.5" />
            <div className="text-xs">
              <div className="text-sky-200 font-medium">
                {da
                  ? 'Police indeholder en adresse uden for porteføljen'
                  : 'Policy contains an address outside the portfolio'}
              </div>
              {analyseResult.sikrede_adresser_uden_for_portefoelje.map((s, i) => (
                <div key={`${s.adresse}-${i}`} className="text-slate-400 mt-0.5">
                  {s.dokument_navn && (
                    <span className="text-slate-300 font-medium">{s.dokument_navn}</span>
                  )}
                  {s.dokument_navn && ' — '}
                  {da
                    ? `policen indeholder ${s.adresse}, som ligger uden for porteføljen`
                    : `the policy contains ${s.adresse}, which is outside the portfolio`}
                  {s.policy_number && ` (police ${s.policy_number})`}
                </div>
              ))}
              <div className="text-slate-400 mt-0.5">
                {da
                  ? 'Adressen er forsikringstagers sikrede-/korrespondance-adresse (typisk lejet hovedkontor), ikke et forsikringssted, og ejes ikke af virksomheden.'
                  : "The address is the policyholder's correspondence address (typically a leased head office), not an insured location, and is not owned by the company."}
              </div>
            </div>
          </div>
        )}

      {/* Advarsel: standard betingelser matchede ikke policens selskab */}
      {analyseResult?.std_betingelser_advarsel && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 flex items-start gap-2">
          <AlertTriangle size={15} className="text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-200">{analyseResult.std_betingelser_advarsel}</p>
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
              <div className="text-slate-400 mb-0.5">{da ? 'Aktiver' : 'Assets'}</div>
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
              <div className="text-slate-400 mb-0.5">{da ? 'Forsikrede' : 'Insured'}</div>
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
              <div className="text-slate-400 mb-0.5">Gaps</div>
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
          <div className="text-slate-400 text-[10px] uppercase tracking-wide">
            {da ? 'Tidligere forsikringsejere' : 'Previous insurance owners'}
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
                  // BIZZ-1791: Auto-vis doc picker for eksisterende kunder
                  setShowDocPicker(true);
                  onCustomerSelect(customer);
                }}
                className="flex-1 text-left px-3 py-2 bg-white/3 hover:bg-white/5 rounded-lg text-xs flex items-center justify-between"
              >
                <span className="text-white font-medium">{s.kunde_navn ?? s.kunde_id}</span>
                <span className="text-slate-400">
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
                className="p-2 text-slate-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors shrink-0"
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
            <div className="text-slate-400">{da ? 'Ejendomme' : 'Properties'}</div>
          </div>
          <div>
            <div className="text-emerald-300 text-xl font-bold">{insured}</div>
            <div className="text-slate-400">{da ? 'Forsikrede' : 'Insured'}</div>
          </div>
          <div>
            <div className="text-red-300 text-xl font-bold">{total - insured}</div>
            <div className="text-slate-400">{da ? 'Uforsikrede' : 'Uninsured'}</div>
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

          // BIZZ-2084: Aktive dækninger per police — til grøn "Dækket"-visning
          const covByPolicy = new Map<string, AnalyseCoverage[]>();
          for (const cov of detail.coverages ?? []) {
            if (!cov.is_covered) continue;
            const list = covByPolicy.get(cov.policy_id) ?? [];
            list.push(cov);
            covByPolicy.set(cov.policy_id, list);
          }

          // BIZZ-1792: Dedup gaps per check_id
          const dedupGaps = (rawGaps: typeof detail.gaps) => {
            const seen = new Set<string>();
            return rawGaps.filter((g) => {
              const key = g.check_id ?? g.title;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
          };

          // BIZZ-1941: Forsikringsejer-/virksomheds-gaps løftes op i dedikerede
          // sektioner; ejendomsrækker viser kun ejendomsspecifikke gaps (scope='property').
          const ownerGaps = dedupGaps(detail.gaps.filter((g) => gapScope(g.check_id) === 'owner'));
          const companyGaps = dedupGaps(
            detail.gaps.filter((g) => gapScope(g.check_id) === 'company')
          );

          // Byg PropertyGroups
          // BIZZ-1957: Bygnings-/ejendomsspecifikke gaps (scope='property') må kun
          // hænge under ejendoms-aktiver — ikke under virksomheds-aktivet, selv om
          // policen tilfældigvis også er matchet dertil. Ellers lækker fx 'Udvidet
          // vandskade' op på virksomheds-niveau.
          const groups: PropertyGroup[] = uniqueAktiver.map((aktiv) => {
            const aktivGaps =
              aktiv.matched_policy_id && aktiv.type === 'ejendom'
                ? dedupGaps(
                    detail.gaps.filter(
                      (g) =>
                        g.policy_id === aktiv.matched_policy_id &&
                        gapScope(g.check_id) === 'property'
                    )
                  )
                : [];
            return {
              aktiv,
              matchedPolicy: aktiv.matched_policy_id
                ? (polById.get(aktiv.matched_policy_id) ?? null)
                : null,
              gaps: aktivGaps,
              coverages: aktiv.matched_policy_id
                ? (covByPolicy.get(aktiv.matched_policy_id) ?? [])
                : [],
            };
          });

          // BIZZ-1802: Hierarkisk layout — virksomheder → ejendomme → gaps
          const virkGroups = groups.filter((g) => g.aktiv.type === 'virksomhed');
          const ejdGroups = groups.filter((g) => g.aktiv.type === 'ejendom');
          const ejdByCvr = new Map<string, PropertyGroup[]>();
          const orphans: PropertyGroup[] = [];
          for (const eg of ejdGroups) {
            const cvr = (eg.aktiv.raw_data as { ejer_cvr?: string } | null)?.ejer_cvr;
            if (cvr && virkGroups.some((v) => v.aktiv.cvr === cvr)) {
              const list = ejdByCvr.get(cvr) ?? [];
              list.push(eg);
              ejdByCvr.set(cvr, list);
            } else {
              orphans.push(eg);
            }
          }
          // Sortér: flest gaps/uforsikrede først
          const sortGrp = (a: PropertyGroup, b: PropertyGroup) => {
            const aI = a.aktiv.matched_policy_id ? 1 : 0;
            const bI = b.aktiv.matched_policy_id ? 1 : 0;
            if (aI !== bI) return aI - bI;
            return b.gaps.length - a.gaps.length;
          };
          orphans.sort(sortGrp);
          const trees = virkGroups
            .map((v) => ({ v, ejd: (ejdByCvr.get(v.aktiv.cvr ?? '') ?? []).sort(sortGrp) }))
            .sort((a, b) => b.ejd.length - a.ejd.length);

          // BIZZ-1972: Fold forsikringsejer-/virksomheds-findings ind under den
          // eneste virksomhed når den ER forsikringssejeren (samme entitet).
          const foldOwnerIntoCompany = shouldFoldOwnerIntoCompany(
            detail.analyse.kunde_type,
            detail.analyse.kunde_id,
            virkGroups.map((v) => v.aktiv.cvr)
          );

          return (
            <>
              {/* BIZZ-1941: Forsikringsejer-niveau — vises kun her, ikke per ejendom.
                  BIZZ-1972: Skjult i fold-casen (foldet ind under virksomheden). */}
              {!foldOwnerIntoCompany && ownerGaps.length > 0 && (
                <div className="bg-white/5 border border-white/8 rounded-xl p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <Briefcase size={14} className="text-purple-400" />
                    <h4 className="text-white text-sm font-semibold">
                      {da ? 'Forsikringsejer-niveau' : 'Insurance owner level'}
                    </h4>
                    <span className="text-slate-400 text-[11px]">
                      {da
                        ? `${ownerGaps.length} generelle findings`
                        : `${ownerGaps.length} general findings`}
                    </span>
                  </div>
                  <GapList gaps={ownerGaps} da={da} />
                </div>
              )}

              {/* BIZZ-1941: Virksomheds-niveau — gælder porteføljen, ikke per ejendom.
                  BIZZ-1972: Skjult i fold-casen (foldet ind under virksomheden). */}
              {!foldOwnerIntoCompany && companyGaps.length > 0 && (
                <div className="bg-white/5 border border-white/8 rounded-xl p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <Building2 size={14} className="text-blue-400" />
                    <h4 className="text-white text-sm font-semibold">
                      {da ? 'Virksomheds-niveau' : 'Company level'}
                    </h4>
                    <span className="text-slate-400 text-[11px]">
                      {companyGaps.length} findings
                    </span>
                  </div>
                  <GapList gaps={companyGaps} da={da} />
                </div>
              )}

              {trees.map((tree) => (
                <div key={tree.v.aktiv.id} className="space-y-2">
                  <PropertyRow
                    group={
                      foldOwnerIntoCompany
                        ? { ...tree.v, gaps: [...ownerGaps, ...companyGaps] }
                        : tree.v
                    }
                    da={da}
                    foldedNote={foldOwnerIntoCompany}
                  />
                  {tree.ejd.length > 0 && (
                    <div className="ml-6 pl-3 border-l border-white/8 space-y-2">
                      {tree.ejd.map((eg) => (
                        <PropertyRow key={eg.aktiv.id} group={eg} da={da} />
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {orphans.map((g) => (
                <PropertyRow key={g.aktiv.id} group={g} da={da} />
              ))}
            </>
          );
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
      // BIZZ-1631: Filtrer per kunde + sag
      const params = new URLSearchParams();
      if (activeSagId) params.set('sag_id', activeSagId);
      if (selectedCustomer?.id) params.set('kunde_id', selectedCustomer.id);
      const qs = params.toString();
      const url = qs ? `/api/forsikring?${qs}` : '/api/forsikring';
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
  }, [activeSagId, selectedCustomer?.id]);

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
        // BIZZ-1632: Link dokument til valgt kunde
        if (selectedCustomer?.id) formData.append('kunde_id', selectedCustomer.id);
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
                    <ChevronRight size={16} className="text-slate-400" />
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
                    {job.status === 'failed' && (
                      <span className="text-red-400" title={job.error ?? t.parseFailed}>
                        {job.error ?? t.parseFailed}
                      </span>
                    )}
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
                    <span
                      className={`text-xs ml-auto max-w-[300px] truncate ${doc.parse_status === 'failed' ? 'text-red-400' : 'text-slate-400'}`}
                      title={
                        doc.parse_status === 'failed'
                          ? (doc.parse_error ?? t.parseFailed)
                          : doc.parse_status
                      }
                    >
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
                      className="p-1 text-slate-400 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors shrink-0"
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
                <Building2 className="mx-auto text-slate-400 mb-3" size={36} />
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
