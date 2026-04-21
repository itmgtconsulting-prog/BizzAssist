/**
 * EjendomDokumenterTab — Dokumenter-fane på ejendoms-detaljesiden.
 *
 * Viser:
 *   - Stamdokumenter: BBR-meddelelse, jordforureningsattest, matrikelkort, fredet bygning
 *   - Planer (lokalplaner + delområder) med detalje-dropdown + PDF-links
 *   - Energimærker fra EMO med gyldighed-status og PDF-download
 *   - ZIP-download af udvalgte dokumenter via checkboxes
 *
 * BIZZ-657: Extraheret fra EjendomDetaljeClient.tsx. Ren filopdeling — ingen
 * logik-/adfærds-ændring. State + handleDownloadZip forbliver i parent (tæt
 * koblet til dawaAdresse/ejendom) og er passed som callbacks.
 *
 * @module app/dashboard/ejendomme/[id]/tabs/EjendomDokumenterTab
 */

'use client';

import { ChevronRight, Download, FileText, Map as MapIcon, Zap } from 'lucide-react';
import TabLoadingSpinner from '@/app/components/TabLoadingSpinner';
import type { EjendomApiResponse } from '@/app/api/ejendom/[id]/route';
import type { PlandataItem } from '@/app/api/plandata/route';
import type { EnergimaerkeItem } from '@/app/api/energimaerke/route';
import type { JordParcelItem } from '@/app/api/jord/route';
import type { DawaAdresse } from '@/app/lib/dawa';

interface Props {
  /** 'da' | 'en' — bilingual */
  lang: 'da' | 'en';
  /** Loadere per datakilde */
  plandataLoader: boolean;
  energiLoader: boolean;
  jordLoader: boolean;
  /** BBR-data (til BFE, matrikel, moderBfe til ejerlejlighed-note) */
  bbrData: EjendomApiResponse | null;
  /** DAWA-adresse (til moderejendom-advarsel på ejerlejligheder) */
  dawaAdresse: DawaAdresse | null;
  /** Plandata med errors/empty-states */
  plandata: PlandataItem[] | null;
  plandataFejl: string | null;
  /** Energimærker med errors/manglende-adgang */
  energimaerker: EnergimaerkeItem[] | null;
  energiFejl: string | null;
  energiManglerAdgang: boolean;
  /** Jordforurening */
  jordData: JordParcelItem[] | null;
  jordIngenData: boolean;
  jordFejl: string | null;
  /** Valgte-dokumenter checkbox-state (Set af dok-IDs) */
  valgteDoc: Set<string>;
  /** Toggler et dokument i valg-listen */
  toggleDoc: (docId: string) => void;
  /** Trigger ZIP-download af alle valgte */
  handleDownloadZip: () => void;
  /** true mens ZIP-filen genereres */
  zipLoader: boolean;
  /** Udvidet-state for planer-detaljepanel */
  expandedPlaner: Set<string>;
  setExpandedPlaner: React.Dispatch<React.SetStateAction<Set<string>>>;
  /** Udvidet-state for jord-detaljepanel */
  expandedJord: Set<string>;
  setExpandedJord: React.Dispatch<React.SetStateAction<Set<string>>>;
}

