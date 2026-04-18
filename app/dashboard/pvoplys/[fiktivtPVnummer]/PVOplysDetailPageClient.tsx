'use client';

/**
 * BIZZ-483: Detaljeside for EJF_PersonVirksomhedsoplys-parter.
 *
 * Håndterer parter uden CVR/CPR:
 *   - Dødsboer ("Boet efter X")
 *   - Udenlandske selskaber og personer (vist med udlandsadresse + landekode)
 *   - Fonde og stiftelser uden CVR
 *   - Administratorer (advokater, bobestyrer)
 *
 * Data kommer fra /api/pvoplys/[fiktivtPVnummer] som slår op i
 * EJF_PersonVirksomhedsoplys og reverse-lookup'er ejede ejendomme via
 * EJFCustom_EjerskabBegraenset.
 */

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, User, Home, Globe, AlertCircle } from 'lucide-react';
import TabLoadingSpinner from '@/app/components/TabLoadingSpinner';
import { useLanguage } from '@/app/context/LanguageContext';
import { logger } from '@/app/lib/logger';
import type { PVOplysPart, PVOplysEjendom } from '@/app/api/pvoplys/[fiktivtPVnummer]/route';

/** Next.js App Router props — params er Promise i Next 16 */
interface Props {
  params: Promise<{ fiktivtPVnummer: string }>;
}

/**
 * Gætter på parts-type ud fra navnet. Dødsboer begynder typisk med "Boet
 * efter" eller "Bo efter". Hvis partens landekode er sat (og ikke Danmark)
 * vurderes parten som udenlandsk. Ellers falder vi tilbage til "Andet".
 *
 * @param part - Part-data fra API
 * @param lang - UI-sprog
 */
function bestemParttype(part: PVOplysPart, lang: 'da' | 'en'): { label: string; color: string } {
  const navn = (part.navn ?? '').toLowerCase();
  if (navn.startsWith('boet efter') || navn.startsWith('bo efter')) {
    return {
      label: lang === 'da' ? 'Dødsbo' : 'Estate',
      color: 'text-slate-300 bg-slate-700/30 border-slate-500/30',
    };
  }
  if (navn.includes('fond') || navn.includes('stiftelse')) {
    return {
      label: lang === 'da' ? 'Fond' : 'Foundation',
      color: 'text-purple-300 bg-purple-900/40 border-purple-500/30',
    };
  }
  // Dansk landekode 208 i ISO 3166-1 numerisk. Alt andet = udenlandsk.
  if (part.landekode && part.landekode !== '208') {
    return {
      label: lang === 'da' ? 'Udenlandsk ejer' : 'Foreign owner',
      color: 'text-amber-300 bg-amber-900/40 border-amber-500/30',
    };
  }
  return {
    label: lang === 'da' ? 'Anden part' : 'Other party',
    color: 'text-slate-400 bg-slate-700/20 border-slate-500/20',
  };
}

