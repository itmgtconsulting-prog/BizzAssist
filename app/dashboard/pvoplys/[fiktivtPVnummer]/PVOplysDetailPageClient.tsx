'use client';

/**
 * BIZZ-483: PVOplysDetailPageClient — minimal-viable detaljeside for parter
 * uden CVR/CPR (dødsboer, fonde, udenlandske ejere, administratorer).
 *
 * Pt. viser kun data passed via URL-search-params fra hvor brugeren klikkede
 * (ejerskabs-listen). Når EJF Custom_PVOplys grant er på plads kan vi
 * berige med flere felter (relaterede ejendomme, registreringsdato,
 * landekode-flag etc.).
 *
 * Future: Endpoint /api/pvoplys/[fiktivtPVnummer] der queryer EJF for
 * deltager-info + alle ejendomme parten ejer.
 */

import { use } from 'react';
import Link from 'next/link';
import { ArrowLeft, AlertTriangle, MapPin, Globe, User } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

interface PageProps {
  params: Promise<{ fiktivtPVnummer: string }>;
  searchParams?: Promise<Record<string, string | string[]>>;
}

const TYPE_LABELS: Record<string, { da: string; en: string; color: string }> = {
  dodsbo: {
    da: 'Dødsbo',
    en: 'Estate',
    color: 'bg-slate-700/40 text-slate-300 border-slate-600/40',
  },
  fond: {
    da: 'Fond',
    en: 'Foundation',
    color: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
  },
  udenlandsk: {
    da: 'Udenlandsk ejer',
    en: 'Foreign owner',
    color: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  },
  forening: {
    da: 'Forening',
    en: 'Association',
    color: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
  },
  administrator: {
    da: 'Administrator',
    en: 'Administrator',
    color: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  },
  default: {
    da: 'Anden part',
    en: 'Other party',
    color: 'bg-slate-700/40 text-slate-300 border-slate-600/40',
  },
};

function getString(
  searchParams: Record<string, string | string[]> | undefined,
  key: string
): string | null {
  if (!searchParams) return null;
  const v = searchParams[key];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length > 0) return v[0];
  return null;
}

export default function PVOplysDetailPageClient(props: PageProps) {
  const { fiktivtPVnummer } = use(props.params);
  const searchParams = props.searchParams ? use(props.searchParams) : undefined;
  const { lang } = useLanguage();
  const da = lang === 'da';

  const navn = getString(searchParams, 'navn') ?? `PV ${fiktivtPVnummer}`;
  const typeKey = (getString(searchParams, 'type') ?? 'default').toLowerCase();
  const typeMeta = TYPE_LABELS[typeKey] ?? TYPE_LABELS.default;
  const landekode = getString(searchParams, 'landekode');
  const udlandsadresse = getString(searchParams, 'adresse');
  const administrator = getString(searchParams, 'administrator');

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <Link
        href="/dashboard/ejendomme"
        className="inline-flex items-center gap-2 text-slate-400 hover:text-blue-400 transition-colors text-sm"
      >
        <ArrowLeft size={14} />
        {da ? 'Tilbage' : 'Back'}
      </Link>

      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-slate-800 border border-slate-700/50 flex items-center justify-center">
            <User size={18} className="text-slate-400" />
          </div>
          <h1 className="text-2xl font-semibold text-white">{navn}</h1>
        </div>
        <div className="flex flex-wrap gap-2 mt-2">
          <span
            className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs border ${typeMeta.color}`}
          >
            {da ? typeMeta.da : typeMeta.en}
          </span>
          <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs bg-slate-800 border border-slate-700/50 text-slate-300 font-mono">
            PV {fiktivtPVnummer}
          </span>
        </div>
      </div>

      <div className="bg-slate-800/40 border border-slate-700/40 rounded-2xl p-6 space-y-4 max-w-2xl">
        <div className="flex items-start gap-2 text-amber-300 text-xs bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          <p>
            {da
              ? 'PVOplys-parter har intet CVR/CPR. Data hentes pt. fra ejerskabs-listen — fuldt EJF Custom_PVOplys-opslag kommer senere når Datafordeler grant er på plads.'
              : 'PVOplys parties have no CVR/CPR. Data is currently sourced from the ownership list — full EJF Custom_PVOplys lookup will be added later when Datafordeler grant is in place.'}
          </p>
        </div>

        {landekode && (
          <div className="flex items-baseline gap-3">
            <Globe size={14} className="text-slate-500 flex-shrink-0" />
            <div>
              <p className="text-[10px] uppercase tracking-wider text-slate-500">
                {da ? 'Landekode' : 'Country code'}
              </p>
              <p className="text-sm text-slate-200">{landekode}</p>
            </div>
          </div>
        )}

        {udlandsadresse && (
          <div className="flex items-baseline gap-3">
            <MapPin size={14} className="text-slate-500 flex-shrink-0" />
            <div>
              <p className="text-[10px] uppercase tracking-wider text-slate-500">
                {da ? 'Udenlandsk adresse' : 'Foreign address'}
              </p>
              <p className="text-sm text-slate-200 whitespace-pre-line">{udlandsadresse}</p>
            </div>
          </div>
        )}

        {administrator && (
          <div className="flex items-baseline gap-3">
            <User size={14} className="text-slate-500 flex-shrink-0" />
            <div>
              <p className="text-[10px] uppercase tracking-wider text-slate-500">
                {da ? 'Administrator' : 'Administrator'}
              </p>
              <p className="text-sm text-slate-200">{administrator}</p>
            </div>
          </div>
        )}

        {!landekode && !udlandsadresse && !administrator && (
          <p className="text-slate-400 text-sm">
            {da
              ? 'Ingen yderligere data passed fra kilde-siden.'
              : 'No additional data passed from the source page.'}
          </p>
        )}
      </div>
    </div>
  );
}
