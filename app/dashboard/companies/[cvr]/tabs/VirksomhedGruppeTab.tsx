/**
 * VirksomhedGruppeTab — Gruppe-fane (datterselskaber, moderselskaber, ejerkæde).
 * BIZZ-658: Extraheret fra VirksomhedDetaljeClient.tsx.
 * @module app/dashboard/companies/[cvr]/tabs/VirksomhedGruppeTab
 */
'use client';

import { useRouter } from 'next/navigation';
import { Building2, ChevronDown, ExternalLink, Loader2 } from 'lucide-react';
import TabLoadingSpinner from '@/app/components/TabLoadingSpinner';
import { translations } from '@/app/lib/translations';
import type { CVRPublicData } from '@/app/api/cvr-public/route';
import type { RelateretVirksomhed } from '@/app/api/cvr-public/related/route';
import type { RegnskabsAar } from '@/app/api/regnskab/xbrl/route';
import type { OwnerChainNode } from './VirksomhedOverblikTab';

interface Props {
  lang: 'da' | 'en';
  data: CVRPublicData;
  relatedCompanies: RelateretVirksomhed[];
  relatedLoading: boolean;
  ownerChainShared: OwnerChainNode[];
  gruppeFinans: Map<
    number,
    { brutto: number | null; balance: number | null; egenkapital: number | null }
  >;
  gruppeFinansLoading: boolean;
  parentCompanyDetails: Map<number, RelateretVirksomhed>;
  xbrlData: RegnskabsAar[] | null;
  xbrlLoading: boolean;
  parentSectionOpen: boolean;
  setParentSectionOpen: React.Dispatch<React.SetStateAction<boolean>>;
  childSectionOpen: boolean;
  setChildSectionOpen: React.Dispatch<React.SetStateAction<boolean>>;
  visHistorik: boolean;
  setVisHistorik: React.Dispatch<React.SetStateAction<boolean>>;
}

