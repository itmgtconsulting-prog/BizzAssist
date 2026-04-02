/**
 * Seneste sete ejendomme — Supabase-persisteret med in-memory cache + localStorage fallback.
 *
 * Gemmer op til MAX_RECENT ejendomme som brugeren har besøgt.
 * Data synkroniseres til Supabase via /api/recents og caches i hukommelsen.
 * localStorage bruges som fallback når Supabase-auth ikke er tilgængelig.
 *
 * @module app/lib/recentEjendomme
 */

export const MAX_RECENT_EJENDOMME = 6;
const LS_KEY = 'ba-recent-ejendomme';

/** Et ejendom-besøg gemt i historikken */
export interface RecentEjendom {
  /** DAWA adgangsadresse UUID */
  id: string;
  /** Fuld adressestreng f.eks. "Søbyvej 11" */
  adresse: string;
  /** Postnummer f.eks. "2650" */
  postnr: string;
  /** Bynavn f.eks. "Hvidovre" */
  by: string;
  /** Kommunenavn f.eks. "Hvidovre Kommune" */
  kommune: string;
  /** BBR anvendelsestekst — vises som badge, f.eks. "Fritliggende enfamilieshus" */
  anvendelse: string | null;
  /** Unix timestamp (ms) for besøgstidspunktet */
  senestiSet: number;
}

// ── In-memory cache ────────────────────────────────────────────────────────

let _cache: RecentEjendom[] | null = null;
let _fetching = false;

/** Læs fra localStorage (fallback) */
function readLS(): RecentEjendom[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Skriv til localStorage (fallback) */
function writeLS(list: RecentEjendom[]): void {
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
 * @returns Array of recent properties, newest first
 */
export function hentRecentEjendomme(): RecentEjendom[] {
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
 * Fetch recent properties from server.
 *
 * @returns Parsed RecentEjendom array
 */
async function fetchFromServer(): Promise<RecentEjendom[]> {
  if (typeof window === 'undefined') return [];
  try {
    const res = await fetch('/api/recents?type=property');
    if (!res.ok) return [];
    const json = await res.json();
    const recents = json.recents ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return recents.map((r: any) => ({
      id: r.entity_id,
      adresse: r.display_name ?? '',
      postnr: r.entity_data?.postnr ?? '',
      by: r.entity_data?.by ?? '',
      kommune: r.entity_data?.kommune ?? '',
      anvendelse: r.entity_data?.anvendelse ?? null,
      senestiSet: r.visited_at ? new Date(r.visited_at).getTime() : Date.now(),
    }));
  } catch {
    return [];
  }
}

/**
 * Force refresh cache from server.
 *
 * @returns Updated list of recent properties
 */
export async function refreshRecentEjendomme(): Promise<RecentEjendom[]> {
  const list = await fetchFromServer();
  if (list.length > 0) {
    _cache = list;
    writeLS(list);
  }
  return _cache ?? readLS();
}

/**
 * Tilføjer eller opdaterer en ejendom i historikken.
 * Synkroniserer til Supabase + localStorage.
 *
 * @param ejendom - Ejendom at registrere som set
 */
export function gemRecentEjendom(ejendom: Omit<RecentEjendom, 'senestiSet'>): void {
  if (typeof window === 'undefined') return;

  const entry: RecentEjendom = { ...ejendom, senestiSet: Date.now() };

  const existing = (_cache ?? readLS()).filter((e) => e.id !== ejendom.id);
  _cache = [entry, ...existing].slice(0, MAX_RECENT_EJENDOMME);
  writeLS(_cache);

  // Dispatch event for UI re-render
  window.dispatchEvent(new Event('ba-recents-updated'));

  // Sync to Supabase (fire-and-forget)
  fetch('/api/recents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entity_type: 'property',
      entity_id: ejendom.id,
      display_name: ejendom.adresse,
      entity_data: {
        postnr: ejendom.postnr,
        by: ejendom.by,
        kommune: ejendom.kommune,
        anvendelse: ejendom.anvendelse,
      },
    }),
  }).catch(() => {
    /* ignore */
  });
}
