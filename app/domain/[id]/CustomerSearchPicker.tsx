/**
 * CustomerSearchPicker — autocomplete input that searches the existing
 * BizzAssist customer database (CVR companies + persons via /api/search)
 * and emits a structured customer-link ({ kind, cvr|personId, name }).
 *
 * BIZZ-802: Enables optional customer linking on a domain case. The
 * picker deliberately filters out 'address' results — only 'company' and
 * 'person' can be linked as customers.
 *
 * Parent owns the `value` state so the picker is both usable in create
 * forms (uncontrolled via useState) and edit flows (controlled).
 *
 * @module app/domain/[id]/CustomerSearchPicker
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import { Search, Building2, User, X, Loader2 } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

export interface CustomerLink {
  kind: 'company' | 'person';
  cvr: string | null;
  person_id: string | null;
  name: string;
}

interface SearchResult {
  type: 'address' | 'company' | 'person';
  id: string;
  title: string;
  subtitle: string;
  score: number;
}

interface Props {
  value: CustomerLink | null;
  onChange: (v: CustomerLink | null) => void;
  placeholder?: string;
  /** Compact mode for inline use — smaller padding + font. */
  compact?: boolean;
}

/**
 * Controlled customer picker. Debounces search by 250ms, shows up to 10
 * results grouped by type. Selecting a result clears the input and sets
 * the parent value.
 */
export function CustomerSearchPicker({ value, onChange, placeholder, compact }: Props) {
  const { lang } = useLanguage();
  const da = lang === 'da';

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Debounced search. Only fires when query >= 2 chars.
  useEffect(() => {
    if (value) return; // stop searching after user picked one
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    const handle = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        if (!r.ok) {
          setResults([]);
          return;
        }
        const json = (await r.json()) as SearchResult[] | { results: SearchResult[] };
        const arr = Array.isArray(json) ? json : (json.results ?? []);
        // Only customers are linkable — addresses aren't customers.
        setResults(arr.filter((x) => x.type === 'company' || x.type === 'person'));
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [query, value]);

  // Close dropdown on outside click
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const pick = (r: SearchResult) => {
    onChange({
      kind: r.type === 'company' ? 'company' : 'person',
      cvr: r.type === 'company' ? r.id : null,
      person_id: r.type === 'person' ? r.id : null,
      name: r.title,
    });
    setQuery('');
    setResults([]);
    setOpen(false);
  };

  const clear = () => {
    onChange(null);
    setQuery('');
    setResults([]);
  };

  const inputBase = compact ? 'px-2 py-1.5 text-xs' : 'px-3 py-2 text-sm';

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 bg-slate-900/60 border border-blue-500/40 rounded-md px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          {value.kind === 'company' ? (
            <Building2 size={14} className="text-emerald-400 shrink-0" />
          ) : (
            <User size={14} className="text-sky-400 shrink-0" />
          )}
          <div className="min-w-0">
            <p className="text-sm text-white truncate">{value.name}</p>
            <p className="text-[10px] text-slate-500 uppercase">
              {value.kind === 'company'
                ? `CVR ${value.cvr}`
                : da
                  ? `Person · ${value.person_id}`
                  : `Person · ${value.person_id}`}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={clear}
          aria-label={da ? 'Fjern kunde' : 'Remove customer'}
          className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors shrink-0"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none"
        />
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={
            placeholder ??
            (da ? 'Søg virksomhed (CVR) eller person…' : 'Search company (CVR) or person…')
          }
          className={`w-full pl-9 pr-3 bg-slate-900 border border-slate-700 rounded-md text-white ${inputBase}`}
        />
        {loading && (
          <Loader2
            size={14}
            className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-slate-400"
          />
        )}
      </div>
      {open && query.trim().length >= 2 && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-slate-900 border border-slate-700 rounded-md shadow-xl z-50 max-h-72 overflow-y-auto">
          {results.length === 0 && !loading && (
            <p className="px-3 py-3 text-xs text-slate-500">
              {da ? 'Ingen kunder fundet' : 'No customers found'}
            </p>
          )}
          {results.map((r) => (
            <button
              key={`${r.type}-${r.id}`}
              type="button"
              onClick={() => pick(r)}
              className="w-full text-left px-3 py-2 hover:bg-slate-800 flex items-start gap-2 border-b border-slate-800 last:border-0"
            >
              {r.type === 'company' ? (
                <Building2 size={14} className="text-emerald-400 mt-0.5 shrink-0" />
              ) : (
                <User size={14} className="text-sky-400 mt-0.5 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm text-white truncate">{r.title}</p>
                <p className="text-[11px] text-slate-400 truncate">{r.subtitle}</p>
              </div>
              <span className="text-[10px] text-slate-600 uppercase mt-0.5 shrink-0">
                {r.type === 'company' ? 'CVR' : da ? 'Person' : 'Person'}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
