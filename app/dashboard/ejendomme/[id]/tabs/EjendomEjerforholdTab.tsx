/**
 * EjendomEjerforholdTab — Ejerforhold-fane på ejendoms-detaljesiden.
 *
 * Viser:
 *   - Administrator-kort (via EjendomAdministratorCard)
 *   - Ejerkort (EjerKort) + DiagramV2 for normale ejendomme
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
import EjendomEjerforeningFinder from '@/app/components/ejendomme/EjendomEjerforeningFinder';
import TabLoadingSpinner from '@/app/components/TabLoadingSpinner';
import dynamic from 'next/dynamic';
import EjerKort from '../EjerKort';
import type { EjerDetalje } from '../EjerKort';
const DiagramV2 = dynamic(() => import('@/app/components/diagrams/DiagramV2'), { ssr: false });
import type { EjendomApiResponse } from '@/app/api/ejendom/[id]/route';
import type { DawaAdresse } from '@/app/lib/dawa';
import type { Ejerlejlighed } from '@/app/api/ejerlejligheder/route';
import type { StrukturNode } from '@/app/api/ejendom-struktur/route';
import EjendomStrukturTree from '@/app/components/ejendomme/EjendomStrukturTree';

/**
 * Skeleton-placeholder for ejendomsstruktur-træet.
 * Matcher den endelige layoutstruktur (SFE → Hovedejendom → Ejerlejligheder)
 * med pulserende animation for at signalere at data hentes.
 */
