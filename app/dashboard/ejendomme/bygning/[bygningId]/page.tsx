/**
 * Bygning-detaljeside.
 *
 * BIZZ-796 iter 1. Route /dashboard/ejendomme/bygning/[bygningId]
 * hvor bygningId er BBR_Bygning.id_lokalId (UUID).
 *
 * Tidligere var bygninger kun synlige som sub-sektioner på en
 * ejendoms-detaljeside — denne route lader brugeren share/bookmarke
 * en specifik bygning (fx "opgang 62B") som sin egen entitet.
 *
 * Data flow:
 *   1. fetchBygningById(id) — BBR GraphQL by id_lokalId
 *   2. Render bygnings-info (anvendelse, areal, opførelsesår, etager)
 *   3. Link til husnummer-adresse (for enheder og videre BBR-data)
 *
 * Iter 2 (BIZZ-796b, parkeret):
 *   * Server-side enheder-liste (BBR_Enhed where bygning = id)
 *   * SFE-lookup via jordstykke for breadcrumb
 *   * Offentlig SEO-rute /ejendom/bygning/[slug]/[id]
 *   * Kort med bygnings-polygon fra BBR WFS
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Building2, Ruler, Calendar, Layers, MapPin } from 'lucide-react';
import { fetchBygningById } from '@/app/lib/fetchBygning';
import { isUdfasetStatusLabel } from '@/app/lib/bbrKoder';
import { fetchBbrStatusForAdresser } from '@/app/lib/bbrEjendomStatus';
import EjendomBreadcrumb from '@/app/components/ejendomme/EjendomBreadcrumb';

export const dynamic = 'force-dynamic';

interface BygningDetailPageProps {
  params: Promise<{ bygningId: string }>;
}

/**
 * Server component — fetcher BBR_Bygning og renderer kort detalje-side.
 */
