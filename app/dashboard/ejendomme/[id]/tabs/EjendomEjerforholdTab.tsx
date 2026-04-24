/**
 * EjendomEjerforholdTab — Ejerforhold-fane på ejendoms-detaljesiden.
 *
 * Viser:
 *   - Administrator-kort (via EjendomAdministratorCard)
 *   - Ejerstrukturdiagram (PropertyOwnerDiagram) for normale ejendomme
 *   - Lejlighedsliste når ejendommen er en moderejendom opdelt i ejerlejligheder
 *
 * BIZZ-657: Extraheret fra EjendomDetaljeClient.tsx. Ren filopdeling — ingen
 * adfærdsændring. Alt state + data leveres via props.
 *
 * @module app/dashboard/ejendomme/[id]/tabs/EjendomEjerforholdTab
 */

'use client';

import Link from 'next/link';
import { Building2 } from 'lucide-react';
import EjendomAdministratorCard from '@/app/components/ejendomme/EjendomAdministratorCard';
import TabLoadingSpinner from '@/app/components/TabLoadingSpinner';
import PropertyOwnerDiagram from '../PropertyOwnerDiagram';
import type { EjendomApiResponse } from '@/app/api/ejendom/[id]/route';
import type { DawaAdresse } from '@/app/lib/dawa';
import type { Ejerlejlighed } from '@/app/api/ejerlejligheder/route';

/** Simpel sektionsoverskrift — matcher parentens SectionTitle-pattern. */
function SectionTitle({ title }: { title: string }) {
  return (
    <div className="flex items-center justify-between mb-1.5">
      <h3 className="text-white font-semibold text-sm">{title}</h3>
    </div>
  );
}

interface Props {
  /** 'da' | 'en' — bilingual */
  lang: 'da' | 'en';
  /** BBR-respons med ejendomsrelationer + evt. ejerlejlighedBfe */
  bbrData: EjendomApiResponse | null;
  /** DAWA-adresse (bruges til at konstruere diagramadresse + moderejendom-check) */
  dawaAdresse: DawaAdresse | null;
  /** Loaders */
  bbrLoader: boolean;
  ejereLoader: boolean;
  lejlighederLoader: boolean;
  /** Liste af ejerlejligheder under moderejendom (null = ikke hentet) */
  lejligheder: Ejerlejlighed[] | null;
}

