/**
 * IntelligenceClient — Smart SQL UI (BIZZ-1428, BIZZ-1430)
 *
 * Bruger skriver dansk-prompt → AI genererer SQL → resultat vises som
 * tabel + auto-recommendation chart. SQL kan vises i en kollapserbar blok
 * for power users.
 *
 * @module app/dashboard/analyse/intelligence/IntelligenceClient
 */

'use client';

import { useState, useCallback } from 'react';
import {
  Search,
  Loader2,
  ChevronDown,
  ChevronRight,
  Code2,
  Database,
  AlertCircle,
} from 'lucide-react';

interface SqlResponse {
  ok: boolean;
  sql: string;
  explanation?: string;
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
  'Virksomheder stiftet i 2025',
  'Hvad er den nyeste ejendomsdata?',
];

/**
 * Hovedkomponent for Data Intelligence UI.
 */
export default function IntelligenceClient(): React.ReactElement {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<SqlResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);

  const submit = useCallback(async (q: string) => {
    if (!q.trim() || q.length < 3) {
      setError('Skriv mindst 3 tegn');
      return;
    }
    setLoading(true);
    setError(null);
    setResponse(null);
    try {
      const res = await fetch('/api/analyse/sql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: q.trim() }),
      });
      const data = (await res.json()) as SqlResponse;
      if (!res.ok && !data.ok) {
        setError(data.error || 'Ukendt fejl');
        setResponse(data);
      } else {
        setResponse(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Netværksfejl');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      submit(prompt);
    },
    [prompt, submit]
  );

  const handleSuggestion = useCallback(
    (s: string) => {
      setPrompt(s);
      submit(s);
    },
    [submit]
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:bg-emerald-600 focus:text-white focus:px-4 focus:py-2 focus:rounded"
      >
        Spring til indhold
      </a>
      <main id="main" className="max-w-6xl mx-auto px-4 py-8">
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

            {/* Stats */}
            {response.sql && (
              <div className="flex flex-wrap gap-3 text-sm text-slate-400">
                <span>
                  {response.rowCount.toLocaleString('da-DK')} rækker
                  {response.truncated && ' (afkortet ved 10.000)'}
                </span>
                <span>•</span>
                <span>{response.durationMs} ms</span>
                <span>•</span>
                <span>{response.columns.length} kolonner</span>
              </div>
            )}

            {/* Result table */}
            {response.rows.length > 0 && (
              <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-800/50">
                    <tr>
                      {response.columns.map((c) => (
                        <th
                          key={c}
                          className="px-4 py-3 text-left font-medium text-slate-300"
                          scope="col"
                        >
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {response.rows.slice(0, 200).map((row, i) => (
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
                setError(null);
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

/** Format en celle-værdi til tekst-visning. */
function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return v.toLocaleString('da-DK');
  if (typeof v === 'boolean') return v ? 'ja' : 'nej';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
