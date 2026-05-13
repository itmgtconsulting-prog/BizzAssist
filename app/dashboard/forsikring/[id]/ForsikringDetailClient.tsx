'use client';

/**
 * Forsikrings-detail-side — /dashboard/forsikring/[id]
 *
 * Sektioner:
 *   1. Tilbage-link + headline (police-nr + selskab)
 *   2. Metadata-grid (forsikringstager, ejendom, præmie, dato)
 *   3. Dækninger (covered + ikke-covered med ikon-prefix)
 *   4. Detekterede gaps (severity-grupperet, recommendation, kilde-data)
 *   5. Slet-knap (admin)
 *
 * Data fetches fra GET /api/forsikring/[id]. Sletning kalder DELETE og
 * navigerer tilbage til oversigten.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  ShieldCheck,
  AlertCircle,
  AlertTriangle,
  Info,
  CheckCircle2,
  XCircle,
  Trash2,
  Building2,
  Calendar,
  CircleDollarSign,
  FileText,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { translations } from '@/app/lib/translations';
import type {
  ForsikringPolicy,
  ForsikringCoverage,
  ForsikringGap,
  GapSeverity,
} from '@/app/lib/forsikring/types';

interface DetailResponse {
  policy: ForsikringPolicy;
  coverages: ForsikringCoverage[];
  gaps: ForsikringGap[];
}

/** Format DKK with Danish thousand separators */
function formatDkk(n: number | null): string {
  if (n === null) return '—';
  return `${n.toLocaleString('da-DK')} kr`;
}

