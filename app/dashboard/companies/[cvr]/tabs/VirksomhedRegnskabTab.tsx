/**
 * VirksomhedRegnskabTab — Regnskab-fane (XBRL nøgletal, årsrapporter).
 * BIZZ-658: Extraheret fra VirksomhedDetaljeClient.tsx.
 * @module app/dashboard/companies/[cvr]/tabs/VirksomhedRegnskabTab
 */
'use client';

import { BarChart3, Download, FileText, Loader2 } from 'lucide-react';
import TabLoadingSpinner from '@/app/components/TabLoadingSpinner';
import { translations } from '@/app/lib/translations';
import type { Regnskab } from '@/app/api/regnskab/route';
import type { RegnskabsAar } from '@/app/api/regnskab/xbrl/route';
import RegnskabstalTable from '../RegnskabstalTable';

function EmptyState({ ikon, tekst }: { ikon: React.ReactNode; tekst: string }) {
  return (
    <div className="text-center py-12">
      <div className="mx-auto mb-3 flex justify-center">{ikon}</div>
      <p className="text-slate-400 text-sm">{tekst}</p>
    </div>
  );
}

interface Props {
  lang: 'da' | 'en';
  xbrlData: RegnskabsAar[] | null;
  xbrlLoading: boolean;
  xbrlLoadingMore: boolean;
  regnskaber: Regnskab[] | null;
  regnskabLoading: boolean;
  valgteDoc: Set<string>;
  toggleDoc: (id: string) => void;
  visAlleRegnskaber: boolean;
  setVisAlleRegnskaber: React.Dispatch<React.SetStateAction<boolean>>;
}

