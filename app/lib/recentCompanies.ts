/**
 * Seneste besøgte virksomheder — Supabase-persisteret med in-memory cache + localStorage fallback.
 *
 * Gemmer op til MAX_RECENT virksomheder brugeren har besøgt.
 * Data synkroniseres til Supabase via /api/recents og caches i hukommelsen.
 * localStorage bruges som fallback når Supabase-auth ikke er tilgængelig.
 *
 * @module app/lib/recentCompanies
 */

export const MAX_RECENT_COMPANIES = 8;
const LS_KEY = 'ba-recent-companies';

/** En virksomhed gemt i historikken */
export interface RecentCompany {
  /** CVR-nummer */
  cvr: number;
  /** Virksomhedsnavn */
  name: string;
  /** Branche / industri */
  industry: string | null;
  /** Adresse */
  address: string | null;
  /** Postnummer */
  zipcode: string | null;
  /** By */
  city: string | null;
  /** Om virksomheden er aktiv */
  active: boolean;
  /** Unix timestamp (ms) for besøgstidspunktet */
  visitedAt: number;
}

// ── In-memory cache ────────────────────────────────────────────────────────

let _cache: RecentCompany[] | null = null;
let _fetching = false;

/** Læs fra localStorage (fallback) */
function readLS(): RecentCompany[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Skriv til localStorage (fallback) */
function writeLS(list: RecentCompany[]): void {
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
 * @returns Array of recent companies, newest first
 */
export function getRecentCompanies(): RecentCompany[] {
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
 * Fetch recent companies from server.
 *
 * @returns Parsed RecentCompany array
 */
async function fetchFromServer(): Promise<RecentCompany[]> {
  if (typeof window === 'undefined') return [];
  try {
    const res = await fetch('/api/recents?type=company');
    if (!res.ok) return [];
    const json = await res.json();
    const recents = json.recents ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return recents.map((r: any) => ({
      cvr: Number(r.entity_id),
      name: r.display_name ?? '',
      industry: r.entity_data?.industry ?? null,
      address: r.entity_data?.address ?? null,
      zipcode: r.entity_data?.zipcode ?? null,
      city: r.entity_data?.city ?? null,
      active: r.entity_data?.active ?? true,
      visitedAt: r.visited_at ? new Date(r.visited_at).getTime() : Date.now(),
    }));
  } catch {
    return [];
  }
}

/**
 * Force refresh cache from server.
 *
 * @returns Updated list of recent companies
 */
export async function refreshRecentCompanies(): Promise<RecentCompany[]> {
  const list = await fetchFromServer();
  if (list.length > 0) {
    _cache = list;
    writeLS(list);
  }
  return _cache ?? readLS();
}

/**
 * Gemmer en virksomhed i historikken.
 * Synkroniserer til Supabase + localStorage.
 *
 * @param company - Virksomhedsdata at registrere som set
 */
export function saveRecentCompany(company: Omit<RecentCompany, 'visitedAt'>): void {
  if (typeof window === 'undefined') return;

  const entry: RecentCompany = { ...company, visitedAt: Date.now() };

  const existing = (_cache ?? readLS()).filter((c) => c.cvr !== company.cvr);
  _cache = [entry, ...existing].slice(0, MAX_RECENT_COMPANIES);
  writeLS(_cache);

  // Dispatch event for UI re-render
  window.dispatchEvent(new Event('ba-recents-updated'));

  // Sync to Supabase (fire-and-forget)
  fetch('/api/recents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entity_type: 'company',
      entity_id: String(company.cvr),
      display_name: company.name,
      entity_data: {
        industry: company.industry,
        address: company.address,
        zipcode: company.zipcode,
        city: company.city,
        active: company.active,
      },
    }),
  }).catch(() => {
    /* ignore */
  });
}