/** Render Dokumenter-fanen. Ren præsentations-komponent — alt state/data i props. */
export default function EjendomDokumenterTab(props: Props) {
  const {
    lang,
    plandataLoader,
    energiLoader,
    jordLoader,
    bbrData,
    dawaAdresse,
    plandata,
    plandataFejl,
    energimaerker,
    energiFejl,
    energiManglerAdgang,
    jordData,
    jordIngenData,
    jordFejl,
    valgteDoc,
    toggleDoc,
    handleDownloadZip,
    zipLoader,
    expandedPlaner,
    setExpandedPlaner,
    expandedJord,
    setExpandedJord,
  } = props;
  const da = lang === 'da';

  // ─── Translations — afgrænset til Dokumenter-fanen ────────────────────────
  const t = {
    loadingDokumenter: da ? 'Henter dokumenter…' : 'Loading documents…',
    documents: da ? 'Dokumenter' : 'Documents',
    loading: da ? 'Henter…' : 'Loading…',
    selectDocsToDownload: da
      ? 'Vælg dokumenter med checkboks for at downloade'
      : 'Select documents with checkbox to download',
    downloadSelected: da ? 'Download valgte' : 'Download selected',
    bbrNotice: da ? 'BBR-meddelelse' : 'BBR notice',
    soilContamination: da ? 'Jordforureningsattest' : 'Soil contamination certificate',
    notMapped: da ? 'Ikke kortlagt' : 'Not mapped',
    cadastreMap: da ? 'Matrikelkort' : 'Cadastre map',
    slotsOgKultur: da ? 'Slots- og Kulturstyrelsen' : 'Agency for Culture and Palaces',
    protectedBuilding: da ? 'Fredet bygning' : 'Protected building',
    noPlansFound: da ? 'Ingen planer fundet for denne adresse' : 'No plans found for this address',
    generalUsage: da ? 'Generel anvendelse' : 'General usage',
    subAreaNo: da ? 'Delområdenummer' : 'Sub-area number',
    maxBuildingCoverage: da ? 'Maks. bebyggelsesprocent' : 'Max. building coverage',
    maxFloors: da ? 'Maks. antal etager' : 'Max. floors',
    maxBuildingHeight: da ? 'Maks. bygningshøjde' : 'Max. building height',
    minPlotSubdivision: da
      ? 'Min. grundstørrelse ved udstykning'
      : 'Min. plot size for subdivision',
    proposalDate: da ? 'Forslagsdato' : 'Proposal date',
    approvalDate: da ? 'Vedtagelsesdato' : 'Approval date',
    effectiveDate: da ? 'Dato trådt i kraft' : 'Effective date',
    startDate: da ? 'Startdato' : 'Start date',
    endDate: da ? 'Slutdato' : 'End date',
    noAdditionalDetails: da
      ? 'Ingen yderligere detaljer tilgængelige'
      : 'No additional details available',
    energyReports: da ? 'Energimærkerapporter' : 'Energy label reports',
    noEnergyLabels: da
      ? 'Ingen energimærker registreret for denne ejendom'
      : 'No energy labels registered for this property',
    buildingLabel: da ? 'Bygning' : 'Building',
    buildingsLabel: da ? 'bygninger' : 'buildings',
    mappingStatus: da ? 'Kortlægningsstatus' : 'Mapping status',
    nuance: da ? 'Nuancering' : 'Nuance',
    locationRef: da ? 'Lokationsreference' : 'Location reference',
    location: da ? 'Lokation' : 'Location',
    otherLocations: da ? 'Øvrige lokationer' : 'Other locations',
    reevalDate: da ? 'Genvurderingsdato' : 'Re-evaluation date',
    lastModified: da ? 'Senest ændret' : 'Last modified',
    cadastreLabel: da ? 'Matrikel' : 'Cadastre',
    region: da ? 'Region' : 'Region',
    municipalityCode: da ? 'Kommunekode' : 'Municipality code',
    housingStatement: da ? 'Boligudtalelse' : 'Housing statement',
  };

  return (
    <div className="space-y-2">
      {/* BIZZ-616: Tab-level loading indicator når plan/energi/jord data hentes */}
      {(plandataLoader || energiLoader || jordLoader) && (
        <TabLoadingSpinner label={t.loadingDokumenter} />
      )}
      {/* ── Dokumenter (samlet kort) ── */}
      <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-x-auto">
        {/* Kort-header */}
        <div className="px-4 py-2.5 border-b border-slate-700/30 flex items-center gap-2">
          <FileText size={15} className="text-slate-400" />
          <span className="text-sm font-semibold text-slate-200">{t.documents}</span>
          {(plandataLoader || energiLoader || jordLoader) && (
            <span className="ml-2 text-xs text-slate-500 animate-pulse">{t.loading}</span>
          )}
          {/* Download-knap — højrestillet */}
          <button
            onClick={handleDownloadZip}
            disabled={valgteDoc.size === 0 || zipLoader}
            className="ml-auto flex items-center gap-1.5 px-3 py-1 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed border border-slate-600 rounded-lg text-slate-300 text-xs font-medium transition-all"
            title={
              valgteDoc.size === 0
                ? t.selectDocsToDownload
                : `${t.downloadSelected} (${valgteDoc.size}) ZIP`
            }
          >
            {zipLoader ? (
              <>
                <span className="w-3 h-3 border border-slate-400 border-t-transparent rounded-full animate-spin" />
                {t.loading}
              </>
            ) : (
              <>
                <Download size={12} />
                {t.downloadSelected} ({valgteDoc.size})
              </>
            )}
          </button>
        </div>

        {/* ── {t.standardDocs} subsection ── */}
        {(() => {
          const rel = bbrData?.ejendomsrelationer?.[0];
          const bfeNummer = rel?.bfeNummer;
          // PDF-link åbner Miljøportalens viewer i browser; ZIP-download bruger /api/jord/pdf proxy der fetcher /report/generate direkte
          const rapportUrl =
            rel?.ejerlavKode && rel?.matrikelnr
              ? `https://jord.miljoeportal.dk/report?elav=${rel.ejerlavKode}&matrnr=${encodeURIComponent(rel.matrikelnr)}`
              : null;

          const jordItem = jordData?.[0] ?? null;
          const jordIsV2 =
            jordItem?.pollutionStatusCodeValue === '08' ||
            jordItem?.pollutionStatusCodeValue === '13';
          const jordIsV1 = jordItem?.pollutionStatusCodeValue === '07';
          const jordIsUdgaaet =
            jordItem?.pollutionStatusCodeValue === '16' ||
            jordItem?.pollutionStatusCodeValue === '17';
          const jordStatusKlasse = jordIsV2
            ? 'bg-red-500/15 text-red-400'
            : jordIsV1
              ? 'bg-amber-500/15 text-amber-400'
              : jordIsUdgaaet
                ? 'bg-slate-700/40 text-slate-400'
                : 'bg-orange-500/15 text-orange-400';

          const formatDato = (iso: string | null) =>
            iso
              ? new Date(iso).toLocaleDateString(da ? 'da-DK' : 'en-GB', {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                })
              : null;

          const jordDetaljer = jordItem
            ? [
                jordItem.pollutionStatusText && {
                  label: t.mappingStatus,
                  value: `${jordItem.pollutionStatusCodeValue} — ${jordItem.pollutionStatusText}`,
                },
                jordItem.pollutionNuanceStatus.length > 0 && {
                  label: t.nuance,
                  value: jordItem.pollutionNuanceStatus.join(', '),
                },
                jordItem.locationReferences.length > 0 && {
                  label: t.locationRef,
                  value: jordItem.locationReferences.join(', '),
                },
                jordItem.locationNames.length > 0 && {
                  label: t.location,
                  value: jordItem.locationNames[0],
                },
                jordItem.locationNames.length > 1 && {
                  label: t.otherLocations,
                  value: jordItem.locationNames.slice(1).join(' · '),
                },
                formatDato(jordItem.recalculationDate) && {
                  label: t.reevalDate,
                  value: formatDato(jordItem.recalculationDate)!,
                },
                formatDato(jordItem.modifiedDate) && {
                  label: t.lastModified,
                  value: formatDato(jordItem.modifiedDate)!,
                },
                {
                  label: t.cadastreLabel,
                  value: `${jordItem.landParcelIdentifier} (ejerlav ${jordItem.cadastralDistrictIdentifier})`,
                },
                jordItem.regionNavn && { label: t.region, value: jordItem.regionNavn },
                jordItem.municipalityCode && {
                  label: t.municipalityCode,
                  value: String(jordItem.municipalityCode),
                },
                jordItem.housingStatementIndicator && {
                  label: t.housingStatement,
                  value: 'Ja',
                },
              ].filter((r): r is { label: string; value: string } => Boolean(r))
            : [];

          const jordErUdvidet = jordItem ? expandedJord.has(jordItem.id) : false;

          return (
            <div className="border-b border-slate-700/30">
              {/* Kolonneheader — identisk med plan-tabellen */}
              <div className="min-w-[500px] grid grid-cols-[28px_72px_1fr_120px_80px] gap-x-3 px-4 py-1.5 border-b border-slate-700/20">
                <span />
                <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                  {da ? 'År' : 'Year'}
                </span>
                <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                  {da ? 'Dokument' : 'Document'}
                </span>
                <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                  Status
                </span>
                <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                  {da ? 'Dok.' : 'Doc.'}
                </span>
              </div>

              {/* BBR-meddelelse */}
              <div className="min-w-[500px] grid grid-cols-[28px_72px_1fr_120px_80px] gap-x-3 px-4 py-2 border-b border-slate-700/15 hover:bg-slate-700/10 transition-colors items-start">
                <span />
                <span className="text-sm text-slate-300 tabular-nums">
                  {(() => {
                    const datoer = (bbrData?.bbr ?? [])
                      .map((b) => b.revisionsdato)
                      .filter((d): d is string => !!d);
                    if (!datoer.length) return '—';
                    return Math.max(...datoer.map((d) => new Date(d).getFullYear()));
                  })()}
                </span>
                <div>
                  <span className="text-sm text-slate-200">{t.bbrNotice}</span>
                </div>
                <span />
                <div className="flex items-center gap-1.5 self-start">
                  {bfeNummer ? (
                    <a
                      href={`https://bbr.dk/pls/wwwdata/get_newois_pck.show_bbr_meddelelse_pdf?i_bfe=${bfeNummer}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                    >
                      <FileText size={11} />
                      PDF
                    </a>
                  ) : (
                    <span className="text-slate-600 text-xs">—</span>
                  )}
                  {bfeNummer && (
                    <label
                      className="flex items-center cursor-pointer flex-shrink-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={valgteDoc.has('std-3')}
                        onChange={() => toggleDoc('std-3')}
                      />
                      <span
                        className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${valgteDoc.has('std-3') ? 'bg-blue-500 border-blue-500' : 'bg-[#0a1020] border-slate-400'}`}
                      >
                        {valgteDoc.has('std-3') && (
                          <svg
                            viewBox="0 0 10 10"
                            className="w-2 h-2 text-white"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                          >
                            <path d="M1.5 5.5l2.5 2.5 4.5-4.5" />
                          </svg>
                        )}
                      </span>
                    </label>
                  )}
                </div>
              </div>

              {/* Jordforureningsattest */}
              <div>
                <div
                  className="min-w-[500px] grid grid-cols-[28px_72px_1fr_120px_80px] gap-x-3 px-4 py-2 hover:bg-slate-700/10 transition-colors cursor-pointer items-start"
                  onClick={() => {
                    if (!jordItem) return;
                    setExpandedJord((prev) => {
                      const next = new Set(prev);
                      if (next.has(jordItem.id)) next.delete(jordItem.id);
                      else next.add(jordItem.id);
                      return next;
                    });
                  }}
                >
                  <ChevronRight
                    size={14}
                    className={`text-slate-500 mt-0.5 transition-transform flex-shrink-0 ${!jordItem ? 'opacity-0' : ''} ${jordErUdvidet ? 'rotate-90' : ''}`}
                  />
                  <span className="text-sm text-slate-300 tabular-nums">
                    {jordItem?.modifiedDate ? new Date(jordItem.modifiedDate).getFullYear() : '—'}
                  </span>
                  <div>
                    <span className="text-sm text-slate-200">{t.soilContamination}</span>
                    {jordLoader && (
                      <p className="text-xs text-slate-500 mt-0.5 animate-pulse">{t.loading}</p>
                    )}
                  </div>
                  {/* Status — alignet med plan-status kolonnen */}
                  <div className="self-start">
                    {!jordLoader && jordIngenData && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-500/15 text-emerald-400">
                        {t.notMapped}
                      </span>
                    )}
                    {!jordLoader && jordItem && (
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${jordStatusKlasse}`}
                      >
                        {jordItem.pollutionStatusText ?? jordItem.pollutionStatusCodeValue}
                      </span>
                    )}
                    {jordFejl && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-500/15 text-red-400">
                        Fejl
                      </span>
                    )}
                  </div>
                  {/* PDF-link + checkbox — URL peger på intern /api/jord/pdf der konverterer via Puppeteer */}
                  <div className="flex items-center gap-1.5 self-start">
                    {rapportUrl ? (
                      <a
                        href={rapportUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                      >
                        <FileText size={11} />
                        PDF
                      </a>
                    ) : (
                      <span className="text-slate-600 text-xs">—</span>
                    )}
                    {rapportUrl && (
                      <label
                        className="flex items-center cursor-pointer flex-shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={valgteDoc.has('std-7')}
                          onChange={() => toggleDoc('std-7')}
                        />
                        <span
                          className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${valgteDoc.has('std-7') ? 'bg-blue-500 border-blue-500' : 'bg-[#0a1020] border-slate-400'}`}
                        >
                          {valgteDoc.has('std-7') && (
                            <svg
                              viewBox="0 0 10 10"
                              className="w-2 h-2 text-white"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                            >
                              <path d="M1.5 5.5l2.5 2.5 4.5-4.5" />
                            </svg>
                          )}
                        </span>
                      </label>
                    )}
                  </div>
                </div>

                {/* Detaljepanel */}
                {jordErUdvidet && jordDetaljer.length > 0 && (
                  <div className="ml-10 mr-4 mb-2 bg-slate-800/40 rounded-lg border border-slate-700/30 overflow-hidden">
                    <div className="divide-y divide-slate-700/20">
                      {jordDetaljer.map((r) => (
                        <div key={r.label} className="grid grid-cols-[180px_1fr] px-3 py-1 text-xs">
                          <span className="text-slate-500">{r.label}</span>
                          <span className="text-slate-300">{r.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Matrikelkort */}
              {(() => {
                const rel = bbrData?.ejendomsrelationer?.[0];
                const downloadUrl =
                  rel?.ejerlavKode && rel?.matrikelnr
                    ? `/api/matrikelkort?ejerlavKode=${rel.ejerlavKode}&matrikelnr=${encodeURIComponent(rel.matrikelnr)}`
                    : null;
                return (
                  <div className="min-w-[500px] grid grid-cols-[28px_72px_1fr_120px_80px] gap-x-3 px-4 py-2 border-b border-slate-700/15 hover:bg-slate-700/10 transition-colors items-start">
                    <span />
                    <span className="text-sm text-slate-300 tabular-nums">—</span>
                    <div>
                      <span className="text-sm text-slate-200">{t.cadastreMap}</span>
                    </div>
                    <span />
                    <div className="flex items-center gap-1.5 self-start">
                      {downloadUrl ? (
                        <a
                          href={downloadUrl}
                          download
                          className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                        >
                          <FileText size={11} />
                          PDF
                        </a>
                      ) : (
                        <span className="text-slate-600 text-xs">—</span>
                      )}
                      {downloadUrl && (
                        <label className="flex items-center cursor-pointer flex-shrink-0">
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={valgteDoc.has('std-5')}
                            onChange={() => toggleDoc('std-5')}
                          />
                          <span
                            className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${valgteDoc.has('std-5') ? 'bg-blue-500 border-blue-500' : 'bg-[#0a1020] border-slate-400'}`}
                          >
                            {valgteDoc.has('std-5') && (
                              <svg
                                viewBox="0 0 10 10"
                                className="w-2 h-2 text-white"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                              >
                                <path d="M1.5 5.5l2.5 2.5 4.5-4.5" />
                              </svg>
                            )}
                          </span>
                        </label>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* Fredet bygning — kun hvis BBR har fredningsdata */}
              {bbrData?.bbr?.some((b) => b.fredning) && (
                <div className="min-w-[500px] grid grid-cols-[28px_72px_1fr_120px_80px] gap-x-3 px-4 py-2 border-b border-slate-700/15 hover:bg-slate-700/10 transition-colors items-start">
                  <span />
                  <span className="text-sm text-slate-300 tabular-nums">—</span>
                  <div>
                    <span className="text-sm text-slate-200">{t.slotsOgKultur}</span>
                    <p className="text-xs text-slate-500 mt-0.5">{t.protectedBuilding}</p>
                  </div>
                  <span className="inline-flex items-center self-start px-2 py-0.5 rounded text-xs font-medium bg-amber-500/15 text-amber-400">
                    Fredet
                  </span>
                  <a
                    href="https://www.kulturarv.dk/fbb/offentligbygningsoeg.pub?public=true"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors self-start"
                  >
                    <FileText size={11} />
                    PDF
                  </a>
                </div>
              )}
            </div>
          );
        })()}

        {/* ── Planer subsection ── */}
        <div className="border-b border-slate-700/30">
          <div className="px-4 py-2 flex items-center gap-2">
            <MapIcon size={13} className="text-slate-500" />
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
              Planer
            </span>
          </div>

          {plandataFejl && <div className="px-4 py-2 text-xs text-red-400">{plandataFejl}</div>}

          {!plandataLoader && !plandataFejl && (!plandata || plandata.length === 0) && (
            <div className="px-4 py-3 text-center text-slate-500 text-xs">{t.noPlansFound}</div>
          )}

          {plandata && plandata.length > 0 && (
            <div>
              {/* Header */}
              <div className="min-w-[500px] grid grid-cols-[28px_72px_1fr_120px_80px] gap-x-3 px-4 py-2 border-b border-slate-700/20">
                <span />
                <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                  {da ? 'År' : 'Year'}
                </span>
                <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                  {da ? 'Type' : 'Type'}
                </span>
                <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                  Status
                </span>
                <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                  {da ? 'Dok.' : 'Doc.'}
                </span>
              </div>

              {/* Rows — lokalplaner med samme doklink som et delområde vises ikke
                da delområdet er mere specifikt og deler samme PDF-dokument */}
              {(() => {
                const lokalplanDoklinks = new Set(
                  plandata.filter((p) => p.type === 'Lokalplan' && p.doklink).map((p) => p.doklink!)
                );
                const synligePlaner = plandata.filter(
                  (p) => !(p.type === 'Delområde' && p.doklink && lokalplanDoklinks.has(p.doklink))
                );
                return synligePlaner;
              })().map((plan, i) => {
                const rowKey = `${plan.type}-${plan.id}-${i}`;
                const erUdvidet = expandedPlaner.has(rowKey);

                const statusColor =
                  plan.status === 'Vedtaget'
                    ? 'bg-emerald-500/15 text-emerald-400'
                    : plan.status === 'Forslag'
                      ? 'bg-amber-500/15 text-amber-400'
                      : 'bg-red-500/15 text-red-400';

                // Byg detaljefelt-liste — kun vis felter med værdier
                const d = plan.detaljer;
                const detaljeRækker: { label: string; value: string }[] = [
                  d.anvendelse && { label: t.generalUsage, value: d.anvendelse },
                  d.delnr && { label: t.subAreaNo, value: d.delnr },
                  d.bebygpct && {
                    label: t.maxBuildingCoverage,
                    value: `${d.bebygpct} %`,
                  },
                  d.maxetager && {
                    label: t.maxFloors,
                    value: String(d.maxetager),
                  },
                  d.maxbygnhjd && {
                    label: t.maxBuildingHeight,
                    value: `${d.maxbygnhjd} m`,
                  },
                  d.minuds && {
                    label: t.minPlotSubdivision,
                    value: `${d.minuds.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`,
                  },
                  d.datoforsl && { label: t.proposalDate, value: d.datoforsl },
                  d.datovedt && { label: t.approvalDate, value: d.datovedt },
                  d.datoikraft && { label: t.effectiveDate, value: d.datoikraft },
                  d.datostart && { label: t.startDate, value: d.datostart },
                  d.datoslut && { label: t.endDate, value: d.datoslut },
                ].filter((r): r is { label: string; value: string } => Boolean(r));

                return (
                  <div key={rowKey} className="border-b border-slate-700/15 last:border-b-0">
                    {/* Hoved-række */}
                    <div
                      className="min-w-[500px] grid grid-cols-[28px_72px_1fr_120px_80px] gap-x-3 px-4 py-2 hover:bg-slate-700/10 transition-colors cursor-pointer items-start"
                      onClick={() =>
                        setExpandedPlaner((prev) => {
                          const next = new Set(prev);
                          if (next.has(rowKey)) next.delete(rowKey);
                          else next.add(rowKey);
                          return next;
                        })
                      }
                    >
                      <ChevronRight
                        size={14}
                        className={`text-slate-500 mt-0.5 transition-transform flex-shrink-0 ${erUdvidet ? 'rotate-90' : ''}`}
                      />
                      <span className="text-sm text-slate-300 tabular-nums">{plan.aar ?? '—'}</span>
                      <div>
                        <span className="text-sm text-slate-200">
                          {plan.type} ({plan.nummer})
                        </span>
                        {plan.navn && (
                          <p className="text-xs text-slate-500 mt-0.5 leading-tight">{plan.navn}</p>
                        )}
                      </div>
                      <span
                        className={`inline-flex items-center self-start px-2 py-0.5 rounded text-xs font-medium ${statusColor}`}
                      >
                        {plan.status}
                      </span>
                      <div className="flex items-center gap-1.5 self-start">
                        {plan.doklink ? (
                          <a
                            href={plan.doklink}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                          >
                            <FileText size={11} />
                            PDF
                          </a>
                        ) : (
                          <span className="text-slate-600 text-xs">—</span>
                        )}
                        {plan.doklink && (
                          <label
                            className="flex items-center cursor-pointer flex-shrink-0"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input
                              type="checkbox"
                              className="sr-only"
                              checked={valgteDoc.has(`pla-${plan.id}`)}
                              onChange={() => toggleDoc(`pla-${plan.id}`)}
                            />
                            <span
                              className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${valgteDoc.has(`pla-${plan.id}`) ? 'bg-blue-500 border-blue-500' : 'bg-[#0a1020] border-slate-400'}`}
                            >
                              {valgteDoc.has(`pla-${plan.id}`) && (
                                <svg
                                  viewBox="0 0 10 10"
                                  className="w-2 h-2 text-white"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2.5"
                                >
                                  <path d="M1.5 5.5l2.5 2.5 4.5-4.5" />
                                </svg>
                              )}
                            </span>
                          </label>
                        )}
                      </div>
                    </div>

                    {/* Detalje-panel */}
                    {erUdvidet && (
                      <div className="ml-10 mr-4 mb-1.5 bg-slate-800/40 rounded-lg border border-slate-700/30 overflow-hidden">
                        {detaljeRækker.length > 0 ? (
                          detaljeRækker.map((r) => (
                            <div
                              key={r.label}
                              className="flex items-baseline justify-between px-3 py-1 border-b border-slate-700/20 last:border-b-0"
                            >
                              <span className="text-xs text-slate-400">{r.label}</span>
                              <span className="text-xs text-slate-200 font-medium ml-4 text-right">
                                {r.value}
                              </span>
                            </div>
                          ))
                        ) : (
                          <p className="px-3 py-1.5 text-xs text-slate-500">
                            {t.noAdditionalDetails}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {/* end planer subsection */}

        {/* ── Energimærker subsection ──
            BIZZ-565: Header alignet med Planer-sektionen ovenover
            (ikon-style + text-color/size). Tidligere brugte vi en
            emoji-prefix der gjorde sektionen visuelt anderledes
            end de øvrige dokument-sektioner. */}
        <div className="border-t border-slate-700/30">
          <div className="px-4 py-2 flex items-center gap-2">
            <Zap size={13} className="text-slate-500" />
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
              {t.energyReports}
            </span>
          </div>

          {/* BIZZ-332: For ejerlejligheder vises energimærker fra moderejendommen,
              da mærker registreres på bygningsniveau — ikke på den individuelle lejlighed. */}
          {!!dawaAdresse?.etage && !!bbrData?.moderBfe && (
            <div className="px-4 pb-2 text-xs text-slate-500 italic">
              {da
                ? `Energimærker hentes fra moderejendommen (BFE ${bbrData.moderBfe}) — mærker registreres på bygningsniveau.`
                : `Energy labels are fetched from the parent property (BFE ${bbrData.moderBfe}) — labels are registered at building level.`}
            </div>
          )}

          {energiManglerAdgang && (
            <div className="px-4 pb-2 text-xs text-amber-400">
              EMO_USERNAME / EMO_PASSWORD ikke sat i .env.local
            </div>
          )}

          {!energiManglerAdgang && energiFejl && (
            <div className="px-4 pb-2 text-xs text-red-400">{energiFejl}</div>
          )}

          {!energiLoader &&
            !energiFejl &&
            !energiManglerAdgang &&
            (!energimaerker || energimaerker.length === 0) && (
              <div className="px-4 py-3 text-center text-slate-500 text-xs">{t.noEnergyLabels}</div>
            )}

          {energimaerker && energimaerker.length > 0 && (
            <div>
              {/* BIZZ-565 v4: Grid alignet med Dokumenter+Planer-sektionerne
                  ovenfor: 28px leading (matches chevron-kolonne) +
                  72px ÅR + 1fr ADRESSE + 60px KLASSE + 100px GF +
                  100px GT + 120px STATUS + 80px RAPPORT (PDF +
                  checkbox slået sammen som i Planer-sektionen). Det
                  sikrer at ÅR, STATUS og RAPPORT-kolonnerne ligger
                  præcis under tilsvarende kolonner i de øvrige
                  dokument-sektioner. */}
              <div className="min-w-[760px] grid grid-cols-[28px_72px_1fr_60px_100px_100px_120px_80px] gap-x-3 px-4 py-1.5 border-b border-slate-700/20">
                <span />
                <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                  {da ? 'År' : 'Year'}
                </span>
                <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                  {da ? 'Adresse' : 'Address'}
                </span>
                <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                  Klasse
                </span>
                <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                  {da ? 'Gyldig fra' : 'Valid from'}
                </span>
                <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                  {da ? 'Gyldig til' : 'Valid until'}
                </span>
                <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                  Status
                </span>
                <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                  {da ? 'Rapport' : 'Report'}
                </span>
              </div>
              {energimaerker.map((m) => {
                // Officielle EU energimærke farver (Building Energy Performance Directive)
                const klasseStyle = (() => {
                  const k = m.klasse.toUpperCase();
                  if (k.startsWith('A')) return { backgroundColor: '#00843D', color: '#fff' };
                  if (k === 'B') return { backgroundColor: '#4BAE33', color: '#fff' };
                  if (k === 'C') return { backgroundColor: '#ABCB44', color: '#fff' };
                  if (k === 'D') return { backgroundColor: '#F5E700', color: '#1a1a1a' };
                  if (k === 'E') return { backgroundColor: '#F5AB00', color: '#fff' };
                  if (k === 'F') return { backgroundColor: '#EF7D00', color: '#fff' };
                  if (k === 'G') return { backgroundColor: '#EB3223', color: '#fff' };
                  return { backgroundColor: '#475569', color: '#e2e8f0' };
                })();
                const statusKlasse =
                  m.status === 'Gyldig'
                    ? 'bg-emerald-500/15 text-emerald-400'
                    : m.status === 'Ugyldig'
                      ? 'bg-red-500/15 text-red-400'
                      : m.status === 'Erstattet'
                        ? 'bg-amber-500/15 text-amber-400'
                        : 'bg-slate-700/40 text-slate-400';
                // BIZZ-565: Udtræk år fra gyldigFra til ÅR-kolonne.
                // Format kan være "19. jul. 2022", "2022-07-19" eller andet —
                // grab første 4 cifre (årstal-mønster) som fallback.
                const aar = (() => {
                  const s = m.gyldigFra ?? '';
                  const m4 = s.match(/(\d{4})/);
                  return m4 ? m4[1] : '—';
                })();
                return (
                  <div
                    key={m.serialId}
                    className="min-w-[760px] grid grid-cols-[28px_72px_1fr_60px_100px_100px_120px_80px] gap-x-3 px-4 py-2 border-b border-slate-700/15 hover:bg-slate-700/10 transition-colors items-center"
                  >
                    {/* 0. (tom — matcher chevron-kolonne i Dokumenter/Planer) */}
                    <span />
                    {/* 1. ÅR */}
                    <span className="text-sm tabular-nums text-slate-300">{aar}</span>
                    {/* 2. ADRESSE */}
                    <div>
                      <p className="text-sm text-slate-200">{m.adresse ?? '—'}</p>
                      {m.bygninger.length > 0 && (
                        <p className="text-xs text-slate-500 mt-0.5">
                          {m.bygninger.length === 1
                            ? `${t.buildingLabel} ${m.bygninger[0].bygningsnr}`
                            : `${m.bygninger.length} ${t.buildingsLabel}`}
                          {m.bygninger[0]?.opfoerelsesaar != null &&
                            ` · ${m.bygninger[0].opfoerelsesaar}`}
                          {m.bygninger[0]?.varmeforsyning && ` · ${m.bygninger[0].varmeforsyning}`}
                        </p>
                      )}
                    </div>
                    {/* 3. KLASSE */}
                    <span
                      style={klasseStyle}
                      className="inline-flex items-center justify-center w-7 h-7 rounded-md text-xs font-bold"
                    >
                      {m.klasse}
                    </span>
                    {/* 4. GYLDIG FRA */}
                    <span className="text-sm tabular-nums text-slate-400">
                      {m.gyldigFra ?? '—'}
                    </span>
                    {/* 5. GYLDIG TIL */}
                    <span
                      className={`text-sm tabular-nums ${m.status === 'Ugyldig' ? 'text-red-400' : 'text-slate-300'}`}
                    >
                      {m.udloeber ?? '—'}
                    </span>
                    {/* 6. STATUS */}
                    <span
                      className={`inline-flex items-center self-start px-2 py-0.5 rounded text-xs font-medium ${statusKlasse}`}
                    >
                      {m.status ?? '—'}
                    </span>
                    {/* 7. RAPPORT — PDF + checkbox samme celle som Planer-sektionen */}
                    <div className="flex items-center gap-1.5 self-start">
                      {m.pdfUrl ? (
                        <a
                          href={m.pdfUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                        >
                          <FileText size={12} />
                          PDF
                        </a>
                      ) : (
                        <span className="text-xs text-slate-600">—</span>
                      )}
                      {m.pdfUrl && (
                        <label
                          className="flex items-center cursor-pointer flex-shrink-0"
                          onClick={(ev) => ev.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={valgteDoc.has(`energi-${m.serialId}`)}
                            onChange={() => toggleDoc(`energi-${m.serialId}`)}
                          />
                          <span
                            className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${valgteDoc.has(`energi-${m.serialId}`) ? 'bg-blue-500 border-blue-500' : 'bg-[#0a1020] border-slate-400'}`}
                          >
                            {valgteDoc.has(`energi-${m.serialId}`) && (
                              <svg
                                viewBox="0 0 10 10"
                                className="w-2 h-2 text-white"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                              >
                                <path d="M1.5 5.5l2.5 2.5 4.5-4.5" />
                              </svg>
                            )}
                          </span>
                        </label>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {/* end energimærker subsection */}
      </div>
      {/* end Dokumenter card */}
    </div>
  );
}
