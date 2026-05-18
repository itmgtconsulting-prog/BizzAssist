/**
 * Vurderingsrapport sagsoversigt — klient-komponent.
 *
 * BIZZ-1641: Viser liste af sager + opret ny sag med kunde- og ejendomssøgning.
 *
 * @module app/dashboard/analyse/vurderingsrapport/VurderingsrapportClient
 */

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  FileText,
  Plus,
  Search,
  MapPin,
  Building2,
  User,
  Loader2,
  Trash2,
} from 'lucide-react';
import type { UnifiedSearchResult } from '@/app/api/search/route';

/** Sag shape fra API */
interface VurderingSag {
  id: string;
  sag_nummer: string;
  beskrivelse: string | null;
  kunde_type: string;
  kunde_id: string;
  kunde_navn: string | null;
  ejendom_bfe: number | null;
  ejendom_adresse: string | null;
  ejendom_dawa_id: string | null;
  status: string;
  created_at: string;
}

/** Status badge farver */
const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  oprettet: { bg: 'bg-slate-500/15', text: 'text-slate-400' },
  dataindsamling: { bg: 'bg-blue-500/15', text: 'text-blue-400' },
  rapport_genereret: { bg: 'bg-emerald-500/15', text: 'text-emerald-400' },
  afsluttet: { bg: 'bg-purple-500/15', text: 'text-purple-400' },
};

/**
 * Vurderingsrapport sagsoversigt.
 */
