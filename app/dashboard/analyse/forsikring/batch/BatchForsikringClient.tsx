/**
 * BatchForsikringClient — batch forsikrings-gap-analyse UI.
 *
 * BIZZ-1224: Upload CSV med kundeportefølje, kør batch gap-analyse,
 * vis progress og resultater med prioriteret mersalgsliste.
 *
 * Flow:
 *  1. Upload CSV (drag-and-drop eller file picker)
 *  2. Preview parsed kunder + kolonne-mapping
 *  3. Start batch → polling for progress
 *  4. Resultater: prioriteret liste + statistik
 *
 * @module app/dashboard/analyse/forsikring/batch
 */

'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Upload,
  FileSpreadsheet,
  Loader2,
  CheckCircle,
  AlertTriangle,
  BarChart3,
  Users,
  Shield,
  Download,
} from 'lucide-react';

/** En parsed kunde fra CSV */
interface ParsedKunde {
  kundeId: string;
  navn: string;
  kundeType: 'person' | 'virksomhed';
  identifier: string;
  policer: Array<{ type: string; daekningssum: number | null; objekt: string | null }>;
}

/** Job-status fra API */
interface BatchStatus {
  jobId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  totalItems: number;
  processedItems: number;
  progress: number;
  results: Array<{
    kundeId: string;
    navn: string;
    result: {
      gaps: Array<{ gapType: string; besked: string }>;
      summary: { uforsikrede: number; samletVaerdi: number };
    } | null;
    error: string | null;
  }> | null;
  summary: {
    totalKunder: number;
    processeret: number;
    fejlet: number;
    totalGaps: number;
    totalUforsikrede: number;
    topKunder: Array<{ kundeId: string; navn: string; antalGaps: number; samletVaerdi: number }>;
    gapTypeCounts: Record<string, number>;
  } | null;
  error: string | null;
}

/**
 * Parser CSV-tekst til kunder.
 * Forventer kolonner: kundeId, navn, type, identifier, policetype, daekningssum, objekt
 *
 * @param csv - CSV tekst
 * @returns Array af parsed kunder
 */
