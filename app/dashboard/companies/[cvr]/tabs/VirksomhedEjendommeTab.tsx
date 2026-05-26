/**
 * VirksomhedEjendommeTab — Ejendomme-fane på virksomhedsdetaljesiden.
 *
 * Viser: ejendomsportefølje, ejendomshandler, gruppering efter ejer-CVR,
 * ejerlejlighedskomplekser, solgte ejendomme.
 *
 * BIZZ-658: Extraheret fra VirksomhedDetaljeClient.tsx.
 *
 * @module app/dashboard/companies/[cvr]/tabs/VirksomhedEjendommeTab
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRightLeft,
  Building2,
  ChevronDown,
  ChevronRight,
  Home,
  Loader2,
  Printer,
  Shield,
  Sparkles,
} from 'lucide-react';
import type { AiEjendomKandidat } from '@/app/api/ai/ejerforening-ejendomme/route';
import TabLoadingSpinner from '@/app/components/TabLoadingSpinner';
import PropertyOwnerCard from '@/app/components/ejendomme/PropertyOwnerCard';
import { translations } from '@/app/lib/translations';
import type { CVRPublicData } from '@/app/api/cvr-public/route';
import type { RelateretVirksomhed } from '@/app/api/cvr-public/related/route';
import type { EjendomSummary } from '@/app/api/ejendomme-by-owner/route';
import type { CvrHandelData } from '@/app/api/salgshistorik/cvr/route';

/** Tomt-tilstands-besked med ikon. */
function EmptyState({ ikon, tekst }: { ikon: React.ReactNode; tekst: string }) {
  return (
    <div className="text-center py-12">
      <div className="mx-auto mb-3 flex justify-center">{ikon}</div>
      <p className="text-slate-400 text-sm">{tekst}</p>
    </div>
  );
}

/** Pre-enriched ejendomsdata fra vurdering/EJF */
export interface EnrichedPropertyData {
  areal: number | null;
  vurdering: number | null;
  vurderingsaar: number | null;
  erGrundvaerdi?: boolean;
  ejerNavn: string | null;
  koebesum: number | null;
  koebsdato: string | null;
  boligAreal: number | null;
  erhvervsAreal: number | null;
  matrikelAreal: number | null;
}

interface Props {
  lang: 'da' | 'en';
  data: CVRPublicData;
  ejendommeLoading: boolean;
  ejendommeLoadingMore: boolean;
  ejendommeData: EjendomSummary[];
  ejendommeFetchComplete: boolean;
  ejendommeManglerNoegle: boolean;
  ejendommeManglerAdgang: boolean;
  ejendommeTotalBfe: number;
  preEnrichedByBfe: Map<number, EnrichedPropertyData>;
  relatedCompanies: RelateretVirksomhed[];
  ejendomshandler: CvrHandelData[];
  handlerLoading: boolean;
  handlerManglerAdgang: boolean;
  visSolgte: boolean;
  setVisSolgte: React.Dispatch<React.SetStateAction<boolean>>;
}

