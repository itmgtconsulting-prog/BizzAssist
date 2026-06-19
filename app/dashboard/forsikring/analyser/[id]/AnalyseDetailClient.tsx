'use client';

/**
 * Analyse-detail klient-komponent.
 *
 * BIZZ-1367: Viser header med risk-score, aktiver-tabel med matched
 * policer og gap-badges, og gaps-sektion grupperet efter severity.
 *
 * @param props.analyseId - Analyse UUID
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  ShieldCheck,
  Building2,
  Home,
  Briefcase,
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Download,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { getMatchBegrundelse } from '@/app/lib/forsikring/matchBegrundelse';
import {
  erEjendomUdenAdresse,
  findDelteAdresser,
  visAktivLabelDisambig,
} from '@/app/lib/forsikring/aktivLabel';

interface Analyse {
  id: string;
  kunde_type: string;
  kunde_id: string;
  kunde_navn: string | null;
  total_aktiver: number;
  insured_count: number;
  uninsured_count: number;
  total_risk_score: number;
  summary: Record<string, unknown> | null;
  created_at: string;
}

interface Aktiv {
  id: string;
  type: string;
  label: string;
  bfe: number | null;
  cvr: string | null;
  adresse: string | null;
  matched_policy_id: string | null;
  match_score: number | null;
  /** BIZZ-2108: koncern-metadata fra koncernWalk (ejerandel_pct, minoritet) */
  raw_data: {
    ejerandel_pct?: number | string | null;
    minoritet?: boolean;
    /** BIZZ-2123: ejendommen er administreret (ejf_administrator), ikke ejet */
    administreret?: boolean;
  } | null;
}

interface Gap {
  id: string;
  check_id: string;
  severity: string;
  title: string;
  description: string;
  recommendation: string | null;
}

/**
 * Analyse-detail UI.
 *
 * @param props.analyseId - Analyse UUID
 * @returns JSX
 */
