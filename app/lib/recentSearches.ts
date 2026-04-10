/**
 * Recent searches — Supabase-persisteret med in-memory cache.
 *
 * Gemmer op til MAX_ENTRIES søgninger brugeren har foretaget.
 * Data synkroniseres til Supabase via /api/recents og caches i hukommelsen.
 * Ingen localStorage — enterprise-compliant.
 *
 * @module app/lib/recentSearches
 */

const MAX_ENTRIES = 10;

/** A saved recent search entry */
export interface RecentSearch {
  /** The search query text */
  query: string;
  /** Timestamp when searched */
  ts: number;
  /** Optional result type that was selected */
  resultType?: 'address' | 'company' | 'person';
  /** Optional display title of the selected result */
  resultTitle?: string;
  /** Optional href of the selected result */
  resultHref?: string;
}

// ── In-memory cache (populated from Supabase on first read) ──────────────

let _cache: RecentSearch[] | null = null;
let _fetching = false;

/**
 * Henter søgehistorik fra Supabase (cached efter første kald).
 * Returnerer tom liste hvis ikke autentificeret eller ved fejl.
 *
 * @returns Array of recent searches, newest first
 */
export function getRecentSearches(): RecentSearch[] {
  // Return cache immediately if available
  if (_cache !== null) return _cache;

  // Trigger async fetch in background (non-blocking)
  if (!_fetching) {
    _fetching = true;
    fetchFromServer()
      .then((list) => {
        _cache = list;
        _fetching = false;
        // Dispatch event so UI can re-render with fresh data
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new Event('ba-recents-updated'));
        }
      })
      .catch(() => {
        _fetching = false;
      });
  }

  return [];
}

/**
 * Fetch recent searches from server.
 *
 * @returns Parsed RecentSearch array
 */
async function fetchFromServer(): Promise<RecentSearch[]> {
  if (typeof window === 'undefined') return [];
  try {
    const res = await fetch('/api/recents?type=search');
    if (!res.ok) return [];
    const json = await res.json();
    const recents: Array<Record<string, unknown>> = json.recents ?? [];
    // Map Supabase rows to RecentSearch
    return recents.map((r) => {
      const ed = r.entity_data as Record<string, unknown> | undefined;
      return {
        query: (r.display_name as string) ?? '',
        ts: r.visited_at ? new Date(r.visited_at as string).getTime() : Date.now(),
        resultType: (ed?.resultType as RecentSearch['resultType']) ?? undefined,
        resultTitle: (ed?.resultTitle as string | undefined) ?? undefined,
        resultHref: (ed?.resultHref as string | undefined) ?? undefined,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Force refresh cache from server.
 * Call after login or when you need guaranteed fresh data.
 *
 * @returns Updated list of recent searches
 */
export async function refreshRecentSearches(): Promise<RecentSearch[]> {
  const list = await fetchFromServer();
  _cache = list;
  return list;
}

/**
 * Save a search entry to recent searches.
 * Deduplicates by query text (case-insensitive).
 * Synkroniserer til Supabase i baggrunden (fire-and-forget).
 *
 * @param entry - The search entry to save
 */
export function saveRecentSearch(entry: RecentSearch): void {
  if (typeof window === 'undefined') return;

  // Update in-memory cache immediately for instant UI feedback
  const existing = (_cache ?? []).filter(
    (s) => s.query.toLowerCase() !== entry.query.toLowerCase()
  );
  _cache = [entry, ...existing].slice(0, MAX_ENTRIES);

  // Sync to Supabase in background (fire-and-forget)
  // Use query as entity_id (lowercased for dedup)
  fetch('/api/recents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entity_type: 'search',
      entity_id: entry.query.toLowerCase().trim(),
      display_name: entry.query,
      entity_data: {
        resultType: entry.resultType ?? null,
        resultTitle: entry.resultTitle ?? null,
        resultHref: entry.resultHref ?? null,
      },
    }),
  }).catch(() => {
    /* ignore sync errors */
  });
}

/**
 * Clear all recent searches.
 * Sletter fra Supabase i baggrunden.
 */
export function clearRecentSearches(): void {
  _cache = [];

  // Sync deletion to Supabase (fire-and-forget)
  if (typeof window !== 'undefined') {
    fetch('/api/recents?type=search', { method: 'DELETE' }).catch(() => {
      /* ignore */
    });
  }
}
