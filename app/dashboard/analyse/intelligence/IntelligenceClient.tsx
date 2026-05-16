/**
 * IntelligenceClient — Smart SQL UI (BIZZ-1428, BIZZ-1430, BIZZ-1453)
 *
 * Bruger skriver dansk-prompt → AI genererer SQL → resultat vises som
 * tabel + auto-recommendation chart. SQL kan vises i en kollapserbar blok
 * for power users. Forslag-knapper ved forklaringer.
 *
 * @module app/dashboard/analyse/intelligence/IntelligenceClient
 */

'use client';

import { useState, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import {
  Search,
  Loader2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Code2,
  Database,
  AlertCircle,
  Download,
  BarChart3,
  Lightbulb,
} from 'lucide-react';

/**
 * Lazy-load Recharts for at undgå tunge imports ved initial page load.
 * ssr: false fordi Recharts kræver browser DOM.
 */
const LazyChart = dynamic(() => import('./IntelligenceChart'), { ssr: false });

interface SqlResponse {
  ok: boolean;
  sql: string;
  explanation?: string;
  suggestions?: string[];
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  error?: string;
}

const SUGGESTIONS = [
  'Hvor mange virksomheder er der i alt?',
  'Top 10 brancher efter antal aktive virksomheder',
  'Hvilken kommune har flest virksomheder?',
  'Find virksomheder der ejer mere end 5 ejendomme',
  'Hvor mange ejendomme mangler energimærke?',
  'Top 20 virksomhedsformer',
  'Ejerskifter per måned de seneste 12 måneder',
  'Hvad er den nyeste ejendomsdata?',
];

type SortDir = 'asc' | 'desc' | null;

/**
 * Hovedkomponent for Data Intelligence UI.
 */
export default function IntelligenceClient(): React.ReactElement {
  const [prompt, setPrompt] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<SqlResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);
  const [showChart, setShowChart] = useState(true);
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  /** Chat-kontekst: forrige prompt + SQL til iterativ tilpasning. */
  const [previousPrompt, setPreviousPrompt] = useState<string | null>(null);
  const [previousSql, setPreviousSql] = useState<string | null>(null);

  /**
   * Submit en prompt til API'en.
   * BIZZ-1555: Tilføjet client-side AbortSignal.timeout (95s — over server's
   * maxDuration på 90s) så bruger ikke venter uendeligt på hængte requests.
   * Detekter også "stille fejl"-tilfælde hvor API returnerer ok=true men
   * ingen rows + ingen forklaring (typisk AI hallucinering hvor SQL eksekverede
   * men returnerede tomt resultat).
   */
  const submit = useCallback(async (q: string) => {
    if (!q.trim() || q.length < 3) {
      setError('Skriv mindst 3 tegn');
      return;
    }
    setLoading(true);
    setError(null);
    setResponse(null);
    setSortCol(null);
    setSortDir(null);
    try {
      const res = await fetch('/api/analyse/sql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: q.trim(),
          ...(previousPrompt && previousSql ? { previousPrompt, previousSql } : {}),
        }),
        signal: AbortSignal.timeout(95_000),
      });
      let data: SqlResponse;
      try {
        data = (await res.json()) as SqlResponse;
      } catch {
        setError(
          `Server svarede ikke korrekt (HTTP ${res.status}). Prøv at omformulere spørgsmålet eller del det op i mindre dele.`
        );
        return;
      }
      if (!res.ok && !data.ok) {
        setError(data.error || `Ukendt fejl (HTTP ${res.status})`);
        setResponse(data);
      } else {
        // BIZZ-1555: Synliggør stille fejl-cases
        // - response.ok=true men ingen sql, ingen explanation, ingen rows → bug
        if (data.ok && !data.sql && !data.explanation && data.rows.length === 0) {
          setError(
            'AI returnerede et tomt svar. Prøv at omformulere eller del spørgsmålet op i mindre dele (fx start med "hvor mange boliger solgt i hvidovre", spørg så efter m²-pris bagefter).'
          );
        }
        setResponse(data);
        // Gem kontekst til follow-up
        if (data.ok && data.sql) {
          setPreviousPrompt(q.trim());
          setPreviousSql(data.sql);
        }
      }
    } catch (err) {
      // BIZZ-1555: Skeln mellem timeout og generisk netværksfejl
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        setError(
          'Spørgsmålet tog over 95 sekunder. Det er typisk for komplekse joins (fx m²-pris kræver BBR-data). Prøv at del spørgsmålet op eller spørg mere specifikt.'
        );
      } else {
        setError(err instanceof Error ? err.message : 'Netværksfejl');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  /** Form submit handler. */
  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      submit(prompt);
    },
    [prompt, submit]
  );

  /** Klik på forslags-knap. */
  const handleSuggestion = useCallback(
    (s: string) => {
      setPrompt(s);
      submit(s);
    },
    [submit]
  );

  /** Sortér data. */
  const handleSort = useCallback(
    (col: string) => {
      if (sortCol === col) {
        setSortDir((d) => (d === 'asc' ? 'desc' : d === 'desc' ? null : 'asc'));
        if (sortDir === 'desc') setSortCol(null);
      } else {
        setSortCol(col);
        setSortDir('asc');
      }
    },
    [sortCol, sortDir]
  );

  /** Sorterede rækker. */
  const sortedRows = useMemo(() => {
    if (!response?.rows || !sortCol || !sortDir) return response?.rows ?? [];
    return [...response.rows].sort((a, b) => {
      const av = a[sortCol];
      const bv = b[sortCol];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv), 'da');
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [response?.rows, sortCol, sortDir]);

  /** Eksportér som CSV. */
  const exportCsv = useCallback(() => {
    if (!response?.rows.length || !response.columns.length) return;
    const sep = ';';
    const header = response.columns.join(sep);
    const rows = response.rows.map((row) =>
      response.columns
        .map((c) => {
          const v = row[c];
          if (v == null) return '';
          const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
          return s.includes(sep) || s.includes('"') || s.includes('\n')
            ? `"${s.replace(/"/g, '""')}"`
            : s;
        })
        .join(sep)
    );
    const csv = [header, ...rows].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bizzassist-data-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [response]);

  return (
    // BIZZ-1554: flex-1 + min-w-0 sikrer at content udnytter fuld bredde af
    // dashboard-layoutets flex-container. Tidligere uden flex-1 kollapsede
    // viewporten til ~450px når response-grid bestod af enkelte rows.
    <div className="flex-1 min-w-0 min-h-screen bg-slate-950 text-slate-100 overflow-y-auto">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:bg-emerald-600 focus:text-white focus:px-4 focus:py-2 focus:rounded"
      >
        Spring til indhold
      </a>
      <main id="main" className="w-full px-6 py-8">
        <header className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <Database className="w-7 h-7 text-emerald-400" aria-hidden />
            <h1 className="text-2xl font-bold">Data Intelligence</h1>
          </div>
          <p className="text-slate-400 max-w-2xl">
            Stil et spørgsmål på dansk om vores virksomheds- og ejendomsdata. AI&apos;en genererer
            sikker PostgreSQL og kører den read-only mod vores datasæt.
          </p>
        </header>

        {/* Prompt input */}
        <form onSubmit={handleSubmit} className="mb-6">
          <label htmlFor="prompt" className="block text-sm font-medium text-slate-300 mb-2">
            Dit spørgsmål
          </label>
          <div className="flex gap-2">
            <input
              id="prompt"
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Fx: Hvilken kommune har flest virksomheder?"
              className="flex-1 px-4 py-3 bg-slate-900 border border-slate-700 rounded-lg focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
              disabled={loading}
              maxLength={1000}
              aria-label="Dit spørgsmål"
            />
            <button
              type="submit"
              disabled={loading || prompt.trim().length < 3}
              className="px-6 py-3 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:cursor-not-allowed rounded-lg font-medium flex items-center gap-2 transition-colors"
              aria-label="Spørg"
            >
              {loading ? (
                <Loader2 className="w-5 h-5 animate-spin" aria-hidden />
              ) : (
                <Search className="w-5 h-5" aria-hidden />
              )}
              Spørg
            </button>
          </div>
        </form>

        {/* Forslag */}
        {!response && !loading && (
          <div className="mb-6">
            <p className="text-sm text-slate-400 mb-3">Eller prøv et af disse spørgsmål:</p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => handleSuggestion(s)}
                  className="text-sm px-3 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors text-left"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Loader */}
        {loading && (
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-8 text-center">
            <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3 text-emerald-400" aria-hidden />
            <p className="text-slate-400">Genererer SQL og henter data…</p>
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div className="mb-6 bg-red-950/50 border border-red-900 rounded-lg p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" aria-hidden />
            <div>
              <p className="font-medium text-red-200">Fejl</p>
              <p className="text-sm text-red-300 mt-1">{error}</p>
            </div>
          </div>
        )}

        {/* Response */}
        {response && !loading && (
          <div className="space-y-4">
            {/* Explanation case */}
            {response.explanation && (
              <div className="bg-amber-950/30 border border-amber-900 rounded-lg p-4">
                <p className="text-amber-100">{response.explanation}</p>
              </div>
            )}

            {/* Suggestions from AI */}
            {response.suggestions && response.suggestions.length > 0 && (
              <div className="bg-slate-900 border border-slate-700 rounded-lg p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Lightbulb className="w-4 h-4 text-amber-400" aria-hidden />
                  <p className="text-sm font-medium text-slate-300">
                    Prøv i stedet et af disse spørgsmål:
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {response.suggestions.map((s) => (
                    <button
                      key={s}
                      onClick={() => handleSuggestion(s)}
                      className="text-sm px-3 py-2 bg-emerald-900/30 hover:bg-emerald-800/40 border border-emerald-800 rounded-lg transition-colors text-emerald-200 text-left"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* SQL (collapsible) */}
            {response.sql && (
              <div className="bg-slate-900 border border-slate-800 rounded-lg">
                <button
                  onClick={() => setShowSql((v) => !v)}
                  className="w-full px-4 py-3 flex items-center justify-between hover:bg-slate-800/50 rounded-lg"
                  aria-expanded={showSql}
                  aria-controls="sql-block"
                >
                  <div className="flex items-center gap-2">
                    <Code2 className="w-4 h-4 text-slate-400" aria-hidden />
                    <span className="text-sm font-medium text-slate-300">
                      {showSql ? 'Skjul' : 'Vis'} genereret SQL
                    </span>
                  </div>
                  {showSql ? (
                    <ChevronDown className="w-4 h-4 text-slate-400" aria-hidden />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-slate-400" aria-hidden />
                  )}
                </button>
                {showSql && (
                  <pre
                    id="sql-block"
                    className="px-4 py-3 border-t border-slate-800 text-xs text-slate-300 overflow-x-auto whitespace-pre-wrap"
                  >
                    <code>{response.sql}</code>
                  </pre>
                )}
              </div>
            )}

            {/* Stats + actions row */}
            {response.sql && (
              <div className="flex flex-wrap items-center gap-3 text-sm text-slate-400">
                <span>
                  {response.rowCount.toLocaleString('da-DK')} rækker
                  {response.truncated && ' (afkortet ved 10.000)'}
                </span>
                <span>•</span>
                <span>{response.durationMs} ms</span>
                <span>•</span>
                <span>{response.columns.length} kolonner</span>
                {response.rows.length > 0 && (
                  <>
                    <span>•</span>
                    <button
                      onClick={exportCsv}
                      className="flex items-center gap-1 text-emerald-400 hover:text-emerald-300 transition-colors"
                      aria-label="Download som CSV"
                    >
                      <Download className="w-4 h-4" aria-hidden />
                      CSV
                    </button>
                    <span>•</span>
                    <button
                      onClick={() => setShowChart((v) => !v)}
                      className={`flex items-center gap-1 transition-colors ${showChart ? 'text-emerald-400 hover:text-emerald-300' : 'text-slate-500 hover:text-slate-400'}`}
                      aria-label={showChart ? 'Skjul graf' : 'Vis graf'}
                    >
                      <BarChart3 className="w-4 h-4" aria-hidden />
                      Graf
                    </button>
                  </>
                )}
              </div>
            )}

            {/* Chart */}
            {showChart && response.rows.length > 0 && response.columns.length >= 2 && (
              <LazyChart columns={response.columns} rows={response.rows} />
            )}

            {/* Follow-up / tilpas resultat — placeret lige under graf for synlighed */}
            {response?.ok && response.sql && (
              <div className="bg-slate-900/50 border border-emerald-500/20 rounded-lg p-3">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (followUp.trim().length >= 3) {
                      setPrompt(followUp);
                      submit(followUp);
                      setFollowUp('');
                    }
                  }}
                  className="flex gap-2 items-center"
                >
                  <Lightbulb className="w-4 h-4 text-emerald-400 flex-shrink-0" aria-hidden />
                  <input
                    type="text"
                    value={followUp}
                    onChange={(e) => setFollowUp(e.target.value)}
                    placeholder="Tilpas: filtrer kommune, ændr sortering, tilføj kolonner..."
                    className="flex-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm focus:border-emerald-500 focus:outline-none"
                    disabled={loading}
                    maxLength={500}
                  />
                  <button
                    type="submit"
                    disabled={loading || followUp.trim().length < 3}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors whitespace-nowrap"
                  >
                    {loading ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : 'Tilpas'}
                  </button>
                </form>
              </div>
            )}

            {/* Result table */}
            {sortedRows.length > 0 && (
              <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-800/50">
                    <tr>
                      {response.columns.map((c) => (
                        <th
                          key={c}
                          className="px-4 py-3 text-left font-medium text-slate-300 cursor-pointer hover:text-emerald-400 select-none transition-colors"
                          scope="col"
                          onClick={() => handleSort(c)}
                          aria-sort={
                            sortCol === c && sortDir
                              ? sortDir === 'asc'
                                ? 'ascending'
                                : 'descending'
                              : 'none'
                          }
                        >
                          <span className="flex items-center gap-1">
                            {translateColumn(c)}
                            {sortCol === c && sortDir === 'asc' && (
                              <ChevronUp className="w-3 h-3" aria-hidden />
                            )}
                            {sortCol === c && sortDir === 'desc' && (
                              <ChevronDown className="w-3 h-3" aria-hidden />
                            )}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.slice(0, 200).map((row, i) => (
                      <tr key={i} className="border-t border-slate-800 hover:bg-slate-800/30">
                        {response.columns.map((c) => (
                          <td key={c} className="px-4 py-2 text-slate-200">
                            {formatCell(row[c])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {response.rows.length > 200 && (
                  <p className="px-4 py-3 text-xs text-slate-500 border-t border-slate-800">
                    Viser de første 200 af {response.rows.length} rækker.
                  </p>
                )}
              </div>
            )}

            {/* New question */}
            <button
              onClick={() => {
                setResponse(null);
                setPrompt('');
                setFollowUp('');
                setError(null);
                setPreviousPrompt(null);
                setPreviousSql(null);
              }}
              className="text-sm text-emerald-400 hover:text-emerald-300"
            >
              ← Stil et nyt spørgsmål
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

/** Map tekniske kolonnenavne til danske labels. */
const COLUMN_LABELS: Record<string, string> = {
  bfe_nummer: 'BFE-nummer',
  kommune_kode: 'Kommunekode',
  kommunenavn: 'Kommune',
  region: 'Region',
  branche_kode: 'Branchekode',
  branche_tekst: 'Branche',
  virksomhedsform: 'Virksomhedsform',
  byg021_anvendelse: 'Anvendelseskode',
  anvendelse_kode: 'Anvendelseskode',
  anvendelse_tekst: 'Anvendelse',
  anvendelse_kategori: 'Kategori',
  samlet_boligareal: 'Boligareal (m²)',
  boligareal_m2: 'Boligareal (m²)',
  opfoerelsesaar: 'Opført',
  energimaerke: 'Energimærke',
  ejendomsvaerdi: 'Ejendomsværdi',
  grundvaerdi: 'Grundværdi',
  vurderingsaar: 'Vurderingsår',
  ejer_navn: 'Ejer',
  ejer_cvr: 'Ejer CVR',
  ejer_type: 'Ejertype',
  ejerandel_pct: 'Ejerandel (%)',
  virkning_fra: 'Gældende fra',
  overtagelsesdato: 'Overtagelsesdato',
  kontant_koebesum: 'Købesum (DKK)',
  i_alt_koebesum: 'Total købesum',
  m2_pris: 'M²-pris',
  antal: 'Antal',
  total: 'Total',
  aktive: 'Aktive',
  ophoert: 'Ophørt',
  stiftet: 'Stiftet',
  ansatte: 'Ansatte',
  antal_ejendomme: 'Antal ejendomme',
  antal_ejerskifter: 'Antal ejerskifter',
  unikke_ejendomme: 'Unikke ejendomme',
  maaned: 'Måned',
  gennemsnitspris: 'Gennemsnitspris',
  medianpris: 'Medianpris',
  omsaetning: 'Omsætning',
  aarsresultat: 'Årsresultat',
  egenkapital: 'Egenkapital',
  seneste_aar: 'Regnskabsår',
};

/** Oversæt kolonnenavn til dansk label. */
function translateColumn(col: string): string {
  return COLUMN_LABELS[col] ?? col.replace(/_/g, ' ');
}

/** Format en celle-værdi til tekst-visning. */
function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return v.toLocaleString('da-DK');
  if (typeof v === 'boolean') return v ? 'ja' : 'nej';
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  // Konverter ISO timestamps/datoer til dansk format
  if (/^\d{4}-\d{2}-\d{2}(T|\s)\d{2}:\d{2}/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime()))
      return d.toLocaleDateString('da-DK', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s + 'T00:00:00');
    if (!isNaN(d.getTime()))
      return d.toLocaleDateString('da-DK', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  return s;
}
