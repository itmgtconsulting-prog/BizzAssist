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

import { Building2 } from 'lucide-react';
import EjendomAdministratorCard from '@/app/components/ejendomme/EjendomAdministratorCard';
import TabLoadingSpinner from '@/app/components/TabLoadingSpinner';
import PropertyOwnerDiagram from '../PropertyOwnerDiagram';
import type { EjendomApiResponse } from '@/app/api/ejendom/[id]/route';
import type { DawaAdresse } from '@/app/lib/dawa';
import type { Ejerlejlighed } from '@/app/api/ejerlejligheder/route';
import type { StrukturNode } from '@/app/api/ejendom-struktur/route';
import EjendomStrukturTree from '@/app/components/ejendomme/EjendomStrukturTree';

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
  /** Ejendomsstruktur-træ (SFE → Hovedejendom → Ejerlejlighed) */
  strukturTree?: StrukturNode | null;
  /** True mens strukturdata hentes */
  strukturLoader?: boolean;
  /** Aktuel BFE for denne ejendom */
  currentBfe?: number;
  /** BBR enheder — bruges til at berige med værelser */
  bbrEnheder?: Array<{ etage: string | null; doer: string | null; vaerelser: number | null }>;
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
  strukturTree,
  strukturLoader,
  currentBfe,
  bbrEnheder,
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
      {/* Loading state — blå progress bar mens data hentes */}
      {(ejereLoader || bbrLoader || !bbrData) && (
        <TabLoadingSpinner ariaLabel={da ? 'Henter ejerskabsdata' : 'Loading ownership data'} />
      )}
      {/* ── Ejerskabsdiagram / Relationsdiagram (fra Tinglysning + EJF kæde) ── */}
      {!ejereLoader &&
        !bbrLoader &&
        bbrData &&
        (() => {
          const erModer = !dawaAdresse?.etage && !!bbrData?.ejerlejlighedBfe;
          const bfeForDiagram =
            bbrData?.ejerlejlighedBfe ?? bbrData?.ejendomsrelationer?.[0]?.bfeNummer;

          // Hovedejendom opdelt i EL — vis strukturtræ med ejer-data
          if (erModer) {
            // Berig strukturtræ med ejer/pris/dato fra lejligheder-data.
            // Lejligheder-listen er ofte mere komplet end TL-strukturen
            // (TL returnerer 1 item pr. ejendomsnummer, lejligheder har
            // individuelle adresser med etage/dør).
            if (strukturTree && lejligheder && lejligheder.length > 0) {
              /**
               * Ekstraher husnummer fra en adressestreng.
               *
               * @param addr - Adressestreng
               * @returns Husnummer (f.eks. "62A")
               */
              function extractHusnr(addr: string): string {
                const street = addr.split(',')[0].trim();
                const m = street.match(/(\d+\w*)$/);
                return m ? m[1].toUpperCase() : '';
              }

              /**
               * Beriger StrukturNode rekursivt: erstatter hovedejendom-children
               * med lejligheder-data grupperet per husnr. Giver flere og mere
               * detaljerede ejerlejlighed-noder end TL alene.
               *
               * @param node - Struktur-node
               * @returns Beriget kopi med komplet lejlighedsliste
               */
              function enrichWithOwnership(node: StrukturNode): StrukturNode {
                // Ejerlejlighed: berig med ejer/pris/dato fra lejligheder-match
                if (node.niveau === 'ejerlejlighed') {
                  const match = lejligheder!.find(
                    (l) =>
                      (node.bfe > 0 && l.bfe === node.bfe) ||
                      node.adresse
                        .toLowerCase()
                        .includes(l.adresse.split(',')[0].toLowerCase().trim())
                  );
                  if (match) {
                    const etageDoer = match.adresse.split(',')[1]?.trim().toLowerCase() ?? '';
                    const bbrMatch = (bbrEnheder ?? []).find((e) => {
                      const eLow = (e.etage ?? '').toLowerCase();
                      const dLow = (e.doer ?? '').toLowerCase();
                      const combined = `${eLow}. ${dLow}`.trim();
                      return etageDoer.includes(combined) || (eLow && etageDoer.startsWith(eLow));
                    });
                    return {
                      ...node,
                      ejer: match.ejer ?? node.ejer,
                      ejertype: match.ejertype ?? node.ejertype,
                      koebspris: match.koebspris ?? node.koebspris,
                      koebsdato: match.koebsdato ?? node.koebsdato,
                      areal: match.areal ?? node.areal,
                      vaerelser: bbrMatch?.vaerelser ?? node.vaerelser,
                      children: node.children.map(enrichWithOwnership),
                    };
                  }
                }
                // Hovedejendom: hvis TL-strukturen har færre children end
                // lejligheder-listen, tilføj manglende som nye noder
                if (node.niveau === 'hovedejendom') {
                  const nodeHusnr = extractHusnr(node.adresse);
                  const matchingLej = lejligheder!.filter(
                    (l) => extractHusnr(l.adresse) === nodeHusnr
                  );
                  // Brug lejligheder-listen hvis den er mere komplet
                  if (matchingLej.length > node.children.length) {
                    const existingBfes = new Set(node.children.map((c) => c.bfe));
                    const extraChildren: StrukturNode[] = matchingLej
                      .filter((l) => !existingBfes.has(l.bfe))
                      .map((l) => {
                        const etageDoer = l.adresse.split(',')[1]?.trim().toLowerCase() ?? '';
                        const bbrMatch = (bbrEnheder ?? []).find((e) => {
                          const eLow = (e.etage ?? '').toLowerCase();
                          const dLow = (e.doer ?? '').toLowerCase();
                          const combined = `${eLow}. ${dLow}`.trim();
                          return (
                            etageDoer.includes(combined) || (eLow && etageDoer.startsWith(eLow))
                          );
                        });
                        return {
                          bfe: l.bfe,
                          adresse: l.adresse,
                          niveau: 'ejerlejlighed' as const,
                          dawaId: null,
                          ejendomsvaerdi: null,
                          grundvaerdi: null,
                          vurderingsaar: null,
                          tlVurdering: null,
                          areal: l.areal,
                          vaerelser: bbrMatch?.vaerelser ?? null,
                          ejer: l.ejer,
                          ejertype: l.ejertype,
                          koebspris: l.koebspris,
                          koebsdato: l.koebsdato,
                          children: [],
                        };
                      });
                    const enrichedExisting = node.children.map(enrichWithOwnership);
                    return { ...node, children: [...enrichedExisting, ...extraChildren] };
                  }
                }
                return { ...node, children: node.children.map(enrichWithOwnership) };
              }
              const enriched = enrichWithOwnership(strukturTree);
              return (
                <div className="space-y-4">
                  <SectionTitle title={t.ownershipStructure} />
                  <EjendomStrukturTree
                    tree={enriched}
                    lang={lang}
                    currentBfe={currentBfe}
                    showOwnership
                  />
                </div>
              );
            }
            // Fallback: loading / empty state
            if (strukturLoader || lejlighederLoader) {
              return (
                <TabLoadingSpinner
                  ariaLabel={da ? 'Henter ejerskabsdata' : 'Loading ownership data'}
                />
              );
            }
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
              </div>
            );
          }

          if (!bfeForDiagram) return null;
          return (
            <div className="space-y-4">
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
              {/* Strukturtræ under diagrammet for ejerlejligheder —
                  giver kontekst om hvor lejligheden hører til i hierarkiet */}
              {strukturTree &&
                lejligheder &&
                lejligheder.length > 0 &&
                (() => {
                  /** @param addr - Adressestreng */
                  function extractHusnr(addr: string): string {
                    const street = addr.split(',')[0].trim();
                    const m = street.match(/(\d+\w*)$/);
                    return m ? m[1].toUpperCase() : '';
                  }
                  /** @param node - Struktur-node — beriger med ejer-data, bevarer dawaId'er */
                  function enrichNode(node: StrukturNode): StrukturNode {
                    if (node.niveau === 'ejerlejlighed') {
                      const match = lejligheder!.find(
                        (l) =>
                          (node.bfe > 0 && l.bfe === node.bfe) ||
                          node.adresse
                            .toLowerCase()
                            .includes(l.adresse.split(',')[0].toLowerCase().trim())
                      );
                      if (match) {
                        return {
                          ...node,
                          ejer: match.ejer ?? node.ejer,
                          ejertype: match.ejertype ?? node.ejertype,
                          koebspris: match.koebspris ?? node.koebspris,
                          koebsdato: match.koebsdato ?? node.koebsdato,
                          areal: match.areal ?? node.areal,
                          children: node.children.map(enrichNode),
                        };
                      }
                    }
                    if (node.niveau === 'hovedejendom') {
                      const nodeHusnr = extractHusnr(node.adresse);
                      const matchingLej = lejligheder!.filter(
                        (l) => extractHusnr(l.adresse) === nodeHusnr
                      );
                      if (matchingLej.length > node.children.length) {
                        const existingBfes = new Set(node.children.map((c) => c.bfe));
                        const extra: StrukturNode[] = matchingLej
                          .filter((l) => !existingBfes.has(l.bfe))
                          .map((l) => ({
                            bfe: l.bfe,
                            adresse: l.adresse,
                            niveau: 'ejerlejlighed' as const,
                            dawaId: null,
                            ejendomsvaerdi: null,
                            grundvaerdi: null,
                            vurderingsaar: null,
                            tlVurdering: null,
                            areal: l.areal,
                            vaerelser: null,
                            ejer: l.ejer,
                            ejertype: l.ejertype,
                            koebspris: l.koebspris,
                            koebsdato: l.koebsdato,
                            children: [],
                          }));
                        return { ...node, children: [...node.children.map(enrichNode), ...extra] };
                      }
                    }
                    return { ...node, children: node.children.map(enrichNode) };
                  }
                  return (
                    <EjendomStrukturTree
                      tree={enrichNode(strukturTree)}
                      lang={lang}
                      currentBfe={currentBfe}
                      showOwnership
                    />
                  );
                })()}
            </div>
          );
        })()}
    </div>
  );
}
