/**
 * EjendomOekonomiTab — Økonomi-fane på ejendoms-detaljesiden.
 *
 * Viser:
 *   - Ejendomsvurdering (aktuelle ejendomsvaerdi/grundvaerdi/areal)
 *   - Fradrag for forbedringer (BIZZ-494)
 *   - Vurderingshistorik (collapsible, inkl. foreløbige vurderinger)
 *   - Salgshistorik (merged EJF + Tinglysning adkomster)
 *
 * BIZZ-657: Extraheret fra EjendomDetaljeClient.tsx. Ren filopdeling —
 * ingen adfærdsændring. Tungere komponent pga. mergedSalgshistorik som
 * beregnes i parent (bibeholdes der pga. tlSumData/tinglysning-afhængighed).
 *
 * @module app/dashboard/ejendomme/[id]/tabs/EjendomOekonomiTab
 */

'use client';

import Link from 'next/link';
import { ChevronRight, TrendingUp } from 'lucide-react';
import SektionLoader from '@/app/components/SektionLoader';
import { formatDKK } from '@/app/lib/mock/ejendomme';
import type { VurderingData, VurderingResponse } from '@/app/api/vurdering/route';
import type { ForelobigVurdering } from '@/app/api/vurdering-forelobig/route';

/** Merged handel fra EJF + Tinglysning — samme shape som i parent-komponenten. */
export interface MergedHandel {
  kontantKoebesum: number | null;
  samletKoebesum: number | null;
  loesoeresum: number | null;
  entreprisesum: number | null;
  koebsaftaleDato: string | null;
  overtagelsesdato: string | null;
  overdragelsesmaade: string | null;
  koeber: string | null;
  koebercvr: string | null;
  adkomstType: string | null;
  andel: string | null;
  tinglysningsdato: string | null;
  tinglysningsafgift: number | null;
  kilde: 'ejf' | 'tinglysning' | 'begge';
  koebere?: { navn: string; cvr: string | null; andel: string | null }[];
  betinget?: boolean | null;
  fristDato?: string | null;
  forretningshaendelse?: string | null;
  afstaaelsesdato?: string | null;
  skoedetekst?: string | null;
}

function SectionTitle({ title }: { title: string }) {
  return (
    <div className="flex items-center justify-between mb-1.5">
      <h3 className="text-white font-semibold text-sm">{title}</h3>
    </div>
  );
}

interface Props {
  lang: 'da' | 'en';
  vurderingLoader: boolean;
  vurdering: VurderingData | null;
  vurFradrag: VurderingResponse['fradrag'];
  vurFordeling: VurderingResponse['fordeling'];
  vurGrundvaerdispec: VurderingResponse['grundvaerdispec'];
  alleVurderinger: VurderingData[];
  forelobige: ForelobigVurdering[];
  visVurderingHistorik: boolean;
  setVisVurderingHistorik: React.Dispatch<React.SetStateAction<boolean>>;
  salgshistorikLoader: boolean;
  salgshistorikManglerAdgang: boolean;
  tlSumLoader: boolean;
  tlTestFallback: boolean;
  mergedSalgshistorik: MergedHandel[];
  bbrData: { ejendomsrelationer?: { bfeNummer: number | null }[] | null } | null;
}