/** Format ISO date as Danish locale */
function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('da-DK', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Map severity to icon + color tokens */
function severityStyle(severity: GapSeverity) {
  switch (severity) {
    case 'critical':
      return {
        Icon: AlertCircle,
        color: 'text-red-300',
        bg: 'bg-red-500/10',
        border: 'border-red-500/30',
      };
    case 'warning':
      return {
        Icon: AlertTriangle,
        color: 'text-amber-300',
        bg: 'bg-amber-500/10',
        border: 'border-amber-500/30',
      };
    case 'info':
      return {
        Icon: Info,
        color: 'text-slate-300',
        bg: 'bg-slate-500/10',
        border: 'border-slate-500/30',
      };
  }
}

interface Props {
  policyId: string;
}

export default function ForsikringDetailClient({ policyId }: Props): React.ReactElement {
  const router = useRouter();
  const { lang } = useLanguage();
  const t = translations[lang].forsikring;

  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/forsikring/${policyId}`, { cache: 'no-store' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as DetailResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ukendt fejl');
    } finally {
      setLoading(false);
    }
  }, [policyId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleDelete = useCallback(async () => {
    if (!confirm(t.confirmDelete)) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/forsikring/${policyId}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Sletning fejlede');
      }
      router.push('/dashboard/forsikring');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sletning fejlede');
      setDeleting(false);
    }
  }, [policyId, router, t]);

  if (loading)
    return <div className="p-6 text-sm text-slate-400">{translations[lang].common.loading}</div>;
  if (error) {
    return (
      <div className="p-6 space-y-3">
        <Link
          href="/dashboard/forsikring"
          className="inline-flex items-center gap-1 text-sm text-blue-300 hover:text-blue-200"
        >
          <ArrowLeft size={14} /> {t.detailBack}
        </Link>
        <div className="rounded-xl bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm text-red-200 flex items-center gap-2">
          <AlertCircle size={16} />
          {error}
        </div>
      </div>
    );
  }
  if (!data) return <div className="p-6 text-sm text-slate-400">—</div>;

  const { policy, coverages, gaps } = data;
  const insuranceFormLabel = policy.insurance_form ? t.insuranceForm[policy.insurance_form] : null;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-[#0a1020] text-slate-100 min-h-screen">
      {/* Tilbage-link */}
      <Link
        href="/dashboard/forsikring"
        className="inline-flex items-center gap-1 text-sm text-blue-300 hover:text-blue-200"
      >
        <ArrowLeft size={14} /> {t.detailBack}
      </Link>

      {/* Headline */}
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="flex items-center gap-3 text-2xl font-semibold">
            <ShieldCheck className="text-blue-400" size={28} />
            {policy.policy_number}
          </h1>
          <p className="text-sm text-slate-400">
            {policy.insurer_name} · {policy.policyholder_name}
          </p>
        </div>
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-red-500/10 border border-red-500/30 text-red-300 hover:bg-red-500/20 transition-colors disabled:opacity-50"
          aria-label={t.delete}
        >
          <Trash2 size={14} />
          {t.delete}
        </button>
      </header>

      {/* Metadata-grid */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <MetadataCard icon={Building2} title={t.colAddress}>
          <div>{policy.property_address ?? '—'}</div>
          {policy.property_matrikel && (
            <div className="text-xs text-slate-400 mt-1">Matr. {policy.property_matrikel}</div>
          )}
          {policy.business_activity && (
            <div className="text-xs text-slate-400 mt-1">{policy.business_activity}</div>
          )}
        </MetadataCard>

        <MetadataCard icon={FileText} title={t.detailMetadata}>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            {policy.building_area_m2 !== null && (
              <>
                <dt className="text-slate-400">Areal</dt>
                <dd>{policy.building_area_m2} m²</dd>
              </>
            )}
            {policy.building_year_built !== null && (
              <>
                <dt className="text-slate-400">Opført</dt>
                <dd>{policy.building_year_built}</dd>
              </>
            )}
            {policy.building_floors !== null && (
              <>
                <dt className="text-slate-400">Etager</dt>
                <dd>{policy.building_floors}</dd>
              </>
            )}
            {insuranceFormLabel && (
              <>
                <dt className="text-slate-400">Form</dt>
                <dd>{insuranceFormLabel}</dd>
              </>
            )}
          </dl>
        </MetadataCard>

        <MetadataCard icon={CircleDollarSign} title={t.colPremium}>
          <div className="text-xl font-semibold">{formatDkk(policy.annual_premium_dkk)}</div>
          {policy.general_deductible_dkk !== null && (
            <div className="text-xs text-slate-400 mt-1">
              {t.detailDeductible}: {formatDkk(policy.general_deductible_dkk)}
            </div>
          )}
        </MetadataCard>

        <MetadataCard icon={Calendar} title={t.colExpires}>
          <div>{formatDate(policy.effective_to)}</div>
          {policy.main_renewal_date && (
            <div className="text-xs text-slate-400 mt-1">
              Hovedforfald: {formatDate(policy.main_renewal_date)}
            </div>
          )}
        </MetadataCard>
      </section>

      {/* Dækninger */}
      <section className="bg-white/5 border border-white/8 rounded-2xl">
        <header className="px-4 py-3 border-b border-white/5 text-sm font-medium text-slate-300">
          {t.detailCoverages} ({coverages.length})
        </header>
        <div className="divide-y divide-white/5">
          {coverages.map((c) => (
            <div key={c.id} className="px-4 py-3 flex items-start gap-3 text-sm">
              {c.is_covered ? (
                <CheckCircle2 size={16} className="text-emerald-400 mt-0.5 shrink-0" />
              ) : (
                <XCircle size={16} className="text-slate-500 mt-0.5 shrink-0" />
              )}
              <div className="flex-1">
                <div className={c.is_covered ? '' : 'text-slate-500 line-through'}>
                  {c.coverage_label}
                </div>
                {(c.sum_dkk !== null || c.deductible_dkk !== null) && c.is_covered && (
                  <div className="text-xs text-slate-400 mt-0.5">
                    {c.sum_dkk !== null && (
                      <>
                        {t.detailSum}: {formatDkk(c.sum_dkk)}{' '}
                      </>
                    )}
                    {c.deductible_dkk !== null && (
                      <>
                        · {t.detailDeductible}: {formatDkk(c.deductible_dkk)}
                      </>
                    )}
                  </div>
                )}
                {c.notes && <div className="text-xs text-slate-500 italic mt-0.5">{c.notes}</div>}
              </div>
            </div>
          ))}
          {coverages.length === 0 && (
            <div className="px-4 py-6 text-sm text-slate-500 text-center">—</div>
          )}
        </div>
      </section>

      {/* Gaps */}
      <section className="bg-white/5 border border-white/8 rounded-2xl">
        <header className="px-4 py-3 border-b border-white/5 text-sm font-medium text-slate-300">
          {t.detailGaps} ({gaps.length})
        </header>
        {gaps.length === 0 ? (
          <div className="px-4 py-8 text-sm text-emerald-300 text-center flex items-center justify-center gap-2">
            <CheckCircle2 size={16} />
            {t.noGaps}
          </div>
        ) : (
          <ul className="divide-y divide-white/5">
            {gaps.map((g) => {
              const style = severityStyle(g.severity);
              return (
                <li
                  key={g.id}
                  className={`px-4 py-3 flex items-start gap-3 text-sm border-l-2 ${style.border}`}
                >
                  <style.Icon size={18} className={`${style.color} mt-0.5 shrink-0`} />
                  <div className="flex-1">
                    <div className="font-medium">{g.title}</div>
                    <p className="text-xs text-slate-400 mt-1">{g.description}</p>
                    {g.recommendation && (
                      <p className="text-xs text-blue-200 mt-2">
                        <span className="font-medium">{t.gapRecommendation}: </span>
                        {g.recommendation}
                      </p>
                    )}
                  </div>
                  <span
                    className={`px-2 py-0.5 text-[10px] uppercase tracking-wide rounded ${style.bg} ${style.color}`}
                  >
                    {t.severity[g.severity]}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

// ─── Sub-component ───────────────────────────────────────────────

interface MetadataCardProps {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  children: React.ReactNode;
}

/**
 * Metadata-card med ikon-header. Bruges til police-overblik (areal,
 * præmie, datoer, ejendom).
 */
function MetadataCard({ icon: Icon, title, children }: MetadataCardProps): React.ReactElement {
  return (
    <div className="bg-white/5 border border-white/8 rounded-2xl p-5 space-y-2">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-400">
        <Icon size={14} className="text-blue-300" />
        {title}
      </div>
      <div className="text-slate-100">{children}</div>
    </div>
  );
}