/** Render Ejerforhold-fanen. Ren præsentations-komponent. */
export default function EjendomEjerforholdTab({
  lang,
  bbrData,
  dawaAdresse,
  bbrLoader,
  ejereLoader,
  lejlighederLoader,
  lejligheder,
}: Props) {
  const da = lang === 'da';

  const t = {
    ownershipStructure: da ? 'Ejerstruktur' : 'Ownership structure',
    apartments: da ? 'Lejligheder' : 'Apartments',
    apartmentAddress: da ? 'Adresse' : 'Address',
    apartmentOwner: da ? 'Ejer' : 'Owner',
    apartmentArea: da ? 'Areal' : 'Area',
    apartmentPrice: da ? 'Købspris' : 'Purchase price',
    apartmentDate: da ? 'Købsdato' : 'Purchase date',
  };

  return (
    <div className="space-y-2">
      {/* BIZZ-583: Administrator-kort (ejerforening/adv./udlejer). Skjules
          automatisk hvis ejendommen ingen admin-relation har. Bruger
          primær BFE fra ejendomsrelationer (samme som andre tabs). */}
      {bbrData?.ejendomsrelationer?.[0]?.bfeNummer && (
        <EjendomAdministratorCard bfeNummer={bbrData.ejendomsrelationer[0].bfeNummer} lang={lang} />
      )}
      {/* Loading state — vis spinner mens BBR eller ejerskab data hentes */}
      {(ejereLoader || bbrLoader || !bbrData) && (
        <TabLoadingSpinner label={da ? 'Henter ejerskabsdata…' : 'Loading ownership data…'} />
      )}
      {/* ── Ejerskabsdiagram / Relationsdiagram (fra Tinglysning + EJF kæde) ── */}
      {!ejereLoader &&
        !bbrLoader &&
        bbrData &&
        (() => {
          const erModer = !dawaAdresse?.etage && !!bbrData?.ejerlejlighedBfe;
          const bfeForDiagram =
            bbrData?.ejerlejlighedBfe ?? bbrData?.ejendomsrelationer?.[0]?.bfeNummer;

          // Hovedejendom opdelt i EL — vis info + lejlighedsliste
          if (erModer) {
            return (
              <div className="space-y-4">
                <SectionTitle title={t.ownershipStructure} />
                <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-6 text-center space-y-3">
                  <div className="w-12 h-12 bg-amber-500/10 rounded-xl flex items-center justify-center mx-auto">
                    <Building2 size={22} className="text-amber-400" />
                  </div>
                  <p className="text-slate-300 text-sm font-medium">
                    {da
                      ? 'Ejendommen er opdelt i ejerlejligheder'
                      : 'Property is divided into condominiums'}
                  </p>
                  <p className="text-slate-500 text-xs max-w-md mx-auto">
                    {da
                      ? 'Ejerskab er registreret på de enkelte ejerlejligheder.'
                      : 'Ownership is registered on individual condominium units.'}
                  </p>
                </div>

                {/* Lejlighedsliste under info-boksen. BIZZ-478: Ensartet blå TabLoadingSpinner. */}
                {lejlighederLoader && (
                  <TabLoadingSpinner
                    label={da ? 'Henter lejlighedsdata…' : 'Loading apartment data…'}
                  />
                )}
                {/* BIZZ-857: Empty-state når opdelt-flag er true men listen er tom —
                    tydelig fejl i stedet for kun det generiske "ejerskab er registreret"-
                    budskab der ikke hjælper brugeren videre. */}
                {!lejlighederLoader && lejligheder !== null && lejligheder.length === 0 && (
                  <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-6 text-center space-y-2">
                    <p className="text-red-300 text-sm font-medium">
                      {da ? 'Data mangler' : 'Data missing'}
                    </p>
                    <p className="text-slate-400 text-xs max-w-md mx-auto">
                      {da
                        ? 'Ejendommen er registreret som opdelt, men listen af ejerlejligheder kunne ikke hentes. Kontakt support hvis problemet fortsætter.'
                        : 'The property is registered as divided, but the list of condominiums could not be retrieved. Contact support if the issue persists.'}
                    </p>
                  </div>
                )}
                {lejligheder !== null && lejligheder.length > 0 && (
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden overflow-x-auto">
                    <div className="px-3 py-2.5 border-b border-slate-700/40 flex items-center justify-between">
                      <p className="text-slate-200 text-xs font-semibold">{t.apartments}</p>
                      <span className="text-slate-500 text-[10px]">
                        {lejligheder.length} {da ? 'lejligheder' : 'apartments'}
                      </span>
                    </div>
                    <div className="min-w-[720px] grid grid-cols-[1fr_120px_60px_100px_80px] px-3 py-1.5 text-slate-500 text-[10px] font-medium border-b border-slate-700/30">
                      <span>{t.apartmentAddress}</span>
                      <span>{t.apartmentOwner}</span>
                      <span className="text-right">{t.apartmentArea}</span>
                      <span className="text-right">{t.apartmentPrice}</span>
                      <span className="text-right">{t.apartmentDate}</span>
                    </div>
                    <div className="divide-y divide-slate-700/20">
                      {lejligheder.map((lej) => (
                        <Link
                          key={lej.bfe}
                          href={lej.dawaId ? `/dashboard/ejendomme/${lej.dawaId}` : '#'}
                          onClick={
                            lej.dawaId ? undefined : (e: React.MouseEvent) => e.preventDefault()
                          }
                          className={`min-w-[720px] grid grid-cols-[1fr_120px_60px_100px_80px] px-3 py-1.5 items-center gap-1 hover:bg-slate-700/15 transition-colors block ${lej.dawaId ? 'cursor-pointer' : 'cursor-default'}`}
                        >
                          <span
                            className="text-slate-200 text-[11px] font-medium truncate"
                            title={lej.adresse}
                          >
                            {lej.adresse.split(',').slice(0, 2).join(',')}
                          </span>
                          <span className="text-slate-400 text-[10px] truncate" title={lej.ejer}>
                            {lej.ejer}
                          </span>
                          <span className="text-slate-300 text-[10px] text-right">
                            {lej.areal ? `${lej.areal} m²` : '–'}
                          </span>
                          <span className="text-slate-300 text-[10px] text-right font-medium">
                            {lej.koebspris ? `${lej.koebspris.toLocaleString('da-DK')} DKK` : '–'}
                          </span>
                          <span className="text-slate-400 text-[10px] text-right">
                            {lej.koebsdato
                              ? new Date(lej.koebsdato).toLocaleDateString('da-DK', {
                                  day: 'numeric',
                                  month: 'short',
                                  year: 'numeric',
                                })
                              : '–'}
                          </span>
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          }

          if (!bfeForDiagram) return null;
          return (
            <div>
              <PropertyOwnerDiagram
                bfe={bfeForDiagram}
                adresse={
                  dawaAdresse
                    ? `${dawaAdresse.vejnavn} ${dawaAdresse.husnr}${dawaAdresse.etage ? `, ${dawaAdresse.etage}.` : ''}${dawaAdresse.dør ? ` ${dawaAdresse.dør}` : ''}, ${dawaAdresse.postnr} ${dawaAdresse.postnrnavn}`
                    : `BFE ${bfeForDiagram}`
                }
                lang={lang}
                erEjerlejlighed={!!bbrData?.ejerlejlighedBfe}
              />
            </div>
          );
        })()}
    </div>
  );
}