export default function PVOplysDetailPageClient({ params }: Props) {
  const { fiktivtPVnummer } = use(params);
  const { lang } = useLanguage();
  const da = lang === 'da';

  const [part, setPart] = useState<PVOplysPart | null>(null);
  const [ejendomme, setEjendomme] = useState<PVOplysEjendom[]>([]);
  const [loading, setLoading] = useState(true);
  const [fejl, setFejl] = useState<string | null>(null);
  const [manglerAdgang, setManglerAdgang] = useState(false);

  useEffect(() => {
    setLoading(true);
    setFejl(null);
    const controller = new AbortController();

    fetch(`/api/pvoplys/${fiktivtPVnummer}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => {
        setPart(data.part ?? null);
        setEjendomme(Array.isArray(data.ejendomme) ? data.ejendomme : []);
        setManglerAdgang(Boolean(data.manglerAdgang));
        setFejl(data.fejl ?? null);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          logger.error('[pvoplys] fetch error:', err);
          setFejl(da ? 'Kunne ikke hente data' : 'Failed to load data');
        }
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [fiktivtPVnummer, da]);

  if (loading) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <TabLoadingSpinner label={da ? 'Henter partoplysninger…' : 'Loading party details…'} />
      </div>
    );
  }

  const parttype = part ? bestemParttype(part, lang) : null;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Back link */}
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200 transition-colors"
      >
        <ArrowLeft size={14} />
        {da ? 'Tilbage' : 'Back'}
      </Link>

      {/* Manglende adgang */}
      {manglerAdgang && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 flex items-start gap-3">
          <AlertCircle size={18} className="text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-amber-300 text-sm">
            {da
              ? 'Adgang til Ejerfortegnelsen (EJF) er ikke godkendt endnu. Ansøg om Dataadgang på datafordeler.dk.'
              : 'Access to the Danish land registry (EJF) has not been approved yet.'}
          </p>
        </div>
      )}

      {/* Fejl */}
      {fejl && !manglerAdgang && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 flex items-start gap-3">
          <AlertCircle size={18} className="text-red-400 flex-shrink-0 mt-0.5" />
          <p className="text-red-300 text-sm">{fejl}</p>
        </div>
      )}

      {/* Part ikke fundet */}
      {!part && !loading && !manglerAdgang && !fejl && (
        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-8 text-center">
          <User size={40} className="text-slate-600 mx-auto mb-3" />
          <h1 className="text-white text-lg font-semibold mb-1">
            {da ? 'Part ikke fundet' : 'Party not found'}
          </h1>
          <p className="text-slate-400 text-sm">
            {da
              ? `Ingen EJF-part med fiktivtPVnummer ${fiktivtPVnummer}`
              : `No EJF party with fiktivtPVnummer ${fiktivtPVnummer}`}
          </p>
        </div>
      )}

      {/* Part header + detaljer */}
      {part && parttype && (
        <>
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center flex-shrink-0">
                <User size={18} className="text-amber-400" />
              </div>
              <h1 className="text-white text-2xl font-bold leading-tight">
                {part.navn ?? (da ? 'Ukendt part' : 'Unknown party')}
              </h1>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`text-xs font-medium px-2.5 py-0.5 rounded-full border ${parttype.color}`}
              >
                {parttype.label}
              </span>
              <span className="text-xs text-slate-500 font-mono">PV {part.fiktivtPVnummer}</span>
              {part.status && (
                <span className="text-xs text-slate-400 bg-slate-800/60 px-2 py-0.5 rounded-full">
                  {part.status}
                </span>
              )}
              {part.virkningTil && (
                <span className="text-xs text-slate-500 bg-slate-800/40 px-2 py-0.5 rounded-full">
                  {da ? 'Afsluttet' : 'Ended'}:{' '}
                  {new Date(part.virkningTil).toLocaleDateString(da ? 'da-DK' : 'en-GB', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                  })}
                </span>
              )}
            </div>
          </div>

          {/* Adresse + landekode */}
          {(part.udlandsadresse || part.adresseLokalId || part.landekode) && (
            <div className="bg-slate-800/40 border border-slate-700/40 rounded-2xl p-5 space-y-2">
              <h2 className="text-white font-semibold text-sm flex items-center gap-2">
                <Globe size={15} className="text-slate-400" />
                {da ? 'Adresse' : 'Address'}
              </h2>
              {part.udlandsadresse && (
                <p className="text-slate-300 text-sm whitespace-pre-line">{part.udlandsadresse}</p>
              )}
              {part.landekode && (
                <p className="text-slate-500 text-xs">
                  {da ? 'Landekode' : 'Country code'}: {part.landekode}
                </p>
              )}
              {part.adresseLokalId && !part.udlandsadresse && (
                <p className="text-slate-500 text-xs font-mono">DAR {part.adresseLokalId}</p>
              )}
              {part.kommunekode && (
                <p className="text-slate-500 text-xs">
                  {da ? 'Kommune' : 'Municipality'} {part.kommunekode}
                </p>
              )}
            </div>
          )}

          {/* Ejendomme parten ejer */}
          <div className="bg-slate-800/40 border border-slate-700/40 rounded-2xl overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-700/40 flex items-center gap-2">
              <Home size={15} className="text-emerald-400" />
              <h2 className="text-white font-semibold text-sm">
                {da ? 'Ejendomme' : 'Properties'}{' '}
                <span className="text-slate-500 font-normal">({ejendomme.length})</span>
              </h2>
            </div>
            {ejendomme.length === 0 ? (
              <div className="p-8 text-center">
                <Home size={28} className="text-slate-600 mx-auto mb-2" />
                <p className="text-slate-500 text-sm">
                  {da ? 'Ingen ejendomme fundet' : 'No properties found'}
                </p>
                <p className="text-slate-600 text-xs mt-1 max-w-sm mx-auto">
                  {da
                    ? 'Reverse-lookup kræver at Datafordeler-schemaet understøtter oplysningerEjesAfEjerskab-filteret. Listen kan være tom hvis schemaet endnu ikke er eksponeret.'
                    : 'Reverse-lookup requires Datafordeler schema to expose the oplysningerEjesAfEjerskab filter. List may be empty if schema is not yet available.'}
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-700/30">
                {ejendomme.map((ej) => (
                  <Link
                    key={ej.bfeNummer}
                    href={`/dashboard/ejendomme/${ej.bfeNummer}`}
                    className="flex items-center gap-3 px-5 py-3 hover:bg-slate-700/20 transition-colors group"
                  >
                    <Home
                      size={15}
                      className="text-slate-500 group-hover:text-emerald-400 transition-colors"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-slate-200 text-sm group-hover:text-emerald-300 transition-colors">
                        BFE {ej.bfeNummer.toLocaleString('da-DK')}
                      </p>
                      {ej.virkningFra && (
                        <p className="text-slate-500 text-xs mt-0.5">
                          {da ? 'Ejer siden' : 'Owner since'}:{' '}
                          {new Date(ej.virkningFra).toLocaleDateString(da ? 'da-DK' : 'en-GB', {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                          })}
                        </p>
                      )}
                    </div>
                    {ej.ejerandel && (
                      <span className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-full">
                        {ej.ejerandel}
                      </span>
                    )}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