function StrukturSkeleton() {
  return (
    <div
      className="space-y-3"
      role="progressbar"
      aria-label="Henter ejendomsstruktur"
      aria-busy="true"
    >
      <div className="h-5 w-40 bg-slate-700/40 rounded animate-pulse" />
      {/* SFE-niveau */}
      <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3 space-y-2">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-amber-500/10 rounded animate-pulse" />
          <div className="h-4 w-32 bg-slate-700/40 rounded animate-pulse" />
          <div className="h-3 w-12 bg-amber-500/10 rounded animate-pulse ml-auto" />
        </div>
        {/* Hovedejendom */}
        <div className="ml-6 space-y-2 border-l border-slate-700/30 pl-3">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 bg-amber-500/10 rounded animate-pulse" />
            <div className="h-3.5 w-48 bg-slate-700/40 rounded animate-pulse" />
          </div>
          {/* Ejerlejligheder */}
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="ml-5 flex items-center gap-2 py-1">
              <div className="w-4 h-4 bg-emerald-500/10 rounded animate-pulse" />
              <div
                className="h-3 bg-slate-700/40 rounded animate-pulse"
                style={{ width: `${140 + i * 20}px` }}
              />
              <div className="h-2.5 w-16 bg-slate-700/30 rounded animate-pulse ml-auto" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

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
  /** BIZZ-1288: DAWA-ID for den aktuelle ejendom — fallback for "(denne)" match */
  currentDawaId?: string | null;
  /** BBR enheder — bruges til at berige med værelser */
  bbrEnheder?: Array<{ etage: string | null; doer: string | null; vaerelser: number | null }>;
  /** BIZZ-1143: Ejer-detaljer fra /api/ejerskab/chain (prefetched af parent) */
  chainEjerDetaljer?: EjerDetalje[];
  /** BIZZ-1582: True when deeper ejerkæde levels are available */
  chainHasMore?: boolean;
  /** BIZZ-1582: Callback to re-fetch chain with depth=3 */
  onExpandChain?: () => void;
  /** BIZZ-1143: True mens chain-data hentes */
  chainLoader?: boolean;
  /** BIZZ-1143: Prefetched diagram-graf fra /api/diagram/resolve */
  prefetchedDiagramGraph?: { graph: unknown } | null;
  /** BIZZ-1143: True mens diagram-resolve hentes */
  diagramResolveLoader?: boolean;
}

/** Render Ejerforhold-fanen. Ren præsentations-komponent. */
export default function EjendomEjerforholdTab({
  lang,
  bbrData,
  dawaAdresse,
  bbrLoader,
  ejereLoader: _ejereLoader,
  lejlighederLoader,
  lejligheder,
  strukturTree,
  strukturLoader,
  currentBfe,
  currentDawaId,
  bbrEnheder,
  chainEjerDetaljer = [],
  chainHasMore = false,
  onExpandChain,
  chainLoader = false,
  prefetchedDiagramGraph = null,
  diagramResolveLoader = false,
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
      {/* BIZZ-583 + BIZZ-1659: Administrator-kort. Fallback-kæde for BFE:
          ejendomsrelationer → ejerlejlighedBfe → moderBfe → currentBfe.
          Skjules automatisk hvis ingen admin-relation i EJF. */}
      {(() => {
        const adminBfe =
          bbrData?.ejendomsrelationer?.[0]?.bfeNummer ??
          bbrData?.ejerlejlighedBfe ??
          bbrData?.moderBfe ??
          currentBfe;
        if (!adminBfe) return null;
        return (
          <>
            <EjendomAdministratorCard bfeNummer={adminBfe} lang={lang} />
            {/* Vis AI-finder for ejerlejligheder — uanset om admin er arvet fra SFE.
                Sender adresse+postnr som fallback for BFE'er uden adresse i cache. */}
            {bbrData?.ejerlejlighedBfe && (
              <EjendomEjerforeningFinder
                bfeNummer={adminBfe}
                lang={lang}
                adresse={dawaAdresse ? `${dawaAdresse.vejnavn} ${dawaAdresse.husnr}` : undefined}
                postnr={dawaAdresse?.postnr ?? undefined}
              />
            )}
          </>
        );
      })()}
      {/* Loading state — blå progress bar kun mens BBR-data hentes */}
      {(bbrLoader || !bbrData) && (
        <TabLoadingSpinner ariaLabel={da ? 'Henter ejerskabsdata' : 'Loading ownership data'} />
      )}
      {/* ── Ejerskabsdiagram / Relationsdiagram ──
          BIZZ-1174: Mount med det samme når bbrData er klar — vent IKKE
          på ejereLoader (EJF-data). EjerKort og DiagramV2 modtager
          prefetched data fra parent — ingen intern fetch. */}
      {!bbrLoader &&
        bbrData &&
        (() => {
          const erModer = !dawaAdresse?.etage && !!bbrData?.ejerlejlighedBfe;
          // BIZZ-1308: Brug ejendomsrelationer BFE (altid korrekt for den aktuelle adresse).
          // ejerlejlighedBfe kan pege på en forkert lejlighed (fx Plads 10 i stedet for 18).
          // BIZZ-1876: Fallback til moderBfe (SFE) når ejerlejlighedBfe ikke kan resolves
          const bfeForDiagram =
            bbrData?.ejendomsrelationer?.[0]?.bfeNummer ??
            bbrData?.ejerlejlighedBfe ??
            bbrData?.moderBfe ??
            (currentBfe && currentBfe > 0 ? currentBfe : null);

          // Hovedejendom opdelt i EL — vis strukturtræ med ejer-data
          if (erModer) {
            // BIZZ-1289: Skeleton mens strukturtræ/lejligheder hentes
            if (strukturLoader || lejlighederLoader) {
              return <StrukturSkeleton />;
            }
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
                  // Match via BFE (primær) eller eksakt vejnavn+husnr (fallback)
                  const nodeStreet = node.adresse.split(',')[0].trim().toLowerCase();
                  const match = lejligheder!.find(
                    (l) =>
                      (node.bfe > 0 && l.bfe === node.bfe) ||
                      l.adresse.split(',')[0].trim().toLowerCase() === nodeStreet
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
                // Hovedejendom: erstat children med lejligheder-listen når den
                // er mere komplet. Lejligheder har individuelle adresser med
                // etage/dør mens TL ofte kun har 1 entry per BFE.
                if (node.niveau === 'hovedejendom') {
                  const nodeHusnr = extractHusnr(node.adresse);
                  const matchingLej = lejligheder!.filter(
                    (l) => extractHusnr(l.adresse) === nodeHusnr
                  );
                  if (matchingLej.length > 0 && matchingLej.length >= node.children.length) {
                    // Erstat children helt med lejligheder-data (mere komplet)
                    return {
                      ...node,
                      children: matchingLej.map((l) => {
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
                          dawaId: l.dawaId ?? null,
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
                      }),
                    };
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
                    currentDawaId={currentDawaId}
                    showOwnership
                  />
                </div>
              );
            }
            // BIZZ-1677: Lejligheder fundet via DAWA men strukturTree er null
            // (TL matrikelsøgning fejlede). Vis lejligheder som simpel liste.
            if (!strukturTree && lejligheder && lejligheder.length > 0) {
              return (
                <div className="space-y-4">
                  <SectionTitle title={t.ownershipStructure} />
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                    <div className="px-4 py-2 border-b border-slate-700/30">
                      <p className="text-slate-400 text-xs">
                        {da
                          ? `${lejligheder.length} ejerlejligheder`
                          : `${lejligheder.length} condominiums`}
                      </p>
                    </div>
                    <div className="divide-y divide-slate-700/20 max-h-96 overflow-y-auto">
                      {lejligheder.map((l, i) => (
                        <div
                          key={i}
                          className="px-4 py-2 flex items-center justify-between text-xs"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-emerald-400 text-[10px]">EL</span>
                            {l.dawaId ? (
                              <a
                                href={`/dashboard/ejendomme/${l.dawaId}`}
                                className="text-slate-200 hover:text-blue-300 truncate"
                              >
                                {l.adresse}
                              </a>
                            ) : (
                              <span className="text-slate-200 truncate">{l.adresse}</span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 flex-shrink-0 text-slate-500">
                            {l.ejer && l.ejer !== '–' && (
                              <span className="text-slate-400">{l.ejer}</span>
                            )}
                            {l.areal != null && <span>{l.areal} m²</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            }
            // Fallback: loading / empty state
            if (strukturLoader || lejlighederLoader) {
              return <StrukturSkeleton />;
            }
            // BIZZ-1656: Når lejligheder er tomme (TL matrikelsøgning dækker
            // ikke alle matrikler), vis ejerkæde + diagram i stedet for en
            // ubrugelig "opdelt" placeholder. Brugeren ser mindst admin +
            // moderejendommens ejerskabsdata.
            return (
              <div className="space-y-4">
                <div className="bg-slate-800/40 border border-amber-500/20 rounded-xl p-4 flex items-start gap-3">
                  <div className="w-8 h-8 bg-amber-500/10 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Building2 size={16} className="text-amber-400" />
                  </div>
                  <div>
                    <p className="text-slate-300 text-sm font-medium">
                      {da
                        ? 'Ejendommen er opdelt i ejerlejligheder'
                        : 'Property is divided into condominiums'}
                    </p>
                    <p className="text-slate-500 text-xs mt-0.5">
                      {da
                        ? 'Lejlighedslisten kunne ikke hentes — ejerskabsdata vises for hovedejendommen.'
                        : 'Apartment list unavailable — showing ownership data for the parent property.'}
                    </p>
                  </div>
                </div>
                {bfeForDiagram && (
                  <>
                    {chainLoader ? (
                      <TabLoadingSpinner
                        ariaLabel={da ? 'Henter ejerskabsdata' : 'Loading ownership data'}
                      />
                    ) : (
                      <>
                        <EjerKort ejerDetaljer={chainEjerDetaljer} lang={lang} />
                        {chainHasMore && onExpandChain && (
                          <button
                            type="button"
                            onClick={onExpandChain}
                            className="text-sm text-blue-400 hover:text-blue-300 underline underline-offset-2 transition-colors"
                            aria-label={
                              da
                                ? 'Udvid ejerkæde til dybere niveauer'
                                : 'Expand ownership chain to deeper levels'
                            }
                          >
                            {da ? 'Vis dybere ejerkæde...' : 'Show deeper ownership chain...'}
                          </button>
                        )}
                      </>
                    )}
                    {/* BIZZ-1826: Vis diagram for alle ejendomme med mindst én ejer
                        (ikke kun virksomheds-ejere som BIZZ-1808 begrænsede til) */}
                    {chainEjerDetaljer.some((e) => e.type !== 'status') && (
                      <>
                        {diagramResolveLoader ? (
                          <div className="w-full h-96 bg-slate-800/50 rounded-xl animate-pulse" />
                        ) : (
                          <DiagramV2
                            rootType="property"
                            rootId={String(bfeForDiagram)}
                            rootLabel={
                              dawaAdresse
                                ? `${dawaAdresse.vejnavn} ${dawaAdresse.husnr}${dawaAdresse.etage ? `, ${dawaAdresse.etage}.` : ''}${dawaAdresse.dør ? ` ${dawaAdresse.dør}` : ''}, ${dawaAdresse.postnr} ${dawaAdresse.postnrnavn}`
                                : `BFE ${bfeForDiagram}`
                            }
                            lang={lang}
                            prefetchedGraph={prefetchedDiagramGraph}
                          />
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            );
          }

          if (!bfeForDiagram) return null;

          // BIZZ-1858: For lejligheder der bruger SFE-fallback BFE,
          // vis en note om at data vises for hele matriklen
          const usesSfeFallback = !!dawaAdresse?.etage && !bbrData?.ejerlejlighedBfe;

          /**
           * BIZZ-1826: Bestem om ejendommen har mindst én reel ejer (person eller selskab).
           * Diagrammet vises for alle ejendomme med ejere — ikke kun virksomheds-ejede.
           */
          const harReelEjer = chainEjerDetaljer.some((e) => e.type !== 'status');

          return (
            <div className="space-y-4">
              {/* BIZZ-1858: Info-boks for lejligheder med SFE-fallback */}
              {usesSfeFallback && (
                <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-3 flex items-start gap-3">
                  <Building2 size={16} className="text-amber-400 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-amber-200 text-sm font-medium">
                      {da
                        ? 'Ejerskabsdata vises for hele ejendommen'
                        : 'Ownership data shown for the entire property'}
                    </p>
                    <p className="text-slate-400 text-xs mt-0.5">
                      {da
                        ? 'Den specifikke lejligheds-BFE kunne ikke resolves. Data herunder gælder hele matriklen.'
                        : 'The specific apartment BFE could not be resolved. Data below applies to the entire cadastral unit.'}
                    </p>
                  </div>
                </div>
              )}
              {/* BIZZ-1143: Ejerkort — ren præsentation, data leveret fra parent */}
              {chainLoader ? (
                <TabLoadingSpinner
                  ariaLabel={da ? 'Henter ejerskabsdata' : 'Loading ownership data'}
                />
              ) : (
                <>
                  <EjerKort ejerDetaljer={chainEjerDetaljer} lang={lang} />
                  {chainHasMore && onExpandChain && (
                    <button
                      type="button"
                      onClick={onExpandChain}
                      className="text-sm text-blue-400 hover:text-blue-300 underline underline-offset-2 transition-colors"
                      aria-label={
                        da
                          ? 'Udvid ejerkæde til dybere niveauer'
                          : 'Expand ownership chain to deeper levels'
                      }
                    >
                      {da ? 'Vis dybere ejerkæde...' : 'Show deeper ownership chain...'}
                    </button>
                  )}
                </>
              )}
              {/* BIZZ-1826: Vis DiagramV2 for alle ejendomme med mindst én
                  reel ejer (person eller selskab). */}
              {harReelEjer && (
                <>
                  {diagramResolveLoader ? (
                    <div className="w-full h-96 bg-slate-800/50 rounded-xl animate-pulse" />
                  ) : (
                    <DiagramV2
                      rootType="property"
                      rootId={String(bfeForDiagram)}
                      rootLabel={
                        dawaAdresse
                          ? `${dawaAdresse.vejnavn} ${dawaAdresse.husnr}${dawaAdresse.etage ? `, ${dawaAdresse.etage}.` : ''}${dawaAdresse.dør ? ` ${dawaAdresse.dør}` : ''}, ${dawaAdresse.postnr} ${dawaAdresse.postnrnavn}`
                          : `BFE ${bfeForDiagram}`
                      }
                      lang={lang}
                      prefetchedGraph={prefetchedDiagramGraph}
                    />
                  )}
                </>
              )}
              {/* Loading-bar mens strukturtræ hentes */}
              {/* BIZZ-1289: Skeleton mens strukturtræ hentes */}
              {(strukturLoader || lejlighederLoader) && !strukturTree && <StrukturSkeleton />}
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
                      const nodeStreet = node.adresse.split(',')[0].trim().toLowerCase();
                      const match = lejligheder!.find(
                        (l) =>
                          (node.bfe > 0 && l.bfe === node.bfe) ||
                          l.adresse.split(',')[0].trim().toLowerCase() === nodeStreet
                      );
                      // BBR-match for værelser
                      const addrParts = node.adresse.split(',').map((s) => s.trim());
                      const etageDoer = (addrParts[1] ?? '').toLowerCase();
                      const bbrMatch = (bbrEnheder ?? []).find((e) => {
                        const eLow = (e.etage ?? '').toLowerCase();
                        const dLow = (e.doer ?? '').toLowerCase();
                        const combined = `${eLow}. ${dLow}`.trim();
                        return etageDoer.includes(combined) || (eLow && etageDoer.startsWith(eLow));
                      });
                      if (match) {
                        return {
                          ...node,
                          ejer: match.ejer ?? node.ejer,
                          ejertype: match.ejertype ?? node.ejertype,
                          koebspris: match.koebspris ?? node.koebspris,
                          koebsdato: match.koebsdato ?? node.koebsdato,
                          areal: match.areal ?? node.areal,
                          vaerelser: bbrMatch?.vaerelser ?? node.vaerelser,
                          children: node.children.map(enrichNode),
                        };
                      }
                      // Kun BBR-berigelse (ingen lejligheder-match)
                      if (bbrMatch?.vaerelser) {
                        return {
                          ...node,
                          vaerelser: bbrMatch.vaerelser,
                          children: node.children.map(enrichNode),
                        };
                      }
                    }
                    if (node.niveau === 'hovedejendom') {
                      const nodeHusnr = extractHusnr(node.adresse);
                      const matchingLej = lejligheder!.filter(
                        (l) => extractHusnr(l.adresse) === nodeHusnr
                      );
                      if (matchingLej.length > 0 && matchingLej.length >= node.children.length) {
                        return {
                          ...node,
                          children: matchingLej.map((l) => ({
                            bfe: l.bfe,
                            adresse: l.adresse,
                            niveau: 'ejerlejlighed' as const,
                            dawaId: l.dawaId ?? null,
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
                          })),
                        };
                      }
                    }
                    return { ...node, children: node.children.map(enrichNode) };
                  }
                  return (
                    <EjendomStrukturTree
                      tree={enrichNode(strukturTree)}
                      lang={lang}
                      currentBfe={currentBfe}
                      currentDawaId={currentDawaId}
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