export default function AnalyseDetailClient({ analyseId }: { analyseId: string }) {
  const { lang } = useLanguage();
  const da = lang === 'da';

  const [loading, setLoading] = useState(true);
  const [analyse, setAnalyse] = useState<Analyse | null>(null);
  const [aktiver, setAktiver] = useState<Aktiv[]>([]);
  const [gaps, setGaps] = useState<Gap[]>([]);

  useEffect(() => {
    fetch(`/api/forsikring/analyser/${analyseId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) {
          setAnalyse(data.analyse);
          setAktiver(data.aktiver ?? []);
          setGaps(data.gaps ?? []);
        }
      })
      .finally(() => setLoading(false));
  }, [analyseId]);

  // BIZZ-2149: Adresser delt af flere distinkte ejendoms-BFE'er (ejerlejligheder
  // med samme gade-adresse) disambigueres med et BFE-suffix i tabellen.
  const delteAdresser = useMemo(() => findDelteAdresser(aktiver, da), [aktiver, da]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="animate-spin text-blue-400" size={32} />
      </div>
    );
  }

  if (!analyse) {
    return (
      <div className="max-w-5xl mx-auto p-6 text-center text-slate-400">
        {da ? 'Analyse ikke fundet' : 'Analysis not found'}
      </div>
    );
  }

  const criticalGaps = gaps.filter((g) => g.severity === 'critical');
  const warningGaps = gaps.filter((g) => g.severity === 'warning');
  const infoGaps = gaps.filter((g) => g.severity === 'info');

  // BIZZ-1973: Policer der dækker en adresse uden for kundens portefølje
  const addressMismatches = Array.isArray(analyse.summary?.address_mismatches)
    ? (analyse.summary.address_mismatches as Array<{
        policy_number: string;
        insurer_name: string;
        property_address: string | null;
        is_policyholder_address: boolean;
      }>)
    : [];

  /** Ikon for aktiv-type */
  const typeIcon = (type: string) => {
    switch (type) {
      case 'ejendom':
        return <Home size={14} className="text-emerald-400" />;
      case 'virksomhed':
        return <Building2 size={14} className="text-blue-400" />;
      case 'bestyrelsespost':
        return <Briefcase size={14} className="text-purple-400" />;
      default:
        return <ShieldCheck size={14} className="text-slate-400" />;
    }
  };

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          href="/dashboard/forsikring"
          className="text-slate-400 hover:text-white transition-colors"
        >
          <ArrowLeft size={18} />
        </Link>
        <div>
          <h1 className="text-white text-xl font-bold">
            {analyse.kunde_navn ?? `${analyse.kunde_type} ${analyse.kunde_id}`}
          </h1>
          <p className="text-slate-400 text-xs">
            {da ? 'Gap-analyse' : 'Gap analysis'} —{' '}
            {new Date(analyse.created_at).toLocaleDateString('da-DK')}
          </p>
        </div>
        {/* BIZZ-1618: Eksport-knapper — DOCX (primær) + CSV (sekundær) */}
        <div className="ml-auto flex items-center gap-2">
          <a
            href={`/api/forsikring/analyser/${analyseId}/eksport?format=docx`}
            download
            className="bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5"
          >
            <Download size={13} />
            {da ? 'Download rapport' : 'Download report'}
          </a>
          <a
            href={`/api/forsikring/analyser/${analyseId}/eksport?format=csv`}
            download
            className="bg-slate-700 hover:bg-slate-600 text-slate-200 px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5"
          >
            <Download size={13} />
            CSV
          </a>
        </div>
      </div>

      {/* KPI tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-4 text-center">
          <div className="text-blue-300 text-2xl font-bold">{analyse.total_aktiver}</div>
          <div className="text-slate-400 text-xs mt-1">{da ? 'Aktiver' : 'Assets'}</div>
        </div>
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4 text-center">
          <div className="text-emerald-300 text-2xl font-bold">{analyse.insured_count}</div>
          <div className="text-slate-400 text-xs mt-1">{da ? 'Forsikrede' : 'Insured'}</div>
        </div>
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-center">
          <div className="text-red-300 text-2xl font-bold">{analyse.uninsured_count}</div>
          <div className="text-slate-400 text-xs mt-1">{da ? 'Uforsikrede' : 'Uninsured'}</div>
        </div>
        <div
          className={`${analyse.total_risk_score >= 51 ? 'bg-red-500/10 border-red-500/30' : 'bg-amber-500/10 border-amber-500/30'} border rounded-xl p-4 text-center`}
        >
          <div
            className={`${analyse.total_risk_score >= 51 ? 'text-red-300' : 'text-amber-300'} text-2xl font-bold`}
          >
            {analyse.total_risk_score}
          </div>
          <div className="text-slate-400 text-xs mt-1">Risk score</div>
        </div>
      </div>

      {/* BIZZ-1973: Advarsel — policer der dækker en adresse uden for porteføljen */}
      {addressMismatches.length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4 flex items-start gap-3">
          <AlertTriangle size={18} className="text-amber-400 shrink-0 mt-0.5" />
          <div className="text-sm">
            <h2 className="text-amber-200 font-semibold">
              {da
                ? `${addressMismatches.length} police${addressMismatches.length === 1 ? '' : 'r'} dækker en adresse uden for porteføljen`
                : `${addressMismatches.length} polic${addressMismatches.length === 1 ? 'y' : 'ies'} cover an address outside the portfolio`}
            </h2>
            <p className="text-slate-300 text-xs mt-1">
              {da
                ? 'Følgende policer dækker en ejendom der hverken ejes eller administreres af forsikringssejeren. Verificér at dokumentet hører til denne kunde.'
                : 'The following policies cover a property neither owned nor administered by the policyholder. Verify the document belongs to this customer.'}
            </p>
            <ul className="mt-2 space-y-1">
              {addressMismatches.map((m, i) => (
                <li key={i} className="text-xs text-amber-100">
                  <span className="font-medium">
                    {m.property_address ?? (da ? 'Ukendt adresse' : 'Unknown address')}
                  </span>
                  <span className="text-slate-400">
                    {' '}
                    — {m.insurer_name} · {da ? 'Police' : 'Policy'} {m.policy_number}
                    {m.is_policyholder_address &&
                      (da ? ' · forsikringstagers egen adresse' : " · policyholder's own address")}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Aktiver-tabel */}
      <section className="bg-white/5 border border-white/8 rounded-2xl overflow-hidden">
        <h2 className="text-white font-semibold text-sm px-4 py-3 border-b border-white/8">
          {da ? 'Aktiver' : 'Assets'} ({aktiver.length})
        </h2>
        <table className="w-full text-sm">
          <thead className="bg-white/3 text-slate-400 text-xs">
            <tr>
              <th className="px-4 py-2 text-left">{da ? 'Type' : 'Type'}</th>
              <th className="px-4 py-2 text-left">{da ? 'Aktiv' : 'Asset'}</th>
              <th className="px-4 py-2 text-left">{da ? 'Adresse/ID' : 'Address/ID'}</th>
              <th className="px-4 py-2 text-center">{da ? 'Match' : 'Match'}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {aktiver.map((a) => (
              <tr key={a.id} className="hover:bg-white/3">
                <td className="px-4 py-2.5 flex items-center gap-2">
                  {typeIcon(a.type)}
                  <span className="text-slate-400 text-xs capitalize">{a.type}</span>
                </td>
                <td className="px-4 py-2.5 text-white">
                  <span className="inline-flex items-center gap-1.5">
                    {visAktivLabelDisambig(a, da, delteAdresser)}
                    {/* BIZZ-2150: gul badge når ejendommen mangler adresse */}
                    {erEjendomUdenAdresse(a) && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 shrink-0">
                        {da ? 'Ingen adresse' : 'No address'}
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-slate-400">{a.adresse ?? a.cvr ?? a.bfe ?? '—'}</td>
                <td className="px-4 py-2.5 text-center">
                  {/* BIZZ-2080: Vis match-begrundelse + score så brugeren kan
                      vurdere om police→aktiv-koblingen er rigtig */}
                  {a.matched_policy_id ? (
                    <div className="flex flex-col items-center gap-0.5">
                      <CheckCircle2 size={14} className="text-emerald-400" />
                      {a.match_score != null && (
                        <span className="text-[10px] text-slate-400">
                          {getMatchBegrundelse(a.type, a.match_score, da)} ({a.match_score}/100)
                        </span>
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-0.5">
                      <AlertCircle size={14} className="text-red-400" />
                      <span className="text-[10px] text-slate-400">
                        {da ? 'Ingen police matchet' : 'No policy matched'}
                      </span>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Gaps */}
      {gaps.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-white font-semibold text-sm">
            {da ? 'Detekterede gaps' : 'Detected gaps'} ({gaps.length})
          </h2>

          {criticalGaps.length > 0 && (
            <div className="space-y-2">
              {criticalGaps.map((g) => (
                <div
                  key={g.id}
                  className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <AlertTriangle size={14} className="text-red-400" />
                    <span className="text-red-300 text-sm font-medium">{g.title}</span>
                  </div>
                  <p className="text-slate-400 text-xs">{g.description}</p>
                  {g.recommendation && (
                    <p className="text-slate-400 text-xs mt-1 italic">{g.recommendation}</p>
                  )}
                </div>
              ))}
            </div>
          )}

          {warningGaps.length > 0 && (
            <div className="space-y-2">
              {warningGaps.map((g) => (
                <div
                  key={g.id}
                  className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <AlertCircle size={14} className="text-amber-400" />
                    <span className="text-amber-300 text-sm font-medium">{g.title}</span>
                  </div>
                  <p className="text-slate-400 text-xs">{g.description}</p>
                </div>
              ))}
            </div>
          )}

          {infoGaps.length > 0 && (
            <div className="space-y-2">
              {infoGaps.map((g) => (
                <div
                  key={g.id}
                  className="bg-slate-500/10 border border-slate-500/30 rounded-xl px-4 py-3"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <ShieldCheck size={14} className="text-slate-400" />
                    <span className="text-slate-300 text-sm font-medium">{g.title}</span>
                  </div>
                  <p className="text-slate-400 text-xs">{g.description}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* BIZZ-1386: Koncern-visualisering med forsikringsstatus */}
      {aktiver.length > 0 && (
        <section className="bg-white/5 border border-white/8 rounded-2xl p-5">
          <h2 className="text-white font-semibold text-sm mb-4">
            {da ? 'Koncern-overblik' : 'Corporate overview'}
          </h2>
          <div className="space-y-4">
            {(['ejendom', 'virksomhed', 'bestyrelsespost'] as const).map((type) => {
              const items = aktiver.filter((a) => a.type === type);
              if (items.length === 0) return null;
              const matched = items.filter((a) => a.matched_policy_id).length;
              return (
                <div key={type}>
                  <div className="flex items-center gap-2 mb-2">
                    {typeIcon(type)}
                    <span className="text-slate-300 text-xs font-medium capitalize">{type}</span>
                    <span className="text-slate-400 text-xs">
                      ({matched}/{items.length} {da ? 'forsikrede' : 'insured'})
                    </span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1.5">
                    {items.map((a) => {
                      // BIZZ-2108: Ejerandel-badge på virksomheder med < 100% —
                      // minoritetsposter skal tydeligt adskilles fra døtre.
                      const pctRaw = a.raw_data?.ejerandel_pct;
                      const pct =
                        a.type === 'virksomhed' &&
                        pctRaw != null &&
                        Number.isFinite(Number(pctRaw)) &&
                        Number(pctRaw) < 100
                          ? Number(pctRaw)
                          : null;
                      return (
                        <div
                          key={a.id}
                          className={`rounded-lg px-2.5 py-2 text-xs border ${
                            a.matched_policy_id
                              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                              : 'bg-red-500/10 border-red-500/30 text-red-300'
                          }`}
                        >
                          <div className="truncate font-medium">
                            {a.label}
                            {/* BIZZ-2123: Markér administrerede (ikke-ejede) ejendomme */}
                            {a.type === 'ejendom' && a.raw_data?.administreret && (
                              <span
                                className="ml-1.5 text-[9px] px-1 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 align-middle"
                                title={
                                  da
                                    ? 'Kunden administrerer ejendommen uden at stå som ejer'
                                    : 'The customer administers the property without being the owner'
                                }
                              >
                                {da ? 'Administreret' : 'Administered'}
                              </span>
                            )}
                            {pct != null && (
                              <span
                                className="ml-1.5 text-[9px] px-1 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 align-middle"
                                title={
                                  da
                                    ? 'Ejerandel — under 50% er en minoritetspost'
                                    : 'Ownership share — below 50% is a minority stake'
                                }
                              >
                                {pct}%
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] opacity-70 mt-0.5">
                            {a.matched_policy_id
                              ? da
                                ? '✓ Forsikret'
                                : '✓ Insured'
                              : da
                                ? '✗ Uforsikret'
                                : '✗ Uninsured'}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {gaps.length === 0 && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-2xl p-6 text-center">
          <CheckCircle2 className="mx-auto text-emerald-400 mb-2" size={28} />
          <p className="text-emerald-300 font-medium">
            {da ? 'Ingen gaps detekteret' : 'No gaps detected'}
          </p>
          <p className="text-slate-400 text-xs mt-1">
            {da ? 'Alle aktiver er forsikrede.' : 'All assets are insured.'}
          </p>
        </div>
      )}
    </div>
  );
}
