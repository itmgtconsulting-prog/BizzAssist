/**
 * MultiEntityPicker — søg og tilknyt flere entiteter til en sag.
 *
 * BIZZ-983: Erstatter CustomerSearchPicker for multi-entity linking.
 * Understøtter person, virksomhed og ejendom (via /api/search).
 * Linked entities vises som chips med fjern-knap.
 *
 * @param entities - Aktuelt linkede entiteter
 * @param onAdd - Callback når en ny entitet tilføjes
 * @param onRemove - Callback når en entitet fjernes (by link ID)
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import { Search, X, Loader2, Building2, User, Home } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

/** En linket entitet fra domain_case_entity */
export interface LinkedEntity {
  id: string;
  entity_type: 'company' | 'person' | 'property';
  entity_id: string;
  entity_name: string | null;
  linked_at: string;
}

/** Ny entitet at tilføje */
export interface NewEntity {
  entity_type: 'company' | 'person' | 'property';
  entity_id: string;
  entity_name: string;
}

interface SearchResult {
  type: 'address' | 'company' | 'person';
  id: string;
  title: string;
  subtitle: string;
}

interface Props {
  /** Aktuelt linkede entiteter */
  entities: LinkedEntity[];
  /** Callback når bruger vælger en søgeresultat */
  onAdd: (entity: NewEntity) => void;
  /** Callback når bruger fjerner en entitet */
  onRemove: (linkId: string) => void;
}

/** Ikon for entitets-type */
function EntityIcon({ type }: { type: string }) {
  switch (type) {
    case 'company':
      return <Building2 className="w-3 h-3 text-blue-400" />;
    case 'person':
      return <User className="w-3 h-3 text-purple-400" />;
    case 'property':
      return <Home className="w-3 h-3 text-emerald-400" />;
    default:
      return null;
  }
}

/**
 * Multi-entity picker med søgning og chips.
 */
export default function MultiEntityPicker({ entities, onAdd, onRemove }: Props) {
  const { lang } = useLanguage();
  const da = lang === 'da';
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Debounced search
  useEffect(() => {
    if (query.length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=8`);
        if (res.ok) {
          const data = (await res.json()) as { results?: SearchResult[] };
          setResults(data.results ?? []);
          setOpen(true);
        }
      } catch {
        /* ignore */
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  // Click outside closes dropdown
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  /** Map search result type til entity_type */
  function mapType(type: string): 'company' | 'person' | 'property' {
    if (type === 'company') return 'company';
    if (type === 'person') return 'person';
    return 'property';
  }

  /** Vælg et søgeresultat */
  function handleSelect(result: SearchResult) {
    const entityType = mapType(result.type);
    // Check om allerede linket
    if (entities.some((e) => e.entity_type === entityType && e.entity_id === result.id)) {
      setQuery('');
      setOpen(false);
      return;
    }
    onAdd({
      entity_type: entityType,
      entity_id: result.id,
      entity_name: result.title,
    });
    setQuery('');
    setOpen(false);
  }

  return (
    <div className="space-y-2">
      {/* Linked entity chips */}
      {entities.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {entities.map((e) => (
            <span
              key={e.id}
              className="inline-flex items-center gap-1.5 bg-slate-800/60 border border-slate-700/50 rounded-full px-2.5 py-1 text-xs text-slate-300"
            >
              <EntityIcon type={e.entity_type} />
              <span className="truncate max-w-[150px]">{e.entity_name ?? e.entity_id}</span>
              <button
                type="button"
                onClick={() => onRemove(e.id)}
                className="text-slate-500 hover:text-red-400 transition-colors"
                aria-label={`${da ? 'Fjern' : 'Remove'} ${e.entity_name ?? e.entity_id}`}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Search input */}
      <div ref={containerRef} className="relative">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              da
                ? 'Søg person, virksomhed eller ejendom...'
                : 'Search person, company or property...'
            }
            className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg pl-8 pr-8 py-1.5 text-xs text-white placeholder:text-slate-600 outline-none focus:border-blue-500/50 transition-colors"
          />
          {loading && (
            <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-blue-400 animate-spin" />
          )}
        </div>

        {/* Dropdown results */}
        {open && results.length > 0 && (
          <div className="absolute z-20 top-full mt-1 left-0 right-0 bg-slate-900 border border-slate-700/60 rounded-lg shadow-xl max-h-60 overflow-y-auto">
            {results
              .filter((r) => r.type !== 'address')
              .map((r) => (
                <button
                  key={`${r.type}-${r.id}`}
                  type="button"
                  onClick={() => handleSelect(r)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-slate-800/60 transition-colors text-left"
                >
                  <EntityIcon type={r.type} />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-white truncate">{r.title}</p>
                    <p className="text-[10px] text-slate-500 truncate">{r.subtitle}</p>
                  </div>
                </button>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