export default function VirksomhedGruppeTab({
  lang,
  data,
  relatedCompanies,
  relatedLoading,
  ownerChainShared,
  gruppeFinans,
  gruppeFinansLoading,
  parentCompanyDetails,
  xbrlData,
  xbrlLoading,
  parentSectionOpen,
  setParentSectionOpen,
  childSectionOpen,
  setChildSectionOpen,
  visHistorik,
  setVisHistorik,
}: Props) {
  const c = translations[lang].company;
  const router = useRouter();

  return (
    <div className="space-y-4">
      {/* BIZZ-617: Loading med specifik label */}
      {relatedLoading && <TabLoadingSpinner label={c.loadingDatterselskaber} />}

      {/* Gruppe-hierarki */}
      {!relatedLoading &&
        data &&
        (() => {
          /** Aktive relaterede virksomheder (ophørte filtreres fra) */
          const aktive = relatedCompanies.filter((v) => v.aktiv);
          /**
           * BIZZ-475: Historiske (ophørte/solgte) datterselskaber. Vises
           * kun når brugeren toggler "Vis historik" — beholdes som flad
           * liste for at undgå at rode gruppestrukturen til.
           */
          const historiske = relatedCompanies.filter((v) => !v.aktiv);
          /** Rod-virksomheder (ejet direkte af den valgte, eller ingen anden ejer på listen) */
          const rodVirksomheder = aktive.filter((v) => v.ejetAfCvr == null);
          /** Børn grupperet efter ejer-CVR */
          const boernMap = new Map<number, typeof aktive>();
          for (const v of aktive) {
            if (v.ejetAfCvr != null) {
              const arr = boernMap.get(v.ejetAfCvr) ?? [];
              arr.push(v);
              boernMap.set(v.ejetAfCvr, arr);
            }
          }

          /** Formatér tal med tusindtalsseparator */
          const fmtNum = (n: number | null) => {
            if (n == null) return '–';
            return n.toLocaleString('da-DK');
          };
          /** Formatér tal i tusinder/millioner */
          const fmtKr = (n: number | null) => {
            if (n == null) return '–';
            const abs = Math.abs(n);
            if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.', ',')} mio`;
            if (abs >= 1_000) return `${Math.round(n / 1_000)} t.kr`;
            return fmtNum(n);
          };

          /** Find ejerandel — direkte fra queried company, eller fra overliggende virksomhed */
          const findEjerandel = (rel: (typeof aktive)[0]): string | null => {
            // Direkte ejerandel fra den forespurgte virksomhed
            if (rel.ejerandel) return rel.ejerandel;
            // Find ejerandel fra parent-virksomheden (ejetAfCvr) via ejere-listen
            if (rel.ejetAfCvr != null) {
              // Find parent-virksomhedens navn
              const parent = aktive.find((a) => a.cvr === rel.ejetAfCvr);
              const parentNavn = parent?.navn ?? data.name;
              // Match ejer-entry med samme navn som parent
              const parentEjer = rel.ejere.find((e) => e.erVirksomhed && e.navn === parentNavn);
              if (parentEjer?.ejerandel) return parentEjer.ejerandel;
            }
            return null;
          };

          const renderCard = (rel: (typeof aktive)[0], depth: number) => {
            const fin = gruppeFinans.get(rel.cvr);
            const visEjerandel = findEjerandel(rel);
            return (
              <button
                key={rel.cvr}
                onClick={() => router.push(`/dashboard/companies/${rel.cvr}`)}
                className={`w-full bg-[#0f1729] border border-slate-700/50 rounded-xl px-4 py-3.5 text-left hover:border-blue-500/40 hover:bg-[#131d36] transition-all group ${depth > 0 ? 'border-l-2 border-l-blue-500/30' : ''}`}
              >
                {/* Øverste linje: Navn + badges */}
                <div className="flex items-center gap-2 mb-3">
                  <Building2
                    size={15}
                    className="text-slate-500 group-hover:text-blue-400 shrink-0 transition-colors"
                  />
                  <span className="text-white text-sm font-semibold truncate group-hover:text-blue-300 transition-colors">
                    {rel.navn}
                  </span>
                  {visEjerandel && (
                    <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/20">
                      {visEjerandel}
                    </span>
                  )}
                  {rel.aktiv ? (
                    <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                      {lang === 'da' ? 'Aktiv' : 'Active'}
                    </span>
                  ) : (
                    <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-red-500/15 text-red-400 border border-red-500/20">
                      {lang === 'da' ? 'Ophørt' : 'Dissolved'}
                    </span>
                  )}
                  <ExternalLink
                    size={12}
                    className="ml-auto text-slate-600 group-hover:text-blue-400 shrink-0 transition-colors"
                  />
                </div>

                {/* 3 sektioner med vertikale dividers — proportional bredde */}
                <div className="flex items-stretch gap-0 rounded-lg bg-[#0a1020]/60 border border-slate-700/30">
                  {/* Sektion 1: Stamdata */}
                  <div className="flex-[3] min-w-0 px-3.5 py-2.5">
                    <div className="text-[10px] text-slate-500/80 font-medium uppercase tracking-wider mb-1.5">
                      Stamdata
                    </div>
                    <div className="text-xs text-slate-300">
                      CVR {rel.cvr} · {rel.form ?? ''}
                    </div>
                    {rel.branche && (
                      <div className="text-[11px] text-slate-400 truncate mt-0.5">
                        {rel.branche}
                      </div>
                    )}
                    {rel.adresse && (
                      <div className="text-[11px] text-slate-500 truncate mt-0.5">
                        {rel.adresse}
                        {rel.postnr ? `, ${rel.postnr}` : ''}
                        {rel.by ? ` ${rel.by}` : ''}
                      </div>
                    )}
                    {rel.direktoer && (
                      <div className="text-[11px] text-slate-400 truncate mt-0.5">
                        Dir. {rel.direktoer}
                      </div>
                    )}
                  </div>

                  {/* Vertikal divider */}
                  <div className="w-px bg-slate-700/40 self-stretch my-2" />

                  {/* Sektion 2: Organisation */}
                  <div className="flex-[2] min-w-0 px-3.5 py-2.5">
                    <div className="text-[10px] text-slate-500/80 font-medium uppercase tracking-wider mb-1.5">
                      Organisation
                    </div>
                    <div className="space-y-1">
                      <div className="flex justify-between text-[11px]">
                        <span className="text-slate-500">Ansatte</span>
                        <span className="text-slate-300 font-medium tabular-nums">
                          {rel.ansatte ?? '–'}
                        </span>
                      </div>
                      <div className="flex justify-between text-[11px]">
                        <span className="text-slate-500">P-enheder</span>
                        <span className="text-slate-300 font-medium tabular-nums">
                          {rel.antalPenheder}
                        </span>
                      </div>
                      <div className="flex justify-between text-[11px]">
                        <span className="text-slate-500">Datterselskaber</span>
                        <span className="text-slate-300 font-medium tabular-nums">
                          {rel.antalDatterselskaber}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Vertikal divider */}
                  <div className="w-px bg-slate-700/40 self-stretch my-2" />

                  {/* Sektion 3: Regnskab */}
                  <div className="flex-[2] min-w-0 px-3.5 py-2.5">
                    <div className="text-[10px] text-slate-500/80 font-medium uppercase tracking-wider mb-1.5">
                      Regnskab
                      {gruppeFinansLoading && !fin && (
                        <Loader2 size={8} className="inline ml-1 animate-spin" />
                      )}
                    </div>
                    <div className="space-y-1">
                      <div className="flex justify-between text-[11px]">
                        <span className="text-slate-500">Brutto</span>
                        <span
                          className={`font-medium tabular-nums ${fin?.brutto != null ? (fin.brutto >= 0 ? 'text-emerald-400' : 'text-red-400') : 'text-slate-500'}`}
                        >
                          {fin ? fmtKr(fin.brutto) : '–'}
                        </span>
                      </div>
                      <div className="flex justify-between text-[11px]">
                        <span className="text-slate-500">Balance</span>
                        <span className="font-medium tabular-nums text-slate-300">
                          {fin ? fmtKr(fin.balance) : '–'}
                        </span>
                      </div>
                      <div className="flex justify-between text-[11px]">
                        <span className="text-slate-500">Egenkapital</span>
                        <span
                          className={`font-medium tabular-nums ${fin?.egenkapital != null ? (fin.egenkapital >= 0 ? 'text-emerald-400' : 'text-red-400') : 'text-slate-500'}`}
                        >
                          {fin ? fmtKr(fin.egenkapital) : '–'}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </button>
            );
          };

          // Udtræk modervirksomheder fra ejerkæden
          const parentCompanies: {
            navn: string;
            cvr: number | null;
            enhedsNummer: number | null;
            ejerandel: string | null;
          }[] = [];
          const seenParentIds = new Set<number>();
          function collectParentCompanies(nodes: OwnerChainNode[]) {
            for (const n of nodes) {
              if (n.erVirksomhed) {
                const id = n.cvr ?? n.enhedsNummer ?? 0;
                if (id && !seenParentIds.has(id) && id !== data!.vat) {
                  seenParentIds.add(id);
                  parentCompanies.push({
                    navn: n.navn,
                    cvr: n.cvr,
                    enhedsNummer: n.enhedsNummer,
                    ejerandel: n.ejerandel,
                  });
                }
              }
              if (n.parents.length > 0) collectParentCompanies(n.parents);
            }
          }
          collectParentCompanies(ownerChainShared);

          const _totalRelateret = aktive.length + parentCompanies.length;

          return (
            <>
              {/* Modervirksomheder (opad i strukturen) — collapsed by default */}
              {parentCompanies.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() => setParentSectionOpen((prev) => !prev)}
                    className="flex items-center gap-2 w-full group cursor-pointer"
                  >
                    <ChevronDown
                      size={14}
                      className={`text-slate-400 group-hover:text-slate-300 transition-all duration-200 shrink-0 ${parentSectionOpen ? '' : '-rotate-90'}`}
                    />
                    <span className="text-sm text-slate-300 group-hover:text-slate-200 font-medium transition-colors whitespace-nowrap">
                      {lang === 'da'
                        ? `${parentCompanies.length} modervirksomhed${parentCompanies.length > 1 ? 'er' : ''}`
                        : `${parentCompanies.length} parent compan${parentCompanies.length > 1 ? 'ies' : 'y'}`}
                    </span>
                    <div className="h-px flex-1 bg-slate-700 group-hover:bg-slate-600 transition-colors" />
                  </button>
                  {parentSectionOpen && (
                    <div className="grid gap-3">
                      {parentCompanies.map((pc) => {
                        const linkCvr = pc.cvr ?? pc.enhedsNummer;
                        const detail = linkCvr ? parentCompanyDetails.get(linkCvr) : null;

                        // Brug detaljeret kort hvis data er hentet, ellers vis simpelt kort med loading
                        if (detail) {
                          return (
                            <div key={linkCvr} className="relative">
                              {/* Moderselskab-badge overlay */}
                              <div className="absolute top-2 right-12 z-10">
                                <span className="px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-indigo-500/15 text-indigo-400 border border-indigo-500/20">
                                  {lang === 'da' ? 'Moderselskab' : 'Parent'}
                                </span>
                              </div>
                              {renderCard(detail, 0)}
                            </div>
                          );
                        }

                        // Fallback: simpelt kort mens data loader
                        return (
                          <button
                            key={linkCvr}
                            onClick={() =>
                              linkCvr && router.push(`/dashboard/companies/${linkCvr}`)
                            }
                            className="w-full bg-[#0f1729] border border-slate-700/50 rounded-xl px-4 py-3.5 text-left hover:border-blue-500/40 hover:bg-[#131d36] transition-all group"
                          >
                            <div className="flex items-center gap-2">
                              <Building2
                                size={15}
                                className="text-slate-500 group-hover:text-blue-400 shrink-0 transition-colors"
                              />
                              <span className="text-white text-sm font-semibold truncate group-hover:text-blue-300 transition-colors">
                                {pc.navn}
                              </span>
                              {pc.ejerandel && (
                                <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/20">
                                  {pc.ejerandel}
                                </span>
                              )}
                              <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-indigo-500/15 text-indigo-400 border border-indigo-500/20">
                                {lang === 'da' ? 'Moderselskab' : 'Parent'}
                              </span>
                              <Loader2
                                size={12}
                                className="ml-auto text-slate-500 animate-spin shrink-0"
                              />
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              )}

              {/* Parent card — den valgte virksomhed (same 3-section layout) */}
              {(() => {
                const selFin =
                  gruppeFinans.get(data.vat) ??
                  (xbrlData && xbrlData.length > 0
                    ? {
                        brutto: xbrlData[0].resultat?.bruttofortjeneste ?? null,
                        balance: xbrlData[0].balance?.aktiverIAlt ?? null,
                        egenkapital: xbrlData[0].balance?.egenkapital ?? null,
                      }
                    : null);
                const selPenheder = (data.productionunits ?? []).filter((p) => p.active).length;
                const selDirektør = (data.deltagere ?? []).find((d) =>
                  d.roller.some((r) => r.rolle.toUpperCase().includes('DIREKTION') && !r.til)
                );
                return (
                  <div className="w-full bg-[#131d36] border border-blue-500/30 rounded-xl px-4 py-3.5">
                    {/* Øverste linje: Navn + badges */}
                    <div className="flex items-center gap-2 mb-3">
                      <Building2 size={15} className="text-blue-400 shrink-0" />
                      <span className="text-white text-sm font-semibold truncate">{data.name}</span>
                      <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-blue-500/20 text-blue-300 border border-blue-500/30">
                        {lang === 'da' ? 'Valgt' : 'Selected'}
                      </span>
                      {!data.enddate ? (
                        <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                          {lang === 'da' ? 'Aktiv' : 'Active'}
                        </span>
                      ) : (
                        <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-red-500/15 text-red-400 border border-red-500/20">
                          {lang === 'da' ? 'Ophørt' : 'Dissolved'}
                        </span>
                      )}
                    </div>

                    {/* 3 sektioner med vertikale dividers */}
                    <div className="flex items-stretch gap-0 rounded-lg bg-[#0a1020]/60 border border-blue-500/20">
                      {/* Sektion 1: Stamdata */}
                      <div className="flex-[3] min-w-0 px-3.5 py-2.5">
                        <div className="text-[10px] text-slate-500/80 font-medium uppercase tracking-wider mb-1.5">
                          Stamdata
                        </div>
                        <div className="text-xs text-slate-300">
                          CVR {data.vat} · {data.companydesc ?? ''}
                        </div>
                        {data.industrydesc && (
                          <div className="text-[11px] text-slate-400 truncate mt-0.5">
                            {data.industrydesc}
                          </div>
                        )}
                        {data.address && (
                          <div className="text-[11px] text-slate-500 truncate mt-0.5">
                            {data.address}, {data.zipcode} {data.city}
                          </div>
                        )}
                        {selDirektør && (
                          <div className="text-[11px] text-slate-400 truncate mt-0.5">
                            Dir. {selDirektør.navn}
                          </div>
                        )}
                      </div>

                      {/* Vertikal divider */}
                      <div className="w-px bg-slate-700/40 self-stretch my-2" />

                      {/* Sektion 2: Organisation */}
                      <div className="flex-[2] min-w-0 px-3.5 py-2.5">
                        <div className="text-[10px] text-slate-500/80 font-medium uppercase tracking-wider mb-1.5">
                          Organisation
                        </div>
                        <div className="space-y-1">
                          <div className="flex justify-between text-[11px]">
                            <span className="text-slate-500">Ansatte</span>
                            <span className="text-slate-300 font-medium tabular-nums">
                              {data.employees ?? '–'}
                            </span>
                          </div>
                          <div className="flex justify-between text-[11px]">
                            <span className="text-slate-500">P-enheder</span>
                            <span className="text-slate-300 font-medium tabular-nums">
                              {selPenheder}
                            </span>
                          </div>
                          <div className="flex justify-between text-[11px]">
                            <span className="text-slate-500">Datterselskaber</span>
                            <span className="text-slate-300 font-medium tabular-nums">
                              {aktive.length}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Vertikal divider */}
                      <div className="w-px bg-slate-700/40 self-stretch my-2" />

                      {/* Sektion 3: Regnskab */}
                      <div className="flex-[2] min-w-0 px-3.5 py-2.5">
                        <div className="text-[10px] text-slate-500/80 font-medium uppercase tracking-wider mb-1.5">
                          Regnskab
                          {!selFin && xbrlLoading && (
                            <Loader2 size={8} className="inline ml-1 animate-spin" />
                          )}
                        </div>
                        <div className="space-y-1">
                          <div className="flex justify-between text-[11px]">
                            <span className="text-slate-500">Brutto</span>
                            <span
                              className={`font-medium tabular-nums ${selFin?.brutto != null ? (selFin.brutto >= 0 ? 'text-emerald-400' : 'text-red-400') : 'text-slate-500'}`}
                            >
                              {selFin ? fmtKr(selFin.brutto) : '–'}
                            </span>
                          </div>
                          <div className="flex justify-between text-[11px]">
                            <span className="text-slate-500">Balance</span>
                            <span className="font-medium tabular-nums text-slate-300">
                              {selFin ? fmtKr(selFin.balance) : '–'}
                            </span>
                          </div>
                          <div className="flex justify-between text-[11px]">
                            <span className="text-slate-500">Egenkapital</span>
                            <span
                              className={`font-medium tabular-nums ${selFin?.egenkapital != null ? (selFin.egenkapital >= 0 ? 'text-emerald-400' : 'text-red-400') : 'text-slate-500'}`}
                            >
                              {selFin ? fmtKr(selFin.egenkapital) : '–'}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Datterselskaber — collapsible */}
              {aktive.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() => setChildSectionOpen((prev) => !prev)}
                    className="flex items-center gap-2 w-full group cursor-pointer pt-2"
                  >
                    <ChevronDown
                      size={14}
                      className={`text-slate-400 group-hover:text-slate-300 transition-all duration-200 shrink-0 ${childSectionOpen ? '' : '-rotate-90'}`}
                    />
                    <span className="text-sm text-slate-300 group-hover:text-slate-200 font-medium transition-colors whitespace-nowrap">
                      {lang === 'da'
                        ? `${aktive.length} datterselskab${aktive.length > 1 ? 'er' : ''}`
                        : `${aktive.length} subsidiar${aktive.length > 1 ? 'ies' : 'y'}`}
                    </span>
                    <div className="h-px flex-1 bg-slate-700 group-hover:bg-slate-600 transition-colors" />
                  </button>
                  {childSectionOpen && (
                    <div className="grid gap-3">
                      {(() => {
                        /** Renderer en virksomhed og dens børn rekursivt */
                        const renderTree = (
                          virk: (typeof aktive)[0],
                          depth: number
                        ): React.ReactNode => (
                          <div
                            key={virk.cvr}
                            style={depth > 0 ? { paddingLeft: `${depth * 32}px` } : undefined}
                          >
                            {renderCard(virk, depth)}
                            {boernMap.has(virk.cvr) && (
                              <div className="grid gap-2 mt-2">
                                {boernMap
                                  .get(virk.cvr)!
                                  .map((child) => renderTree(child, depth + 1))}
                              </div>
                            )}
                          </div>
                        );
                        return rodVirksomheder.map((rel) => renderTree(rel, 0));
                      })()}
                    </div>
                  )}
                </>
              )}

              {/* BIZZ-475: Historiske datterselskaber — toggle-drevet */}
              {historiske.length > 0 && (
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={() => setVisHistorik((prev) => !prev)}
                    className="flex items-center gap-2 w-full group cursor-pointer"
                    aria-expanded={visHistorik}
                  >
                    <ChevronDown
                      size={14}
                      className={`text-slate-500 group-hover:text-slate-400 transition-all duration-200 shrink-0 ${visHistorik ? '' : '-rotate-90'}`}
                    />
                    <span className="text-sm text-slate-400 group-hover:text-slate-300 font-medium transition-colors whitespace-nowrap">
                      {lang === 'da'
                        ? `Vis historik (${historiske.length} ophørt${historiske.length > 1 ? 'e' : ''})`
                        : `Show history (${historiske.length} dissolved)`}
                    </span>
                    <div className="h-px flex-1 bg-slate-700/60 group-hover:bg-slate-600 transition-colors" />
                  </button>
                  {visHistorik && (
                    <div className="grid gap-3 mt-2 opacity-75">
                      {historiske.map((rel) => renderCard(rel, 0))}
                    </div>
                  )}
                </div>
              )}

              {/* No related companies */}
              {aktive.length === 0 && historiske.length === 0 && (
                <div className="text-center py-8">
                  <Building2 size={32} className="mx-auto text-slate-600 mb-2" />
                  <p className="text-slate-500 text-sm">{c.noCompanies}</p>
                </div>
              )}
            </>
          );
        })()}
    </div>
  );
}
