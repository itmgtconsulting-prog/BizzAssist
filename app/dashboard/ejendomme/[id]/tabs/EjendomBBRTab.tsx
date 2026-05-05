/**
 * EjendomBBRTab — BBR-fane på ejendoms-detaljesiden.
 *
 * Viser:
 *   - Information (matrikelnr, ejerlav, kommune, grundareal)
 *   - Bygninger — aktive bygninger med risk-badges (asbest, træ), expandable detaljer
 *   - Enheder — bolig/erhvervsenheder sorteret pr. bygning, expandable detaljer
 *   - Tekniske anlæg (solceller, varmepumper, oliefyr, tanke)
 *   - Matrikeloplysninger (Datafordeler MAT) med jordstykker og historik
 *
 * BIZZ-657: Extraheret fra EjendomDetaljeClient.tsx for at reducere
 * master-file-størrelsen. Ren filopdeling — ingen logik-/adfærds-ændring.
 *
 * Data leveres via props (parent fetcher BBR + matrikel).
 *
 * @module app/dashboard/ejendomme/[id]/tabs/EjendomBBRTab
 */

'use client';

import { MapIcon, ChevronRight, ChevronDown, CheckCircle, XCircle, Clock } from 'lucide-react';
import SektionLoader from '@/app/components/SektionLoader';
import TabLoadingSpinner from '@/app/components/TabLoadingSpinner';
import { formatDKK } from '@/app/lib/mock/ejendomme';
import { tekniskAnlaegTekst, tekniskAnlaegKategori } from '@/app/lib/bbrTekniskAnlaegKoder';
import { isUdfasetStatusLabel } from '@/app/lib/bbrKoder';
import type { EjendomApiResponse } from '@/app/api/ejendom/[id]/route';
import type { VurderingData } from '@/app/api/vurdering/route';
import type { DawaAdresse, DawaJordstykke } from '@/app/lib/dawa';
import type { MatrikelEjendom } from '@/app/api/matrikel/route';
import ByggeaktivitetBadge from '@/app/components/ejendomme/ByggeaktivitetBadge';
import SkraafotoGalleri from '@/app/components/ejendomme/SkraafotoGalleri';
import type { MatrikelHistorikEvent } from '@/app/api/matrikel/historik/route';
// Ejendomsstruktur flyttet til Ejerskab-fanen

/** Small re-implementation of the parent's SectionTitle for this tab. */
function SectionTitle({ title }: { title: string }) {
  return (
    <div className="flex items-center justify-between mb-1.5">
      <h3 className="text-white font-semibold text-sm">{title}</h3>
    </div>
  );
}

/** Small stat card used for summary rows. */
function DataKort({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-slate-900/50 border border-slate-700/40 rounded-xl p-2">
      <p className="text-slate-400 text-xs leading-none mb-0.5">{label}</p>
      <p className="text-white font-semibold text-sm leading-tight">{value}</p>
    </div>
  );
}

interface Props {
  /** 'da' | 'en' — bilingual */
  lang: 'da' | 'en';
  /** true hvis BBR-data stadig indlæses */
  bbrLoader: boolean;
  /** BBR response (bygninger, enheder, tekniske anlæg etc.) */
  bbrData: EjendomApiResponse | null;
  /** DAWA adresse (matrikelnr, kommunenavn) */
  dawaAdresse: DawaAdresse;
  /** DAWA jordstykke (areal, ejerlav, kommune) */
  dawaJordstykke: DawaJordstykke | null;
  /** Officiel vurdering (bruges til vurderetAreal fallback) */
  vurdering: VurderingData | null;
  /** Set af expanded bygning row-IDs */
  expandedBygninger: Set<string>;
  /** Setter for expandedBygninger */
  setExpandedBygninger: React.Dispatch<React.SetStateAction<Set<string>>>;
  /** Set af expanded enhed row-IDs */
  expandedEnheder: Set<string>;
  /** Setter for expandedEnheder */
  setExpandedEnheder: React.Dispatch<React.SetStateAction<Set<string>>>;
  /** true hvis matrikel-historik er collapsed */
  historikOpen: boolean;
  /** Setter for historikOpen */
  setHistorikOpen: React.Dispatch<React.SetStateAction<boolean>>;
  /** true hvis matrikel-historik indlæses */
  historikLoader: boolean;
  /** true hvis matrikeldata indlæses */
  matrikelLoader: boolean;
  /** Matrikeldata fra Datafordeler MAT */
  matrikelData: MatrikelEjendom | null;
  /** Matrikel-historik events */
  matrikelHistorik: MatrikelHistorikEvent[];
  /** BIZZ-1079: Kommunekode for byggeaktivitet */
  kommunekode?: string | null;
}

/**
 * Render BBR-fanen for en ejendom.
 * Ren præsentations-komponent — alt data leveres via props.
 */