export default function VirksomhedEjendommeTab({
  lang,
  data,
  ejendommeLoading,
  ejendommeLoadingMore,
  ejendommeData,
  ejendommeFetchComplete,
  ejendommeManglerNoegle,
  ejendommeManglerAdgang,
  ejendommeTotalBfe,
  preEnrichedByBfe,
  relatedCompanies,
  ejendomshandler,
  handlerLoading,
  handlerManglerAdgang,
  visSolgte,
  setVisSolgte,
}: Props) {
  const c = translations[lang].company;

  // BIZZ-1834: SFE-expansion client-side — fold SFE ud til ejerlejligheder via DAWA
  const [expandedEjendomme, setExpandedEjendomme] = useState<EjendomSummary[]>([]);

  useEffect(() => {
    if (ejendommeData.length === 0 || ejendommeLoading) return;

    // Find SFE-ejendomme (har adresse, ingen etage, ikke ejerlejlighed)
    const sfes = ejendommeData.filter(
      (e) => e.adresse && !e.etage && e.ejendomstype !== 'Ejerlejlighed' && e.postnr
    );
    if (sfes.length === 0) {
      setExpandedEjendomme(ejendommeData);
      return;
    }

    let cancelled = false;
    (async () => {
      const extra: EjendomSummary[] = [];

      for (const sfe of sfes.slice(0, 5)) {
        try {
          // Step 1: Find ejerlav+matrikelnr via DAWA jordstykke
          const jordRes = await fetch(
            `https://api.dataforsyningen.dk/jordstykker?bfenummer=${sfe.bfeNummer}&format=json`,
            { signal: AbortSignal.timeout(8000) }
          );
          if (!jordRes.ok) continue;
          const jord = (await jordRes.json()) as Array<{
            ejerlav?: { kode?: number };
            matrikelnr?: string;
          }>;
          const ejerlav = jord[0]?.ejerlav?.kode;
          const matr = jord[0]?.matrikelnr;
          if (!ejerlav || !matr) continue;

          // Step 2: Hent alle adresser på matriklen
          const adrRes = await fetch(
            `https://api.dataforsyningen.dk/adresser?ejerlavkode=${ejerlav}&matrikelnr=${encodeURIComponent(matr)}&format=json&struktur=mini&per_side=200`,
            { signal: AbortSignal.timeout(8000) }
          );
          if (!adrRes.ok) continue;
          const adresser = (await adrRes.json()) as Array<{
            id: string;
            vejnavn: string;
            husnr: string;
            etage: string | null;
            dør: string | null;
            postnr: string;
            postnrnavn: string;
          }>;

          // Kun adresser med etage (= ejerlejligheder)
          for (const a of adresser.filter((x) => x.etage)) {
            if (cancelled) return;
            extra.push({
              bfeNummer: 0,
              ownerCvr: sfe.ownerCvr,
              adresse: `${a.vejnavn} ${a.husnr}`,
              postnr: a.postnr,
              by: a.postnrnavn,
              kommune: sfe.kommune,
              kommuneKode: sfe.kommuneKode,
              ejendomstype: 'Ejerlejlighed',
              dawaId: a.id,
              etage: a.etage,
              doer: a.dør,
              ejerandel: sfe.ejerandel,
              administreret: sfe.administreret,
              aktiv: sfe.aktiv,
            });
          }
        } catch {
          /* DAWA fallback non-critical */
        }
      }

      if (!cancelled) {
        // Merge: original data + expanded children (dedup by dawaId)
        const seenIds = new Set(ejendommeData.map((e) => e.dawaId).filter(Boolean));
        const uniqueExtra = extra.filter((e) => e.dawaId && !seenIds.has(e.dawaId));
        setExpandedEjendomme([...ejendommeData, ...uniqueExtra]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ejendommeData, ejendommeLoading]);

  /** Bruge expandedEjendomme i stedet for ejendommeData for visning.
   * Skjul SFE/hovedejendomme når der er child-lejligheder — for foreninger
   * er det lejlighederne der er relevante, ikke selve SFE-ejendommen. */
  const displayEjendomme = (() => {
    const src = expandedEjendomme.length > 0 ? expandedEjendomme : ejendommeData;
    // Har vi expanded children (etage != null)?
    const hasChildren = src.some((e) => e.etage);
    if (!hasChildren) return src;
    // Fjern SFE-ejendomme (ingen etage, ikke ejerlejlighed) der har children
    return src.filter((e) => e.etage || e.ejendomstype === 'Ejerlejlighed');
  })();

  // BIZZ-1828: AI-baseret ejendomsresolve for ejerforeninger (FFO)
  const isFFO =
    data.companydesc?.toUpperCase().includes('FFO') ||
    data.companydesc?.toLowerCase().includes('forening') ||
    false;
  const [aiCandidates, setAiCandidates] = useState<AiEjendomKandidat[]>([]);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiExpanded, setAiExpanded] = useState(false);
  /** BIZZ-1866: Print-anmodning afventer fuld load */
  const [printPending, setPrintPending] = useState(false);
  const printPendingRef = useRef(false);

  /**
   * BIZZ-1866: Udløs browser-print når alle ejendomme er loaded.
   * printPendingRef bruges til at undgå dobbelt-trigger ved re-render.
   */
  useEffect(() => {
    if (printPending && ejendommeFetchComplete && !ejendommeLoadingMore) {
      if (!printPendingRef.current) {
        printPendingRef.current = true;
        // Lad React genrendre én gang (alle ejendomme er nu i DOM)
        requestAnimationFrame(() => {
          window.print();
          setPrintPending(false);
          printPendingRef.current = false;
        });
      }
    }
  }, [printPending, ejendommeFetchComplete, ejendommeLoadingMore]);

  /**
   * Kald AI-endpoint for at finde potentielle ejendomme under ejerforeningen.
   */
  const handleAiResolve = useCallback(async () => {
    setAiLoading(true);
    setAiError(null);
    try {
      const res = await fetch(`/api/ai/ejerforening-ejendomme?cvr=${data.vat}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setAiError(err.error ?? 'Ukendt fejl');
        return;
      }
      const json = await res.json();
      setAiCandidates(json.candidates ?? []);
      setAiExpanded(true);
    } catch {
      setAiError('Netværksfejl');
    } finally {
      setAiLoading(false);
    }
  }, [data.vat]);

  return (
    <div className="space-y-4">
      {/* BIZZ-617 + BIZZ-635: ÉN tab-level loading spinner. Tidligere
        rendrerede vi 2-3 parallelle spinners (tab-level +
        portefølje-sektion + indledende) — nu er der kun én. */}
      {(ejendommeLoading || ejendommeLoadingMore) && ejendommeData.length === 0 && (
        <TabLoadingSpinner label={c.loadingEjendomsportefoelje} />
      )}
      {/* BIZZ-441: Filter chips removed — only property portfolio shown */}

      {/* ── Ejendomme-portefølje sektion ── */}
      {
        <div className="space-y-4">
          {/* BIZZ-635: Fjernet intern "Indledende spinner" — den ydre
            tab-spinner dækker allerede første-load. Intern duplicate
            gav 2 stablede spinners ved tab-åbning. */}

          {/* Mangler nøgle / adgang */}
          {ejendommeFetchComplete && ejendommeManglerNoegle && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Home size={36} className="text-slate-600 mb-3" />
              <p className="text-slate-400 text-sm max-w-sm">
                {lang === 'da'
                  ? 'Ejendomsopslag kræver Datafordeler OAuth-nøgler (DATAFORDELER_OAUTH_CLIENT_ID / CLIENT_SECRET).'
                  : 'Property lookup requires Datafordeler OAuth keys (DATAFORDELER_OAUTH_CLIENT_ID / CLIENT_SECRET).'}
              </p>
            </div>
          )}
          {ejendommeFetchComplete && ejendommeManglerAdgang && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Home size={36} className="text-slate-600 mb-3" />
              <p className="text-slate-400 text-sm max-w-sm">
                {lang === 'da'
                  ? 'Adgang til Ejerfortegnelsen (EJF) er ikke godkendt endnu. Ansøg om Dataadgang på datafordeler.dk.'
                  : 'Access to the Danish land registry (EJF) has not been approved yet. Apply for Dataadgang at datafordeler.dk.'}
              </p>
            </div>
          )}

          {/* Ejendomme grid */}
          {displayEjendomme.length > 0 && (
            <>
              {/* BIZZ-1859: Loading-indikator i toppen når listen er lang */}
              {ejendommeLoadingMore && displayEjendomme.length >= 10 && (
                <div className="flex items-center justify-center gap-2 py-2 text-slate-500 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {lang === 'da'
                    ? `Indlæser flere ejendomme… (${displayEjendomme.length} af ${ejendommeTotalBfe})`
                    : `Loading more properties… (${displayEjendomme.length} of ${ejendommeTotalBfe})`}
                </div>
              )}
              <div className="flex items-center justify-between">
                <p className="text-slate-400 text-sm">
                  {ejendommeLoadingMore
                    ? lang === 'da'
                      ? `Indlæser… (${displayEjendomme.length} af ${ejendommeTotalBfe} ejendomme)`
                      : `Loading… (${displayEjendomme.length} of ${ejendommeTotalBfe} properties)`
                    : (() => {
                        const aktiveCount = displayEjendomme.filter(
                          (e) => e.aktiv !== false
                        ).length;
                        const historiskeCount = displayEjendomme.filter(
                          (e) => e.aktiv === false
                        ).length;
                        if (lang === 'da') {
                          const aktivLabel = `${aktiveCount} aktiv${aktiveCount !== 1 ? 'e' : ''} ejendom${aktiveCount !== 1 ? 'me' : ''}`;
                          return historiskeCount > 0
                            ? `${aktivLabel} · ${historiskeCount} historisk${historiskeCount !== 1 ? 'e' : ''}`
                            : aktivLabel;
                        }
                        const aktivLabel = `${aktiveCount} active propert${aktiveCount !== 1 ? 'ies' : 'y'}`;
                        return historiskeCount > 0
                          ? `${aktivLabel} · ${historiskeCount} historical`
                          : aktivLabel;
                      })()}
                </p>
                <div className="flex items-center gap-2">
                  {relatedCompanies.length > 0 && (
                    <span className="text-slate-500 text-xs">
                      {lang === 'da'
                        ? `Inkl. ${relatedCompanies.filter((v) => v.aktiv).length} datterselskab${relatedCompanies.filter((v) => v.aktiv).length !== 1 ? 'er' : ''}`
                        : `Incl. ${relatedCompanies.filter((v) => v.aktiv).length} subsidiar${relatedCompanies.filter((v) => v.aktiv).length !== 1 ? 'ies' : 'y'}`}
                    </span>
                  )}
                  {/* BIZZ-1866: Print-knap — afventer fuld load hvis data stadig indlæses */}
                  <button
                    type="button"
                    aria-label={lang === 'da' ? 'Print ejendomsliste' : 'Print property list'}
                    title={
                      ejendommeLoadingMore
                        ? lang === 'da'
                          ? 'Afventer fuld indlæsning...'
                          : 'Waiting for full load...'
                        : lang === 'da'
                          ? 'Print ejendomsliste'
                          : 'Print property list'
                    }
                    onClick={() => {
                      if (ejendommeFetchComplete && !ejendommeLoadingMore) {
                        window.print();
                      } else {
                        setPrintPending(true);
                      }
                    }}
                    className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors text-xs"
                  >
                    {printPending ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Printer size={13} />
                    )}
                    {printPending
                      ? lang === 'da'
                        ? 'Venter...'
                        : 'Waiting...'
                      : lang === 'da'
                        ? 'Print'
                        : 'Print'}
                  </button>
                </div>
              </div>

              {/* BIZZ-456: Gruppér ejendomme efter ejer-CVR i koncernhierarki.
                BIZZ-455: Separat fold-ud for solgte ejendomme. */}
              {(() => {
                // Build concern hierarchy order: main CVR first, then active subsidiaries
                const cvrOrder: number[] = [data.vat];
                const seenCvr = new Set<number>([data.vat]);
                for (const rv of relatedCompanies.filter((v) => v.aktiv)) {
                  if (!seenCvr.has(rv.cvr)) {
                    cvrOrder.push(rv.cvr);
                    seenCvr.add(rv.cvr);
                  }
                }
                const nameByCvr = new Map<number, string>();
                nameByCvr.set(data.vat, data.name);
                for (const rv of relatedCompanies) nameByCvr.set(rv.cvr, rv.navn);

                // BIZZ-1672: Split into owned, administered and sold
                const administrerede = displayEjendomme.filter(
                  (e) => e.administreret === true && e.aktiv !== false
                );
                const aktive = displayEjendomme.filter(
                  (e) => e.aktiv !== false && e.administreret !== true
                );
                const solgte = displayEjendomme.filter((e) => e.aktiv === false);

                // Group active by ownerCvr (normalized to number)
                const groupedActive = new Map<number, typeof aktive>();
                for (const e of aktive) {
                  const cvrNum = parseInt(e.ownerCvr, 10);
                  if (!groupedActive.has(cvrNum)) groupedActive.set(cvrNum, []);
                  groupedActive.get(cvrNum)!.push(e);
                }
                // Catch any ownerCvrs not in cvrOrder (e.g. person-owned)
                for (const cvr of groupedActive.keys()) {
                  if (!seenCvr.has(cvr)) {
                    cvrOrder.push(cvr);
                    seenCvr.add(cvr);
                  }
                }

                return (
                  <>
                    {cvrOrder.map((cvr) => {
                      const props = groupedActive.get(cvr);
                      if (!props || props.length === 0) return null;
                      const name = nameByCvr.get(cvr) ?? `CVR ${cvr}`;
                      const isMain = cvr === data.vat;
                      return (
                        <div key={cvr} className="space-y-2">
                          <Link
                            href={`/dashboard/companies/${cvr}`}
                            className="inline-flex items-center gap-2 group"
                          >
                            <Building2
                              size={14}
                              className="text-slate-500 group-hover:text-blue-400 transition-colors"
                            />
                            <h3 className="text-sm font-semibold text-slate-200 group-hover:text-blue-400 transition-colors">
                              {name}
                            </h3>
                            <span className="text-[10px] text-slate-500 font-mono">CVR {cvr}</span>
                            <span className="text-[10px] text-slate-500">
                              · {props.length}{' '}
                              {lang === 'da'
                                ? props.length === 1
                                  ? 'ejendom'
                                  : 'ejendomme'
                                : props.length === 1
                                  ? 'property'
                                  : 'properties'}
                            </span>
                            {isMain && (
                              <span className="text-[9px] px-1.5 py-0.5 bg-blue-500/15 border border-blue-500/30 rounded text-blue-400 font-medium">
                                {lang === 'da' ? 'Moder' : 'Parent'}
                              </span>
                            )}
                          </Link>
                          {/* BIZZ-461: Gruppér ejendomme der deler adresse (typisk
                            ejerlejligheder i samme bygning) under en kompleks-header.
                            Kun grupper med 2+ ejendomme får header — single-ejendomme
                            vises som før. */}
                          {(() => {
                            type EjType = (typeof props)[number];
                            const groups = new Map<string, EjType[]>();
                            const order: string[] = [];
                            for (const ej of props) {
                              // BIZZ-1861: Grupper på vejnavn+husnr (opgang) i stedet
                              // for fuld adresse. Lejligheder i samme opgang grupperes
                              // under én fold-ud header (Plads 16: 11 lejligheder).
                              const key = ej.adresse
                                ? `${ej.adresse.split(',')[0].trim()}|${ej.postnr ?? ''}`
                                : `bfe-${ej.bfeNummer}`;
                              if (!groups.has(key)) {
                                groups.set(key, []);
                                order.push(key);
                              }
                              groups.get(key)!.push(ej);
                            }
                            // BIZZ-569: Saml ALLE single-properties (ikke-kompleks)
                            // i ÉN delt grid så de flow'er horisontalt på desktop.
                            // Tidligere fik hver enkelt sit eget grid-wrapper hvilket
                            // tvang dem til at stack vertikalt selv på brede skærme.
                            // Bumpet bredde til lg:3 og xl:4 kolonner per spec.
                            const singleEjendomme = order
                              .filter((k) => groups.get(k)!.length === 1)
                              .map((k) => groups.get(k)![0]);
                            const komplekser = order.filter((k) => groups.get(k)!.length > 1);
                            return (
                              <div className="space-y-4">
                                {singleEjendomme.length > 0 && (
                                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                                    {singleEjendomme.map((ej) => (
                                      <PropertyOwnerCard
                                        key={ej.bfeNummer}
                                        ejendom={ej}
                                        showOwner={false}
                                        lang={lang}
                                        preEnriched={preEnrichedByBfe.get(ej.bfeNummer) ?? null}
                                      />
                                    ))}
                                  </div>
                                )}
                                {/* BIZZ-1861: Opgange med fold-ud */}
                                {komplekser.map((key) => {
                                  const grp = groups.get(key)!;
                                  const opgangAddr = grp[0].adresse?.split(',')[0].trim() ?? key;
                                  const opgangPostnr = grp[0].postnr;
                                  return (
                                    <details
                                      key={key}
                                      className="border-l-2 border-emerald-500/30 pl-3 group"
                                    >
                                      <summary className="flex items-center gap-2 mb-1.5 cursor-pointer list-none select-none hover:bg-slate-800/30 rounded px-1 py-1 -ml-1 transition-colors">
                                        <ChevronRight
                                          size={14}
                                          className="text-emerald-400/70 group-open:rotate-90 transition-transform shrink-0"
                                        />
                                        <Building2
                                          size={12}
                                          className="text-emerald-400/70 shrink-0"
                                        />
                                        <span className="text-xs font-medium text-slate-300">
                                          {opgangAddr}
                                          {opgangPostnr ? `, ${opgangPostnr}` : ''}
                                        </span>
                                        <span className="text-[10px] text-emerald-400/70 px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20">
                                          {grp.length} {lang === 'da' ? 'lejligheder' : 'units'}
                                        </span>
                                      </summary>
                                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-2">
                                        {grp.map((ej) => (
                                          <PropertyOwnerCard
                                            key={
                                              ej.bfeNummer || `${ej.adresse}-${ej.etage}-${ej.doer}`
                                            }
                                            ejendom={ej}
                                            showOwner={false}
                                            lang={lang}
                                            preEnriched={preEnrichedByBfe.get(ej.bfeNummer) ?? null}
                                          />
                                        ))}
                                      </div>
                                    </details>
                                  );
                                })}
                              </div>
                            );
                          })()}
                        </div>
                      );
                    })}
                    {/* BIZZ-1672: Administrerede ejendomme */}
                    {administrerede.length > 0 && (
                      <div className="pt-4 border-t border-teal-500/20">
                        <div className="flex items-center gap-2 mb-3">
                          <Shield size={14} className="text-teal-400" />
                          <h3 className="text-sm font-semibold text-teal-300">
                            {lang === 'da'
                              ? `Administrerede ejendomme (${administrerede.length})`
                              : `Administered properties (${administrerede.length})`}
                          </h3>
                        </div>
                        <p className="text-slate-500 text-xs mb-3">
                          {lang === 'da'
                            ? 'Følgende ejendomme administreres af denne virksomhed/ejerforening.'
                            : 'The following properties are administered by this company/association.'}
                        </p>
                        {/* BIZZ-1861: Grupper administrerede ejendomme på opgang
                          (vejnavn+husnr) med fold-ud — samme mønster som aktive. */}
                        {(() => {
                          type EjType = (typeof administrerede)[number];
                          const groups = new Map<string, EjType[]>();
                          const order: string[] = [];
                          for (const ej of administrerede) {
                            const key = ej.adresse
                              ? `${ej.adresse.split(',')[0].trim()}|${ej.postnr ?? ''}`
                              : `bfe-${ej.bfeNummer}`;
                            if (!groups.has(key)) {
                              groups.set(key, []);
                              order.push(key);
                            }
                            groups.get(key)!.push(ej);
                          }
                          const singleEjendomme = order
                            .filter((k) => groups.get(k)!.length === 1)
                            .map((k) => groups.get(k)![0]);
                          const komplekser = order.filter((k) => groups.get(k)!.length > 1);
                          return (
                            <div className="space-y-4">
                              {singleEjendomme.length > 0 && (
                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                                  {singleEjendomme.map((ej) => (
                                    <PropertyOwnerCard
                                      key={ej.bfeNummer}
                                      ejendom={ej}
                                      showOwner={false}
                                      lang={lang}
                                      preEnriched={preEnrichedByBfe.get(ej.bfeNummer) ?? null}
                                    />
                                  ))}
                                </div>
                              )}
                              {komplekser.map((key) => {
                                const grp = groups.get(key)!;
                                const opgangAddr = grp[0].adresse?.split(',')[0].trim() ?? key;
                                const opgangPostnr = grp[0].postnr;
                                return (
                                  <details
                                    key={key}
                                    className="border-l-2 border-teal-500/30 pl-3 group"
                                  >
                                    <summary className="flex items-center gap-2 mb-1.5 cursor-pointer list-none select-none hover:bg-slate-800/30 rounded px-1 py-1 -ml-1 transition-colors">
                                      <ChevronRight
                                        size={14}
                                        className="text-teal-400/70 group-open:rotate-90 transition-transform shrink-0"
                                      />
                                      <Building2 size={12} className="text-teal-400/70 shrink-0" />
                                      <span className="text-xs font-medium text-slate-300">
                                        {opgangAddr}
                                        {opgangPostnr ? `, ${opgangPostnr}` : ''}
                                      </span>
                                      <span className="text-[10px] text-teal-400/70 px-1.5 py-0.5 rounded bg-teal-500/10 border border-teal-500/20">
                                        {grp.length} {lang === 'da' ? 'lejligheder' : 'units'}
                                      </span>
                                    </summary>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-2">
                                      {grp.map((ej) => (
                                        <PropertyOwnerCard
                                          key={
                                            ej.bfeNummer || `${ej.adresse}-${ej.etage}-${ej.doer}`
                                          }
                                          ejendom={ej}
                                          showOwner={false}
                                          lang={lang}
                                          preEnriched={preEnrichedByBfe.get(ej.bfeNummer) ?? null}
                                        />
                                      ))}
                                    </div>
                                  </details>
                                );
                              })}
                            </div>
                          );
                        })()}
                      </div>
                    )}
                    {/* Fold-out for sold properties — grouped by historical owner */}
                    {solgte.length > 0 && (
                      <div className="pt-4 border-t border-slate-700/30">
                        <button
                          type="button"
                          onClick={() => setVisSolgte((v) => !v)}
                          className="flex items-center gap-2 text-xs text-slate-400 hover:text-slate-200 transition-colors"
                        >
                          {visSolgte ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          {lang === 'da'
                            ? `${visSolgte ? 'Skjul' : 'Vis'} ${solgte.length} tidligere ejendom${solgte.length !== 1 ? 'me' : ''}`
                            : `${visSolgte ? 'Hide' : 'Show'} ${solgte.length} former propert${solgte.length !== 1 ? 'ies' : 'y'}`}
                        </button>
                        {visSolgte &&
                          (() => {
                            // Group sold properties by historical owner (same ownerCvr logic)
                            const groupedSold = new Map<number, typeof solgte>();
                            for (const e of solgte) {
                              const cvrNum = parseInt(e.ownerCvr, 10);
                              if (!groupedSold.has(cvrNum)) groupedSold.set(cvrNum, []);
                              groupedSold.get(cvrNum)!.push(e);
                            }
                            // Include sold-only CVRs not already in cvrOrder
                            const soldCvrOrder = [...cvrOrder];
                            for (const cvr of groupedSold.keys()) {
                              if (!soldCvrOrder.includes(cvr)) soldCvrOrder.push(cvr);
                            }
                            return (
                              <div className="space-y-4 mt-3">
                                {soldCvrOrder.map((cvr) => {
                                  const props = groupedSold.get(cvr);
                                  if (!props || props.length === 0) return null;
                                  const name = nameByCvr.get(cvr) ?? `CVR ${cvr}`;
                                  return (
                                    <div key={cvr} className="space-y-2">
                                      <Link
                                        href={`/dashboard/companies/${cvr}`}
                                        className="inline-flex items-center gap-2 group"
                                      >
                                        <Building2
                                          size={14}
                                          className="text-slate-500 group-hover:text-blue-400 transition-colors"
                                        />
                                        <h3 className="text-sm font-semibold text-slate-400 group-hover:text-blue-400 transition-colors">
                                          {name}
                                        </h3>
                                        <span className="text-[10px] text-slate-500 font-mono">
                                          CVR {cvr}
                                        </span>
                                        <span className="text-[10px] text-slate-500">
                                          · {props.length}{' '}
                                          {lang === 'da'
                                            ? props.length === 1
                                              ? 'tidligere ejendom'
                                              : 'tidligere ejendomme'
                                            : props.length === 1
                                              ? 'former property'
                                              : 'former properties'}
                                        </span>
                                      </Link>
                                      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                                        {props.map((ej) => (
                                          <PropertyOwnerCard
                                            key={ej.bfeNummer}
                                            ejendom={ej}
                                            showOwner={false}
                                            lang={lang}
                                            preEnriched={preEnrichedByBfe.get(ej.bfeNummer) ?? null}
                                          />
                                        ))}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            );
                          })()}
                      </div>
                    )}
                  </>
                );
              })()}

              {ejendommeLoadingMore && (
                <div className="flex items-center justify-center gap-2 py-4 text-slate-500 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {lang === 'da' ? `Indlæser flere ejendomme…` : `Loading more properties…`}
                </div>
              )}
            </>
          )}

          {/* Ingen ejendomme */}
          {ejendommeFetchComplete &&
            !ejendommeManglerNoegle &&
            !ejendommeManglerAdgang &&
            displayEjendomme.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Home size={36} className="text-slate-600 mb-3" />
                <p className="text-slate-400 text-sm">
                  {lang === 'da'
                    ? 'Ingen registrerede ejendomme fundet for denne virksomhed eller dens koncern.'
                    : 'No registered properties found for this company or its group.'}
                </p>
              </div>
            )}

          {/* BIZZ-1843: AI-foreslåede ejendomme for ejerforeninger — vises uanset displayEjendomme count */}
          {isFFO && ejendommeFetchComplete && (
            <div className="pt-4 border-t border-purple-500/20">
              <div className="flex items-center gap-2 mb-3">
                <Sparkles size={14} className="text-purple-400" />
                <h3 className="text-sm font-semibold text-purple-300">
                  {lang === 'da' ? 'Find flere ejendomme (AI)' : 'Find more properties (AI)'}
                </h3>
                {aiCandidates.length === 0 && !aiLoading && (
                  <button
                    type="button"
                    onClick={handleAiResolve}
                    disabled={aiLoading}
                    className="ml-auto text-xs px-3 py-1 rounded-lg bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 transition-colors border border-purple-500/30"
                    aria-label={
                      lang === 'da'
                        ? 'Analysér adressemønstre med AI'
                        : 'Analyze address patterns with AI'
                    }
                  >
                    {aiLoading ? (
                      <Loader2 size={12} className="animate-spin inline mr-1" />
                    ) : (
                      <Sparkles size={12} className="inline mr-1" />
                    )}
                    {lang === 'da' ? 'Analysér' : 'Analyze'}
                  </button>
                )}
              </div>
              {aiLoading && (
                <div className="flex items-center gap-2 py-4 text-slate-400 text-xs">
                  <Loader2 size={14} className="animate-spin" />
                  {lang === 'da' ? 'Analyserer adressemønstre...' : 'Analyzing address patterns...'}
                </div>
              )}
              {aiError && <p className="text-red-400 text-xs py-2">{aiError}</p>}
              {aiCandidates.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() => setAiExpanded((v) => !v)}
                    className="flex items-center gap-2 text-xs text-purple-400 hover:text-purple-300 transition-colors mb-2"
                  >
                    {aiExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    {lang === 'da'
                      ? `${aiCandidates.length} AI-foreslåede ejendomme`
                      : `${aiCandidates.length} AI-suggested properties`}
                  </button>
                  {aiExpanded && (
                    <div className="space-y-2">
                      <p className="text-slate-500 text-[10px] italic mb-2">
                        {lang === 'da'
                          ? 'Genereret af AI — kan indeholde fejl. Bør verificeres manuelt.'
                          : 'Generated by AI — may contain errors. Should be verified manually.'}
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                        {aiCandidates.map((c) => (
                          <Link
                            key={c.bfeNummer}
                            href={`/dashboard/ejendomme/${c.bfeNummer}`}
                            className="block bg-slate-800/30 border border-purple-500/20 rounded-lg px-3 py-2 hover:border-purple-500/40 transition-colors"
                          >
                            <div className="flex items-center gap-2">
                              <Home size={12} className="text-purple-400 shrink-0" />
                              <span className="text-xs text-slate-200 truncate">
                                {c.adresse}
                                {c.postnr ? `, ${c.postnr}` : ''}
                                {c.by ? ` ${c.by}` : ''}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 mt-1">
                              <span
                                className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${
                                  c.confidence === 'high'
                                    ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                                    : c.confidence === 'medium'
                                      ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30'
                                      : 'bg-slate-500/20 text-slate-400 border border-slate-500/30'
                                }`}
                              >
                                {c.confidence === 'high'
                                  ? lang === 'da'
                                    ? 'Høj'
                                    : 'High'
                                  : c.confidence === 'medium'
                                    ? lang === 'da'
                                      ? 'Medium'
                                      : 'Medium'
                                    : lang === 'da'
                                      ? 'Lav'
                                      : 'Low'}
                              </span>
                              <span className="text-[10px] text-slate-500 truncate">
                                {c.reasoning}
                              </span>
                            </div>
                          </Link>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      }

      {/* BIZZ-441: Ejendomshandler sektion removed — only property portfolio shown */}
      {false && (
        <div className="space-y-4">
          {handlerLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 text-blue-500 animate-spin" />
              <span className="ml-2 text-slate-400 text-sm">
                {lang === 'da' ? 'Henter ejendomshandler…' : 'Loading property trades…'}
              </span>
            </div>
          ) : ejendomshandler.length > 0 ? (
            <>
              {/* Summary cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 text-center">
                  <p className="text-xl font-bold text-white">{ejendomshandler.length}</p>
                  <p className="text-slate-500 text-[10px] mt-0.5">
                    {lang === 'da' ? 'Handler i alt' : 'Total trades'}
                  </p>
                </div>
                <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 text-center">
                  <p className="text-xl font-bold text-emerald-400">
                    {ejendomshandler.filter((h) => h.rolle === 'koeber').length}
                  </p>
                  <p className="text-slate-500 text-[10px] mt-0.5">
                    {lang === 'da' ? 'Køb' : 'Purchases'}
                  </p>
                </div>
                <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 text-center">
                  <p className="text-xl font-bold text-rose-400">
                    {ejendomshandler.filter((h) => h.rolle === 'saelger').length}
                  </p>
                  <p className="text-slate-500 text-[10px] mt-0.5">
                    {lang === 'da' ? 'Salg' : 'Sales'}
                  </p>
                </div>
                <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 text-center">
                  <p className="text-xl font-bold text-white">
                    {new Set(ejendomshandler.map((h) => h.bfeNummer)).size}
                  </p>
                  <p className="text-slate-500 text-[10px] mt-0.5">
                    {lang === 'da' ? 'Ejendomme' : 'Properties'}
                  </p>
                </div>
              </div>

              {/* Trade table */}
              <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-slate-500 text-xs uppercase tracking-wide border-b border-slate-700/30">
                        <th className="px-4 py-2.5 whitespace-nowrap">
                          {lang === 'da' ? 'Dato' : 'Date'}
                        </th>
                        <th className="px-4 py-2.5 whitespace-nowrap">
                          {lang === 'da' ? 'Type' : 'Type'}
                        </th>
                        <th className="px-4 py-2.5 whitespace-nowrap">
                          {lang === 'da' ? 'Rolle' : 'Role'}
                        </th>
                        <th className="px-4 py-2.5 whitespace-nowrap">{c.address}</th>
                        <th className="px-4 py-2.5 whitespace-nowrap text-right">
                          {lang === 'da' ? 'Kontantpris' : 'Cash price'}
                        </th>
                        <th className="px-4 py-2.5 whitespace-nowrap text-right">{c.totalPrice}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ejendomshandler.map((h, i) => {
                        const dato = h.koebsaftaleDato ?? h.overtagelsesdato ?? '—';
                        const fmtDato = dato !== '—' ? dato.slice(0, 10) : '—';
                        const fmtPris = (n: number | null) => {
                          if (n == null) return '—';
                          if (Math.abs(n) >= 1_000_000)
                            return `${(n / 1_000_000).toFixed(1).replace('.', ',')} mio kr`;
                          return `${n.toLocaleString('da-DK')} kr`;
                        };
                        const adr = h.adresse
                          ? `${h.adresse}${h.postnr ? `, ${h.postnr}` : ''}${h.by ? ` ${h.by}` : ''}`
                          : `BFE ${h.bfeNummer}`;

                        return (
                          <tr
                            key={i}
                            className="border-b border-slate-700/20 hover:bg-slate-800/30 transition-colors"
                          >
                            <td className="px-4 py-2.5 text-white font-mono text-xs whitespace-nowrap">
                              {fmtDato}
                            </td>
                            <td className="px-4 py-2.5 text-slate-300 text-xs whitespace-nowrap">
                              {h.overdragelsesmaade ?? '—'}
                            </td>
                            <td className="px-4 py-2.5 whitespace-nowrap">
                              {h.rolle === 'koeber' ? (
                                <span className="text-[10px] font-medium bg-emerald-500/15 text-emerald-400 px-2 py-0.5 rounded-full">
                                  {lang === 'da' ? 'Køber' : 'Buyer'}
                                </span>
                              ) : h.rolle === 'saelger' ? (
                                <span className="text-[10px] font-medium bg-rose-500/15 text-rose-400 px-2 py-0.5 rounded-full">
                                  {lang === 'da' ? 'Sælger' : 'Seller'}
                                </span>
                              ) : (
                                <span className="text-[10px] font-medium bg-slate-500/15 text-slate-400 px-2 py-0.5 rounded-full">
                                  —
                                </span>
                              )}
                            </td>
                            <td
                              className="px-4 py-2.5 text-white text-xs max-w-[250px] truncate"
                              title={adr}
                            >
                              {adr}
                            </td>
                            <td className="px-4 py-2.5 text-right whitespace-nowrap">
                              <span
                                className={`text-sm font-medium ${h.kontantKoebesum != null ? 'text-white' : 'text-slate-600'}`}
                              >
                                {fmtPris(h.kontantKoebesum)}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-right whitespace-nowrap">
                              <span
                                className={`text-sm font-medium ${h.samletKoebesum != null ? 'text-white' : 'text-slate-600'}`}
                              >
                                {fmtPris(h.samletKoebesum)}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : handlerManglerAdgang ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Shield size={32} className="text-amber-500/60 mb-3" />
              <p className="text-slate-300 text-sm font-medium mb-1">
                {lang === 'da'
                  ? 'Afventer EJF-adgang fra Datafordeler'
                  : 'Awaiting EJF access from Datafordeler'}
              </p>
              <p className="text-slate-500 text-xs max-w-md">
                {lang === 'da'
                  ? 'Ejendomshandler kræver godkendt Dataadgang til Ejerfortegnelsen (EJF) hos Geodatastyrelsen. Ansøgningen er indsendt.'
                  : 'Property trades require approved data access to EJF from the Danish Geodata Agency. The application has been submitted.'}
              </p>
            </div>
          ) : !handlerLoading ? (
            <EmptyState
              ikon={<ArrowRightLeft size={32} className="text-slate-600" />}
              tekst={c.noTradesFound}
            />
          ) : null}
        </div>
      )}

      {/* BIZZ-409: Historiske ejendomme (solgte) — hidden with handler section */}
      {false &&
        !handlerLoading &&
        (() => {
          const solgte = ejendomshandler.filter((h) => h.rolle === 'saelger' && h.adresse);
          if (solgte.length === 0) return null;
          const da = lang === 'da';
          return (
            <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 border-b border-slate-700/40">
                <p className="text-slate-200 text-xs font-semibold">
                  {da ? 'Historiske ejendomme (solgte)' : 'Historical properties (sold)'}
                  <span className="text-slate-500 font-normal ml-2">({solgte.length})</span>
                </p>
              </div>
              <div className="divide-y divide-slate-700/20">
                {solgte.slice(0, 20).map((h, i) => (
                  <div
                    key={`sold-${h.bfeNummer ?? i}`}
                    className="px-4 py-2 flex items-center justify-between text-sm"
                  >
                    <div>
                      <p className="text-slate-300 text-xs">{h.adresse}</p>
                      <p className="text-slate-500 text-[10px]">
                        {h.overtagelsesdato
                          ? new Date(h.overtagelsesdato).toLocaleDateString('da-DK', {
                              day: 'numeric',
                              month: 'short',
                              year: 'numeric',
                            })
                          : '–'}
                        {h.overdragelsesmaade ? ` · ${h.overdragelsesmaade}` : ''}
                      </p>
                    </div>
                    {h.kontantKoebesum != null && h.kontantKoebesum > 0 && (
                      <span className="text-slate-400 text-xs font-medium">
                        {h.kontantKoebesum.toLocaleString('da-DK')} DKK
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })()}
    </div>
  );
}