export default async function BygningDetailPage({ params }: BygningDetailPageProps) {
  const { bygningId } = await params;
  // Guard: id_lokalId skal være UUID-form
  if (!/^[a-f0-9-]{10,}$/i.test(bygningId)) notFound();

  const bygning = await fetchBygningById(bygningId);
  if (!bygning) notFound();

  // BIZZ-825: central udfaset-tjek via isUdfasetStatusLabel. Udfasede
  // bygninger (status 4/10/11) = !statusOk.
  const statusOk = !isUdfasetStatusLabel(bygning.status);

  // BIZZ-832: SFE BFE-lookup via bbr_ejendom_status for breadcrumb.
  // Non-blocking — manglende BFE giver shallow breadcrumb som før.
  let sfeBfe: number | null = null;
  if (bygning.husnummerId) {
    const statusMap = await fetchBbrStatusForAdresser([bygning.husnummerId]);
    const entry = statusMap.get(bygning.husnummerId.toLowerCase());
    sfeBfe = entry?.bfeNummer ?? null;
  }

  return (
    <div className="bg-[#0a1020] min-h-screen">
      <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
        {/* BIZZ-832: Breadcrumb med SFE-link når BFE er bekendt.
            Dashboard → Ejendomme → SFE [bfe] → Bygning X */}
        <EjendomBreadcrumb
          ariaLabel="Breadcrumb"
          levels={[
            { label: 'Dashboard', href: '/dashboard' },
            { label: 'Ejendomme', href: '/dashboard/ejendomme' },
            ...(sfeBfe
              ? [{ label: `SFE ${sfeBfe}`, href: `/dashboard/ejendomme/sfe/${sfeBfe}` }]
              : []),
            { label: `Bygning ${bygning.anvendelse ?? bygning.id.slice(0, 8)}` },
          ]}
        />

        {/* Back-link */}
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 text-slate-400 hover:text-white text-sm transition-colors"
        >
          <ArrowLeft size={14} />
          Tilbage
        </Link>

        {/* Header */}
        <div>
          <div className="flex items-center gap-2 text-xs text-slate-400 mb-2">
            <Building2 size={12} />
            <span>Bygning (BBR)</span>
          </div>
          <h1 className="text-white text-2xl font-bold">
            {bygning.anvendelse ?? 'Ukendt anvendelse'}
          </h1>
          <p className="text-slate-500 text-xs mt-1 font-mono break-all">{bygning.id}</p>
          {bygning.status && (
            <span
              className={`inline-block mt-3 px-2 py-0.5 rounded-full text-xs border ${
                statusOk
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                  : 'bg-red-500/10 border-red-500/30 text-red-300'
              }`}
            >
              {bygning.status}
            </span>
          )}
        </div>

        {/* Key facts grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {bygning.samletBygningsareal != null && (
            <InfoCard
              icon={<Ruler size={14} className="text-blue-400" />}
              label="Samlet areal"
              value={`${bygning.samletBygningsareal} m²`}
            />
          )}
          {bygning.bebyggetAreal != null && (
            <InfoCard
              icon={<Ruler size={14} className="text-blue-400" />}
              label="Bebygget areal"
              value={`${bygning.bebyggetAreal} m²`}
            />
          )}
          {bygning.samletBoligAreal != null && (
            <InfoCard
              icon={<Ruler size={14} className="text-emerald-400" />}
              label="Boligareal"
              value={`${bygning.samletBoligAreal} m²`}
            />
          )}
          {bygning.samletErhvervsAreal != null && (
            <InfoCard
              icon={<Ruler size={14} className="text-amber-400" />}
              label="Erhvervsareal"
              value={`${bygning.samletErhvervsAreal} m²`}
            />
          )}
          {bygning.opfoerelsesaar != null && (
            <InfoCard
              icon={<Calendar size={14} className="text-purple-400" />}
              label="Opført"
              value={String(bygning.opfoerelsesaar)}
            />
          )}
          {bygning.ombygningsaar != null && bygning.ombygningsaar > 0 && (
            <InfoCard
              icon={<Calendar size={14} className="text-purple-400" />}
              label="Om/tilbygget"
              value={String(bygning.ombygningsaar)}
            />
          )}
          {bygning.antalEtager != null && (
            <InfoCard
              icon={<Layers size={14} className="text-slate-300" />}
              label="Etager"
              value={String(bygning.antalEtager)}
            />
          )}
        </div>

        {/* Link til adresse-niveau */}
        {bygning.husnummerId && (
          <Link
            href={`/dashboard/ejendomme/${bygning.husnummerId}`}
            className="flex items-center gap-3 px-4 py-3 rounded-lg bg-[#0f172a] border border-slate-700/50 hover:border-blue-500/40 transition-colors"
          >
            <MapPin size={16} className="text-blue-400 shrink-0" />
            <div className="flex-1">
              <p className="text-white text-sm font-medium">Se adresse-detaljer</p>
              <p className="text-slate-500 text-xs mt-0.5 font-mono">{bygning.husnummerId}</p>
            </div>
          </Link>
        )}

        {/* BIZZ-832: "Tilhører hovedejendom" block */}
        {sfeBfe && (
          <Link
            href={`/dashboard/ejendomme/sfe/${sfeBfe}`}
            className="flex items-center gap-3 px-4 py-3 rounded-lg bg-amber-500/5 border border-amber-500/20 hover:border-amber-500/40 transition-colors"
          >
            <Building2 size={16} className="text-amber-400 shrink-0" />
            <div className="flex-1">
              <p className="text-amber-300 text-sm font-medium">Tilhører hovedejendom</p>
              <p className="text-slate-500 text-xs mt-0.5">SFE {sfeBfe} — Samlet Fast Ejendom</p>
            </div>
          </Link>
        )}
      </div>
    </div>
  );
}

/** Lille info-card til key-facts grid. */
function InfoCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg bg-[#0f172a] border border-slate-700/50 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-slate-400 text-[10px] uppercase tracking-wide mb-1">
        {icon}
        {label}
      </div>
      <p className="text-white text-sm font-semibold">{value}</p>
    </div>
  );
}
