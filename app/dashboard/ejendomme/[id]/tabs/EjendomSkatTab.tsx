/**
 * EjendomSkatTab — SKAT/ejendomsskat-fane på ejendoms-detaljesiden.
 *
 * Viser:
 *   - Nuværende ejendomsskatter (grundskyld + ejendomsværdiskat) fra foreløbig
 *     vurdering, med kolonihave-undtagelse
 *   - Skattehistorik (faktiske tal fra Vurderingsportalen, estimater fjernet)
 *   - Grundskatteloft-info (ESL §45 4,75%-regulering) når loftansættelse aktiv
 *   - Skattefritagelser
 *
 * BIZZ-657: Extraheret fra EjendomDetaljeClient.tsx (7.834 → ~7.500 linjer)
 * for at reducere master-file-størrelsen. Ren filopdeling — ingen
 * logik-/adfærds-ændring.
 *
 * Data leveres via props (parent fetcher vurderinger).
 *
 * @module app/dashboard/ejendomme/[id]/tabs/EjendomSkatTab
 */

'use client';

import { Info, Landmark, Sparkles } from 'lucide-react';
import SektionLoader from '@/app/components/SektionLoader';
import TabLoadingSpinner from '@/app/components/TabLoadingSpinner';
import { formatDKK } from '@/app/lib/mock/ejendomme';
import type { VurderingData, VurderingResponse } from '@/app/api/vurdering/route';
import type { ForelobigVurdering } from '@/app/api/vurdering-forelobig/route';

/** Small re-implementation of the parent's SectionTitle for this tab. */
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
  /** true hvis foreløbig-vurderinger stadig indlæses */
  forelobigLoader: boolean;
  /** true hvis officiel vurdering stadig indlæses */
  vurderingLoader: boolean;
  /** Array af foreløbige vurderinger, sorteret nyeste først */
  forelobige: ForelobigVurdering[];
  /** Officiel vurdering (kan være null hvis ikke tilgængelig) */
  vurdering: VurderingData | null;
  /** Grundskatteloft-rækker (ESL §45) */
  vurLoft: VurderingResponse['loft'];
  /** Skattefritagelser */
  vurFritagelser: VurderingResponse['fritagelser'];
  /** true hvis ejendommen er en kolonihave (ejendomsværdiskat-fritaget) */
  erKolonihave: boolean;
}

/**
 * Render skattetabellerne for en ejendom.
 * Ren præsentations-komponent — alt data leveres via props.
 */
