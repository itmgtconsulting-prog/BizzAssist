/**
 * Sag-detalje for vurderingsrapport — upload-zoner + rapport-tabs.
 *
 * BIZZ-1641: To-delt layout: venstre = dataindsamling (5 upload-zoner),
 * højre = rapport-preview (8 tabs). Mobil: stacked.
 *
 * @module app/dashboard/analyse/vurderingsrapport/[sagId]/SagDetaljeClient
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  FileText,
  Upload,
  ChevronDown,
  ChevronRight,
  Loader2,
  Building2,
  MapPin,
  DollarSign,
  Wrench,
  Camera,
  BarChart3,
  FolderOpen,
} from 'lucide-react';
import TokenUsageBar from '@/app/components/TokenUsageBar';
import RapportTabRenderer from '@/app/components/vurdering/RapportTabRenderer';

/** Zone-type konfiguration */
const ZONE_CONFIG = [
  { key: 'lejeindtaegter', label: 'Lejeindtægter', icon: DollarSign, color: 'text-emerald-400' },
  { key: 'driftsudgifter', label: 'Driftsudgifter', icon: Wrench, color: 'text-amber-400' },
  { key: 'besigtigelse', label: 'Besigtigelse', icon: Camera, color: 'text-blue-400' },
  {
    key: 'referenceejendomme',
    label: 'Referenceejendomme',
    icon: BarChart3,
    color: 'text-purple-400',
  },
  { key: 'oevrige', label: 'Øvrige dokumenter', icon: FolderOpen, color: 'text-slate-400' },
] as const;

/** Rapport-tab konfiguration */
const TAB_CONFIG = [
  { key: 'identifikation', label: 'Identifikation' },
  { key: 'bygningsdata', label: 'Bygningsdata' },
  { key: 'energi', label: 'Energi' },
  { key: 'vurdering_skat', label: 'Vurdering & Skat' },
  { key: 'tinglysning', label: 'Tinglysning' },
  { key: 'servitutter', label: 'Servitutter' },
  { key: 'beliggenhed', label: 'Beliggenhed' },
  { key: 'risiko', label: 'Risiko-flag' },
] as const;

interface SagData {
  sag: Record<string, unknown>;
  zoner: Array<Record<string, unknown>>;
  dokumenter: Array<Record<string, unknown>>;
  tabs: Array<Record<string, unknown>>;
}

interface Props {
  sagId: string;
}

/**
 * Sag-detalje med upload-zoner og rapport-tabs.
 */