function parseCsv(csv: string): ParsedKunde[] {
  const lines = csv
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const header = lines[0].toLowerCase();
  const sep = header.includes(';') ? ';' : ',';
  const cols = header.split(sep).map((c) => c.trim().replace(/"/g, ''));

  const idxId = cols.findIndex((c) => /kunde.?id|id/i.test(c));
  const idxNavn = cols.findIndex((c) => /navn|name/i.test(c));
  const idxType = cols.findIndex((c) => /type|kunde.?type/i.test(c));
  const idxIdent = cols.findIndex((c) => /cvr|enheds|identifier/i.test(c));
  const idxPolice = cols.findIndex((c) => /police|forsikring|type.?police/i.test(c));
  const idxDaek = cols.findIndex((c) => /daekning|daekningssum|sum|beloeb/i.test(c));
  const idxObjekt = cols.findIndex((c) => /objekt|adresse|reg/i.test(c));

  if (idxNavn === -1 || idxIdent === -1) return [];

  const kundeMap = new Map<string, ParsedKunde>();

  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(sep).map((v) => v.trim().replace(/^"|"$/g, ''));
    const kundeId = idxId >= 0 ? vals[idxId] : `kunde-${i}`;
    const navn = vals[idxNavn] ?? '';
    const typeRaw = idxType >= 0 ? vals[idxType]?.toLowerCase() : '';
    const kundeType = typeRaw.includes('person') ? ('person' as const) : ('virksomhed' as const);
    const identifier = vals[idxIdent] ?? '';

    if (!identifier) continue;

    const existing = kundeMap.get(kundeId);
    const police = {
      type: idxPolice >= 0 ? (vals[idxPolice] ?? 'andet') : 'andet',
      daekningssum: idxDaek >= 0 ? parseInt(vals[idxDaek]?.replace(/\D/g, ''), 10) || null : null,
      objekt: idxObjekt >= 0 ? vals[idxObjekt] || null : null,
    };

    if (existing) {
      existing.policer.push(police);
    } else {
      kundeMap.set(kundeId, { kundeId, navn, kundeType, identifier, policer: [police] });
    }
  }

  return Array.from(kundeMap.values());
}

/**
 * Batch forsikrings-gap klient-komponent.
 *
 * @returns Batch UI JSX
 */
export default function BatchForsikringClient() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [kunder, setKunder] = useState<ParsedKunde[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<BatchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /** Håndter fil-upload */
  const handleFile = useCallback((file: File) => {
    setError(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const parsed = parseCsv(text);
      if (parsed.length === 0) {
        setError(
          'Kunne ikke parse CSV — tjek format (kundeId, navn, type, cvr/enhedsNummer, policetype, dækningssum)'
        );
        return;
      }
      setKunder(parsed);
      setStep(2);
    };
    reader.readAsText(file, 'utf-8');
  }, []);

  /** Start batch-job */
  const startBatch = useCallback(async () => {
    setUploading(true);
    setError(null);
    try {
      const res = await fetch('/api/analyse/forsikring-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kunder }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError((data as { error?: string })?.error ?? 'Fejl ved oprettelse');
        return;
      }
      const data = (await res.json()) as { jobId: string };
      setJobId(data.jobId);
      setStep(3);
    } catch {
      setError('Netværksfejl');
    } finally {
      setUploading(false);
    }
  }, [kunder]);

  /** Poll for job-status */
  useEffect(() => {
    if (!jobId || step !== 3) return;

    const poll = async () => {
      try {
        const res = await fetch(`/api/analyse/forsikring-batch?jobId=${jobId}`);
        if (res.ok) {
          const data = (await res.json()) as BatchStatus;
          setJobStatus(data);
          if (data.status === 'completed' || data.status === 'failed') {
            if (pollRef.current) clearInterval(pollRef.current);
          }
        }
      } catch {
        /* ignore */
      }
    };

    void poll();
    pollRef.current = setInterval(poll, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [jobId, step]);

  /** Eksportér resultater som CSV */
  const exportCsv = useCallback(() => {
    if (!jobStatus?.results) return;
    const rows = ['kundeId;navn;antal_gaps;uforsikrede;samlet_vaerdi;gaps'];
    for (const r of jobStatus.results) {
      const gaps = r.result?.gaps?.map((g) => g.gapType).join(', ') ?? '';
      rows.push(
        `${r.kundeId};${r.navn};${r.result?.gaps?.length ?? 0};${r.result?.summary?.uforsikrede ?? 0};${r.result?.summary?.samletVaerdi ?? 0};${gaps}`
      );
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `forsikring-gap-batch-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [jobStatus]);

  return (
    <div className="flex-1 bg-[#0a1628] p-6 sm:p-8 overflow-y-auto">
      <Link
        href="/dashboard/analyse/forsikring"
        className="inline-flex items-center gap-1.5 text-slate-400 hover:text-white text-sm transition-colors mb-4"
      >
        <ArrowLeft size={14} />
        Forsikrings-gap
      </Link>

      <h1 className="text-white text-2xl font-bold flex items-center gap-2 mb-1">
        <Users size={22} className="text-blue-400" />
        Batch Forsikrings-gap
      </h1>
      <p className="text-slate-400 text-sm mb-6">
        Upload kundeportefølje (CSV) og kør gap-analyse for alle kunder.
      </p>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-red-300 text-sm mb-4">
          {error}
        </div>
      )}

      {/* ── Step 1: Upload ── */}
      {step === 1 && (
        <div
          className="border-2 border-dashed border-slate-700/60 hover:border-blue-500/40 rounded-2xl p-12 text-center transition-colors cursor-pointer"
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (file) handleFile(file);
          }}
        >
          <Upload size={40} className="text-slate-500 mx-auto mb-4" />
          <p className="text-white font-medium mb-1">Drop CSV-fil her, eller klik for at vælge</p>
          <p className="text-slate-500 text-xs">
            Format: kundeId, navn, type (person/virksomhed), CVR/enhedsNummer, policetype,
            dækningssum, objekt
          </p>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
        </div>
      )}

      {/* ── Step 2: Preview + Start ── */}
      {step === 2 && (
        <div className="space-y-4">
          <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <FileSpreadsheet size={16} className="text-emerald-400" />
              <span className="text-white font-medium">{kunder.length} kunder parsed</span>
              <span className="text-slate-500 text-xs">
                ({kunder.reduce((s, k) => s + k.policer.length, 0)} policer total)
              </span>
            </div>
            <div className="max-h-64 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-800">
                  <tr className="text-slate-500 text-left border-b border-slate-700/30">
                    <th className="py-1.5 px-2">Kunde-ID</th>
                    <th className="py-1.5 px-2">Navn</th>
                    <th className="py-1.5 px-2">Type</th>
                    <th className="py-1.5 px-2">Identifier</th>
                    <th className="py-1.5 px-2">Policer</th>
                  </tr>
                </thead>
                <tbody>
                  {kunder.slice(0, 50).map((k) => (
                    <tr key={k.kundeId} className="text-slate-300 border-b border-slate-700/20">
                      <td className="py-1.5 px-2 font-mono">{k.kundeId}</td>
                      <td className="py-1.5 px-2">{k.navn}</td>
                      <td className="py-1.5 px-2">{k.kundeType}</td>
                      <td className="py-1.5 px-2 font-mono">{k.identifier}</td>
                      <td className="py-1.5 px-2">{k.policer.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {kunder.length > 50 && (
                <p className="text-slate-500 text-xs p-2">...og {kunder.length - 50} mere</p>
              )}
            </div>
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => {
                setStep(1);
                setKunder([]);
              }}
              className="bg-slate-700 hover:bg-slate-600 text-slate-300 px-4 py-2 rounded-lg text-sm"
            >
              Annullér
            </button>
            <button
              onClick={startBatch}
              disabled={uploading || kunder.length === 0}
              className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white px-5 py-2 rounded-lg text-sm font-medium flex items-center gap-2"
            >
              {uploading ? <Loader2 size={14} className="animate-spin" /> : <Shield size={14} />}
              Kør batch-analyse ({kunder.length} kunder)
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: Progress + Resultater ── */}
      {step === 3 && (
        <div className="space-y-4">
          {/* Progress */}
          {jobStatus && jobStatus.status !== 'completed' && (
            <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-5">
              <div className="flex items-center gap-3 mb-3">
                <Loader2 size={16} className="text-blue-400 animate-spin" />
                <span className="text-white font-medium">
                  Processerer... {jobStatus.processedItems}/{jobStatus.totalItems}
                </span>
              </div>
              <div className="w-full bg-slate-700 rounded-full h-2">
                <div
                  className="bg-blue-500 h-2 rounded-full transition-all"
                  style={{ width: `${jobStatus.progress}%` }}
                />
              </div>
              <p className="text-slate-500 text-xs mt-2">
                {jobStatus.progress}% — ca.{' '}
                {Math.ceil(((jobStatus.totalItems - jobStatus.processedItems) * 0.5) / 60)} min.
                tilbage
              </p>
            </div>
          )}

          {/* Fejl */}
          {jobStatus?.status === 'failed' && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4">
              <div className="flex items-center gap-2 text-red-300 mb-1">
                <AlertTriangle size={16} />
                <span className="font-medium">Batch fejlede</span>
              </div>
              <p className="text-red-400/70 text-sm">{jobStatus.error}</p>
            </div>
          )}

          {/* Resultat-dashboard */}
          {jobStatus?.status === 'completed' && jobStatus.summary && (
            <div className="space-y-4">
              {/* Summary cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  {
                    label: 'Kunder',
                    value: jobStatus.summary.totalKunder,
                    icon: <Users size={14} />,
                  },
                  {
                    label: 'Gaps fundet',
                    value: jobStatus.summary.totalGaps,
                    icon: <AlertTriangle size={14} />,
                  },
                  {
                    label: 'Uforsikrede',
                    value: jobStatus.summary.totalUforsikrede,
                    icon: <Shield size={14} />,
                  },
                  {
                    label: 'Fejlet',
                    value: jobStatus.summary.fejlet,
                    icon: <AlertTriangle size={14} />,
                  },
                ].map((card) => (
                  <div
                    key={card.label}
                    className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-4"
                  >
                    <div className="flex items-center gap-2 text-slate-400 text-xs mb-1">
                      {card.icon}
                      {card.label}
                    </div>
                    <p className="text-white text-xl font-bold">
                      {card.value.toLocaleString('da-DK')}
                    </p>
                  </div>
                ))}
              </div>

              {/* Gap-type fordeling */}
              {Object.keys(jobStatus.summary.gapTypeCounts).length > 0 && (
                <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <BarChart3 size={14} className="text-blue-400" />
                    <span className="text-white text-sm font-medium">Gap-type fordeling</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(jobStatus.summary.gapTypeCounts).map(([type, count]) => (
                      <span
                        key={type}
                        className="px-2.5 py-1 bg-slate-700 rounded-lg text-xs text-slate-300"
                      >
                        {type}: <strong>{count}</strong>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Top kunder (mersalgspotentiale) */}
              <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <CheckCircle size={14} className="text-emerald-400" />
                    <span className="text-white text-sm font-medium">
                      Top kunder efter mersalgspotentiale
                    </span>
                  </div>
                  <button
                    onClick={exportCsv}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded-lg text-xs text-slate-300"
                  >
                    <Download size={12} />
                    Eksportér CSV
                  </button>
                </div>
                <div className="max-h-96 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-slate-800">
                      <tr className="text-slate-500 text-left border-b border-slate-700/30">
                        <th className="py-1.5 px-2">#</th>
                        <th className="py-1.5 px-2">Kunde</th>
                        <th className="py-1.5 px-2">Gaps</th>
                        <th className="py-1.5 px-2">Uforsikrede</th>
                        <th className="py-1.5 px-2">Samlet værdi</th>
                      </tr>
                    </thead>
                    <tbody>
                      {jobStatus.summary.topKunder.map((k, i) => (
                        <tr
                          key={k.kundeId}
                          className="text-slate-300 border-b border-slate-700/20 hover:bg-slate-800/40"
                        >
                          <td className="py-1.5 px-2 text-slate-500">{i + 1}</td>
                          <td className="py-1.5 px-2">{k.navn}</td>
                          <td className="py-1.5 px-2 font-medium text-amber-400">{k.antalGaps}</td>
                          <td className="py-1.5 px-2 text-red-400">{k.antalUforsikrede ?? 0}</td>
                          <td className="py-1.5 px-2 font-mono">
                            {k.samletVaerdi
                              ? `${(k.samletVaerdi / 1_000_000).toFixed(1)} mio`
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