export default function EjendomSkatTab({
  lang,
  forelobigLoader,
  vurderingLoader,
  forelobige,
  vurdering,
  vurLoft,
  vurFritagelser,
  erKolonihave,
}: Props) {
  const da = lang === 'da';

  // ─── Translations — afgrænset til Skatter-fanen ────────────────────────────
  const t = {
    loadingSkat: da ? 'Henter SKAT-data…' : 'Loading tax data…',
    propertyTaxes: da ? 'Ejendomsskatter' : 'Property taxes',
    noTaxData: da ? 'Ingen skattedata tilgængelig' : 'No tax data available',
    currentTaxation: da ? 'Nuværende beskatning' : 'Current taxation',
    groundTaxToMunicipality: da ? 'Grundskyld til kommunen' : 'Land tax to municipality',
    propertyValueTax: da ? 'Ejendomsværdiskat' : 'Property value tax',
    propertyValueTaxExempt: da ? 'Ejendomsværdiskat (fritaget)' : 'Property value tax (exempt)',
    totalTax: da ? 'Totale skat' : 'Total tax',
    taxBreakdownKoloni: da
      ? '(kun grundskyld — fritaget for ejendomsværdiskat)'
      : '(land tax only — property value tax exempt)',
    taxBreakdownNormal: da ? '(grundskyld + ejendomsværdiskat)' : '(land tax + property value tax)',
    koloniTooltip: da
      ? 'Kolonihavehuse ikke må bruges til helårsbeboelse og er derfor undtaget ejendomsværdiskat jf. kolonihavelovens § 2.'
      : 'Allotment houses may not be used for year-round habitation and are therefore exempt from property value tax per the Allotment Act § 2.',
  };

  return (
    <div className="space-y-5">
      {/* BIZZ-616: Top-level tab loading spinner — vises mens VUR-data
                  hentes så tabben ikke står blank ved første klik. */}
      {(forelobigLoader || vurderingLoader) && <TabLoadingSpinner label={t.loadingSkat} />}

      {/* ── Ejendomsskatter — baseret på foreløbige + estimerede data ── */}
      <div>
        <SectionTitle title={t.propertyTaxes} />

        {(() => {
          // BIZZ-319: Show loader while tax data is being fetched
          if (forelobigLoader || vurderingLoader) {
            return (
              <SektionLoader label={da ? 'Henter skattedata…' : 'Loading tax data…'} rows={3} />
            );
          }

          /** Nyeste foreløbig vurdering (typisk 2024) */
          const nyeste = forelobige.length > 0 ? forelobige[0] : null;

          if (!nyeste && !vurdering?.estimereretGrundskyld) {
            return (
              <div className="bg-slate-800/20 border border-slate-700/30 rounded-xl p-5 text-center">
                <p className="text-slate-500 text-xs">{t.noTaxData}</p>
              </div>
            );
          }

          /** Ejendomsværdiskat = 0 for kolonihaver på lejet grund */
          const visEjendomsskat =
            !erKolonihave && nyeste?.ejendomsskat != null && nyeste.ejendomsskat > 0;
          const effektivGrundskyld = nyeste?.grundskyld ?? 0;
          const effektivEjendomsskat = erKolonihave ? 0 : (nyeste?.ejendomsskat ?? 0);

          return (
            <div className="space-y-4">
              {/* BIZZ-956: Forklar min vurdering-knap */}
              <button
                type="button"
                onClick={() => {
                  const prompt = da
                    ? 'Forklar min ejendomsvurdering i klart sprog — grundværdi, ejendomsværdi, skatteberegning, skatteloft og eventuelle fradrag.'
                    : 'Explain my property valuation in plain language — land value, property value, tax calculation, tax ceiling and any deductions.';
                  window.dispatchEvent(
                    new CustomEvent('bizz:ai-open-with-prompt', { detail: { prompt } })
                  );
                }}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/30 text-blue-300 text-sm transition-colors"
              >
                <Sparkles size={14} />
                {da ? 'Forklar min vurdering' : 'Explain my valuation'}
              </button>

              {/* ── {t.currentTaxation} (nyeste foreløbige) ── */}
              {nyeste && (
                <div>
                  <p className="text-slate-300 text-sm font-semibold mb-0.5">
                    {t.currentTaxation} ({nyeste.vurderingsaar + 1})
                  </p>
                  {/*
                    BIZZ-469: Forklar eksplicit år-mappingen i
                    selve Nuværende beskatning-sektion.
                  */}
                  <p className="text-slate-500 text-[11px] mb-2 leading-relaxed">
                    {da
                      ? `Skat betalt i ${nyeste.vurderingsaar + 1}, beregnet ud fra vurderingen for ${nyeste.vurderingsaar}.`
                      : `Tax paid in ${nyeste.vurderingsaar + 1}, calculated from the ${nyeste.vurderingsaar} assessment.`}
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {/* Grundskyld */}
                    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                      <p className="text-white text-lg font-bold flex items-center gap-1.5">
                        {effektivGrundskyld > 0 ? formatDKK(effektivGrundskyld) : formatDKK(0)}
                        <span className="text-slate-500 text-xs font-normal">DKK</span>
                      </p>
                      <p className="text-slate-500 text-xs mt-0.5">{t.groundTaxToMunicipality}</p>
                    </div>
                    {/* Ejendomsværdiskat */}
                    {visEjendomsskat && (
                      <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                        <p className="text-white text-lg font-bold">
                          {formatDKK(nyeste.ejendomsskat!)}
                          <span className="text-slate-500 text-xs font-normal ml-1">DKK</span>
                        </p>
                        <p className="text-slate-500 text-xs mt-0.5">{t.propertyValueTax}</p>
                      </div>
                    )}
                    {/* Kolonihave: vis 0 kr med (i)-ikon tooltip */}
                    {erKolonihave && (
                      <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 relative group/info">
                        <p className="text-white text-lg font-bold flex items-center gap-1.5">
                          0<span className="text-slate-500 text-xs font-normal">DKK</span>
                          <span className="relative">
                            <Info className="w-3.5 h-3.5 text-blue-400/70 cursor-help" />
                            <span className="absolute left-full top-1/2 -translate-y-1/2 ml-2 w-64 px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-300 leading-relaxed opacity-0 invisible group-hover/info:opacity-100 group-hover/info:visible transition-all z-50 pointer-events-none shadow-xl">
                              {t.koloniTooltip}
                              <span className="absolute right-full top-1/2 -translate-y-1/2 border-4 border-transparent border-r-slate-700" />
                            </span>
                          </span>
                        </p>
                        <p className="text-slate-500 text-xs mt-0.5">{t.propertyValueTaxExempt}</p>
                      </div>
                    )}
                  </div>

                  {/* {t.totalTax} */}
                  {(visEjendomsskat || erKolonihave) && (
                    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 mt-3">
                      <p className="text-white text-lg font-bold">
                        {formatDKK(effektivGrundskyld + effektivEjendomsskat)}
                        <span className="text-slate-500 text-xs font-normal ml-1">DKK</span>
                      </p>
                      <p className="text-slate-500 text-xs mt-0.5">
                        {t.totalTax} {erKolonihave ? t.taxBreakdownKoloni : t.taxBreakdownNormal}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* BIZZ-445: Removed estimated grundskyld fallback — only actual Vurderingsportalen data */}
            </div>
          );
        })()}
      </div>

      {/* BIZZ-445 + BIZZ-469: Skattehistorik — kun faktiske tal fra Vurderingsportalen (estimater fjernet) */}
      {forelobige.length > 0 &&
        (() => {
          type SkatRaekke = {
            aar: number;
            ejendomsvaerdi: number | null;
            grundvaerdi: number | null;
            grundskyldAktuel: number | null;
            ejendomsskatAktuel: number | null;
          };

          const alleRaekker: SkatRaekke[] = forelobige
            .map((fv) => ({
              aar: fv.vurderingsaar,
              ejendomsvaerdi: fv.ejendomsvaerdi,
              grundvaerdi: fv.grundvaerdi,
              grundskyldAktuel: fv.grundskyld,
              ejendomsskatAktuel: fv.ejendomsskat,
            }))
            .sort((a, b) => b.aar - a.aar);

          if (alleRaekker.length === 0) return null;

          return (
            <div>
              <SectionTitle title={da ? 'Skattehistorik' : 'Tax history'} />
              <p className="text-slate-500 text-xs mb-2 leading-relaxed">
                {da
                  ? 'Årstal refererer til vurderingsåret. Skatten baseret på vurderingen opkræves typisk det følgende år — fx bygger betalinger i 2025 på vurderingen for 2024.'
                  : 'Year refers to the assessment year. The tax based on that assessment is usually collected the following year — e.g. payments in 2025 are based on the 2024 assessment.'}
              </p>
              <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-hidden overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-700/40">
                      <th className="px-4 py-2.5 text-left text-slate-500 font-medium">
                        {da ? 'Vurderingsår' : 'Assessment year'}
                      </th>
                      <th className="px-4 py-2.5 text-right text-slate-500 font-medium">
                        {da ? 'Ejendomsværdi' : 'Property value'}
                      </th>
                      <th className="px-4 py-2.5 text-right text-slate-500 font-medium">
                        {da ? 'Grundværdi' : 'Land value'}
                      </th>
                      <th className="px-4 py-2.5 text-right text-slate-500 font-medium">
                        {da ? 'Grundskyld' : 'Land tax'}
                      </th>
                      <th className="px-4 py-2.5 text-right text-slate-500 font-medium">
                        {da ? 'Ejendomsværdiskat' : 'Property value tax'}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {alleRaekker.map((r) => (
                      <tr
                        key={r.aar}
                        className="border-b border-slate-700/20 last:border-0 hover:bg-slate-800/30"
                      >
                        <td className="px-4 py-2 text-slate-300 font-medium">
                          {r.aar}
                          <span className="ml-1.5 text-slate-600 text-[10px] font-normal">
                            {da ? `(betales ${r.aar + 1})` : `(paid ${r.aar + 1})`}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right text-slate-300">
                          {r.ejendomsvaerdi ? formatDKK(r.ejendomsvaerdi) : '–'}
                        </td>
                        <td className="px-4 py-2 text-right text-slate-300">
                          {r.grundvaerdi ? formatDKK(r.grundvaerdi) : '–'}
                        </td>
                        <td className="px-4 py-2 text-right font-medium tabular-nums">
                          {r.grundskyldAktuel != null ? (
                            <span className="text-emerald-400">
                              {formatDKK(r.grundskyldAktuel)} kr/år
                            </span>
                          ) : (
                            '–'
                          )}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {r.ejendomsskatAktuel != null ? (
                            <span className="text-emerald-400 font-medium">
                              {formatDKK(r.ejendomsskatAktuel)} kr/år
                            </span>
                          ) : (
                            <span className="text-slate-600 text-[10px]">
                              {da ? 'ikke opkrævet' : 'not charged'}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })()}

      {/* BIZZ-490: Grundskatteloft (Loftansættelse, ESL §45 4,75%-regulering). */}
      {vurLoft.length > 0 &&
        (() => {
          const aktivLoft =
            vurLoft.find((l) => l.basisaar != null && l.grundvaerdi != null) ?? vurLoft[0];
          if (!aktivLoft || (aktivLoft.basisaar == null && aktivLoft.grundvaerdi == null)) {
            return null;
          }
          return (
            <div className="bg-amber-500/5 border border-amber-500/30 rounded-xl p-4">
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center">
                  <Landmark size={16} className="text-amber-300" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-amber-200 text-sm font-semibold">
                      {da ? 'Grundskatteloft aktiv' : 'Land-tax ceiling active'}
                    </p>
                    <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30">
                      {da ? 'ESL §45' : 'ESL §45'}
                    </span>
                  </div>
                  <p className="text-slate-400 text-xs mt-1 leading-snug">
                    {da
                      ? 'Grundskylden kan maksimalt stige 4,75% om året (loftreguleret grundværdi). Når loftet er aktivt, beregnes skatten af den regulerede grundværdi, ikke den fulde offentlige vurdering.'
                      : 'Land tax can rise by at most 4.75% per year (capped land value). When the ceiling is active, tax is calculated from the capped value — not the full public valuation.'}
                  </p>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-1 mt-3 text-xs">
                    {aktivLoft.basisaar != null && (
                      <div className="flex justify-between gap-2">
                        <span className="text-slate-500">{da ? 'Basisår' : 'Base year'}</span>
                        <span className="text-slate-300 tabular-nums">{aktivLoft.basisaar}</span>
                      </div>
                    )}
                    {aktivLoft.grundvaerdi != null && (
                      <div className="flex justify-between gap-2">
                        <span className="text-slate-500">{da ? 'Loftværdi' : 'Capped value'}</span>
                        <span className="text-slate-300 tabular-nums">
                          {formatDKK(aktivLoft.grundvaerdi)}
                        </span>
                      </div>
                    )}
                    {aktivLoft.pgf11 && (
                      <div className="flex justify-between gap-2 col-span-2">
                        <span className="text-slate-500">
                          {da ? 'Beregningsgrundlag' : 'Calculation basis'}
                        </span>
                        <span className="text-slate-300">{aktivLoft.pgf11}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

      {/* BIZZ-491: Skattefritagelser */}
      {vurFritagelser.length > 0 && (
        <div>
          <SectionTitle title={da ? 'Skattefritagelser' : 'Tax exemptions'} />
          <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
            {vurFritagelser.map((f) => (
              <div
                key={f.loebenummer}
                className="px-4 py-3 border-b border-slate-700/20 last:border-b-0 flex items-center justify-between"
              >
                <div>
                  <p className="text-slate-300 text-sm">{f.artKode ?? `#${f.loebenummer}`}</p>
                  {f.omfangKode && (
                    <p className="text-slate-500 text-xs">
                      {da ? 'Omfang' : 'Scope'}: {f.omfangKode}
                    </p>
                  )}
                </div>
                <p className="text-white text-sm font-medium tabular-nums">
                  {f.beloeb != null ? formatDKK(f.beloeb) : '—'}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