export default function EjendomBBRTab({
  lang,
  bbrLoader,
  bbrData,
  dawaAdresse,
  dawaJordstykke,
  vurdering,
  expandedBygninger,
  setExpandedBygninger,
  expandedEnheder,
  setExpandedEnheder,
  historikOpen,
  setHistorikOpen,
  historikLoader,
  matrikelLoader,
  matrikelData,
  matrikelHistorik,
  kommunekode,
}: Props) {
  const da = lang === 'da';

  // ─── Translations — afgrænset til BBR-fanen ────────────────────────────
  const t = {
    loadingBBR: da ? 'Henter BBR-data…' : 'Loading BBR data…',
    information: da ? 'Information' : 'Information',
    buildings: da ? 'bygninger' : 'buildings',
    buildingArea: da ? 'Bygningsareal' : 'Building area',
    residentialArea: da ? 'Beboelsesareal' : 'Residential area',
    commercialArea: da ? 'Erhvervsareal' : 'Commercial area',
    basement: da ? 'Kælder' : 'Basement',
    noActiveBuildings: da ? 'Ingen aktive bygninger tilgængelige' : 'No active buildings available',
    nr: da ? 'Nr.' : 'No.',
    usage: da ? 'Anvendelse' : 'Usage',
    builtYear: da ? 'Opf. år' : 'Built',
    builtArea: da ? 'Bebygget' : 'Built area',
    totalArea: da ? 'Samlet' : 'Total',
    geodata: da ? 'Geodata' : 'Geodata',
    status: da ? 'Status' : 'Status',
    erected: da ? 'Opført' : 'Erected',
    projected: da ? 'Projekteret' : 'Projected',
    underConstruction: da ? 'Under opførelse' : 'Under construction',
    temporary: da ? 'Midlertidig' : 'Temporary',
    condemned: da ? 'Kondemneret' : 'Condemned',
    outerWall: da ? 'Ydervæg' : 'Outer wall',
    roofMaterial: da ? 'Tagmateriale' : 'Roof material',
    heatingInstallation: da ? 'Varmeinstallation' : 'Heating installation',
    heatingForm: da ? 'Opvarmningsform' : 'Heating type',
    supplementaryHeat: da ? 'Supplerende varme' : 'Supplementary heat',
    waterSupply: da ? 'Vandforsyning' : 'Water supply',
    drainage: da ? 'Afløb' : 'Drainage',
    floors: da ? 'Etager' : 'Floors',
    preservation: da ? 'Fredning' : 'Preservation',
    conservationValue: da ? 'Bevaringsværdighed' : 'Conservation value',
    units: da ? 'enheder' : 'units',
    totalUnits: da ? 'Enheder i alt' : 'Total units',
    residentialUnits: da ? 'Beboelsesenheder' : 'Residential units',
    commercialUnits: da ? 'Erhvervsenheder' : 'Commercial units',
    totalAreaLabel: da ? 'Samlet areal' : 'Total area',
    noUnitsAvailable: da ? 'Ingen enheder tilgængelige' : 'No units available',
    bldg: da ? 'Byg.' : 'Bldg.',
    area: da ? 'Areal' : 'Area',
    rooms: da ? 'Værelser' : 'Rooms',
    address: da ? 'Adresse' : 'Address',
    floor: da ? 'Etage' : 'Floor',
    door: da ? 'Dør' : 'Door',
    housingType: da ? 'Boligtype' : 'Housing type',
    energySupply: da ? 'Energiforsyning' : 'Energy supply',
    bbrDataUnavailable: da ? 'BBR-data utilgængelig' : 'BBR data unavailable',
    bbrSubscriptionRequired: da
      ? 'BBR-data kræver et aktivt abonnement på BBRPublic-tjenesten på datafordeler.dk.'
      : 'BBR data requires an active subscription to the BBRPublic service on datafordeler.dk.',
    cadastreInfo: da ? 'Matrikeloplysninger' : 'Cadastre information',
    loadingCadastre: da ? 'Henter matrikeldata…' : 'Loading cadastre data…',
    agriculturalNote: da ? 'Landbrugsnotering' : 'Agricultural note',
    condominiums: da ? 'Ejerlejligheder' : 'Condominiums',
    dividedIntoCondominiums: da ? 'Opdelt i ejerlejligheder' : 'Divided into condominiums',
    commonLot: da ? 'Fælleslod' : 'Common lot',
    yes: da ? 'Ja' : 'Yes',
    separatedRoad: da ? 'Udskilt vej' : 'Separated road',
    parcels: da ? 'Jordstykker' : 'Parcels',
    noCadastreData: da ? 'Ingen matrikeldata fundet' : 'No cadastre data found',
    protectedForest: da ? 'Fredskov' : 'Protected forest',
    coastalProtection: da ? 'Strandbeskyttelse' : 'Coastal protection',
    duneProtection: da ? 'Klitfredning' : 'Dune protection',
    groundRent: da ? 'Jordrente' : 'Ground rent',
    road: da ? 'Vej' : 'Road',
  };

  return (
    <div className="space-y-3">
      {/* BIZZ-616: Specifik "Henter BBR-data…" label i stedet for generisk t.loading */}
      {bbrLoader && <TabLoadingSpinner label={t.loadingBBR} />}
      {bbrData?.bbrFejl && (
        <div className="p-3 bg-orange-500/10 border border-orange-500/20 rounded-lg">
          <p className="text-orange-300 text-sm">BBR: {bbrData.bbrFejl}</p>
        </div>
      )}

      {/* Information */}
      <div>
        <SectionTitle title={t.information} />
        {(() => {
          const grundareal = (dawaJordstykke?.areal_m2 || null) ?? vurdering?.vurderetAreal ?? null;
          const kommunenavn =
            (dawaAdresse.kommunenavn || null) ?? dawaJordstykke?.kommune.navn ?? null;
          return (
            <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
              <div className="flex items-center gap-3 px-3 py-2 text-xs">
                <MapIcon size={12} className="text-slate-500 flex-shrink-0" />
                <span className="text-slate-200 font-medium flex-shrink-0">
                  {dawaJordstykke?.matrikelnr ?? dawaAdresse.matrikelnr ?? '–'}
                </span>
                <span className="text-slate-500">·</span>
                <span className="text-slate-400 truncate flex-1">
                  {dawaJordstykke?.ejerlav.navn ?? '–'}
                </span>
                {kommunenavn && (
                  <>
                    <span className="text-slate-500">·</span>
                    <span className="text-slate-400 flex-shrink-0">{kommunenavn}</span>
                  </>
                )}
                {grundareal && (
                  <>
                    <span className="text-slate-500">·</span>
                    <span className="text-slate-300 flex-shrink-0 font-medium">
                      {grundareal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²
                    </span>
                  </>
                )}
              </div>
            </div>
          );
        })()}
      </div>

      {/* Bygninger — ekskluder nedrevne/historiske */}
      {(() => {
        const alleBygninger = bbrData?.bbr ?? [];
        const geodataIds = new Set((bbrData?.bygningPunkter ?? []).map((p) => p.id));
        // BIZZ-825: central udfaset-tjek
        const bygninger = alleBygninger
          .filter((b) => !isUdfasetStatusLabel(b.status))
          .sort((a, b) => (a.bygningsnr ?? 9999) - (b.bygningsnr ?? 9999));
        const totAreal = bygninger.reduce((s, b) => s + (b.samletBygningsareal ?? 0), 0);
        const boligAreal = bygninger.reduce((s, b) => s + (b.samletBoligareal ?? 0), 0);
        const erhvAreal = bygninger.reduce((s, b) => s + (b.samletErhvervsareal ?? 0), 0);
        const kaelderAreal = bygninger.reduce((s, b) => s + (b.kaelder ?? 0), 0);
        const tagetageAreal = bygninger.reduce((s, b) => s + (b.tagetage ?? 0), 0);
        return (
          <div>
            <SectionTitle title={t.buildings} />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
              <DataKort label={t.buildings} value={bbrLoader ? '…' : `${bygninger.length}`} />
              <DataKort
                label={t.buildingArea}
                value={totAreal ? `${totAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²` : '–'}
              />
              <DataKort
                label={t.residentialArea}
                value={
                  boligAreal ? `${boligAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²` : '0 m²'
                }
              />
              <DataKort
                label={t.commercialArea}
                value={erhvAreal ? `${erhvAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²` : '–'}
              />
              {/* BIZZ-487: Kælder vises kun når der er et areal > 0 */}
              {kaelderAreal > 0 && (
                <DataKort
                  label={t.basement}
                  value={`${kaelderAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`}
                />
              )}
              {/* BIZZ-487: Tagetage vises kun når der er et areal > 0 */}
              {tagetageAreal > 0 && (
                <DataKort
                  label={da ? 'Tagetage' : 'Attic'}
                  value={`${tagetageAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`}
                />
              )}
            </div>
            {bbrLoader ? (
              <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden animate-pulse">
                {[1, 2, 3].map((n) => (
                  <div
                    key={n}
                    className="px-3 py-2.5 border-b border-slate-700/20 flex items-center gap-3"
                  >
                    <div className="w-4 h-4 bg-slate-700/50 rounded" />
                    <div className="h-3 w-8 bg-slate-700/50 rounded" />
                    <div className="h-3 flex-1 bg-slate-700/30 rounded" />
                    <div className="h-3 w-12 bg-slate-700/40 rounded" />
                    <div className="h-3 w-16 bg-slate-700/40 rounded" />
                  </div>
                ))}
              </div>
            ) : bygninger.length === 0 ? (
              <div className="text-slate-500 text-sm text-center py-3">{t.noActiveBuildings}</div>
            ) : (
              <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden overflow-x-auto">
                {/* Kolonneheader: ▶ | Byg# | Anvendelse | Opf.år | Bebygget | Samlet | Geo | Status */}
                <div className="min-w-[700px] grid grid-cols-[28px_40px_1fr_68px_96px_96px_52px_90px] px-3 py-2 text-slate-500 text-xs font-medium border-b border-slate-700/30">
                  <span />
                  <span className="text-center">{t.nr}</span>
                  <span>{t.usage}</span>
                  <span className="text-right">{t.builtYear}</span>
                  <span className="text-right">{t.builtArea}</span>
                  <span className="text-right">{t.totalArea}</span>
                  <span className="text-center">{t.geodata}</span>
                  <span className="text-center">{t.status}</span>
                </div>
                {bygninger.map((b, i) => {
                  const rowId = b.id || String(i);
                  const aaben = expandedBygninger.has(rowId);
                  // BIZZ-485: Risk-badges for materiale-risici
                  const risks = b.risks ?? {
                    asbestTag: false,
                    asbestYdervaeg: false,
                    traeYdervaeg: false,
                  };
                  // BIZZ-486: Opgang/etage data for denne bygning
                  // BIZZ-825: central udfaset-tjek. '7' er midlertidig
                  // opførelse-kode som også filtreres fra opgang/etage-lister.
                  const bygOpgange = (bbrData?.opgange ?? []).filter(
                    (o) =>
                      o.bygningId === b.id && o.status !== '7' && !isUdfasetStatusLabel(o.status)
                  );
                  const bygEtager = (bbrData?.etager ?? []).filter(
                    (e) =>
                      e.bygningId === b.id && e.status !== '7' && !isUdfasetStatusLabel(e.status)
                  );
                  const harElevator = bygOpgange.some((o) => o.elevator === true);
                  const etageBetegnelser = [
                    ...new Set(bygEtager.map((e) => e.etagebetegnelse).filter(Boolean)),
                  ].join(', ');
                  const detaljer: [string, string][] = (
                    [
                      [t.outerWall, b.ydervaeg || null],
                      [
                        da ? 'Tagkonstruktion' : 'Roof construction',
                        b.tagkonstruktion && b.tagkonstruktion !== '–' ? b.tagkonstruktion : null,
                      ],
                      [t.roofMaterial, b.tagmateriale || null],
                      [t.heatingInstallation, b.varmeinstallation || null],
                      [t.heatingForm, b.opvarmningsform || null],
                      [t.supplementaryHeat, b.supplerendeVarme || null],
                      [t.waterSupply, b.vandforsyning || null],
                      [t.drainage, b.afloeb || null],
                      [t.floors, b.antalEtager != null ? `${b.antalEtager}` : null],
                      // BIZZ-486: Opgange + elevator
                      [
                        da ? 'Opgange' : 'Stairwells',
                        bygOpgange.length > 0
                          ? `${bygOpgange.length}${harElevator ? ` (${da ? 'med elevator' : 'with elevator'})` : ''}`
                          : null,
                      ],
                      // BIZZ-486: Etage-betegnelser
                      [da ? 'Etager (BBR)' : 'Floors (BBR)', etageBetegnelser || null],
                      [
                        'Boligareal',
                        b.samletBoligareal
                          ? `${b.samletBoligareal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                          : null,
                      ],
                      [
                        'Erhvervsareal',
                        b.samletErhvervsareal
                          ? `${b.samletErhvervsareal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                          : null,
                      ],
                      [
                        'Erhvervsenheder',
                        b.antalErhvervsenheder != null && b.antalErhvervsenheder > 0
                          ? `${b.antalErhvervsenheder}`
                          : null,
                      ],
                      [
                        da ? 'Ombygningsår' : 'Renovation year',
                        b.ombygningsaar != null ? `${b.ombygningsaar}` : null,
                      ],
                      [t.preservation, b.fredning || null],
                      [t.conservationValue, b.bevaringsvaerdighed || null],
                      // BIZZ-488: Revisionsdato
                      [
                        da ? 'Data sidst revideret' : 'Data last revised',
                        b.revisionsdato
                          ? new Date(b.revisionsdato).toLocaleDateString(da ? 'da-DK' : 'en-GB', {
                              year: 'numeric',
                              month: 'short',
                              day: 'numeric',
                            })
                          : null,
                      ],
                    ] as [string, string | null][]
                  ).filter((row): row is [string, string] => row[1] !== null);
                  return (
                    <div key={rowId} className="border-t border-slate-700/30 first:border-0">
                      <button
                        onClick={() =>
                          setExpandedBygninger((prev) => {
                            const next = new Set(prev);
                            if (aaben) {
                              next.delete(rowId);
                            } else {
                              next.add(rowId);
                            }
                            return next;
                          })
                        }
                        className="w-full min-w-[700px] grid grid-cols-[28px_40px_1fr_68px_96px_96px_52px_90px] px-3 py-1.5 text-sm hover:bg-slate-700/20 transition-colors text-left items-center"
                      >
                        {/* Chevron til venstre */}
                        <ChevronRight
                          size={14}
                          className={`text-slate-500 transition-transform flex-shrink-0 ${aaben ? 'rotate-90' : ''}`}
                        />
                        {/* Bygningsnummer */}
                        <span className="text-slate-500 text-xs text-center font-mono">
                          {b.bygningsnr ?? '–'}
                        </span>
                        <span className="text-slate-200 truncate pr-2 flex items-center gap-1.5">
                          <span className="truncate">{b.anvendelse || '–'}</span>
                          {/* BIZZ-485: Risk-badges — asbest har højeste prioritet (rød). */}
                          {/* BIZZ-485 v2: BBR's eksplicitte asbest-flag (byg036) */}
                          {risks.asbestEksplicit && !risks.asbestTag && !risks.asbestYdervaeg && (
                            <span
                              className="flex-shrink-0 text-[9px] px-1 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/30"
                              title={
                                da
                                  ? 'BBR har bekræftet asbestholdigt materiale (byg036)'
                                  : 'BBR confirmed asbestos-containing material (byg036)'
                              }
                            >
                              {da ? 'Asbest (BBR)' : 'Asbestos (BBR)'}
                            </span>
                          )}
                          {risks.asbestTag && (
                            <span
                              className="flex-shrink-0 text-[9px] px-1 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/30"
                              title={
                                da
                                  ? 'Asbest i tagmateriale (fibercement pre-1986)'
                                  : 'Asbestos in roof (pre-1986 fibre cement)'
                              }
                            >
                              {da ? 'Asbest tag' : 'Asbestos roof'}
                            </span>
                          )}
                          {risks.asbestYdervaeg && (
                            <span
                              className="flex-shrink-0 text-[9px] px-1 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/30"
                              title={
                                da
                                  ? 'Asbest i ydervæg (eternit pre-1986)'
                                  : 'Asbestos in outer wall (pre-1986 eternit)'
                              }
                            >
                              {da ? 'Asbest væg' : 'Asbestos wall'}
                            </span>
                          )}
                          {risks.traeYdervaeg &&
                            b.opfoerelsesaar != null &&
                            new Date().getFullYear() - b.opfoerelsesaar > 40 &&
                            !b.ombygningsaar && (
                              <span
                                className="flex-shrink-0 text-[9px] px-1 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20"
                                title={
                                  da
                                    ? 'Træydervæg uden kendt ombygning — tjek efterisolering'
                                    : 'Wooden exterior without known renovation — check insulation'
                                }
                              >
                                {da ? 'Ældre træ' : 'Old wood'}
                              </span>
                            )}
                          {/* BIZZ-488: Fredet og bevaringsværdig badge */}
                          {b.fredning ? (
                            <span
                              className="flex-shrink-0 text-[9px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30"
                              title={
                                da
                                  ? `Fredet bygning: ${b.fredning}`
                                  : `Protected building: ${b.fredning}`
                              }
                            >
                              {da ? 'Fredet' : 'Protected'}
                            </span>
                          ) : b.bevaringsvaerdighed ? (
                            <span
                              className="flex-shrink-0 text-[9px] px-1 py-0.5 rounded bg-purple-500/15 text-purple-300 border border-purple-500/30"
                              title={
                                da
                                  ? `Bevaringsværdig (SAVE): ${b.bevaringsvaerdighed}`
                                  : `Conservation value (SAVE): ${b.bevaringsvaerdighed}`
                              }
                            >
                              SAVE
                            </span>
                          ) : null}
                        </span>
                        <span className="text-slate-400 text-right">{b.opfoerelsesaar ?? '–'}</span>
                        <span className="text-slate-300 text-right">
                          {b.bebyggetAreal
                            ? `${b.bebyggetAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                            : formatDKK(0)}
                        </span>
                        <span className="text-slate-300 text-right">
                          {b.samletBygningsareal
                            ? `${b.samletBygningsareal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                            : formatDKK(0)}
                        </span>
                        {/* Geodata-status: grøn ✓ hvis koordinater kendes, rød ✗ hvis mangler */}
                        <span className="flex justify-center">
                          {geodataIds.has(b.id) ? (
                            <CheckCircle size={14} className="text-emerald-400" />
                          ) : (
                            <XCircle size={14} className="text-red-400" />
                          )}
                        </span>
                        {/* Status badge */}
                        <span className="flex justify-center">
                          {b.status == null || b.status.startsWith('Bygning opført') ? (
                            <span className="text-emerald-400 text-xs">{t.erected}</span>
                          ) : b.status === 'Projekteret bygning' ? (
                            <span className="text-amber-400 text-xs">{t.projected}</span>
                          ) : b.status === 'Bygning under opførelse' ? (
                            <span className="text-amber-400 text-xs">{t.underConstruction}</span>
                          ) : b.status === 'Midlertidig opførelse' ? (
                            <span className="text-amber-400 text-xs">{t.temporary}</span>
                          ) : b.status === 'Kondemneret' ? (
                            <span className="text-red-400 text-xs">{t.condemned}</span>
                          ) : (
                            <span className="text-slate-400 text-xs truncate">{b.status}</span>
                          )}
                        </span>
                      </button>
                      {aaben && detaljer.length > 0 && (
                        <div className="px-3 pb-2 bg-slate-900/40 border-t border-slate-700/20">
                          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs pt-2">
                            {detaljer.map(([lbl, val]) => (
                              <div key={lbl} className="flex justify-between gap-2">
                                <span className="text-slate-500">{lbl}</span>
                                <span className="text-slate-300 text-right">{val}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}

      {/* Enheder — kun summary-boksen, detaljelisten erstattes af Ejendomsstruktur */}
      {(() => {
        const enheder = bbrData?.enheder ?? [];
        const boligEnh = enheder.filter((e) => (e.arealBolig ?? 0) > 0).length;
        const erhvEnh = enheder.filter((e) => (e.arealErhverv ?? 0) > 0).length;
        const totAreal = enheder.reduce((s, e) => s + (e.areal ?? 0), 0);
        return (
          <div>
            <SectionTitle title={t.units} />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
              <DataKort label={t.totalUnits} value={bbrLoader ? '…' : `${enheder.length}`} />
              <DataKort label={t.residentialUnits} value={`${boligEnh}`} />
              <DataKort label={t.commercialUnits} value={`${erhvEnh}`} />
              <DataKort
                label={t.totalAreaLabel}
                value={totAreal ? `${totAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²` : '–'}
              />
            </div>
          </div>
        );
      })()}

      {/* Enheder-detaljeliste */}
      {(() => {
        const bygningsnrMap = new Map(
          (bbrData?.bygningPunkter ?? []).map((p) => [p.id, p.bygningsnr ?? 9999])
        );
        const enheder = (bbrData?.enheder ?? []).slice().sort((a, b) => {
          const nrA = a.bygningId ? (bygningsnrMap.get(a.bygningId) ?? 9999) : 9999;
          const nrB = b.bygningId ? (bygningsnrMap.get(b.bygningId) ?? 9999) : 9999;
          return nrA - nrB;
        });
        return (
          <div>
            {bbrLoader ? (
              <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden animate-pulse">
                {[1, 2].map((n) => (
                  <div
                    key={n}
                    className="px-3 py-2.5 border-b border-slate-700/20 flex items-center gap-3"
                  >
                    <div className="w-4 h-4 bg-slate-700/50 rounded" />
                    <div className="h-3 w-8 bg-slate-700/50 rounded" />
                    <div className="h-3 flex-1 bg-slate-700/30 rounded" />
                    <div className="h-3 w-14 bg-slate-700/40 rounded" />
                  </div>
                ))}
              </div>
            ) : enheder.length === 0 ? (
              <div className="text-slate-500 text-sm text-center py-3">{t.noUnitsAvailable}</div>
            ) : (
              <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden overflow-x-auto">
                {/* Kolonneheader: ▶ | Byg.nr | Anvendelse | Areal | Værelser */}
                <div className="min-w-[500px] grid grid-cols-[28px_44px_1fr_96px_72px] px-3 py-2 text-slate-500 text-xs font-medium border-b border-slate-700/30">
                  <span />
                  <span className="text-center">{t.bldg}</span>
                  <span>{t.usage}</span>
                  <span className="text-right">{t.area}</span>
                  <span className="text-right">{t.rooms}</span>
                </div>
                {enheder.map((e, i) => {
                  const rowId = e.id || String(i);
                  const aaben = expandedEnheder.has(rowId);
                  const bygningsnr = e.bygningId
                    ? ((bbrData?.bygningPunkter ?? []).find((p) => p.id === e.bygningId)
                        ?.bygningsnr ?? null)
                    : null;
                  const detaljer: [string, string][] = (
                    [
                      [t.address, e.adressebetegnelse || null],
                      [t.floor, e.etage || null],
                      [t.door, e.doer || null],
                      [t.housingType, e.boligtype || null],
                      [t.status, e.status || null],
                      [
                        'Boligareal',
                        e.arealBolig
                          ? `${e.arealBolig.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                          : null,
                      ],
                      [
                        'Erhvervsareal',
                        e.arealErhverv
                          ? `${e.arealErhverv.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                          : null,
                      ],
                      [
                        'Varmeinstallation',
                        e.varmeinstallation !== '–' ? e.varmeinstallation : null,
                      ],
                      [t.energySupply, e.energiforsyning || null],
                    ] as [string, string | null][]
                  ).filter((row): row is [string, string] => row[1] !== null);
                  return (
                    <div key={rowId} className="border-t border-slate-700/30 first:border-0">
                      <button
                        onClick={() =>
                          setExpandedEnheder((prev) => {
                            const next = new Set(prev);
                            if (aaben) {
                              next.delete(rowId);
                            } else {
                              next.add(rowId);
                            }
                            return next;
                          })
                        }
                        className="w-full min-w-[500px] grid grid-cols-[28px_44px_1fr_96px_72px] px-3 py-1.5 text-sm hover:bg-slate-700/20 transition-colors text-left items-center"
                      >
                        <ChevronRight
                          size={14}
                          className={`text-slate-500 transition-transform flex-shrink-0 ${aaben ? 'rotate-90' : ''}`}
                        />
                        <span className="text-slate-500 text-xs text-center font-mono">
                          {bygningsnr ?? '–'}
                        </span>
                        <span className="min-w-0 pr-2">
                          <span className="block text-slate-200 truncate">
                            {e.anvendelse || '–'}
                          </span>
                          {(e.etage || e.doer) && (
                            <span className="block text-slate-500 text-xs truncate">
                              {[e.etage && `${e.etage}.`, e.doer].filter(Boolean).join(' ')}
                            </span>
                          )}
                        </span>
                        <span className="text-slate-300 text-right">
                          {e.areal
                            ? `${e.areal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                            : formatDKK(0)}
                        </span>
                        <span className="text-slate-400 text-right">{e.vaerelser ?? '–'}</span>
                      </button>
                      {aaben && detaljer.length > 0 && (
                        <div className="px-3 pb-2 bg-slate-900/40 border-t border-slate-700/20">
                          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs pt-2">
                            {detaljer.map(([lbl, val]) => (
                              <div key={lbl} className="flex justify-between gap-2">
                                <span className="text-slate-500">{lbl}</span>
                                <span className="text-slate-300 text-right">{val}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}

      {/* Ingen BBR-data */}
      {!bbrLoader && !bbrData?.bbr && (
        <div className="bg-orange-500/8 border border-orange-500/20 rounded-xl p-5">
          <p className="text-orange-300 text-sm font-medium mb-1">{t.bbrDataUnavailable}</p>
          <p className="text-slate-400 text-xs leading-relaxed">
            {bbrData?.bbrFejl ?? t.bbrSubscriptionRequired}
          </p>
        </div>
      )}

      {/* BIZZ-484: Tekniske anlæg (solceller, varmepumper, oliefyr, tanke etc.) */}
      {!bbrLoader && bbrData?.tekniskeAnlaeg && bbrData.tekniskeAnlaeg.length > 0 && (
        <div className="mt-5">
          <SectionTitle title={da ? 'Tekniske anlæg' : 'Technical installations'} />
          <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
            <div className="divide-y divide-slate-700/30">
              {bbrData.tekniskeAnlaeg.map((anlaeg) => {
                const tekst = tekniskAnlaegTekst(anlaeg.tek020Klassifikation);
                const kategori = tekniskAnlaegKategori(anlaeg.tek020Klassifikation);
                const farve =
                  kategori === 'energi'
                    ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20'
                    : kategori === 'tank'
                      ? 'text-amber-300 bg-amber-500/10 border-amber-500/20'
                      : 'text-slate-300 bg-slate-700/30 border-slate-600/30';
                return (
                  <div
                    key={anlaeg.id_lokalId}
                    className="px-4 py-2.5 flex items-center justify-between gap-3"
                  >
                    <span className="text-slate-200 text-sm">{tekst}</span>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${farve}`}
                    >
                      {kategori === 'energi'
                        ? da
                          ? 'Energi'
                          : 'Energy'
                        : kategori === 'tank'
                          ? da
                            ? 'Tank'
                            : 'Tank'
                          : da
                            ? 'Andet'
                            : 'Other'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── Matrikeloplysninger (Datafordeler MAT) ── */}
      <div className="mt-5">
        <SectionTitle title={t.cadastreInfo} />
        {matrikelLoader ? (
          <SektionLoader label={t.loadingCadastre} rows={3} />
        ) : matrikelData ? (
          <div className="space-y-3">
            {/* Ejendomsinfo */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {matrikelData.landbrugsnotering && (
                <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3">
                  <p className="text-slate-400 text-xs mb-0.5">{t.agriculturalNote}</p>
                  <p className="text-white text-sm font-medium">{matrikelData.landbrugsnotering}</p>
                </div>
              )}
              {matrikelData.opdeltIEjerlejligheder && (
                <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3">
                  <p className="text-slate-400 text-xs mb-0.5">{t.condominiums}</p>
                  <p className="text-white text-sm font-medium">{t.dividedIntoCondominiums}</p>
                </div>
              )}
              {matrikelData.erFaelleslod && (
                <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3">
                  <p className="text-slate-400 text-xs mb-0.5">{t.commonLot}</p>
                  <p className="text-white text-sm font-medium">{t.yes}</p>
                </div>
              )}
              {matrikelData.udskiltVej && (
                <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3">
                  <p className="text-slate-400 text-xs mb-0.5">{t.separatedRoad}</p>
                  <p className="text-white text-sm font-medium">{t.yes}</p>
                </div>
              )}
            </div>

            {/* Jordstykker tabel */}
            {matrikelData.jordstykker.length > 0 && (
              <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-hidden overflow-x-auto">
                <div className="px-4 py-2.5 border-b border-slate-700/30">
                  <p className="text-slate-300 text-xs font-semibold uppercase tracking-wider">
                    {t.parcels} ({matrikelData.jordstykker.length})
                  </p>
                </div>
                <div className="divide-y divide-slate-700/20">
                  {matrikelData.jordstykker.map((js) => (
                    <div
                      key={js.id}
                      className="min-w-[450px] px-4 py-2.5 grid grid-cols-[1fr_100px_80px_auto] gap-3 items-center"
                    >
                      <div>
                        <p className="text-white text-sm font-medium">
                          {da ? 'Matr.nr.' : 'Cad. no.'} {js.matrikelnummer}
                          {js.ejerlavskode && (
                            <span className="text-slate-500 text-xs ml-2">
                              {da ? 'Ejerlav' : 'District'} {js.ejerlavskode}
                            </span>
                          )}
                        </p>
                        {js.ejerlavsnavn && (
                          <p className="text-slate-500 text-xs">{js.ejerlavsnavn}</p>
                        )}
                        {/* BIZZ-499: Vis arealtype fra MAT */}
                        {js.arealtype && (
                          <p className="text-slate-500 text-[10px]">
                            {da ? 'Arealtype' : 'Area type'}: {js.arealtype}
                          </p>
                        )}
                      </div>
                      <p className="text-slate-300 text-sm tabular-nums text-right">
                        {js.registreretAreal != null
                          ? `${js.registreretAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                          : formatDKK(0)}
                      </p>
                      <p className="text-slate-500 text-xs text-right">
                        {js.vejareal != null && js.vejareal > 0
                          ? `${t.road}: ${js.vejareal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                          : ''}
                      </p>
                      <div className="flex gap-1.5 flex-wrap justify-end">
                        {js.fredskov === true && (
                          <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-green-900/50 text-green-400 border border-green-800/40">
                            {t.protectedForest}
                          </span>
                        )}
                        {js.strandbeskyttelse === true && (
                          <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-blue-900/50 text-blue-400 border border-blue-800/40">
                            {t.coastalProtection}
                          </span>
                        )}
                        {js.klitfredning === true && (
                          <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-amber-900/50 text-amber-400 border border-amber-800/40">
                            {t.duneProtection}
                          </span>
                        )}
                        {js.jordrente === true && (
                          <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-purple-900/50 text-purple-400 border border-purple-800/40">
                            {t.groundRent}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── BIZZ-500: Matrikel-historik (collapsible tidslinje) ── */}
            <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-hidden">
              <button
                type="button"
                onClick={() => setHistorikOpen((prev) => !prev)}
                className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-slate-700/20 transition-colors"
                aria-expanded={historikOpen}
              >
                <span className="text-slate-300 text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5">
                  <Clock size={12} className="text-slate-500" />
                  {da ? 'Matrikel-historik' : 'Cadastre history'}
                </span>
                {historikOpen ? (
                  <ChevronDown size={14} className="text-slate-500" />
                ) : (
                  <ChevronRight size={14} className="text-slate-500" />
                )}
              </button>
              {historikOpen && (
                <div className="px-4 pb-4 border-t border-slate-700/20">
                  {historikLoader ? (
                    <div className="py-4 text-center">
                      <div className="inline-block w-4 h-4 border-2 border-slate-600 border-t-blue-400 rounded-full animate-spin" />
                      <p className="text-slate-500 text-xs mt-2">
                        {da ? 'Henter historik…' : 'Loading history…'}
                      </p>
                    </div>
                  ) : matrikelHistorik.length > 0 ? (
                    <div className="relative mt-3">
                      <div className="absolute left-[7px] top-2 bottom-2 w-px bg-slate-700/50" />
                      <div className="space-y-4">
                        {matrikelHistorik.map((evt, idx) => {
                          const typeColor =
                            {
                              oprettelse: 'bg-green-500',
                              udstykning: 'bg-orange-500',
                              sammenlægning: 'bg-blue-500',
                              arealændring: 'bg-yellow-500',
                              statusændring: 'bg-purple-500',
                            }[evt.type] ?? 'bg-slate-500';
                          const typeLabel = da
                            ? {
                                oprettelse: 'Oprettet',
                                udstykning: 'Udstykning',
                                sammenlægning: 'Sammenlægning',
                                arealændring: 'Arealændring',
                                statusændring: 'Statusændring',
                              }[evt.type]
                            : {
                                oprettelse: 'Created',
                                udstykning: 'Subdivision',
                                sammenlægning: 'Merger',
                                arealændring: 'Area change',
                                statusændring: 'Status change',
                              }[evt.type];
                          const formattedDate = (() => {
                            try {
                              return new Date(evt.dato).toLocaleDateString(da ? 'da-DK' : 'en-GB', {
                                year: 'numeric',
                                month: 'short',
                                day: 'numeric',
                              });
                            } catch {
                              return evt.dato;
                            }
                          })();
                          return (
                            <div key={`${evt.dato}-${evt.type}-${idx}`} className="relative pl-6">
                              <div
                                className={`absolute left-0.5 top-1 w-3 h-3 rounded-full border-2 border-slate-900 ${typeColor}`}
                              />
                              <div>
                                <div className="flex items-center gap-2 mb-0.5">
                                  <span className="text-slate-400 text-[10px] tabular-nums">
                                    {formattedDate}
                                  </span>
                                  <span
                                    className={`px-1.5 py-0.5 text-[10px] font-semibold rounded ${typeColor}/20 text-white/80`}
                                  >
                                    {typeLabel}
                                  </span>
                                </div>
                                <p className="text-slate-300 text-xs">{evt.beskrivelse}</p>
                                {evt.detaljer && (
                                  <div className="mt-1 text-[10px] text-slate-500 space-y-0.5">
                                    {evt.detaljer.arealFoer != null &&
                                      evt.detaljer.arealEfter != null && (
                                        <p>
                                          {da ? 'Areal' : 'Area'}:{' '}
                                          {evt.detaljer.arealFoer.toLocaleString(
                                            da ? 'da-DK' : 'en-GB'
                                          )}{' '}
                                          m² →{' '}
                                          {evt.detaljer.arealEfter.toLocaleString(
                                            da ? 'da-DK' : 'en-GB'
                                          )}{' '}
                                          m²
                                        </p>
                                      )}
                                    {evt.detaljer.jordstykkerFoer &&
                                      evt.detaljer.jordstykkerEfter && (
                                        <p>
                                          {da ? 'Jordstykker' : 'Parcels'}:{' '}
                                          {evt.detaljer.jordstykkerFoer.join(', ')} →{' '}
                                          {evt.detaljer.jordstykkerEfter.join(', ')}
                                        </p>
                                      )}
                                    {evt.detaljer.forretningshaendelse && (
                                      <p className="italic">{evt.detaljer.forretningshaendelse}</p>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <p className="py-3 text-slate-500 text-xs text-center">
                      {da
                        ? 'Ingen historik fundet for denne ejendom'
                        : 'No history found for this property'}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="bg-slate-800/30 border border-slate-700/40 rounded-xl p-4 text-center">
            <p className="text-slate-500 text-xs">{t.noCadastreData}</p>
          </div>
        )}
      </div>

      {/* BIZZ-1079: Byggeaktivitet flyttet hertil fra Økonomi-tab */}
      {kommunekode && <ByggeaktivitetBadge kommunekode={kommunekode} lang={lang} />}

      {/* BIZZ-1018: Skråfoto flyttet hertil fra Oversigt-tab */}
      <SkraafotoGalleri lat={dawaAdresse?.y ?? null} lng={dawaAdresse?.x ?? null} lang={lang} />
    </div>
  );
}
