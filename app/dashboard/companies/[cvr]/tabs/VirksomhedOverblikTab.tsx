/**
 * VirksomhedOverblikTab — Overblik-fane på virksomhedsdetaljesiden.
 *
 * Viser: stamdata, branche, ledelse/ejere, kontakt, formål,
 * tegningsregel, produktionsenheder, koncernstruktur.
 *
 * BIZZ-658: Extraheret fra VirksomhedDetaljeClient.tsx for at reducere
 * master-file-størrelsen. Ren filopdeling — ingen logik-/adfærds-ændring.
 *
 * @module app/dashboard/companies/[cvr]/tabs/VirksomhedOverblikTab
 */

'use client';

import { Fragment } from 'react';
import Link from 'next/link';
import { Building2, Factory, LayoutDashboard, MapPin, Phone, Mail } from 'lucide-react';
import TabLoadingSpinner from '@/app/components/TabLoadingSpinner';
import { translations } from '@/app/lib/translations';
import type { CVRPublicData } from '@/app/api/cvr-public/route';
import type { RelateretVirksomhed } from '@/app/api/cvr-public/related/route';
import type { RegnskabsAar } from '@/app/api/regnskab/xbrl/route';

/** Tomt-tilstands-besked med ikon. */
function EmptyState({ ikon, tekst }: { ikon: React.ReactNode; tekst: string }) {
  return (
    <div className="text-center py-12">
      <div className="mx-auto mb-3 flex justify-center">{ikon}</div>
      <p className="text-slate-400 text-sm">{tekst}</p>
    </div>
  );
}

/** Ejer-/ledelsesinformation afledt fra CVR deltagere */
export interface PersonMedRolle {
  deltager: CVRPublicData['deltagere'][0];
  rolle: CVRPublicData['deltagere'][0]['roller'][0];
}

/** Ejerkædenode (rekursiv) */
export interface OwnerChainNode {
  navn: string;
  enhedsNummer: number | null;
  cvr: number | null;
  erVirksomhed: boolean;
  ejerandel: string | null;
  isCeased?: boolean;
  parents: OwnerChainNode[];
}

interface Props {
  /** 'da' | 'en' */
  lang: 'da' | 'en';
  /** CVR virksomhedsdata */
  data: CVRPublicData;
  /** Relaterede virksomheder (datterselskaber, moderselskaber) */
  relatedCompanies: RelateretVirksomhed[];
  /** Delte ejerkædenoder */
  ownerChainShared: OwnerChainNode[];
  /** XBRL regnskabsdata */
  xbrlData: RegnskabsAar[] | null;
  /** true hvis XBRL data indlæses */
  xbrlLoading: boolean;
  /** Grupperede deltagere med aktive/historiske */
  personerByKategori: Record<string, { aktive: PersonMedRolle[]; historiske: PersonMedRolle[] }>;
  /** true hvis relaterede virksomheder indlæses */
  relatedLoading: boolean;
  /** Aktiv sektionsfilter */
  oversigtFilter: string | null;
  /** Setter for oversigtFilter */
  setOversigtFilter: React.Dispatch<React.SetStateAction<string | null>>;
}

/**
 * Render overblik-fanen for en virksomhed.
 * Ren præsentations-komponent — alt data leveres via props.
 */