/** Render Økonomi-fanen. Ren præsentations-komponent. */
export default function EjendomOekonomiTab(props: Props) {
  const {
    lang,
    vurderingLoader,
    vurdering,
    vurFradrag,
    vurFordeling,
    vurGrundvaerdispec,
    alleVurderinger,
    forelobige,
    visVurderingHistorik,
    setVisVurderingHistorik,
    salgshistorikLoader,
    salgshistorikManglerAdgang,
    tlSumLoader,
    tlTestFallback,
    mergedSalgshistorik,
    bbrData,
  } = props;
  const da = lang === 'da';

  const t = {
    propertyValuation: da ? 'Ejendomsvurdering' : 'Property valuation',
    loadingValuation: da ? 'Henter vurderingsdata…' : 'Loading valuation data…',
    propertyValue: da ? 'Ejendomsværdi' : 'Property value',
    landValue: da ? 'Grundværdi' : 'Land value',
    plotArea: da ? 'Grundareal' : 'Plot area',
    valuationHistory: da ? 'Vurderingshistorik' : 'Valuation history',
    yearCol: da ? 'Aar' : 'Year',
    propertyValueCol: da ? 'Ejendomsvaerdi' : 'Property value',
    landValueCol: da ? 'Grundvaerdi' : 'Land value',
    preliminary: da ? 'FORELØBIG' : 'PRELIMINARY',
    noValuationFound: da ? 'Ingen vurderingsdata fundet' : 'No valuation data found',
    bfeUnavailable: da ? 'BFEnummer ikke tilgængeligt' : 'BFE number unavailable',
    salesHistory: da ? 'Salgshistorik' : 'Sales history',
    loadingSalesHistory: da ? 'Henter salgshistorik…' : 'Loading sales history…',
    salesHistoryEJF: da
      ? 'Salgshistorik kræver EJF-adgang fra Geodatastyrelsen via datafordeler.dk.'
      : 'Sales history requires EJF access from Geodatastyrelsen via datafordeler.dk.',
    noTransactions: da
      ? 'Ingen handler registreret for denne ejendom'
      : 'No transactions recorded for this property',
    date: da ? 'Dato' : 'Date',
    type: da ? 'Type' : 'Type',
    share: da ? 'Andel' : 'Share',
    purchasePrice: da ? 'Købesum' : 'Purchase price',
    cashPrice: da ? 'Kontant' : 'Cash',
    buyerName: da ? 'Køber' : 'Buyer',
    registrationDate: da ? 'Tinglyst' : 'Registered',
    registrationFee: da ? 'Tinglysningsafgift' : 'Registration fee',
    loesoereSum: da ? 'Løsøre' : 'Movables',
    entrepriseSum: da ? 'Entreprise' : 'Construction',
    overtagelsesdato: da ? 'Overtagelse' : 'Possession',
  };

  return (
    <div className="space-y-5">
      {/* ── Ejendomsvurdering ── */}
      <div>
        <SectionTitle title={t.propertyValuation} />
        {vurderingLoader ? (
          <div className="flex items-center gap-2 text-slate-500 text-sm py-4">
            <div className="w-4 h-4 border-2 border-slate-600 border-t-blue-500 rounded-full animate-spin" />
            {t.loadingValuation}
          </div>
        ) : vurdering ? (
          <>
            {/* Aktuelle tal */}
            <div className="grid grid-cols-3 gap-3 mb-3">
              <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                <p className="text-slate-400 text-xs mb-1">
                  {t.propertyValue}
                  {vurdering.aar && <span className="ml-1 text-slate-500">({vurdering.aar})</span>}
                </p>
                <p className="text-white text-lg font-bold">
                  {vurdering.ejendomsvaerdi ? formatDKK(vurdering.ejendomsvaerdi) : formatDKK(0)}
                </p>
              </div>
              <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                <p className="text-slate-400 text-xs mb-1">{t.landValue}</p>
                <p className="text-white text-lg font-bold">
                  {vurdering.grundvaerdi ? formatDKK(vurdering.grundvaerdi) : formatDKK(0)}
                </p>
              </div>
              <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                <p className="text-slate-400 text-xs mb-1">{t.plotArea}</p>
                <p className="text-white text-lg font-bold">
                  {vurdering.vurderetAreal != null
                    ? `${vurdering.vurderetAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                    : formatDKK(0)}
                </p>
              </div>
            </div>

            {/* BIZZ-494: Fradrag for forbedringer — vises under Grundværdi */}
            {vurFradrag && vurFradrag.vaerdiSum != null && vurFradrag.vaerdiSum > 0 && (
              <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 mb-3">
                <p className="text-slate-400 text-xs font-semibold uppercase tracking-wider mb-2">
                  {da ? 'Fradrag for forbedringer' : 'Improvement deductions'}
                </p>
                <p className="text-white text-sm font-bold mb-2">
                  {formatDKK(vurFradrag.vaerdiSum)}
                  {vurFradrag.foersteGangAar && (
                    <span className="text-slate-500 text-xs font-normal ml-2">
                      {da ? 'fra' : 'from'} {vurFradrag.foersteGangAar}
                    </span>
                  )}
                </p>
                {vurFradrag.poster.length > 0 && (
                  <div className="space-y-1">
                    {vurFradrag.poster.map((post, i) => (
                      <div key={i} className="flex items-center justify-between text-xs">
                        <span className="text-slate-400">
                          {post.tekst ?? (da ? 'Fradrag' : 'Deduction')}
                          {post.aar && <span className="text-slate-500 ml-1">({post.aar})</span>}
                        </span>
                        <span className="text-slate-300 tabular-nums">
                          {post.vaerdi != null ? formatDKK(post.vaerdi) : '—'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* BIZZ-493: Ejerboligfordeling — skjult for enfamiliehuse */}
            {vurFordeling.length > 0 && (
              <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 mb-3">
                <p className="text-slate-400 text-xs font-semibold uppercase tracking-wider mb-2">
                  {da ? 'Ejerboligfordeling' : 'Owner-occupied allocation'}
                </p>
                <div className="space-y-2">
                  {vurFordeling.map((f, i) => (
                    <div key={i} className="grid grid-cols-2 gap-3">
                      {f.ejerboligvaerdi != null && (
                        <div>
                          <p className="text-slate-500 text-[10px] uppercase">
                            {da ? 'Ejerboligværdi' : 'Owner-occupied value'}
                          </p>
                          <p className="text-white text-sm font-medium">
                            {formatDKK(f.ejerboligvaerdi)}
                          </p>
                        </div>
                      )}
                      {f.ejerboliggrundvaerdi != null && (
                        <div>
                          <p className="text-slate-500 text-[10px] uppercase">
                            {da ? 'Ejerboliggrundværdi' : 'Owner-occupied land value'}
                          </p>
                          <p className="text-white text-sm font-medium">
                            {formatDKK(f.ejerboliggrundvaerdi)}
                          </p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* BIZZ-492: Grundværdispecifikation — nedbrydning af grundværdiberegning */}
            {vurGrundvaerdispec.length > 0 && (
              <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden overflow-x-auto mb-3">
                <div className="px-4 py-2.5 border-b border-slate-700/30">
                  <p className="text-slate-400 text-xs font-semibold uppercase tracking-wider">
                    {da ? 'Grundværdispecifikation' : 'Land value specification'}
                  </p>
                </div>
                <div className="min-w-[400px]">
                  <div className="grid grid-cols-[1fr_80px_90px_90px] px-4 py-1.5 text-slate-500 text-[10px] font-medium uppercase bg-slate-900/30">
                    <span>{da ? 'Beskrivelse' : 'Description'}</span>
                    <span className="text-right">{da ? 'Areal' : 'Area'}</span>
                    <span className="text-right">{da ? 'Enhedspris' : 'Unit price'}</span>
                    <span className="text-right">{da ? 'Beløb' : 'Amount'}</span>
                  </div>
                  {vurGrundvaerdispec.map((spec) => (
                    <div
                      key={spec.loebenummer}
                      className="grid grid-cols-[1fr_80px_90px_90px] px-4 py-2 text-sm border-t border-slate-700/20 items-center"
                    >
                      <span className="text-slate-300 text-xs">
                        {spec.tekst ?? `#${spec.loebenummer}`}
                      </span>
                      <span className="text-slate-400 text-xs text-right tabular-nums">
                        {spec.areal != null
                          ? `${spec.areal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                          : '—'}
                      </span>
                      <span className="text-slate-400 text-xs text-right tabular-nums">
                        {spec.enhedBeloeb != null ? formatDKK(spec.enhedBeloeb) : '—'}
                      </span>
                      <span className="text-white text-xs text-right tabular-nums font-medium">
                        {spec.beloeb != null ? formatDKK(spec.beloeb) : '—'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Vurderingshistorik — collapsible tabel med forelobige prepended */}
            {(alleVurderinger.length > 1 || forelobige.length > 0) && (
              <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden overflow-x-auto">
                <button
                  onClick={() => setVisVurderingHistorik((v) => !v)}
                  className="w-full flex items-center gap-2 px-4 py-3 hover:bg-slate-700/20 transition-colors"
                >
                  <ChevronRight
                    size={14}
                    className={`text-slate-500 transition-transform flex-shrink-0 ${visVurderingHistorik ? 'rotate-90' : ''}`}
                  />
                  <span className="text-slate-300 text-sm font-medium">{t.valuationHistory}</span>
                  {forelobige.length > 0 && (
                    <span className="px-1.5 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded text-[10px] text-amber-400 font-medium">
                      {forelobige.length} {t.preliminary}
                      {forelobige.length > 1 ? 'E' : ''}
                    </span>
                  )}
                </button>
                {visVurderingHistorik && (
                  <>
                    {/* Header */}
                    <div className="min-w-[550px] grid grid-cols-[140px_1fr_1fr_100px] px-4 py-2 text-slate-500 text-xs font-medium border-t border-slate-700/30 bg-slate-900/30">
                      <span>{t.yearCol}</span>
                      <span>{t.propertyValueCol}</span>
                      <span>{t.landValueCol}</span>
                      <span className="text-right">{t.plotArea}</span>
                    </div>

                    {/* Forelobige vurderinger — prepended med amber badge */}
                    {forelobige.map((fv, i) => (
                      <div
                        key={`forelobig-${fv.vurderingsaar}-${i}`}
                        className="min-w-[550px] grid grid-cols-[140px_1fr_1fr_100px] px-4 py-2.5 text-sm border-t border-amber-500/10 bg-amber-500/[0.02] hover:bg-amber-500/5 items-center"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-amber-200 font-medium">{fv.vurderingsaar}</span>
                          <span className="px-1.5 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded text-[10px] text-amber-400 font-medium">
                            {t.preliminary}
                          </span>
                        </div>
                        <span className="text-amber-200/80">
                          {fv.ejendomsvaerdi ? formatDKK(fv.ejendomsvaerdi) : formatDKK(0)}
                        </span>
                        <span className="text-amber-200/80">
                          {fv.grundvaerdi ? formatDKK(fv.grundvaerdi) : '0 DKK'}
                        </span>
                        <span className="text-slate-400 text-right">–</span>
                      </div>
                    ))}

                    {/* Endelige vurderinger fra Datafordeler */}
                    {alleVurderinger.map((v, i) => {
                      return (
                        <div
                          key={`${v.aar}-${i}`}
                          className="min-w-[550px] grid grid-cols-[140px_1fr_1fr_100px] px-4 py-2.5 text-sm border-t border-slate-700/20 hover:bg-slate-700/10 items-center"
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-slate-200 font-medium">{v.aar ?? '–'}</span>
                            {v.erNytSystem && (
                              <span className="px-1.5 py-0.5 bg-blue-500/10 border border-blue-500/20 rounded text-[10px] text-blue-400 font-medium">
                                NY
                              </span>
                            )}
                          </div>
                          <span className="text-slate-300">
                            {v.ejendomsvaerdi != null ? formatDKK(v.ejendomsvaerdi) : formatDKK(0)}
                          </span>
                          <span className="text-slate-300">
                            {v.grundvaerdi != null ? formatDKK(v.grundvaerdi) : '0 DKK'}
                          </span>
                          <span className="text-slate-400 text-right">
                            {v.vurderetAreal != null
                              ? `${v.vurderetAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                              : formatDKK(0)}
                          </span>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            )}
          </>
        ) : !bbrData?.ejendomsrelationer?.[0]?.bfeNummer ? (
          <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4">
            <p className="text-amber-300 text-sm font-medium mb-1">{t.bfeUnavailable}</p>
            <p className="text-slate-400 text-xs">
              Ejendomsvurdering kræver BFEnummer fra BBR Ejendomsrelation.
            </p>
          </div>
        ) : (
          <div className="bg-slate-800/30 border border-slate-700/40 rounded-xl p-4 text-center">
            <p className="text-slate-500 text-xs">{t.noValuationFound}</p>
          </div>
        )}
      </div>

      {/* ── Salgshistorik (EJF + Tinglysning) ── */}
      {/* BIZZ-402: only render when loading or when there is data to show */}
      {(salgshistorikLoader || tlSumLoader || mergedSalgshistorik.length > 0) && (
        <div>
          <div className="flex items-center gap-2 mb-1">
            <SectionTitle title={t.salesHistory} />
            {tlTestFallback && mergedSalgshistorik.length > 0 && (
              <span className="px-2 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded text-[10px] text-amber-400 font-medium">
                TESTDATA
              </span>
            )}
          </div>
          {salgshistorikLoader || tlSumLoader ? (
            <SektionLoader label={t.loadingSalesHistory} rows={4} />
          ) : mergedSalgshistorik.length > 0 ? (
            <div className="bg-slate-800/20 border border-slate-700/30 rounded-xl overflow-hidden overflow-x-auto">
              {/* BIZZ-324: table expanded with tinglysningsdato, tinglysningsafgift, loesoeresum and entreprisesum */}
              <table className="w-full text-sm min-w-[900px]">
                <thead>
                  <tr className="border-b border-slate-700/30 text-slate-500 text-xs uppercase tracking-wider">
                    <th className="text-left px-4 py-2.5 font-medium">{t.date}</th>
                    <th className="text-left px-4 py-2.5 font-medium">{t.buyerName}</th>
                    <th className="text-left px-4 py-2.5 font-medium">{t.type}</th>
                    <th className="text-right px-4 py-2.5 font-medium">{t.purchasePrice}</th>
                    <th className="text-right px-4 py-2.5 font-medium">{t.cashPrice}</th>
                    <th className="text-right px-4 py-2.5 font-medium">{t.loesoereSum}</th>
                    <th className="text-right px-4 py-2.5 font-medium">{t.entrepriseSum}</th>
                    <th className="text-right px-4 py-2.5 font-medium">{t.registrationDate}</th>
                    <th className="text-right px-4 py-2.5 font-medium">{t.registrationFee}</th>
                    <th className="text-right px-4 py-2.5 font-medium">{t.share}</th>
                  </tr>
                </thead>
                <tbody>
                  {mergedSalgshistorik.map((h, i) => {
                    /** Primær dato: købsaftaledato foretrukkes, ellers overtagelsesdato */
                    const dato = h.koebsaftaleDato ?? h.overtagelsesdato;
                    const overdragelse = h.overdragelsesmaade ?? h.adkomstType;
                    return (
                      <tr
                        key={i}
                        className="border-b border-slate-700/20 last:border-0 hover:bg-white/[0.02] transition-colors"
                      >
                        <td className="px-4 py-2.5 text-slate-300 tabular-nums whitespace-nowrap">
                          {dato
                            ? new Date(dato).toLocaleDateString(da ? 'da-DK' : 'en-GB', {
                                year: 'numeric',
                                month: 'short',
                                day: 'numeric',
                              })
                            : '—'}
                          {/* Show overtagelsesdato as secondary line when different from koebsaftaleDato */}
                          {h.koebsaftaleDato &&
                            h.overtagelsesdato &&
                            h.koebsaftaleDato !== h.overtagelsesdato && (
                              <p className="text-slate-600 text-[10px] mt-0.5">
                                {t.overtagelsesdato}:{' '}
                                {new Date(h.overtagelsesdato).toLocaleDateString(
                                  da ? 'da-DK' : 'en-GB',
                                  {
                                    year: 'numeric',
                                    month: 'short',
                                    day: 'numeric',
                                  }
                                )}
                              </p>
                            )}
                        </td>
                        <td className="px-4 py-2.5">
                          {h.koeber ? (
                            <div>
                              <p className="text-slate-200 text-sm leading-tight">
                                {h.koebercvr ? (
                                  <Link
                                    href={`/dashboard/companies/${h.koebercvr}`}
                                    className="hover:text-blue-400 transition-colors"
                                  >
                                    {h.koeber}
                                  </Link>
                                ) : (
                                  h.koeber
                                )}
                              </p>
                              {h.koebercvr && (
                                <p className="text-slate-500 text-[10px]">CVR {h.koebercvr}</p>
                              )}
                            </div>
                          ) : (
                            <span className="text-slate-500 text-xs">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex flex-col gap-1">
                            <span
                              className={`text-xs px-2 py-0.5 rounded-full inline-block w-fit ${
                                overdragelse?.toLowerCase().includes('frit')
                                  ? 'text-emerald-400 bg-emerald-500/10 border border-emerald-500/20'
                                  : overdragelse?.toLowerCase().includes('tvang')
                                    ? 'text-red-400 bg-red-500/10 border border-red-500/20'
                                    : 'text-slate-400 bg-slate-500/10 border border-slate-500/20'
                              }`}
                            >
                              {overdragelse ?? '—'}
                            </span>
                            {/* BIZZ-481: Betinget-badge med frist-dato — vigtigt
                                advarselsflag på tinglyste handler med uopfyldte
                                betingelser (købesum ikke fuldt betalt, skøder
                                afhænger af tilladelser etc.). */}
                            {h.betinget && (
                              <span
                                className="text-[10px] px-2 py-0.5 rounded-full inline-block w-fit text-amber-300 bg-amber-500/10 border border-amber-500/20"
                                title={
                                  da
                                    ? 'Tinglyst med uopfyldte betingelser'
                                    : 'Recorded with unfulfilled conditions'
                                }
                              >
                                ⚠ {da ? 'Betinget' : 'Conditional'}
                                {h.fristDato && (
                                  <span className="ml-1 text-amber-400/80">
                                    {' · '}
                                    {da ? 'Frist' : 'Deadline'}{' '}
                                    {new Date(h.fristDato).toLocaleDateString(
                                      da ? 'da-DK' : 'en-GB',
                                      { year: 'numeric', month: 'short', day: 'numeric' }
                                    )}
                                  </span>
                                )}
                              </span>
                            )}
                            {/* BIZZ-481: Officiel forretningshaendelse-klassificering
                                fra EJF (fx "Salg", "Arv", "Gave", "Fusion"). Vises når
                                den afviger fra den fritekstede overdragelsesmaade. */}
                            {h.forretningshaendelse && h.forretningshaendelse !== overdragelse && (
                              <span className="text-[10px] text-slate-500 italic">
                                {h.forretningshaendelse}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-right text-white font-medium tabular-nums">
                          {h.samletKoebesum != null
                            ? `${h.samletKoebesum.toLocaleString(da ? 'da-DK' : 'en-GB')} kr.`
                            : '—'}
                        </td>
                        <td className="px-4 py-2.5 text-right text-slate-400 tabular-nums">
                          {h.kontantKoebesum != null
                            ? `${h.kontantKoebesum.toLocaleString(da ? 'da-DK' : 'en-GB')} kr.`
                            : '—'}
                        </td>
                        <td className="px-4 py-2.5 text-right text-slate-400 tabular-nums text-xs">
                          {h.loesoeresum != null
                            ? `${h.loesoeresum.toLocaleString(da ? 'da-DK' : 'en-GB')} kr.`
                            : '—'}
                        </td>
                        <td className="px-4 py-2.5 text-right text-slate-400 tabular-nums text-xs">
                          {h.entreprisesum != null
                            ? `${h.entreprisesum.toLocaleString(da ? 'da-DK' : 'en-GB')} kr.`
                            : '—'}
                        </td>
                        <td className="px-4 py-2.5 text-right text-slate-400 tabular-nums text-xs whitespace-nowrap">
                          {h.tinglysningsdato
                            ? new Date(h.tinglysningsdato).toLocaleDateString(
                                da ? 'da-DK' : 'en-GB',
                                {
                                  year: 'numeric',
                                  month: 'short',
                                  day: 'numeric',
                                }
                              )
                            : '—'}
                        </td>
                        <td className="px-4 py-2.5 text-right text-slate-400 tabular-nums text-xs">
                          {h.tinglysningsafgift != null
                            ? `${h.tinglysningsafgift.toLocaleString(da ? 'da-DK' : 'en-GB')} kr.`
                            : '—'}
                        </td>
                        <td className="px-4 py-2.5 text-right text-slate-400 tabular-nums text-xs">
                          {h.andel ?? '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="bg-slate-800/20 border border-slate-700/30 rounded-xl p-5 text-center space-y-2">
              <TrendingUp size={22} className="text-slate-600 mx-auto" />
              <p className="text-slate-500 text-xs">{t.noTransactions}</p>
              {salgshistorikManglerAdgang && (
                <p className="text-slate-600 text-[10px] max-w-sm mx-auto leading-relaxed">
                  {t.salesHistoryEJF}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Hæftelser fjernet — vises nu under Tinglysning-tab */}
      {/* BIZZ-325: Udbudshistorik og Lignende handler fjernet — ingen datakilde tilgængelig endnu */}
    </div>
  );
}