export default function VirksomhedRegnskabTab({
  lang,
  xbrlData,
  xbrlLoading,
  xbrlLoadingMore,
  regnskaber,
  regnskabLoading,
  valgteDoc,
  toggleDoc,
  visAlleRegnskaber,
  setVisAlleRegnskaber,
}: Props) {
  const c = translations[lang].company;

  return (
    <div className="space-y-4">
      {/* BIZZ-617: Specifik label på regnskabs-loader */}
      {(xbrlLoading || xbrlLoadingMore || regnskabLoading) && (
        <TabLoadingSpinner label={c.loadingRegnskab} />
      )}

      {/* Data — vises så snart første batch er klar */}
      {!xbrlLoading && xbrlData && xbrlData.length > 0 && (
        <RegnskabstalTable years={xbrlData} lang={lang} regnskaber={regnskaber ?? []} />
      )}

      {/* Progressiv loading-indikator for efterfølgende batches */}
      {xbrlLoadingMore && (
        <div className="flex items-center justify-center gap-2 py-3">
          <Loader2 size={14} className="animate-spin text-blue-400" />
          <span className="text-slate-400 text-xs">
            {lang === 'da' ? 'Henter flere regnskaber…' : 'Loading more financials…'}
          </span>
        </div>
      )}

      {/* Empty / fallback — kun når BÅDE xbrl OG PDF-regnskaber er tomme */}
      {!xbrlLoading &&
        !xbrlLoadingMore &&
        (!xbrlData || xbrlData.length === 0) &&
        !regnskabLoading &&
        (!regnskaber || regnskaber.length === 0) && (
          <EmptyState
            ikon={<BarChart3 size={32} className="text-slate-600" />}
            tekst={c.noFinancials}
          />
        )}

      {/* ── Årsregnskaber (PDF / XBRL downloads) — vises kun når der er data eller loading ── */}
      {(regnskabLoading || (regnskaber && regnskaber.length > 0)) && (
        <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-hidden overflow-x-auto">
          <div className="px-4 py-2.5 border-b border-slate-700/30 flex items-center gap-2">
            <BarChart3 size={15} className="text-slate-400" />
            <span className="text-sm font-semibold text-slate-200">{c.annualReports}</span>
            {regnskabLoading && (
              <span className="ml-2 text-xs text-slate-500 animate-pulse">{c.loading}</span>
            )}
            <button
              onClick={async () => {
                // valgteDoc indeholder direkte dokumentUrl-strenge — ingen lookup nødvendig
                // Sequential anchor-click — undgår popup-blokering ved window.open i loop
                for (const url of valgteDoc) {
                  const a = document.createElement('a');
                  a.href = url;
                  a.target = '_blank';
                  a.rel = 'noopener noreferrer';
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  await new Promise((r) => setTimeout(r, 400));
                }
              }}
              disabled={valgteDoc.size === 0}
              className="ml-auto flex items-center gap-1.5 px-3 py-1 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed border border-slate-600 rounded-lg text-slate-300 text-xs font-medium transition-all"
              title={
                valgteDoc.size === 0
                  ? c.selectDocsToDownload
                  : `${c.downloadSelected} (${valgteDoc.size})`
              }
            >
              <Download size={12} />
              {c.downloadSelected} ({valgteDoc.size})
            </button>
          </div>
          <div className="min-w-[420px] grid grid-cols-[28px_60px_1fr_80px] gap-x-3 px-4 py-1.5 border-b border-slate-700/20">
            <span />
            <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
              {lang === 'da' ? 'År' : 'Year'}
            </span>
            <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
              {lang === 'da' ? 'Dokument' : 'Document'}
            </span>
            <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
              {lang === 'da' ? 'Dok.' : 'Doc.'}
            </span>
          </div>
          {regnskabLoading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />
            </div>
          )}
          {!regnskabLoading && regnskaber && regnskaber.length > 0 ? (
            <div className="divide-y divide-slate-700/15">
              {(visAlleRegnskaber ? regnskaber : regnskaber.slice(0, 3)).map((regnsk) => {
                const pdfDok = regnsk.dokumenter?.find((d) => d.dokumentMimeType?.includes('pdf'));
                const xbrlDok = regnsk.dokumenter?.find(
                  (d) =>
                    d.dokumentType?.toLowerCase().includes('xbrl') ||
                    d.dokumentMimeType?.includes('xml')
                );
                const year = regnsk.periodeSlut ? new Date(regnsk.periodeSlut).getFullYear() : null;
                const label = year
                  ? `${lang === 'da' ? 'Årsrapport' : 'Annual Report'} ${year}`
                  : `${lang === 'da' ? 'Årsrapport' : 'Annual Report'} (${regnsk.sagsNummer})`;
                return (
                  <div
                    key={regnsk.sagsNummer}
                    className="min-w-[420px] grid grid-cols-[28px_60px_1fr_80px] gap-x-3 px-4 py-2 hover:bg-slate-700/10 transition-colors items-start"
                  >
                    <span />
                    <span className="text-sm text-slate-300 tabular-nums">{year ?? '—'}</span>
                    <div className="min-w-0">
                      <p className="text-sm text-slate-200 truncate">{label}</p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {regnsk.periodeStart ?? '?'} — {regnsk.periodeSlut ?? '?'}
                      </p>
                    </div>
                    <div className="flex flex-col gap-1 self-start">
                      {pdfDok && (
                        <div className="flex items-center justify-between w-full">
                          <a
                            href={pdfDok.dokumentUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                          >
                            <FileText size={11} />
                            PDF
                          </a>
                          <label className="flex items-center cursor-pointer flex-shrink-0 ml-2">
                            <input
                              type="checkbox"
                              className="sr-only"
                              checked={valgteDoc.has(pdfDok.dokumentUrl)}
                              onChange={() => toggleDoc(pdfDok.dokumentUrl)}
                            />
                            <span
                              className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${valgteDoc.has(pdfDok.dokumentUrl) ? 'bg-blue-500 border-blue-500' : 'bg-[#0a1020] border-slate-400'}`}
                            >
                              {valgteDoc.has(pdfDok.dokumentUrl) && (
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
                        </div>
                      )}
                      {xbrlDok && (
                        <div className="flex items-center justify-between w-full">
                          <a
                            href={xbrlDok.dokumentUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-amber-400/80 hover:text-amber-300 transition-colors"
                          >
                            <FileText size={11} />
                            XBRL
                          </a>
                          <label className="flex items-center cursor-pointer flex-shrink-0 ml-2">
                            <input
                              type="checkbox"
                              className="sr-only"
                              checked={valgteDoc.has(xbrlDok.dokumentUrl)}
                              onChange={() => toggleDoc(xbrlDok.dokumentUrl)}
                            />
                            <span
                              className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${valgteDoc.has(xbrlDok.dokumentUrl) ? 'bg-blue-500 border-blue-500' : 'bg-[#0a1020] border-slate-400'}`}
                            >
                              {valgteDoc.has(xbrlDok.dokumentUrl) && (
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
                        </div>
                      )}
                      {!pdfDok && !xbrlDok && <span className="text-slate-600 text-xs">—</span>}
                    </div>
                  </div>
                );
              })}
              {regnskaber.length > 3 && (
                <button
                  onClick={() => setVisAlleRegnskaber((prev) => !prev)}
                  className="w-full px-4 py-2 text-xs text-blue-400 hover:text-blue-300 hover:bg-slate-700/10 transition-colors text-center"
                >
                  {visAlleRegnskaber
                    ? lang === 'da'
                      ? 'Vis færre'
                      : 'Show less'
                    : lang === 'da'
                      ? `Vis alle ${regnskaber.length} regnskaber`
                      : `Show all ${regnskaber.length} reports`}
                </button>
              )}
            </div>
          ) : (
            !regnskabLoading && (
              <div className="px-4 py-6 text-center">
                <p className="text-slate-500 text-sm">{c.noFinancials}</p>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}
