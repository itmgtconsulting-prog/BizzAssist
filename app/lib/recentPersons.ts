/**
 * Seneste besøgte personer — Supabase-persisteret med in-memory cache + localStorage fallback.
 *
 * Gemmer op til MAX_RECENT personer brugeren har besøgt.
 * Data synkroniseres til Supabase via /api/recents og caches i hukommelsen.
 * localStorage bruges som fallback når Supabase-auth ikke er tilgængelig.
 *
 * @module app/lib/recentPersons
 */

export const MAX_RECENT_PERSONS = 8;
const LS_KEY = 'ba-recent-persons';

/** En person gemt i historikken */
export interface RecentPerson {
  /** Enhedsnummer fra CVR */
  enhedsNummer: number;
  /** Personens navn */
  name: string;
  /** Om enheden er en virksomhed */
  erVirksomhed: boolean;
  /** Antal virksomheder personen er tilknyttet */
  antalVirksomheder: number;
  /** Unix timestamp (ms) for besøgstidspunktet */
  visitedAt: number;
}

// ── In-memory cache ────────────────────────────────────────────────────────

let _cache: RecentPerson[] | null = null;
let _fetching = false;

/** Læs fra localStorage (fallback) */
function readLS(): RecentPerson[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Skriv til localStorage (fallback) */
function writeLS(list: RecentPerson[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

/**
 * Henter historiklisten (cached efter første kald).
 * Bruger Supabase som primær kilde, localStorage som fallback.
 *
 * @returns Array of recent persons, newest first
 */
export function getRecentPersons(): RecentPerson[] {
  if (_cache !== null) return _cache;

  // Returner localStorage straks som fallback
  const lsData = readLS();
  if (lsData.length > 0) _cache = lsData;

  if (!_fetching) {
    _fetching = true;
    fetchFromServer()
      .then((list) => {
        if (list.length > 0) {
          _cache = list;
          writeLS(list);
        }
        _fetching = false;
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new Event('ba-recents-updated'));
        }
      })
      .catch(() => {
        _fetching = false;
      });
  }

  return _cache ?? [];
}

/**
 * Fetch recent persons from server.
 *
 * @returns Parsed RecentPerson array
 */
async function fetchFromServer(): Promise<RecentPerson[]> {
  if (typeof window === 'undefined') return [];
  try {
    const res = await fetch('/api/recents?type=person');
    if (!res.ok) return [];
    const json = await res.json();
    const recents: Array<Record<string, unknown>> = json.recents ?? [];
    return recents.map((r) => {
      const ed = r.entity_data as Record<string, unknown> | undefined;
      return {
        enhedsNummer: Number(r.entity_id),
        name: (r.display_name as string) ?? '',
        erVirksomhed: (ed?.erVirksomhed as boolean) ?? false,
        antalVirksomheder: (ed?.antalVirksomheder as number) ?? 0,
        visitedAt: r.visited_at ? new Date(r.visited_at as string).getTime() : Date.now(),
      };
    });
  } catch {
    return [];
  }
}

/**
 * Gemmer en person i historikken.
 * Synkroniserer til Supabase + localStorage.
 *
 * @param person - Persondata at registrere som besøgt
 */
export function saveRecentPerson(person: Omit<RecentPerson, 'visitedAt'>): void {
  if (typeof window === 'undefined') return;

  const entry: RecentPerson = { ...person, visitedAt: Date.now() };

  const existing = (_cache ?? readLS()).filter((p) => p.enhedsNummer !== person.enhedsNummer);
  _cache = [entry, ...existing].slice(0, MAX_RECENT_PERSONS);
  writeLS(_cache);

  // Dispatch event for UI re-render
  window.dispatchEvent(new Event('ba-recents-updated'));

  // Sync to Supabase (fire-and-forget)
  fetch('/api/recents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entity_type: 'person',
      entity_id: String(person.enhedsNummer),
      display_name: person.name,
      entity_data: {
        erVirksomhed: person.erVirksomhed,
        antalVirksomheder: person.antalVirksomheder,
      },
    }),
  }).catch(() => {
    /* ignore */
  });
}
