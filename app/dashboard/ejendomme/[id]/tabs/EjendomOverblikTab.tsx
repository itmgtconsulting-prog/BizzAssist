/**
 * EjendomOverblikTab — Overblik-fane på ejendoms-detaljesiden.
 *
 * Viser:
 *   - Matrikel/lejlighedsinfo (grundareal, matrikelnr, ejerlav, kommune)
 *   - Ejendomsvurdering (ejendomsværdi, grundværdi, foreløbig vurdering)
 *   - Bygninger (antal, areal, bolig/erhverv)
 *   - Enheder / ejerlejligheder
 *   - Virksomheder på adressen (CVR)
 *   - BBR-fejlbesked
 *
 * BIZZ-657: Extraheret fra EjendomDetaljeClient.tsx for at reducere
 * master-file-størrelsen. Ren filopdeling — ingen logik-/adfærds-ændring.
 *
 * @module app/dashboard/ejendomme/[id]/tabs/EjendomOverblikTab
 */

'use client';

import Link from 'next/link';
import { ChevronDown, ChevronRight } from 'lucide-react';
import TabLoadingSpinner from '@/app/components/TabLoadingSpinner';
import { formatDKK } from '@/app/lib/mock/ejendomme';
import { isUdfasetStatusLabel } from '@/app/lib/bbrKoder';
import type { EjendomApiResponse } from '@/app/api/ejendom/[id]/route';
import type { VurderingData } from '@/app/api/vurdering/route';
import type { ForelobigVurdering } from '@/app/api/vurdering-forelobig/route';
import type { DawaAdresse, DawaJordstykke } from '@/app/lib/dawa';
import type { CVRVirksomhed } from '@/app/api/cvr/route';
import type { Ejerlejlighed } from '@/app/api/ejerlejligheder/route';

interface TinglysningSnapshot {
  tinglystAreal: number | null;
  ejerlejlighedNr: number | null;
  fordelingstal: { taeller: number; naevner: number } | null;
}

interface Props {
  /** 'da' | 'en' — bilingual */
  lang: 'da' | 'en';
  /** true hvis BBR-data stadig indlæses */
  bbrLoader: boolean;
  /** true hvis vurderingsdata stadig indlæses */
  vurderingLoader: boolean;
  /** BBR response */
  bbrData: EjendomApiResponse | null;
  /** DAWA adresse */
  dawaAdresse: DawaAdresse;
  /** DAWA jordstykke */
  dawaJordstykke: DawaJordstykke | null;
  /** Officiel vurdering */
  vurdering: VurderingData | null;
  /** Foreløbige vurderinger, nyeste først */
  forelobige: ForelobigVurdering[];
  /** Tinglysning snapshot (tinglystAreal, ejerlejlighedNr) */
  tinglysningData: TinglysningSnapshot | null;
  /** Ejerlejligheder i ejendommen */
  lejligheder: Ejerlejlighed[] | null;
  /** true hvis lejlighedsdata hentes */
  lejlighederLoader: boolean;
  /** CVR virksomheder på adressen */
  cvrVirksomheder: CVRVirksomhed[] | null;
  /** true når CVR fetch er komplet */
  cvrFetchComplete: boolean;
  /** true hvis CVR-token mangler */
  cvrTokenMangler: boolean;
  /** true hvis CVR API er nede */
  cvrApiDown: boolean;
  /** true hvis historiske virksomheder skal vises */
  visOphoerte: boolean;
  /** Setter for visOphoerte */
  setVisOphoerte: React.Dispatch<React.SetStateAction<boolean>>;
}

/**
 * Render overblik-fanen for en ejendom.
 * Ren præsentations-komponent — alt data leveres via props.
 */