export default function VurderingsrapportClient() {
  const router = useRouter();
  const [sager, setSager] = useState<VurderingSag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Opret-form state
  const [showForm, setShowForm] = useState(false);
  const [formBeskrivelse, setFormBeskrivelse] = useState('');
  const [formKunde, setFormKunde] = useState<{ type: string; id: string; navn: string } | null>(
    null
  );
  const [formEjendom, setFormEjendom] = useState<{
    bfe: number;
    adresse: string;
    dawaId: string;
  } | null>(null);
  const [creating, setCreating] = useState(false);

  // Søge-state
  const [kundeQuery, setKundeQuery] = useState('');
  const [kundeResults, setKundeResults] = useState<UnifiedSearchResult[]>([]);
  const [kundeLoading, setKundeLoading] = useState(false);
  const [ejdQuery, setEjdQuery] = useState('');
  const [ejdResults, setEjdResults] = useState<UnifiedSearchResult[]>([]);
  const [ejdLoading, setEjdLoading] = useState(false);
  const debounceKunde = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceEjd = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Hent sager */
  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/vurderingsrapport/sager');
      if (!r.ok) throw new Error('Kunne ikke hente sager');
      const data = await r.json();
      setSager(data.sager ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ukendt fejl');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Kunde-søgning */
  useEffect(() => {
    if (debounceKunde.current) clearTimeout(debounceKunde.current);
    if (!kundeQuery || kundeQuery.length < 2) {
      setKundeResults([]);
      return;
    }
    setKundeLoading(true);
    debounceKunde.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(kundeQuery)}`);
        if (r.ok) {
          const data = await r.json();
          const list = Array.isArray(data) ? data : (data.results ?? []);
          setKundeResults(
            list.filter((x: UnifiedSearchResult) => x.type === 'company' || x.type === 'person')
          );
        }
      } catch {
        /* ignore */
      } finally {
        setKundeLoading(false);
      }
    }, 250);
  }, [kundeQuery]);

  /** Ejendoms-søgning */
  useEffect(() => {
    if (debounceEjd.current) clearTimeout(debounceEjd.current);
    if (!ejdQuery || ejdQuery.length < 2) {
      setEjdResults([]);
      return;
    }
    setEjdLoading(true);
    debounceEjd.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(ejdQuery)}`);
        if (r.ok) {
          const data = await r.json();
          const list = Array.isArray(data) ? data : (data.results ?? []);
          setEjdResults(list.filter((x: UnifiedSearchResult) => x.type === 'address'));
        }
      } catch {
        /* ignore */
      } finally {
        setEjdLoading(false);
      }
    }, 250);
  }, [ejdQuery]);

  /** Vælg ejendom → resolver BFE */
  const handleSelectEjendom = useCallback(async (result: UnifiedSearchResult) => {
    setEjdQuery('');
    setEjdResults([]);
    try {
      const r = await fetch(`/api/ejendom/${result.id}`);
      if (r.ok) {
        const data = await r.json();
        const bfe = data?.ejendomsrelationer?.[0]?.bfeNummer;
        setFormEjendom({
          bfe: bfe ? Number(bfe) : 0,
          adresse: result.title,
          dawaId: result.id,
        });
      }
    } catch {
      /* ignore */
    }
  }, []);

  /** Opret sag */
  const handleCreate = useCallback(async () => {
    if (!formKunde) return;
    setCreating(true);
    try {
      const r = await fetch('/api/vurderingsrapport/sager', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kunde_type: formKunde.type === 'company' ? 'virksomhed' : 'person',
          kunde_id: formKunde.id,
          kunde_navn: formKunde.navn,
          ejendom_bfe: formEjendom?.bfe ?? undefined,
          ejendom_adresse: formEjendom?.adresse ?? undefined,
          ejendom_dawa_id: formEjendom?.dawaId ?? undefined,
          beskrivelse: formBeskrivelse || undefined,
        }),
      });
      if (r.ok) {
        const data = await r.json();
        router.push(`/dashboard/analyse/vurderingsrapport/${data.sag.id}`);
      }
    } catch {
      /* ignore */
    } finally {
      setCreating(false);
    }
  }, [formKunde, formEjendom, formBeskrivelse, router]);

  /** Slet sag */
  const handleDelete = useCallback(
    async (id: string) => {
      if (!confirm('Slet denne sag permanent?')) return;
      await fetch(`/api/vurderingsrapport/sager/${id}`, { method: 'DELETE' });
      await refresh();
    },
    [refresh]
  );

  return (
    <div className="w-full text-slate-100 px-6 py-8 max-w-5xl">
      {/* Header */}
      <Link
        href="/dashboard/analyse"
        className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-slate-200 mb-4 transition-colors"
      >
        <ArrowLeft size={14} /> Tilbage til Analyse & Tools
      </Link>

      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-xl bg-blue-500/10 text-blue-400">
            <FileText size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Vurderingsrapport</h1>
            <p className="text-slate-400 text-sm">Sags-baseret ejendomsvurdering</p>
          </div>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-sm font-semibold flex items-center gap-2 transition-colors"
        >
          <Plus size={16} /> Ny sag
        </button>
      </div>

      {/* Opret-form */}
      {showForm && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 mb-6 space-y-4">
          <h2 className="text-white font-semibold text-sm">Opret ny vurderingssag</h2>

          {/* Beskrivelse */}
          <div>
            <label className="text-xs text-slate-500 block mb-1">Beskrivelse (valgfri)</label>
            <input
              type="text"
              value={formBeskrivelse}
              onChange={(e) => setFormBeskrivelse(e.target.value)}
              placeholder="Kort beskrivelse af sagen..."
              className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500"
            />
          </div>

          {/* Kunde-søgning */}
          <div>
            <label className="text-xs text-slate-500 block mb-1">Kunde *</label>
            {formKunde ? (
              <div className="flex items-center gap-2 px-3 py-2 bg-emerald-950/30 border border-emerald-900 rounded-lg">
                {formKunde.type === 'company' ? (
                  <Building2 size={14} className="text-blue-400" />
                ) : (
                  <User size={14} className="text-purple-400" />
                )}
                <span className="text-sm text-white">{formKunde.navn}</span>
                <button
                  onClick={() => setFormKunde(null)}
                  className="ml-auto text-xs text-slate-500 hover:text-white"
                >
                  Skift
                </button>
              </div>
            ) : (
              <div className="relative">
                <div className="flex items-center gap-2 px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg focus-within:border-emerald-500">
                  <Search size={14} className="text-slate-500" />
                  <input
                    type="text"
                    value={kundeQuery}
                    onChange={(e) => setKundeQuery(e.target.value)}
                    placeholder="Søg virksomhed eller person..."
                    className="flex-1 bg-transparent text-sm text-white placeholder:text-slate-600 focus:outline-none"
                  />
                  {kundeLoading && <Loader2 size={14} className="animate-spin text-slate-500" />}
                </div>
                {kundeResults.length > 0 && (
                  <div className="absolute z-10 mt-1 w-full bg-slate-900 border border-slate-700 rounded-lg shadow-xl max-h-48 overflow-y-auto">
                    {kundeResults.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => {
                          setFormKunde({ type: r.type, id: r.id, navn: r.title });
                          setKundeQuery('');
                          setKundeResults([]);
                        }}
                        className="w-full px-3 py-2 text-left hover:bg-slate-800 flex items-center gap-2 text-sm border-b border-slate-800 last:border-0"
                      >
                        {r.type === 'company' ? (
                          <Building2 size={12} className="text-blue-400" />
                        ) : (
                          <User size={12} className="text-purple-400" />
                        )}
                        <span className="text-slate-200 truncate">{r.title}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Ejendom-søgning */}
          <div>
            <label className="text-xs text-slate-500 block mb-1">Ejendom (valgfri)</label>
            {formEjendom ? (
              <div className="flex items-center gap-2 px-3 py-2 bg-emerald-950/30 border border-emerald-900 rounded-lg">
                <MapPin size={14} className="text-emerald-400" />
                <span className="text-sm text-white">{formEjendom.adresse}</span>
                <span className="text-xs text-slate-500">BFE {formEjendom.bfe}</span>
                <button
                  onClick={() => setFormEjendom(null)}
                  className="ml-auto text-xs text-slate-500 hover:text-white"
                >
                  Skift
                </button>
              </div>
            ) : (
              <div className="relative">
                <div className="flex items-center gap-2 px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg focus-within:border-emerald-500">
                  <Search size={14} className="text-slate-500" />
                  <input
                    type="text"
                    value={ejdQuery}
                    onChange={(e) => setEjdQuery(e.target.value)}
                    placeholder="Søg adresse eller BFE..."
                    className="flex-1 bg-transparent text-sm text-white placeholder:text-slate-600 focus:outline-none"
                  />
                  {ejdLoading && <Loader2 size={14} className="animate-spin text-slate-500" />}
                </div>
                {ejdResults.length > 0 && (
                  <div className="absolute z-10 mt-1 w-full bg-slate-900 border border-slate-700 rounded-lg shadow-xl max-h-48 overflow-y-auto">
                    {ejdResults.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => handleSelectEjendom(r)}
                        className="w-full px-3 py-2 text-left hover:bg-slate-800 flex items-center gap-2 text-sm border-b border-slate-800 last:border-0"
                      >
                        <MapPin size={12} className="text-emerald-400" />
                        <span className="text-slate-200 truncate">{r.title}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <button
            onClick={handleCreate}
            disabled={!formKunde || creating}
            className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-xl text-sm font-semibold flex items-center gap-2 transition-colors"
          >
            {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Opret sag
          </button>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={24} className="animate-spin text-slate-500" />
        </div>
      )}

      {/* Error */}
      {error && <p className="text-red-400 text-sm mb-4">{error}</p>}

      {/* Sag-liste */}
      {!loading && sager.length === 0 && (
        <div className="text-center py-16 text-slate-500">
          <FileText size={40} className="mx-auto mb-3 text-slate-600" />
          <p className="text-sm">Ingen sager endnu. Klik &quot;Ny sag&quot; for at starte.</p>
        </div>
      )}

      {sager.length > 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-slate-500 text-xs">
                <th className="text-left px-4 py-3 font-medium">Sagsnr</th>
                <th className="text-left px-4 py-3 font-medium">Kunde</th>
                <th className="text-left px-4 py-3 font-medium hidden sm:table-cell">Ejendom</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="text-right px-4 py-3 font-medium">Dato</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {sager.map((sag) => {
                const colors = STATUS_COLORS[sag.status] ?? STATUS_COLORS.oprettet;
                return (
                  <tr
                    key={sag.id}
                    className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/dashboard/analyse/vurderingsrapport/${sag.id}`}
                        className="text-blue-400 hover:text-blue-300 font-medium"
                      >
                        {sag.sag_nummer}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-white">{sag.kunde_navn ?? sag.kunde_id}</td>
                    <td className="px-4 py-3 text-slate-400 hidden sm:table-cell truncate max-w-[200px]">
                      {sag.ejendom_adresse ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full ${colors.bg} ${colors.text}`}
                      >
                        {sag.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-slate-500 text-xs">
                      {new Date(sag.created_at).toLocaleDateString('da-DK')}
                    </td>
                    <td className="px-2 py-3">
                      <button
                        onClick={() => handleDelete(sag.id)}
                        className="p-1.5 text-slate-600 hover:text-red-400 transition-colors"
                        aria-label={`Slet ${sag.sag_nummer}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
