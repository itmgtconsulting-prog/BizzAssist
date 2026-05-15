/**
 * PrisudviklingClient — Dashboard med prisudvikling og ejerskabstidslinje.
 *
 * BIZZ-1464: Viser prishistorik (line chart), m²-pris vs kommune-gennemsnit,
 * og ejerskabskæde-tidslinje for en ejendom.
 *
 * @module app/dashboard/analyse/prisudvikling/PrisudviklingClient
 */

'use client';

import { useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { Search, Loader2, TrendingUp, Users, Building2, AlertCircle } from 'lucide-react';

/** Lazy-load chart komponent (Recharts kræver browser DOM). */
const LazyPrisChart = dynamic(() => import('./PrisudviklingChart'), { ssr: false });

interface PrisHistorikRow {
  overtagelsesdato: string | null;
  ejer_navn: string | null;
  ejer_cvr: string | null;
  ejer_type: string | null;
  kontant_koebesum: number | null;
  i_alt_koebesum: number | null;
  m2_pris: number | null;
  boligareal_m2: number | null;
  dokument_id: string | null;
}

interface EjendomInfo {
  bfe_nummer: number;
  kommune_kode: number | null;
  samlet_boligareal: number | null;
  byg021_anvendelse: number | null;
  opfoerelsesaar: number | null;
  energimaerke: string | null;
}

interface KommuneGns {
  kvartal: string;
  gns_m2_pris: number;
  antal: number;
}

interface DashboardData {
  bfe_nummer: number;
  prishistorik: PrisHistorikRow[];
  ejendom: EjendomInfo | null;
  kommuneGennemsnit: KommuneGns[] | null;
  dataPunkter: number;
  medPris: number;
}

/**
 * Hovedkomponent for prisudvikling dashboard.
 */
export default function PrisudviklingClient(): React.ReactElement {
  const [bfe, setBfe] = useState('');
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Hent prisudvikling for et BFE-nummer. */
  const search = useCallback(async (bfeNum: string) => {
    const num = Number(bfeNum.trim());
    if (!Number.isFinite(num) || num <= 0) {
      setError('Indtast et gyldigt BFE-nummer');
      return;
    }
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch(`/api/analyse/prisudvikling?bfe=${num}`);
      if (!res.ok) throw new Error('Kunne ikke hente data');
      const json = (await res.json()) as DashboardData;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Netværksfejl');
    } finally {
      setLoading(false);
    }
  }, []);

  /** Form submit. */
  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      search(bfe);
    },
    [bfe, search]
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <main className="max-w-5xl mx-auto px-4 py-8">
        <header className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <TrendingUp className="w-7 h-7 text-emerald-400" aria-hidden />
            <h1 className="text-2xl font-bold">Prisudvikling</h1>
          </div>
          <p className="text-slate-400 max-w-2xl">
            Se ejerskiftehistorik, salgspriser og m²-pris udvikling for en ejendom. Data fra
            Tinglysning og EJF ejerskabsregistret.
          </p>
        </header>

        {/* Søgefelt */}
        <form onSubmit={handleSubmit} className="mb-6">
          <label htmlFor="bfe-input" className="block text-sm font-medium text-slate-300 mb-2">
            BFE-nummer
          </label>
          <div className="flex gap-2">
            <input
              id="bfe-input"
              type="text"
              value={bfe}
              onChange={(e) => setBfe(e.target.value)}
              placeholder="Fx: 5764389"
              className="flex-1 max-w-xs px-4 py-3 bg-slate-900 border border-slate-700 rounded-lg focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
              disabled={loading}
              aria-label="BFE-nummer"
            />
            <button
              type="submit"
              disabled={loading || !bfe.trim()}
              className="px-6 py-3 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:cursor-not-allowed rounded-lg font-medium flex items-center gap-2 transition-colors"
              aria-label="Søg"
            >
              {loading ? (
                <Loader2 className="w-5 h-5 animate-spin" aria-hidden />
              ) : (
                <Search className="w-5 h-5" aria-hidden />
              )}
              Søg
            </button>
          </div>
        </form>

        {/* Loading */}
        {loading && (
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-8 text-center">
            <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3 text-emerald-400" aria-hidden />
            <p className="text-slate-400">Henter prisudvikling…</p>
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div className="mb-6 bg-red-950/50 border border-red-900 rounded-lg p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" aria-hidden />
            <p className="text-red-300">{error}</p>
          </div>
        )}

        {/* Resultater */}
        {data && !loading && (
          <div className="space-y-6">
            {/* Ejendomsinfo kort */}
            {data.ejendom && (
              <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Building2 className="w-5 h-5 text-blue-400" aria-hidden />
                  <h2 className="font-semibold">BFE {data.bfe_nummer}</h2>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  {data.ejendom.samlet_boligareal && (
                    <div>
                      <p className="text-slate-500">Boligareal</p>
                      <p className="font-medium">{data.ejendom.samlet_boligareal} m²</p>
                    </div>
                  )}
                  {data.ejendom.opfoerelsesaar && (
                    <div>
                      <p className="text-slate-500">Opført</p>
                      <p className="font-medium">{data.ejendom.opfoerelsesaar}</p>
                    </div>
                  )}
                  {data.ejendom.energimaerke && (
                    <div>
                      <p className="text-slate-500">Energimærke</p>
                      <p className="font-medium">{data.ejendom.energimaerke}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-slate-500">Datapunkter</p>
                    <p className="font-medium">
                      {data.dataPunkter} ejerskifter, {data.medPris} med pris
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Prisudvikling chart */}
            {data.prishistorik.length > 0 && (
              <LazyPrisChart
                prishistorik={data.prishistorik}
                kommuneGennemsnit={data.kommuneGennemsnit}
              />
            )}

            {/* Ejerskabstidslinje */}
            {data.prishistorik.length > 0 && (
              <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
                <div className="flex items-center gap-2 mb-4">
                  <Users className="w-5 h-5 text-amber-400" aria-hidden />
                  <h2 className="font-semibold">Ejerskabshistorik</h2>
                </div>
                <div className="space-y-0">
                  {data.prishistorik.map((row, i) => (
                    <div key={i} className="flex items-start gap-4 relative">
                      {/* Tidslinje-linje */}
                      <div className="flex flex-col items-center">
                        <div className="w-3 h-3 rounded-full bg-emerald-500 mt-1.5 z-10" />
                        {i < data.prishistorik.length - 1 && (
                          <div className="w-0.5 flex-1 bg-slate-700 min-h-[40px]" />
                        )}
                      </div>
                      {/* Indhold */}
                      <div className="pb-4 flex-1 min-w-0">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <span className="text-sm font-medium text-slate-200">
                            {row.ejer_navn ?? 'Ukendt ejer'}
                          </span>
                          {row.ejer_cvr && (
                            <span className="text-xs text-slate-500">CVR {row.ejer_cvr}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-xs text-slate-400 flex-wrap">
                          {row.overtagelsesdato && (
                            <span>
                              {new Date(row.overtagelsesdato).toLocaleDateString('da-DK')}
                            </span>
                          )}
                          {(row.kontant_koebesum || row.i_alt_koebesum) && (
                            <span className="text-emerald-400 font-medium">
                              {(row.kontant_koebesum ?? row.i_alt_koebesum ?? 0).toLocaleString(
                                'da-DK'
                              )}{' '}
                              kr
                            </span>
                          )}
                          {row.m2_pris && (
                            <span className="text-blue-400">
                              {row.m2_pris.toLocaleString('da-DK')} kr/m²
                            </span>
                          )}
                          {row.ejer_type && (
                            <span className="px-1.5 py-0.5 bg-slate-800 rounded text-slate-500">
                              {row.ejer_type}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Ingen data */}
            {data.prishistorik.length === 0 && (
              <div className="bg-slate-900 border border-slate-800 rounded-lg p-8 text-center">
                <p className="text-slate-400">
                  Ingen ejerskiftedata fundet for BFE {data.bfe_nummer}. Data populeres løbende fra
                  Tinglysning.
                </p>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