export default function VirksomhedOverblikTab({
  lang,
  data,
  relatedCompanies,
  ownerChainShared,
  xbrlData,
  xbrlLoading,
  personerByKategori,
  relatedLoading,
  oversigtFilter,
  setOversigtFilter,
}: Props) {
  const c = translations[lang].company;

  return (
    <div className="space-y-4">
      {/* ── Sektionsfiltre (Kronologi-stil: Alle eller én valgt) ── */}
      {(() => {
        const harGruppe =
          relatedCompanies.filter((v) => v.aktiv).length > 0 ||
          ownerChainShared.some((o) => o.erVirksomhed);
        const filterChips: [string, string, React.ReactNode, string, string][] = [
          [
            'info',
            'Info',
            <Building2 key="i" size={12} />,
            'text-blue-400',
            'bg-blue-600/30 border-blue-500/50 text-blue-300',
          ],
          ...(harGruppe
            ? [
                [
                  'gruppe',
                  lang === 'da' ? 'Gruppe Info' : 'Group Info',
                  <Building2 key="g" size={12} />,
                  'text-indigo-400',
                  'bg-indigo-600/30 border-indigo-500/50 text-indigo-300',
                ] as [string, string, React.ReactNode, string, string],
              ]
            : []),
          [
            'pe',
            lang === 'da' ? 'P-enheder' : 'Prod. Units',
            <Factory key="p" size={12} />,
            'text-cyan-400',
            'bg-cyan-600/30 border-cyan-500/50 text-cyan-300',
          ],
        ];
        return (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setOversigtFilter(null)}
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all border ${
                oversigtFilter === null
                  ? 'bg-white/10 border-white/30 text-white'
                  : 'bg-slate-800/50 border-slate-700/40 text-slate-400 hover:text-slate-200 hover:border-slate-600'
              }`}
            >
              <LayoutDashboard size={12} />
              {lang === 'da' ? 'Alle' : 'All'}
            </button>
            {filterChips.map(([key, label, icon, color, activeClass]) => (
              <button
                key={key}
                onClick={() => setOversigtFilter(oversigtFilter === key ? null : key)}
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all border ${
                  oversigtFilter === key
                    ? activeClass
                    : 'bg-slate-800/50 border-slate-700/40 text-slate-400 hover:text-slate-200 hover:border-slate-600'
                }`}
              >
                <span className={oversigtFilter === key ? '' : color}>{icon}</span>
                {label}
              </button>
            ))}
          </div>
        );
      })()}

      {/* ── Layout: Info (venstre) + Gruppe (højre) — fuld bredde hvis ingen gruppe ── */}
      <div
        className={`grid grid-cols-1 ${relatedCompanies.filter((v) => v.aktiv).length > 0 ? 'lg:grid-cols-2' : ''} gap-4`}
      >
        {/* ═══ KOLONNE 1: Info ═══ */}
        {(oversigtFilter === null || oversigtFilter === 'info') &&
          (() => {
            const aktiveEjere = personerByKategori['EJER']?.aktive ?? [];
            const aktiveDirektion = personerByKategori['DIREKTION']?.aktive ?? [];
            const aktiveRevision = personerByKategori['REVISION']?.aktive ?? [];
            return (
              <section className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-5">
                {/* Overskrift med branchekode */}
                <h2 className="text-white font-semibold text-sm flex items-center gap-2">
                  <Building2 size={15} className="text-blue-400" />
                  Info
                </h2>
                {data.industrydesc && (
                  <p className="text-slate-400 text-xs mt-1">
                    {data.industrycode ? `${data.industrycode} — ` : ''}
                    {data.industrydesc}
                  </p>
                )}
                {/* BIZZ-512: Sekundære brancher (bibranche1/2/3). For holdinger
                  og blandede virksomheder er bibrancherne ofte mere retvisende
                  end hovedbranchen alene. */}
                {data.secondaryIndustries && data.secondaryIndustries.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1 mb-3">
                    {data.secondaryIndustries.map((b, i) => (
                      <span
                        key={i}
                        className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-slate-700/40 border border-slate-600/40 text-slate-300"
                        title={b.code != null ? `${b.code} — ${b.desc ?? '—'}` : (b.desc ?? '')}
                      >
                        {b.code != null && <span className="text-slate-500 mr-1">{b.code}</span>}
                        {b.desc ?? '—'}
                      </span>
                    ))}
                  </div>
                )}
                {!data.industrydesc &&
                  !(data.secondaryIndustries && data.secondaryIndustries.length > 0) && (
                    <div className="mb-3" />
                  )}

                {/* ── Stamdata — 2-kolonne grid, label over værdi ── */}
                <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                  <div>
                    <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                      {c.founded}
                    </p>
                    <p className="text-white text-sm font-medium">
                      {data.stiftet ?? data.startdate ?? '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                      {c.employees}
                    </p>
                    <p className="text-white text-sm font-medium">{data.employees ?? '—'}</p>
                  </div>
                  <div>
                    <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                      {c.registeredCapital}
                    </p>
                    <p className="text-white text-sm font-medium">
                      {data.registreretKapital
                        ? `${data.registreretKapital.vaerdi.toLocaleString('da-DK')} ${data.registreretKapital.valuta}`
                        : '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                      {c.municipality}
                    </p>
                    <p className="text-white text-sm font-medium">{data.kommune ?? '—'}</p>
                  </div>
                  <div>
                    <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                      {c.accountingYear}
                    </p>
                    <p className="text-white text-sm font-medium">
                      {data.regnskabsaar
                        ? `${String(data.regnskabsaar.startDag).padStart(2, '0')}/${String(data.regnskabsaar.startMaaned).padStart(2, '0')} – ${String(data.regnskabsaar.slutDag).padStart(2, '0')}/${String(data.regnskabsaar.slutMaaned).padStart(2, '0')}`
                        : '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                      {c.adProtected}
                    </p>
                    <p className="text-white text-sm font-medium">
                      {data.reklamebeskyttet ? 'Ja' : 'Nej'}
                    </p>
                  </div>
                  {data.enddate && (
                    <div className="col-span-2">
                      <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                        {c.endDate}
                      </p>
                      <p className="text-red-400 text-sm font-medium">{data.enddate}</p>
                    </div>
                  )}
                  {data.senesteVedtaegtsdato && (
                    <div>
                      <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                        {lang === 'da' ? 'Seneste vedtægtsdato' : 'Latest articles date'}
                      </p>
                      <p className="text-white text-sm font-medium">{data.senesteVedtaegtsdato}</p>
                    </div>
                  )}
                  {data.foersteRegnskabsperiode && (
                    <div>
                      <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                        {lang === 'da' ? 'Første regnskabsperiode' : 'First accounting period'}
                      </p>
                      <p className="text-white text-sm font-medium">
                        {data.foersteRegnskabsperiode.start} – {data.foersteRegnskabsperiode.slut}
                      </p>
                    </div>
                  )}
                  {data.statusTekst && (
                    <div>
                      <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                        {lang === 'da' ? 'Virksomhedsstatus' : 'Company status'}
                      </p>
                      <p className="text-white text-sm font-medium">{data.statusTekst}</p>
                    </div>
                  )}
                  {/* BIZZ-520: P-enheder count */}
                  {data.productionunits && data.productionunits.length > 0 && (
                    <div>
                      <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                        {lang === 'da' ? 'Produktionsenheder' : 'Production units'}
                      </p>
                      <p className="text-white text-sm font-medium">
                        {data.productionunits.filter((p) => p.active).length}
                        {data.productionunits.some((p) => !p.active) && (
                          <span className="text-slate-500 text-xs ml-1">
                            ({data.productionunits.length} {lang === 'da' ? 'i alt' : 'total'})
                          </span>
                        )}
                      </p>
                    </div>
                  )}
                  {/* BIZZ-520: sidstOpdateret — CVR data freshness */}
                  {data.sidstOpdateret && (
                    <div className="col-span-2">
                      <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                        {lang === 'da' ? 'Data opdateret' : 'Data updated'}
                      </p>
                      <p className="text-slate-400 text-xs">
                        {new Date(data.sidstOpdateret).toLocaleDateString(
                          lang === 'da' ? 'da-DK' : 'en-GB',
                          { year: 'numeric', month: 'long', day: 'numeric' }
                        )}
                      </p>
                    </div>
                  )}
                </div>

                {/* BIZZ-513: Beskæftigelseshistorik */}
                {data.aarsbeskaeftigelse && data.aarsbeskaeftigelse.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-slate-700/30">
                    <p className="text-slate-500 text-[10px] uppercase tracking-wider font-medium mb-2">
                      {lang === 'da' ? 'Beskæftigelseshistorik' : 'Employment history'}
                    </p>
                    <div className="grid grid-cols-[auto_1fr_1fr] gap-x-4 gap-y-1 text-xs">
                      <span className="text-slate-500 font-medium">
                        {lang === 'da' ? 'År' : 'Year'}
                      </span>
                      <span className="text-slate-500 font-medium text-right">
                        {lang === 'da' ? 'Ansatte' : 'Employees'}
                      </span>
                      <span className="text-slate-500 font-medium text-right">
                        {lang === 'da' ? 'Årsværk' : 'FTE'}
                      </span>
                      {data.aarsbeskaeftigelse.slice(0, 8).map((a, idx) => (
                        <Fragment key={a.aar ?? idx}>
                          <span className="text-slate-400 tabular-nums">{a.aar}</span>
                          <span className="text-white text-right tabular-nums">
                            {a.antalAnsatte ?? '—'}
                          </span>
                          <span className="text-slate-300 text-right tabular-nums">
                            {a.antalAarsvaerk ?? '—'}
                          </span>
                        </Fragment>
                      ))}
                    </div>
                  </div>
                )}

                {/* ── Ledelse, Ejere & Kontakt — 2-kolonne grid ── */}
                <div className="mt-4 pt-3 border-t border-slate-700/30 grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Ejere */}
                  {aktiveEjere.length > 0 && (
                    <div>
                      <p className="text-slate-500 text-[10px] uppercase tracking-wider font-medium mb-1.5">
                        {lang === 'da' ? 'Ejere' : 'Owners'}
                      </p>
                      <ul className="space-y-1.5">
                        {aktiveEjere.map((e, i) => (
                          <li key={i} className="flex items-center justify-between gap-2">
                            {e.deltager.enhedsNummer ? (
                              <Link
                                href={
                                  e.deltager.erVirksomhed
                                    ? `/dashboard/companies/${e.deltager.enhedsNummer}`
                                    : `/dashboard/owners/${e.deltager.enhedsNummer}`
                                }
                                className={`text-white text-sm truncate transition-colors ${e.deltager.erVirksomhed ? 'hover:text-blue-300' : 'hover:text-purple-300'}`}
                              >
                                {e.deltager.navn}
                              </Link>
                            ) : (
                              <span className="text-white text-sm truncate">{e.deltager.navn}</span>
                            )}
                            {e.rolle.ejerandel && (
                              <span className="shrink-0 text-[10px] font-medium text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded">
                                {e.rolle.ejerandel}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Direktion */}
                  {aktiveDirektion.length > 0 && (
                    <div>
                      <p className="text-slate-500 text-[10px] uppercase tracking-wider font-medium mb-1.5">
                        {lang === 'da' ? 'Direktion' : 'Management'}
                      </p>
                      <ul className="space-y-1">
                        {aktiveDirektion.map((e, i) => (
                          <li key={i} className="text-sm truncate">
                            {e.deltager.enhedsNummer ? (
                              <Link
                                href={
                                  e.deltager.erVirksomhed
                                    ? `/dashboard/companies/${e.deltager.enhedsNummer}`
                                    : `/dashboard/owners/${e.deltager.enhedsNummer}`
                                }
                                className={`text-white transition-colors ${e.deltager.erVirksomhed ? 'hover:text-blue-300' : 'hover:text-purple-300'}`}
                              >
                                {e.deltager.navn}
                              </Link>
                            ) : (
                              <span className="text-white">{e.deltager.navn}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Revision */}
                  {aktiveRevision.length > 0 && (
                    <div>
                      <p className="text-slate-500 text-[10px] uppercase tracking-wider font-medium mb-1.5">
                        {lang === 'da' ? 'Revision' : 'Auditor'}
                      </p>
                      <ul className="space-y-1">
                        {aktiveRevision.map((e, i) => (
                          <li key={i} className="text-sm truncate">
                            {e.deltager.enhedsNummer ? (
                              <Link
                                href={
                                  e.deltager.erVirksomhed
                                    ? `/dashboard/companies/${e.deltager.enhedsNummer}`
                                    : `/dashboard/owners/${e.deltager.enhedsNummer}`
                                }
                                className={`text-white transition-colors ${e.deltager.erVirksomhed ? 'hover:text-blue-300' : 'hover:text-purple-300'}`}
                              >
                                {e.deltager.navn}
                              </Link>
                            ) : (
                              <span className="text-white">{e.deltager.navn}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Kontakt */}
                  <div>
                    <p className="text-slate-500 text-[10px] uppercase tracking-wider font-medium mb-1.5">
                      {c.contact}
                    </p>
                    <div className="space-y-1">
                      <p className="text-white text-sm flex items-center gap-1.5">
                        <MapPin size={12} className="text-slate-500 shrink-0" />
                        {data.address}
                        {data.addressco ? `, ${data.addressco}` : ''}, {data.zipcode} {data.city}
                      </p>
                      {data.phone && (
                        <p className="text-white text-sm flex items-center gap-1.5">
                          <Phone size={12} className="text-slate-500 shrink-0" />
                          {data.phone}
                        </p>
                      )}
                      {data.email && (
                        <p className="text-white text-sm flex items-center gap-1.5">
                          <Mail size={12} className="text-slate-500 shrink-0" />
                          {data.email}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                {/* ── Tegningsregel + Formål — 2-kolonne grid ── */}
                {(data.tegningsregel || data.formaal) && (
                  <div className="mt-3 pt-3 border-t border-slate-700/30 grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {data.tegningsregel && (
                      <div>
                        <p className="text-slate-500 text-[10px] uppercase tracking-wider mb-0.5">
                          {c.signingRule}
                        </p>
                        <p className="text-slate-300 text-xs leading-relaxed">
                          {data.tegningsregel}
                        </p>
                      </div>
                    )}
                    {data.formaal && (
                      <div>
                        <p className="text-slate-500 text-[10px] uppercase tracking-wider mb-0.5">
                          {c.purpose}
                        </p>
                        <p className="text-slate-300 text-xs leading-relaxed">{data.formaal}</p>
                      </div>
                    )}
                  </div>
                )}
              </section>
            );
          })()}

        {/* ═══ KOLONNE 2: Gruppe Info + Gruppeøkonomi ═══ */}
        <div className="flex flex-col gap-4">
          {/* Gruppe Info */}
          {(oversigtFilter === null || oversigtFilter === 'gruppe') &&
            (() => {
              const aktive = relatedCompanies.filter((v) => v.aktiv);
              const totalAnsatte =
                aktive.reduce((sum, v) => {
                  const n = v.ansatte ? parseInt(v.ansatte.replace(/\D/g, ''), 10) : 0;
                  return sum + (isNaN(n) ? 0 : n);
                }, 0) +
                (data.employees ? parseInt(String(data.employees).replace(/\D/g, ''), 10) || 0 : 0);
              const totalPenheder =
                aktive.reduce((sum, v) => sum + v.antalPenheder, 0) +
                (data.productionunits?.length ?? 0);
              const totalDatter = aktive.length;
              const fmtNum = (n: number) => n.toLocaleString('da-DK');

              return relatedLoading ? (
                // BIZZ-478: Ensartet blå TabLoadingSpinner.
                // BIZZ-617: Specifik label så brugeren ved hvad der hentes
                <TabLoadingSpinner label={c.loadingDatterselskaber} />
              ) : aktive.length > 0 ? (
                <section className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-5">
                  <h2 className="text-white font-semibold text-sm mb-3 flex items-center gap-2">
                    <Building2 size={15} className="text-indigo-400" />
                    {lang === 'da' ? 'Gruppe Info' : 'Group Info'}
                  </h2>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-slate-900/50 rounded-lg p-3 text-center">
                      <p className="text-xl font-bold text-white">{totalDatter + 1}</p>
                      <p className="text-slate-500 text-[10px] mt-0.5">
                        {lang === 'da' ? 'Virksomheder' : 'Companies'}
                      </p>
                    </div>
                    <div className="bg-slate-900/50 rounded-lg p-3 text-center">
                      <p className="text-xl font-bold text-white">{fmtNum(totalAnsatte)}</p>
                      <p className="text-slate-500 text-[10px] mt-0.5">
                        {lang === 'da' ? 'Ansatte' : 'Employees'}
                      </p>
                    </div>
                    <div className="bg-slate-900/50 rounded-lg p-3 text-center">
                      <p className="text-xl font-bold text-white">{fmtNum(totalPenheder)}</p>
                      <p className="text-slate-500 text-[10px] mt-0.5">
                        P-{lang === 'da' ? 'enheder' : 'units'}
                      </p>
                    </div>
                    <div className="bg-slate-900/50 rounded-lg p-3 text-center">
                      <p className="text-xl font-bold text-white">{totalDatter}</p>
                      <p className="text-slate-500 text-[10px] mt-0.5">
                        {lang === 'da' ? 'Datterselskaber' : 'Subsidiaries'}
                      </p>
                    </div>
                  </div>
                </section>
              ) : null;
            })()}

          {/* BIZZ-406: Regnskabs-nøgletal for seneste år */}
          {(oversigtFilter === null || oversigtFilter === 'gruppe') &&
            (() => {
              if (xbrlLoading)
                return (
                  <section className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-5 animate-pulse">
                    <div className="h-4 bg-slate-700/50 rounded w-32 mb-3" />
                    <div className="grid grid-cols-3 gap-3">
                      <div className="h-10 bg-slate-700/30 rounded" />
                      <div className="h-10 bg-slate-700/30 rounded" />
                      <div className="h-10 bg-slate-700/30 rounded" />
                    </div>
                  </section>
                );
              if (!xbrlData || xbrlData.length === 0) return null;
              const seneste = xbrlData[0];
              const r = seneste.resultat;
              const b = seneste.balance;
              const hasData =
                r.bruttofortjeneste != null || r.resultatFoerSkat != null || b.egenkapital != null;
              if (!hasData) return null;
              // BIZZ-459: XBRL-route normaliserer nu alle monetære
              // felter til T DKK (tusinder) før udlevering. Label
              // matcher kilden.
              const fmtDKK = (v: number | null | undefined) =>
                v != null
                  ? v.toLocaleString('da-DK', { maximumFractionDigits: 0 }) + ' T DKK'
                  : '–';
              return (
                <section className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-5">
                  <h3 className="text-white font-semibold text-sm mb-3">
                    {lang === 'da' ? 'Nøgletal' : 'Key Figures'}
                    <span className="text-slate-500 text-xs font-normal ml-2">({seneste.aar})</span>
                  </h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {r.bruttofortjeneste != null && (
                      <div>
                        <p className="text-slate-500 text-xs">
                          {lang === 'da' ? 'Bruttofortjeneste' : 'Gross profit'}
                        </p>
                        <p
                          className={`text-sm font-semibold ${(r.bruttofortjeneste ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}
                        >
                          {fmtDKK(r.bruttofortjeneste)}
                        </p>
                      </div>
                    )}
                    {r.resultatFoerSkat != null && (
                      <div>
                        <p className="text-slate-500 text-xs">
                          {lang === 'da' ? 'Resultat før skat' : 'Profit before tax'}
                        </p>
                        <p
                          className={`text-sm font-semibold ${(r.resultatFoerSkat ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}
                        >
                          {fmtDKK(r.resultatFoerSkat)}
                        </p>
                      </div>
                    )}
                    {b.egenkapital != null && (
                      <div>
                        <p className="text-slate-500 text-xs">
                          {lang === 'da' ? 'Egenkapital' : 'Equity'}
                        </p>
                        <p
                          className={`text-sm font-semibold ${(b.egenkapital ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}
                        >
                          {fmtDKK(b.egenkapital)}
                        </p>
                      </div>
                    )}
                  </div>
                </section>
              );
            })()}
        </div>
      </div>

      {/* ── P-enheder — fuld bredde under kolonnerne ── */}
      {(oversigtFilter === null || oversigtFilter === 'pe') && (
        <section className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-5">
          <h2 className="text-white font-semibold text-sm mb-3 flex items-center gap-2">
            <Factory size={15} className="text-cyan-400" />
            {c.productionUnits} {data.productionunits ? `(${data.productionunits.length})` : ''}
          </h2>
          {data.productionunits && data.productionunits.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-500 text-xs uppercase tracking-wide border-b border-slate-700/40">
                    <th className="pb-2 pr-4">{c.pNumber}</th>
                    <th className="pb-2 pr-4">{c.name}</th>
                    <th className="pb-2 pr-4">{c.address}</th>
                    <th className="pb-2 pr-4">{c.industry}</th>
                    {/* BIZZ-514: Ansatte-kolonne per P-enhed */}
                    <th className="pb-2 pr-4">{c.employeesShort}</th>
                    <th className="pb-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.productionunits.map((pu) => (
                    <tr key={pu.pno} className="border-b border-slate-700/20 text-white">
                      <td className="py-2 pr-4 text-slate-400 font-mono text-xs">
                        {pu.pno}
                        {/* BIZZ-514: Hoved-P-enhed markering */}
                        {pu.main && (
                          <span
                            className="ml-1.5 text-[9px] px-1 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30"
                            title={lang === 'da' ? 'Hovedproduktionsenhed' : 'Main production unit'}
                          >
                            {lang === 'da' ? 'Hoved' : 'Main'}
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-4">{pu.name}</td>
                      <td className="py-2 pr-4 text-slate-300 text-xs">
                        {pu.address}, {pu.zipcode} {pu.city}
                      </td>
                      <td className="py-2 pr-4 text-slate-400 text-xs">
                        <div className="flex flex-col gap-0.5">
                          <span>{pu.industrydesc ?? '—'}</span>
                          {/* BIZZ-514: Bibrancher per P-enhed som små tags under hovedbranchen */}
                          {pu.secondaryIndustries && pu.secondaryIndustries.length > 0 && (
                            <div className="flex flex-wrap gap-0.5">
                              {pu.secondaryIndustries.map((b, i) => (
                                <span
                                  key={i}
                                  className="text-[9px] px-1 py-0.5 rounded bg-slate-700/40 border border-slate-600/40 text-slate-400"
                                  title={
                                    b.code != null ? `${b.code} — ${b.desc ?? '—'}` : (b.desc ?? '')
                                  }
                                >
                                  {b.desc ?? '—'}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="py-2 pr-4 text-slate-300 text-xs tabular-nums">
                        {pu.employees ?? '—'}
                      </td>
                      <td className="py-2">
                        <span
                          className={`px-2 py-0.5 rounded text-xs font-medium ${pu.active !== false ? 'bg-emerald-600/20 text-emerald-400' : 'bg-red-600/20 text-red-400'}`}
                        >
                          {pu.active !== false ? c.active : c.ceased}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              ikon={<MapPin size={32} className="text-slate-600" />}
              tekst={c.noProductionUnits}
            />
          )}
        </section>
      )}
    </div>
  );
}