export default function SagDetaljeClient({ sagId }: Props) {
  const [data, setData] = useState<SagData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedZones, setExpandedZones] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState('identifikation');
  /** BIZZ-1685: AI-generering state */
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [genSuccess, setGenSuccess] = useState(false);
  /** BIZZ-1686: Tokens brugt ved sidste generering */
  const [lastTokensUsed, setLastTokensUsed] = useState<number | null>(null);

  /** Hent sag-data */
  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/vurderingsrapport/sager/${sagId}`);
      if (!r.ok) throw new Error('Kunne ikke hente sag');
      setData(await r.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ukendt fejl');
    } finally {
      setLoading(false);
    }
  }, [sagId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** BIZZ-1685: Trigger AI-generering af alle 8 rapport-tabs */
  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setGenError(null);
    setGenSuccess(false);
    try {
      const r = await fetch(`/api/vurderingsrapport/sager/${sagId}/generate-tabs`, {
        method: 'POST',
      });
      if (r.ok) {
        const result = await r.json().catch(() => null);
        setGenSuccess(true);
        // BIZZ-1686: Vis tokens brugt
        if (result?.tokens_used?.total) {
          setLastTokensUsed(result.tokens_used.total);
        }
        await refresh();
      } else {
        const errData = await r.json().catch(() => null);
        setGenError(errData?.error ?? `Generering fejlede (HTTP ${r.status})`);
      }
    } catch (err) {
      setGenError(err instanceof Error ? err.message : 'Netværksfejl');
    } finally {
      setGenerating(false);
    }
  }, [sagId, refresh]);

  const toggleZone = (key: string) => {
    setExpandedZones((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={24} className="animate-spin text-slate-500" />
      </div>
    );
  }

  if (error || !data) {
    return <div className="px-6 py-8 text-red-400 text-sm">{error ?? 'Sag ikke fundet'}</div>;
  }

  const sag = data.sag;

  return (
    <div className="w-full text-slate-100 px-6 py-8">
      {/* Header */}
      <Link
        href="/dashboard/analyse/vurderingsrapport"
        className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-slate-200 mb-4 transition-colors"
      >
        <ArrowLeft size={14} /> Tilbage til sagsoversigt
      </Link>

      <div className="flex items-center gap-3 mb-6">
        <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-400">
          <FileText size={20} />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            {String(sag.sag_nummer)}
            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-700 text-slate-400">
              {String(sag.status)}
            </span>
          </h1>
          <div className="flex items-center gap-3 text-sm text-slate-400">
            {sag.kunde_navn ? (
              <span className="flex items-center gap-1">
                <Building2 size={12} /> {String(sag.kunde_navn)}
              </span>
            ) : null}
            {sag.ejendom_adresse ? (
              <span className="flex items-center gap-1">
                <MapPin size={12} /> {String(sag.ejendom_adresse)}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {/* BIZZ-1686: Token-forbrug under header */}
      <div className="mb-4">
        <TokenUsageBar />
      </div>

      {/* To-delt layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Venstre: Upload-zoner */}
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Upload size={14} /> Dataindsamling
          </h2>
          {ZONE_CONFIG.map((zone) => {
            const isOpen = expandedZones.has(zone.key);
            const Icon = zone.icon;
            const docs = data.dokumenter.filter((d) => {
              const z = data.zoner.find((z) => z.zone_type === zone.key);
              return z && d.zone_id === z.id;
            });
            return (
              <div
                key={zone.key}
                className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden"
              >
                <button
                  onClick={() => toggleZone(zone.key)}
                  className="w-full px-4 py-3 flex items-center gap-3 hover:bg-slate-800/50 transition-colors"
                >
                  <Icon size={16} className={zone.color} />
                  <span className="text-sm font-medium text-white flex-1 text-left">
                    {zone.label}
                  </span>
                  <span className="text-xs text-slate-500">{docs.length} filer</span>
                  {isOpen ? (
                    <ChevronDown size={14} className="text-slate-500" />
                  ) : (
                    <ChevronRight size={14} className="text-slate-500" />
                  )}
                </button>
                {isOpen && (
                  <div className="px-4 pb-3 border-t border-slate-800 space-y-3">
                    {/* BIZZ-1684: Fritekst-noter til AI-kontekst */}
                    <div className="mt-2">
                      <label className="text-xs text-slate-500 block mb-1">
                        Noter til AI-generering
                      </label>
                      <textarea
                        className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-blue-500 resize-y min-h-[60px]"
                        placeholder={`Skriv noter om ${zone.label.toLowerCase()}...`}
                        defaultValue={
                          (
                            data.zoner.find((z) => z.zone_type === zone.key) as
                              | { fritekst?: string }
                              | undefined
                          )?.fritekst ?? ''
                        }
                        onBlur={async (e) => {
                          const zoneRow = data.zoner.find((z) => z.zone_type === zone.key);
                          if (!zoneRow?.id) return;
                          await fetch(
                            `/api/vurderingsrapport/sager/${sagId}/zoner/${String(zoneRow.id)}`,
                            {
                              method: 'PATCH',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ fritekst: e.target.value }),
                            }
                          ).catch(() => {});
                        }}
                      />
                    </div>
                    {/* BIZZ-1692: Funktionel file-upload */}
                    <label
                      className="border-2 border-dashed border-slate-700 rounded-lg p-4 text-center text-xs text-slate-500 hover:border-blue-500/50 cursor-pointer transition-colors block"
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.currentTarget.classList.add('border-blue-500');
                      }}
                      onDragLeave={(e) => {
                        e.currentTarget.classList.remove('border-blue-500');
                      }}
                      onDrop={async (e) => {
                        e.preventDefault();
                        e.currentTarget.classList.remove('border-blue-500');
                        const files = e.dataTransfer.files;
                        if (!files.length) return;
                        const zoneRow = data.zoner.find((z) => z.zone_type === zone.key);
                        if (!zoneRow?.id) return;
                        for (const file of Array.from(files)) {
                          const fd = new FormData();
                          fd.append('file', file);
                          fd.append('zone_id', String(zoneRow.id));
                          await fetch(`/api/vurderingsrapport/sager/${sagId}/upload`, {
                            method: 'POST',
                            body: fd,
                          }).catch(() => {});
                        }
                        await refresh();
                      }}
                    >
                      <input
                        type="file"
                        multiple
                        className="hidden"
                        accept=".pdf,.xlsx,.xls,.csv,.doc,.docx,.png,.jpg,.jpeg"
                        onChange={async (e) => {
                          const files = e.target.files;
                          if (!files?.length) return;
                          const zoneRow = data.zoner.find((z) => z.zone_type === zone.key);
                          if (!zoneRow?.id) return;
                          for (const file of Array.from(files)) {
                            const fd = new FormData();
                            fd.append('file', file);
                            fd.append('zone_id', String(zoneRow.id));
                            await fetch(`/api/vurderingsrapport/sager/${sagId}/upload`, {
                              method: 'POST',
                              body: fd,
                            }).catch(() => {});
                          }
                          await refresh();
                          e.target.value = '';
                        }}
                      />
                      <Upload size={16} className="mx-auto mb-1" />
                      Klik eller træk filer hertil
                    </label>
                    {/* Vis uploadede filer */}
                    {docs.length > 0 && (
                      <div className="space-y-1 mt-2">
                        {docs.map((d, i) => (
                          <div
                            key={i}
                            className="flex items-center gap-2 text-xs text-slate-400 px-2 py-1 bg-slate-800/50 rounded"
                          >
                            <FileText size={11} />
                            <span className="truncate flex-1">
                              {String(d.original_name ?? 'Fil')}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Højre: Rapport-tabs — BIZZ-1693: sticky så panelet følger scroll */}
        <div className="lg:sticky lg:top-4 lg:self-start">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <FileText size={14} /> Rapport
            </h2>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={generating}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-xl text-xs font-semibold flex items-center gap-2 transition-colors"
              aria-label="Generer rapport med AI"
            >
              {generating ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  Genererer...
                </>
              ) : (
                <>
                  <FileText size={13} />
                  Generer rapport (AI)
                </>
              )}
            </button>
          </div>
          {genError && (
            <div className="mb-3 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-xs">
              {genError}
            </div>
          )}
          {genSuccess && !generating && (
            <div className="mb-3 px-3 py-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-400 text-xs">
              Rapport genereret
              {lastTokensUsed ? ` — ${lastTokensUsed.toLocaleString('da-DK')} tokens brugt` : ''}.
              Data vises nedenfor.
            </div>
          )}
          {/* Tab-bar */}
          <div className="flex flex-wrap gap-1 mb-4">
            {TAB_CONFIG.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
                  activeTab === tab.key
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab-indhold */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 min-h-[300px]">
            {(() => {
              const tabData = data.tabs.find((t) => t.tab_key === activeTab);
              if (!tabData) {
                return (
                  <div className="text-center py-12 text-slate-500 text-sm">
                    <FileText size={32} className="mx-auto mb-2 text-slate-600" />
                    <p>Ingen data endnu for denne sektion.</p>
                    <p className="text-xs mt-1">Upload dokumenter eller kør AI-generering.</p>
                  </div>
                );
              }
              return (
                <RapportTabRenderer
                  tabKey={activeTab}
                  indhold={tabData.indhold as Record<string, unknown>}
                />
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}
