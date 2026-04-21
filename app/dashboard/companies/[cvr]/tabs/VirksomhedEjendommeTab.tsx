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

import Link from 'next/link';
import {
  ArrowRightLeft,
  Building2,
  ChevronDown,
  ChevronRight,
  Home,
  Loader2,
  Shield,
} from 'lucide-react';
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
          {ejendommeData.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <p className="text-slate-400 text-sm">
                  {ejendommeLoadingMore
                    ? lang === 'da'
                      ? `Indlæser… (${ejendommeData.length} af ${ejendommeTotalBfe} ejendomme)`
                      : `Loading… (${ejendommeData.length} of ${ejendommeTotalBfe} properties)`
                    : (() => {
                        // BIZZ-639: Overskriften skal vise både aktive og
                        // historiske (solgte) tal. Historisk-tallet
                        // skjules helt når 0 så overskriften ikke ser
                        // tom ud for nye/rene porteføljer.
                        const aktiveCount = ejendommeData.filter((e) => e.aktiv !== false).length;
                        const historiskeCount = ejendommeData.filter(
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
                {relatedCompanies.length > 0 && (
                  <span className="text-slate-500 text-xs">
                    {lang === 'da'
                      ? `Inkl. ${relatedCompanies.filter((v) => v.aktiv).length} datterselskab${relatedCompanies.filter((v) => v.aktiv).length !== 1 ? 'er' : ''}`
                      : `Incl. ${relatedCompanies.filter((v) => v.aktiv).length} subsidiar${relatedCompanies.filter((v) => v.aktiv).length !== 1 ? 'ies' : 'y'}`}
                  </span>
                )}
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

                // Split into active and sold
                const aktive = ejendommeData.filter((e) => e.aktiv !== false);
                const solgte = ejendommeData.filter((e) => e.aktiv === false);

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
                              // Key = adresse + postnr; tom adresse = unikt fallback per BFE
                              const key = ej.adresse
                                ? `${ej.adresse}|${ej.postnr ?? ''}`
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
                                {komplekser.map((key) => {
                                  const grp = groups.get(key)!;
                                  // Kompleks: header + indented grid
                                  return (
                                    <div
                                      key={key}
                                      className="border-l-2 border-emerald-500/30 pl-3"
                                    >
                                      <div className="flex items-center gap-2 mb-1.5">
                                        <Building2 size={12} className="text-emerald-400/70" />
                                        <span className="text-xs font-medium text-slate-300">
                                          {grp[0].adresse}
                                          {grp[0].postnr ? `, ${grp[0].postnr}` : ''}
                                        </span>
                                        <span className="text-[10px] text-emerald-400/70 px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20">
                                          {lang === 'da'
                                            ? `Kompleks · ${grp.length} ejerlejligheder`
                                            : `Complex · ${grp.length} units`}
                                        </span>
                                      </div>
                                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                                        {grp.map((ej) => (
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
                      );
                    })}
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
            ejendommeData.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Home size={36} className="text-slate-600 mb-3" />
                <p className="text-slate-400 text-sm">
                  {lang === 'da'
                    ? 'Ingen registrerede ejendomme fundet for denne virksomhed eller dens koncern.'
                    : 'No registered properties found for this company or its group.'}
                </p>
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