export default function EjendomOverblikTab({
  lang,
  bbrLoader,
  vurderingLoader,
  bbrData,
  dawaAdresse,
  dawaJordstykke,
  vurdering,
  forelobige,
  tinglysningData,
  lejligheder,
  lejlighederLoader,
  cvrVirksomheder,
  cvrFetchComplete,
  cvrTokenMangler,
  cvrApiDown,
  visOphoerte,
  setVisOphoerte,
}: Props) {
  const da = lang === 'da';

  // ─── Translations — afgrænset til Overblik-fanen ───────────────────────
  const t = {
    loadingOverblik: da ? 'Henter overblik…' : 'Loading overview…',
    cadastre: da ? 'matrikel' : 'cadastre',
    builtUp: da ? 'bebygget' : 'built-up',
    plotArea: da ? 'Grundareal' : 'Plot area',
    cadastreNr: da ? 'Matrikelnr.' : 'Cadastre no.',
    ejerlav: da ? 'Ejerlav' : 'Land registry district',
    municipality: da ? 'Kommune' : 'Municipality',
    propertyValuation: da ? 'Ejendomsvurdering' : 'Property valuation',
    propertyValue: da ? 'Ejendomsværdi' : 'Property value',
    landValue: da ? 'Grundværdi' : 'Land value',
    assessedArea: da ? 'Vurderet areal' : 'Assessed area',
    groundTax: da ? 'Grundskyld' : 'Land tax',
    taxable: da ? 'Afgiftspligtig' : 'Taxable',
    perYear: da ? '/ år' : '/ year',
    awaitingBBR: da ? 'Afventer BBR-data…' : 'Awaiting BBR data…',
    bfeNotFound: da ? 'BFEnummer ikke fundet' : 'BFE number not found',
    preliminary: da ? 'FORELØBIG' : 'PRELIMINARY',
    buildings: da ? 'bygninger' : 'buildings',
    buildingArea: da ? 'Bygningsareal' : 'Building area',
    residentialArea: da ? 'Beboelsesareal' : 'Residential area',
    commercialArea: da ? 'Erhvervsareal' : 'Commercial area',
    basement: da ? 'Kælder' : 'Basement',
    units: da ? 'enheder' : 'units',
    residentialUnits: da ? 'Beboelsesenheder' : 'Residential units',
    commercialUnits: da ? 'Erhvervsenheder' : 'Commercial units',
    totalUnitArea: da ? 'Samlet enhedsareal' : 'Total unit area',
    companiesAtAddress: da ? 'Virksomheder på adressen' : 'Companies at address',
    cvrAccessRequired: da
      ? 'CVR-opslag kræver gratis adgang til Erhvervsstyrelsens CVR OpenData.'
      : 'CVR lookup requires free access to the Danish Business Authority CVR OpenData.',
    restartDevServer: da ? 'Genstart dev-serveren bagefter.' : 'Restart the dev server afterwards.',
    loadingCVR: da ? 'Henter CVR-data…' : 'Loading CVR data…',
    active: da ? 'aktive' : 'active',
    historical: da ? 'historiske' : 'historical',
    showHistorical: da ? 'Vis historiske' : 'Show historical',
    hideHistorical: da ? 'Skjul historiske' : 'Hide historical',
    company: da ? 'Virksomhed' : 'Company',
    industry: da ? 'Industri' : 'Industry',
    period: da ? 'Periode' : 'Period',
    employees: da ? 'Ansatte' : 'Employees',
    noCVRFound: da
      ? 'Ingen CVR-registrerede virksomheder fundet på denne adresse.'
      : 'No CVR-registered companies found at this address.',
    bbrUnavailable: da ? 'BBR-data utilgængelig' : 'BBR data unavailable',
    openDatafordeler: da ? 'Åbn datafordeler.dk →' : 'Open datafordeler.dk →',
  };

  return (
    <div className="space-y-2">
      {/* BIZZ-616: Tab-level loading spinner mens kerne-data (BBR +
          vurdering) hentes. Matcher øvrige tabs' loading-pattern. */}
      {(bbrLoader || vurderingLoader) && !bbrData && (
        <TabLoadingSpinner label={t.loadingOverblik} />
      )}
      {/* 2-spalte layout: ejendomsdata (venstre) + økonomi (højre) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {/* ─── Rad 1: Matrikel (v) + Ejendomsvurdering (h) ─── */}

        {/* Matrikel / Lejlighedsinfo */}
        {(() => {
          const erModer = !dawaAdresse?.etage && !!bbrData?.ejerlejlighedBfe;
          const erLejlighed = !!bbrData?.ejerlejlighedBfe && !erModer;
          const enhed = erLejlighed ? (bbrData?.enheder ?? [])[0] : null;
          const grundareal = (dawaJordstykke?.areal_m2 || null) ?? vurdering?.vurderetAreal ?? null;
          const bygAreal = bbrData?.bbr?.reduce((s, b) => s + (b.bebyggetAreal ?? 0), 0) ?? 0;
          const bebyggPct =
            !erLejlighed && vurdering?.bebyggelsesprocent != null
              ? vurdering.bebyggelsesprocent
              : !erLejlighed && grundareal && bygAreal
                ? Math.round((bygAreal / grundareal) * 100)
                : null;
          const kommunenavn =
            (dawaAdresse.kommunenavn || null) ?? dawaJordstykke?.kommune.navn ?? null;
          return (
            <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-2.5">
              <div className="flex items-baseline justify-between mb-1.5">
                <div className="flex items-baseline gap-1">
                  <span className="text-white font-bold text-lg">{erLejlighed ? '' : '1'}</span>
                  <span className="text-slate-400 text-xs">
                    {erLejlighed ? (da ? 'Lejlighed' : 'Apartment') : t.cadastre}
                  </span>
                  {erLejlighed && tinglysningData?.ejerlejlighedNr && (
                    <span className="text-slate-500 text-xs ml-1">
                      nr. {tinglysningData.ejerlejlighedNr}
                    </span>
                  )}
                </div>
                {bebyggPct !== null && (
                  <span className="text-slate-400 text-xs font-medium">
                    {bebyggPct}% {t.builtUp}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                {erLejlighed ? (
                  <>
                    {/* Lejligheds-specifik info */}
                    <div>
                      <p className="text-slate-500 text-xs leading-none mb-0.5">
                        {da ? 'Tinglyst areal' : 'Registered area'}
                      </p>
                      <p className="text-white text-sm font-medium">
                        {tinglysningData?.tinglystAreal
                          ? `${tinglysningData.tinglystAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                          : '–'}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500 text-xs leading-none mb-0.5">
                        {da ? 'Værelser' : 'Rooms'}
                      </p>
                      <p className="text-white text-sm font-medium">{enhed?.vaerelser ?? '–'}</p>
                    </div>
                    <div>
                      <p className="text-slate-500 text-xs leading-none mb-0.5">{t.cadastreNr}</p>
                      <p className="text-white text-sm font-medium">
                        {dawaJordstykke?.matrikelnr ?? dawaAdresse.matrikelnr ?? '–'}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500 text-xs leading-none mb-0.5">{t.municipality}</p>
                      <p className="text-white text-sm">{kommunenavn ?? '–'}</p>
                    </div>
                  </>
                ) : (
                  <>
                    {/* Standard matrikel-info */}
                    <div>
                      <p className="text-slate-500 text-xs leading-none mb-0.5">{t.plotArea}</p>
                      <p className="text-white text-sm font-medium">
                        {grundareal
                          ? `${grundareal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                          : '–'}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500 text-xs leading-none mb-0.5">{t.cadastreNr}</p>
                      <p className="text-white text-sm font-medium">
                        {dawaJordstykke?.matrikelnr ?? dawaAdresse.matrikelnr ?? '–'}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500 text-xs leading-none mb-0.5">{t.ejerlav}</p>
                      <p className="text-white text-sm truncate">
                        {dawaJordstykke?.ejerlav.navn ?? '–'}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500 text-xs leading-none mb-0.5">{t.municipality}</p>
                      <p className="text-white text-sm">{kommunenavn ?? '–'}</p>
                    </div>
                  </>
                )}
              </div>
            </div>
          );
        })()}

        {/* Ejendomsvurdering */}
        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-2.5">
          <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-1.5 flex items-center gap-2">
            <span>{t.propertyValuation}</span>
            {vurdering?.erNytSystem && (
              <span className="px-1.5 py-0.5 bg-blue-500/10 border border-blue-500/20 rounded text-[10px] text-blue-400 font-medium normal-case tracking-normal">
                NY
              </span>
            )}
          </p>
          {vurderingLoader ? (
            <div className="space-y-2 animate-pulse">
              <div className="grid grid-cols-2 gap-x-3">
                <div>
                  <div className="h-3 w-20 bg-slate-700/60 rounded mb-1.5" />
                  <div className="h-5 w-28 bg-slate-700/40 rounded" />
                </div>
                <div>
                  <div className="h-3 w-16 bg-slate-700/60 rounded mb-1.5" />
                  <div className="h-5 w-24 bg-slate-700/40 rounded" />
                </div>
              </div>
              <div className="h-3 w-32 bg-slate-700/40 rounded" />
            </div>
          ) : vurdering ? (
            <div className="space-y-2">
              {/* Ejendomsværdi + Grundværdi side om side */}
              <div className="grid grid-cols-2 gap-x-3">
                <div>
                  <p className="text-slate-500 text-xs leading-none mb-0.5">
                    {t.propertyValue}
                    {vurdering.aar && (
                      <span className="ml-1 text-slate-600">({vurdering.aar})</span>
                    )}
                  </p>
                  <p className="text-white text-base font-bold">
                    {vurdering.ejendomsvaerdi ? formatDKK(vurdering.ejendomsvaerdi) : formatDKK(0)}
                  </p>
                  {vurdering.afgiftspligtigEjendomsvaerdi !== null &&
                    vurdering.afgiftspligtigEjendomsvaerdi !== vurdering.ejendomsvaerdi && (
                      <p className="text-slate-500 text-xs mt-0.5">
                        {t.taxable}: {formatDKK(vurdering.afgiftspligtigEjendomsvaerdi)}
                      </p>
                    )}
                </div>
                <div>
                  <p className="text-slate-500 text-xs leading-none mb-0.5">
                    {t.landValue}
                    {vurdering.aar && (
                      <span className="ml-1 text-slate-600">({vurdering.aar})</span>
                    )}
                  </p>
                  <p className="text-white text-sm font-medium">
                    {vurdering.grundvaerdi ? formatDKK(vurdering.grundvaerdi) : formatDKK(0)}
                  </p>
                  {vurdering.afgiftspligtigGrundvaerdi !== null &&
                    vurdering.afgiftspligtigGrundvaerdi !== vurdering.grundvaerdi && (
                      <p className="text-slate-500 text-xs mt-0.5">
                        {t.taxable}: {formatDKK(vurdering.afgiftspligtigGrundvaerdi)}
                      </p>
                    )}
                </div>
              </div>
              {/* Vurderet areal + Grundskyld side om side */}
              <div className="grid grid-cols-2 gap-x-3 pt-1.5 border-t border-slate-700/30">
                <div>
                  <p className="text-slate-500 text-xs leading-none mb-0.5">{t.assessedArea}</p>
                  <p className="text-white text-sm font-medium">
                    {vurdering.vurderetAreal
                      ? `${vurdering.vurderetAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                      : '–'}
                  </p>
                </div>
                {/* Grundskyld — foretrækker faktisk fra Vurderingsportalen */}
                {(() => {
                  const nyesteFrl = forelobige.length > 0 ? forelobige[0] : null;
                  const faktiskGrundskyld = nyesteFrl?.grundskyld ?? null;
                  if (faktiskGrundskyld !== null && faktiskGrundskyld > 0) {
                    return (
                      <div>
                        <p className="text-slate-500 text-xs leading-none mb-0.5">
                          {t.groundTax}
                          <span className="text-slate-600 ml-1">({nyesteFrl!.vurderingsaar})</span>
                        </p>
                        <p className="text-white text-sm font-medium flex items-center gap-1">
                          {formatDKK(faktiskGrundskyld)}
                          <span className="text-slate-500 text-xs">{t.perYear}</span>
                        </p>
                      </div>
                    );
                  }
                  // BIZZ-445: Removed estimated grundskyld fallback — only show actual values
                  return null;
                })()}
              </div>
            </div>
          ) : forelobige.length === 0 ? (
            <p className="text-slate-500 text-xs">
              {bbrLoader || !bbrData
                ? t.awaitingBBR
                : !bbrData.ejendomsrelationer?.[0]?.bfeNummer
                  ? t.bfeNotFound
                  : 'Ingen vurderingsdata'}
            </p>
          ) : null}

          {/* ── Forelobig vurdering — vises hvis nyere end nuvaerende vurdering ── */}
          {(() => {
            const nyesteForelobig = forelobige.length > 0 ? forelobige[0] : null;
            const erNyere =
              nyesteForelobig && (!vurdering?.aar || nyesteForelobig.vurderingsaar > vurdering.aar);
            if (!nyesteForelobig || !erNyere) return null;
            return (
              <div className="mt-2 bg-amber-500/5 border border-amber-500/20 rounded-xl p-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="px-1.5 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded text-[10px] text-amber-400 font-medium">
                    {t.preliminary}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                  <div>
                    <p className="text-slate-500 text-xs leading-none mb-0.5">
                      {t.propertyValue}
                      <span className="ml-1 text-slate-600">({nyesteForelobig.vurderingsaar})</span>
                    </p>
                    <p className="text-amber-200 text-sm font-medium">
                      {nyesteForelobig.ejendomsvaerdi
                        ? formatDKK(nyesteForelobig.ejendomsvaerdi)
                        : formatDKK(0)}
                    </p>
                  </div>
                  <div>
                    <p className="text-slate-500 text-xs leading-none mb-0.5">
                      {t.landValue}
                      <span className="ml-1 text-slate-600">({nyesteForelobig.vurderingsaar})</span>
                    </p>
                    <p className="text-amber-200 text-sm font-medium">
                      {nyesteForelobig.grundvaerdi
                        ? formatDKK(nyesteForelobig.grundvaerdi)
                        : '0 DKK'}
                    </p>
                  </div>
                </div>
              </div>
            );
          })()}
        </div>

        {/* ─── Rad 2: Bygninger (v) + Enheder (h) ─── */}

        {/* Bygninger */}
        {(() => {
          // BIZZ-825: central udfaset-tjek
          const bygninger = (bbrData?.bbr ?? [])
            .filter((b) => !isUdfasetStatusLabel(b.status))
            .sort((a, b) => (a.bygningsnr ?? 9999) - (b.bygningsnr ?? 9999));
          const totAreal = bygninger.reduce((s, b) => s + (b.samletBygningsareal ?? 0), 0);
          const boligAreal = bygninger.reduce((s, b) => s + (b.samletBoligareal ?? 0), 0);
          const erhvAreal = bygninger.reduce((s, b) => s + (b.samletErhvervsareal ?? 0), 0);
          const kaelder = bygninger.reduce((s, b) => s + (b.kaelder ?? 0), 0);
          return (
            <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-2.5 self-start">
              <div className="flex items-baseline gap-1 mb-1.5">
                <span className="text-white font-bold text-lg">
                  {bbrLoader ? '…' : bygninger.length || '–'}
                </span>
                <span className="text-slate-400 text-xs">{t.buildings}</span>
              </div>
              <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                <div>
                  <p className="text-slate-500 text-xs leading-none mb-0.5">{t.buildingArea}</p>
                  <p className="text-white text-sm font-medium">
                    {totAreal
                      ? `${totAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                      : formatDKK(0)}
                  </p>
                </div>
                <div>
                  <p className="text-slate-500 text-xs leading-none mb-0.5">{t.residentialArea}</p>
                  <p className="text-white text-sm font-medium">
                    {boligAreal
                      ? `${boligAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                      : '0 m²'}
                  </p>
                </div>
                <div>
                  <p className="text-slate-500 text-xs leading-none mb-0.5">{t.commercialArea}</p>
                  <p className="text-white text-sm font-medium">
                    {erhvAreal
                      ? `${erhvAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                      : formatDKK(0)}
                  </p>
                </div>
                <div>
                  <p className="text-slate-500 text-xs leading-none mb-0.5">{t.basement}</p>
                  <p className="text-white text-sm font-medium">
                    {kaelder ? `${kaelder.toLocaleString(da ? 'da-DK' : 'en-GB')} m²` : '0 m²'}
                  </p>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Enheder */}
        {(() => {
          const erModerHer = !dawaAdresse?.etage && !!bbrData?.ejerlejlighedBfe;
          const enheder = bbrData?.enheder ?? [];
          const boligEnh = enheder.filter((e) => (e.arealBolig ?? 0) > 0).length;
          const erhvEnh = enheder.filter((e) => (e.arealErhverv ?? 0) > 0).length;
          const totAreal = enheder.reduce((s, e) => s + (e.areal ?? 0), 0);

          // Hovedejendom: vis antal lejligheder i stedet for tom enheder-boks
          if (erModerHer) {
            const antalLej = lejligheder?.length ?? 0;
            return (
              <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-2.5 self-start">
                <div className="flex items-baseline gap-1 mb-1.5">
                  <span className="text-white font-bold text-lg">
                    {lejlighederLoader ? '…' : antalLej || '–'}
                  </span>
                  <span className="text-slate-400 text-xs">
                    {da ? 'ejerlejligheder' : 'condominiums'}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                  <div>
                    <p className="text-slate-500 text-xs leading-none mb-0.5">
                      {t.residentialUnits}
                    </p>
                    <p className="text-white text-sm font-medium">
                      {lejlighederLoader ? '…' : antalLej}
                    </p>
                  </div>
                  <div>
                    <p className="text-slate-500 text-xs leading-none mb-0.5">
                      {t.commercialUnits}
                    </p>
                    <p className="text-white text-sm font-medium">0</p>
                  </div>
                  <div className="col-span-2">
                    <p className="text-slate-500 text-xs leading-none mb-0.5">{t.totalUnitArea}</p>
                    <p className="text-white text-sm font-medium">
                      {lejligheder && antalLej > 0
                        ? `${lejligheder.reduce((s, l) => s + (l.areal ?? 0), 0).toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                        : formatDKK(0)}
                    </p>
                  </div>
                </div>
              </div>
            );
          }

          return (
            <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-2.5 self-start">
              <div className="flex items-baseline gap-1 mb-1.5">
                <span className="text-white font-bold text-lg">
                  {bbrLoader ? '…' : enheder.length || '–'}
                </span>
                <span className="text-slate-400 text-xs">{t.units}</span>
              </div>
              <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                <div>
                  <p className="text-slate-500 text-xs leading-none mb-0.5">{t.residentialUnits}</p>
                  <p className="text-white text-sm font-medium">{boligEnh}</p>
                </div>
                <div>
                  <p className="text-slate-500 text-xs leading-none mb-0.5">{t.commercialUnits}</p>
                  <p className="text-white text-sm font-medium">{erhvEnh}</p>
                </div>
                <div className="col-span-2">
                  <p className="text-slate-500 text-xs leading-none mb-0.5">{t.totalUnitArea}</p>
                  <p className="text-white text-sm font-medium">
                    {totAreal
                      ? `${totAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                      : formatDKK(0)}
                  </p>
                </div>
              </div>
            </div>
          );
        })()}
      </div>

      {/*
        BIZZ-473 follow-up: "Virksomheder på adressen" deterministisk
        på "erModer" (hovedejendom, opdelt i ejerlejligheder).
      */}
      {(() => {
        const erModer = !dawaAdresse?.etage && !!bbrData?.ejerlejlighedBfe;
        return !erModer;
      })() && (
        <>
          {/* Virksomheder på adressen — CVR OpenData */}
          {!cvrFetchComplete ? null : cvrTokenMangler ? (
            <div className="bg-amber-500/8 border border-amber-500/20 rounded-xl p-4">
              <p className="text-amber-300 text-xs font-medium uppercase tracking-wide mb-2">
                {t.companiesAtAddress}
              </p>
              <p className="text-slate-400 text-sm mb-3">{t.cvrAccessRequired}</p>
              <ol className="text-slate-400 text-xs space-y-1 list-decimal list-inside leading-relaxed">
                <li>
                  {da ? 'Gå til' : 'Go to'}{' '}
                  <span className="text-blue-400 font-medium">datacvr.virk.dk/data/login</span>{' '}
                  {da ? '→ opret gratis bruger' : '→ create free account'}
                </li>
                <li>
                  {da ? 'Tilføj til' : 'Add to'}{' '}
                  <code className="bg-slate-800 px-1 rounded">.env.local</code>:
                </li>
              </ol>
              <code className="block bg-slate-900 rounded-lg px-3 py-2 mt-2 text-xs text-emerald-400 font-mono">
                CVR_ES_USER=din@email.dk{'\n'}CVR_ES_PASS=dit_password
              </code>
              <p className="text-slate-500 text-xs mt-2">{t.restartDevServer}</p>
            </div>
          ) : cvrApiDown ? (
            <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
              <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-2">
                {t.companiesAtAddress}
              </p>
              <p className="text-slate-500 text-sm">
                {da
                  ? 'CVR-data er midlertidigt utilgængeligt — prøv igen om lidt.'
                  : 'CVR data is temporarily unavailable — please try again shortly.'}
              </p>
            </div>
          ) : cvrVirksomheder === null ? (
            <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
              <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-2">
                {t.companiesAtAddress}
              </p>
              <div className="flex items-center gap-2 text-slate-500 text-sm">
                <div className="w-3.5 h-3.5 border border-slate-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                {t.loadingCVR}
              </div>
            </div>
          ) : cvrVirksomheder.length > 0 ? (
            (() => {
              const aktive = cvrVirksomheder.filter((v) => v.aktiv && v.påAdressen);
              const historiske = cvrVirksomheder.filter((v) => !v.aktiv || !v.påAdressen);
              const visteVirksomheder = visOphoerte ? [...aktive, ...historiske] : aktive;

              /** Beregn adresseperiode */
              const beregnPeriode = (v: CVRVirksomhed) => {
                const fra = v.adresseFra ?? v.aktivFra;
                if (!fra) return '–';
                const fraDate = new Date(fra);
                const fraStr = fraDate.toLocaleDateString('da-DK', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                });
                if (v.adresseTil) {
                  const tilDate = new Date(v.adresseTil);
                  const tilStr = tilDate.toLocaleDateString('da-DK', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  });
                  return `${fraStr} – ${tilStr}`;
                }
                return `${fraStr} –`;
              };

              return (
                <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden overflow-x-auto">
                  <div className="px-4 py-3 border-b border-slate-700/40 flex items-center justify-between">
                    <p className="text-slate-200 text-sm font-semibold">{t.companiesAtAddress}</p>
                    <div className="flex items-center gap-3">
                      <span className="text-slate-500 text-xs">
                        {aktive.length} {t.active}
                        {historiske.length > 0 && ` · ${historiske.length} ${t.historical}`}
                      </span>
                      {historiske.length > 0 && (
                        <button
                          onClick={() => setVisOphoerte(!visOphoerte)}
                          className="flex items-center gap-1 text-slate-500 hover:text-slate-300 text-xs transition-colors"
                        >
                          {visOphoerte ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          {visOphoerte
                            ? t.hideHistorical
                            : `${t.showHistorical} (${historiske.length})`}
                        </button>
                      )}
                    </div>
                  </div>
                  {/* Tabelheader */}
                  <div className="min-w-[500px] grid grid-cols-[1fr_1fr_120px_72px] px-4 py-2 text-slate-500 text-xs font-medium border-b border-slate-700/30">
                    <span>{t.company}</span>
                    <span>{t.industry}</span>
                    <span className="text-right">{t.period}</span>
                    <span className="text-right">{t.employees}</span>
                  </div>
                  <div className="divide-y divide-slate-700/20">
                    {visteVirksomheder.map((v) => (
                      <div
                        key={v.cvr}
                        className={`min-w-[500px] grid grid-cols-[1fr_1fr_120px_72px] px-4 py-3 items-center gap-2 hover:bg-slate-700/10 transition-colors ${!v.aktiv || !v.påAdressen ? 'opacity-50' : ''}`}
                      >
                        {/* Virksomhed */}
                        <div className="min-w-0 flex items-center gap-2">
                          <div
                            className={`w-2 h-2 rounded-full flex-shrink-0 ${v.aktiv && v.påAdressen ? 'bg-emerald-400' : 'bg-slate-500'}`}
                          />
                          <div className="min-w-0">
                            <Link
                              href={`/dashboard/companies/${v.cvr}`}
                              className="text-slate-200 text-sm font-medium hover:text-blue-400 transition-colors truncate block"
                            >
                              {v.navn}
                            </Link>
                            <p className="text-slate-500 text-xs truncate">
                              {v.type ? `${v.type} · ` : ''}CVR {v.cvr}
                            </p>
                          </div>
                        </div>
                        {/* Industri */}
                        <span className="text-slate-400 text-xs truncate pr-2">
                          {v.branche ?? '–'}
                        </span>
                        {/* Periode */}
                        <span className="text-slate-400 text-xs text-right">
                          {beregnPeriode(v)}
                        </span>
                        {/* Ansatte */}
                        <span className="text-slate-300 text-sm text-right font-medium">
                          {v.ansatte ?? '–'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()
          ) : (
            <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
              <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-1">
                {t.companiesAtAddress}
              </p>
              <p className="text-slate-500 text-sm">{t.noCVRFound}</p>
            </div>
          )}
        </>
      )}

      {/* BBR-fejlbesked */}
      {bbrData?.bbrFejl && (
        <div className="bg-orange-500/8 border border-orange-500/20 rounded-xl p-4 flex items-start gap-3">
          <div className="w-5 h-5 rounded-full bg-orange-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
            <span className="text-orange-400 text-xs">!</span>
          </div>
          <div>
            <p className="text-orange-300 text-sm font-medium">{t.bbrUnavailable}</p>
            <p className="text-slate-400 text-xs mt-1">{bbrData.bbrFejl}</p>
            <a
              href="https://datafordeler.dk"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 text-xs hover:text-blue-300 mt-1 inline-block"
            >
              {t.openDatafordeler}
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
