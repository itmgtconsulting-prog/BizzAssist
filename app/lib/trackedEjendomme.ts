/**
 * Fulgte ejendomme — Supabase-primær tracking med localStorage-fallback.
 *
 * Supabase (`/api/tracked`, `/api/notifications`) er den autoritative kilde.
 * localStorage bruges udelukkende som hurtig synkron cache og offline-fallback.
 *
 * Async-funktioner (prefixed `fetch*`) henter fra Supabase og opdaterer
 * localStorage-cachen. Synkrone `hent*`-funktioner læser kun cachen for
 * instant UI-render (f.eks. initial state i useState).
 *
 * BIZZ-180: Alle localStorage-nøgler er namespaced med brugerens Supabase
 * user ID for at forhindre data-lækage på delte enheder.
 * Kald `initCacheUserId(id)` ved login/auth-check inden brug.
 *
 * Kræver klient-side kald — må ikke importeres i Server Components.
 */

/** Base key for tracked properties (namespaced with userId at runtime) */
export const TRACKED_KEY_BASE = 'ba-tracked-ejendomme';
/** Base key for notifications (namespaced with userId at runtime) */
export const NOTIFICATIONS_KEY_BASE = 'ba-notifikationer';
/** @deprecated Use TRACKED_KEY_BASE — kept for migration of old non-namespaced data */
export const TRACKED_KEY = 'ba-tracked-ejendomme';
/** @deprecated Use NOTIFICATIONS_KEY_BASE — kept for migration of old non-namespaced data */
export const NOTIFICATIONS_KEY = 'ba-notifikationer';
export const MAX_TRACKED = 50;

// ---------------------------------------------------------------------------
// User ID namespace for localStorage keys (BIZZ-180)
// ---------------------------------------------------------------------------

/** Module-level cached user ID — set via `initCacheUserId()` */
let _cacheUserId: string | null = null;

/**
 * Initialises the user ID used to namespace all localStorage cache keys.
 * Must be called once after authentication is confirmed (e.g. in dashboard layout).
 * Also migrates any old non-namespaced keys to the new user-scoped keys.
 *
 * @param userId - Supabase auth user UUID
 */
export function initCacheUserId(userId: string): void {
  _cacheUserId = userId;
  _migrateOldKeys(userId);
}

/**
 * Returns the currently set cache user ID, or null if not yet initialised.
 *
 * @returns The user ID or null
 */
export function getCacheUserId(): string | null {
  return _cacheUserId;
}

/**
 * Clears the cached user ID. Call on logout to prevent stale data access.
 */
export function clearCacheUserId(): void {
  _cacheUserId = null;
}

/**
 * Returns the namespaced localStorage key for tracked properties.
 * Returns null if no user ID is set (prevents cross-user data access).
 *
 * @returns Namespaced key string or null
 */
function trackedKey(): string | null {
  return _cacheUserId ? `${TRACKED_KEY_BASE}_${_cacheUserId}` : null;
}

/**
 * Returns the namespaced localStorage key for notifications.
 * Returns null if no user ID is set (prevents cross-user data access).
 *
 * @returns Namespaced key string or null
 */
function notificationsKey(): string | null {
  return _cacheUserId ? `${NOTIFICATIONS_KEY_BASE}_${_cacheUserId}` : null;
}

/** Key used to track whether old non-namespaced data has been migrated */
const MIGRATION_DONE_KEY = 'ba-cache-ns-migrated';

/**
 * Migrates old non-namespaced localStorage keys to user-scoped keys.
 * Runs once per userId — subsequent calls are no-ops.
 * After migration, the old keys are removed to prevent leaking data.
 *
 * @param userId - The authenticated user's ID
 */
function _migrateOldKeys(userId: string): void {
  if (typeof window === 'undefined') return;
  const migrationFlag = `${MIGRATION_DONE_KEY}_${userId}`;
  try {
    if (window.localStorage.getItem(migrationFlag)) return;

    // Migrate tracked properties
    const oldTracked = window.localStorage.getItem(TRACKED_KEY_BASE);
    const newTrackedKey = `${TRACKED_KEY_BASE}_${userId}`;
    if (oldTracked && !window.localStorage.getItem(newTrackedKey)) {
      window.localStorage.setItem(newTrackedKey, oldTracked);
    }

    // Migrate notifications
    const oldNotifs = window.localStorage.getItem(NOTIFICATIONS_KEY_BASE);
    const newNotifsKey = `${NOTIFICATIONS_KEY_BASE}_${userId}`;
    if (oldNotifs && !window.localStorage.getItem(newNotifsKey)) {
      window.localStorage.setItem(newNotifsKey, oldNotifs);
    }

    // Remove old non-namespaced keys
    window.localStorage.removeItem(TRACKED_KEY_BASE);
    window.localStorage.removeItem(NOTIFICATIONS_KEY_BASE);

    // Mark migration as done for this user
    window.localStorage.setItem(migrationFlag, '1');
  } catch {
    /* ignore storage errors */
  }
}

/** En fulgt ejendom */
export interface TrackedEjendom {
  /** DAWA/DAR adgangsadresse UUID */
  id: string;
  /** Fuld adressestreng f.eks. "Vestergade 3, 8870 Langa" */
  adresse: string;
  /** Postnummer */
  postnr: string;
  /** Bynavn */
  by: string;
  /** Kommunenavn */
  kommune: string;
  /** BBR anvendelsestekst */
  anvendelse: string | null;
  /** Unix timestamp (ms) for hvornaar brugeren startede tracking */
  trackedSiden: number;
}

/** Notifikation om aendring paa en fulgt ejendom */
export interface EjendomNotifikation {
  /** Unik notifikations-ID */
  id: string;
  /** Reference til tracked ejendom ID */
  ejendomId: string;
  /** Adresse for visning */
  adresse: string;
  /** Type af aendring */
  type: 'bbr' | 'vurdering' | 'ejerskifte' | 'energi' | 'plan' | 'generel';
  /** Beskrivelse af aendringen */
  besked: string;
  /** Unix timestamp (ms) */
  tidspunkt: number;
  /** Om brugeren har set den */
  laest: boolean;
}

// ---------------------------------------------------------------------------
// LocalStorage cache helpers (sync — for instant render and offline fallback)
// ---------------------------------------------------------------------------

/**
 * Reads tracked properties from the localStorage cache.
 * Use this for synchronous initial state only; prefer `fetchTrackedEjendomme`
 * for the authoritative Supabase-backed list.
 *
 * Returns empty if no user ID is set (BIZZ-180: prevents cross-user data access).
 *
 * @returns Cached list of tracked properties (may be stale)
 */
export function hentTrackedEjendommeCache(): TrackedEjendom[] {
  if (typeof window === 'undefined') return [];
  const key = trackedKey();
  if (!key) return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as TrackedEjendom[];
  } catch {
    return [];
  }
}

/**
 * Reads notifications from the localStorage cache.
 * Use this for synchronous initial state only; prefer `fetchNotifikationer`
 * for the authoritative Supabase-backed list.
 *
 * Returns empty if no user ID is set (BIZZ-180: prevents cross-user data access).
 *
 * @returns Cached list of notifications (may be stale)
 */
export function hentNotifikationerCache(): EjendomNotifikation[] {
  if (typeof window === 'undefined') return [];
  const key = notificationsKey();
  if (!key) return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as EjendomNotifikation[];
  } catch {
    return [];
  }
}

/**
 * Writes tracked properties to the localStorage cache.
 * No-op if no user ID is set (BIZZ-180).
 *
 * @param items - Properties to cache
 */
function cacheTracked(items: TrackedEjendom[]): void {
  if (typeof window === 'undefined') return;
  const key = trackedKey();
  if (!key) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(items));
  } catch {
    /* ignore quota errors */
  }
}

/**
 * Writes notifications to the localStorage cache.
 * No-op if no user ID is set (BIZZ-180).
 *
 * @param items - Notifications to cache
 */
function cacheNotifikationer(items: EjendomNotifikation[]): void {
  if (typeof window === 'undefined') return;
  const key = notificationsKey();
  if (!key) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(items));
  } catch {
    /* ignore quota errors */
  }
}

// ---------------------------------------------------------------------------
// Supabase response mappers
// ---------------------------------------------------------------------------

/**
 * Maps a Supabase saved_entity record to our TrackedEjendom interface.
 *
 * @param e - Raw record from /api/tracked response
 * @returns Mapped TrackedEjendom
 */
function mapSupabaseToTracked(e: Record<string, unknown>): TrackedEjendom {
  const data = (e.entity_data ?? {}) as Record<string, unknown>;
  return {
    id: e.entity_id as string,
    adresse: (e.label as string) || (e.entity_id as string),
    postnr: (data.postnr as string) || '',
    by: (data.by as string) || '',
    kommune: (data.kommune as string) || '',
    anvendelse: (data.anvendelse as string) || null,
    trackedSiden: new Date(e.created_at as string).getTime(),
  };
}

/**
 * Maps a Supabase notification record to our EjendomNotifikation interface.
 *
 * @param n - Raw record from /api/notifications response
 * @returns Mapped EjendomNotifikation
 */
function mapSupabaseToNotifikation(n: Record<string, unknown>): EjendomNotifikation {
  return {
    id: n.id as string,
    ejendomId: n.entity_id as string,
    adresse: n.title as string,
    type: ((n.notification_type as string) || 'generel') as EjendomNotifikation['type'],
    besked: n.message as string,
    tidspunkt: new Date(n.created_at as string).getTime(),
    laest: n.is_read as boolean,
  };
}

// ---------------------------------------------------------------------------
// Supabase-primary async functions (authoritative)
// ---------------------------------------------------------------------------

/**
 * Fetches all tracked properties from Supabase (primary) with localStorage fallback.
 * Updates the localStorage cache on success.
 *
 * @returns List of tracked properties, sorted by tracking date (newest first)
 */
export async function fetchTrackedEjendomme(): Promise<TrackedEjendom[]> {
  try {
    const res = await fetch('/api/tracked');
    const data: { tracked?: Record<string, unknown>[] } = await res.json();
    if (data.tracked && data.tracked.length > 0) {
      const mapped = data.tracked.map(mapSupabaseToTracked);
      cacheTracked(mapped);
      return mapped;
    }
    // Supabase returned empty — could be unauthenticated or genuinely empty.
    // If unauthenticated, fall back to cache; if authenticated, return empty.
    if (res.ok) {
      // Authenticated but no tracked properties — clear cache to stay in sync
      cacheTracked([]);
      return [];
    }
  } catch {
    // Supabase unavailable — fall through to localStorage cache
  }
  return hentTrackedEjendommeCache();
}

/**
 * Checks if a specific property is tracked, using Supabase as the primary source.
 * Falls back to localStorage cache on failure.
 *
 * @param id - DAWA/DAR UUID
 * @returns true if the property is tracked
 */
export async function fetchErTracked(id: string): Promise<boolean> {
  const tracked = await fetchTrackedEjendomme();
  return tracked.some((e) => e.id === id);
}

/**
 * Starts tracking a property via Supabase. Updates localStorage cache.
 * Ignores duplicates. Falls back to localStorage-only on Supabase failure.
 *
 * @param ejendom - Property data to track
 */
export async function trackEjendom(ejendom: Omit<TrackedEjendom, 'trackedSiden'>): Promise<void> {
  // Optimistic localStorage update for instant UI
  const cached = hentTrackedEjendommeCache();
  if (!cached.some((e) => e.id === ejendom.id)) {
    const updated = [{ ...ejendom, trackedSiden: Date.now() }, ...cached].slice(0, MAX_TRACKED);
    cacheTracked(updated);
  }

  // Write to Supabase (primary)
  try {
    await fetch('/api/tracked', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity_id: ejendom.id,
        label: ejendom.adresse,
        entity_data: {
          postnr: ejendom.postnr,
          by: ejendom.by,
          kommune: ejendom.kommune,
          anvendelse: ejendom.anvendelse,
        },
      }),
    });
  } catch {
    // Supabase unavailable — localStorage cache already updated above
  }
}

/**
 * Stops tracking a property via Supabase and removes related notifications.
 * Updates localStorage cache. Falls back to localStorage-only on Supabase failure.
 *
 * @param id - DAWA/DAR UUID
 */
export async function untrackEjendom(id: string): Promise<void> {
  // Optimistic localStorage update
  const updatedTracked = hentTrackedEjendommeCache().filter((e) => e.id !== id);
  cacheTracked(updatedTracked);
  const updatedNotifs = hentNotifikationerCache().filter((n) => n.ejendomId !== id);
  cacheNotifikationer(updatedNotifs);

  // Delete from Supabase (primary)
  try {
    await fetch(`/api/tracked?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch {
    // Supabase unavailable — localStorage cache already updated above
  }
}

/**
 * Toggles tracking of a property. Returns the new tracking state.
 * Supabase is the primary store; localStorage is updated optimistically.
 *
 * @param ejendom - Property data
 * @returns true if the property is now tracked, false if untracked
 */
export async function toggleTrackEjendom(
  ejendom: Omit<TrackedEjendom, 'trackedSiden'>
): Promise<boolean> {
  const isTracked = hentTrackedEjendommeCache().some((e) => e.id === ejendom.id);
  if (isTracked) {
    await untrackEjendom(ejendom.id);
    return false;
  } else {
    await trackEjendom(ejendom);
    return true;
  }
}

/**
 * Fetches all notifications from Supabase (primary) with localStorage fallback.
 * Updates the localStorage cache on success.
 *
 * @returns List of notifications, newest first
 */
export async function fetchNotifikationer(): Promise<EjendomNotifikation[]> {
  try {
    const res = await fetch('/api/notifications');
    const data: { notifications?: Record<string, unknown>[] } = await res.json();
    if (data.notifications) {
      const mapped = data.notifications.map(mapSupabaseToNotifikation);
      cacheNotifikationer(mapped);
      return mapped;
    }
  } catch {
    // Supabase unavailable — fall through to localStorage cache
  }
  return hentNotifikationerCache();
}

/**
 * Returns count of unread notifications. Supabase-primary with localStorage fallback.
 *
 * @returns Number of unread notifications
 */
export async function fetchAntalUlaeste(): Promise<number> {
  try {
    const res = await fetch('/api/notifications?count=true');
    const data: { unreadCount?: number } = await res.json();
    if (typeof data.unreadCount === 'number') {
      return data.unreadCount;
    }
  } catch {
    // Supabase unavailable — count from cache
  }
  return hentNotifikationerCache().filter((n) => !n.laest).length;
}

/**
 * Marks a notification as read via Supabase. Updates localStorage cache.
 *
 * @param id - Notification ID
 */
export async function markerSomLaest(id: string): Promise<void> {
  // Optimistic localStorage update
  const notifs = hentNotifikationerCache().map((n) => (n.id === id ? { ...n, laest: true } : n));
  cacheNotifikationer(notifs);

  // Write to Supabase (primary)
  try {
    await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'mark_read', id }),
    });
  } catch {
    // Supabase unavailable — localStorage cache already updated
  }
}

/**
 * Marks all notifications as read via Supabase. Updates localStorage cache.
 */
export async function markerAlleSomLaest(): Promise<void> {
  // Optimistic localStorage update
  const notifs = hentNotifikationerCache().map((n) => ({ ...n, laest: true }));
  cacheNotifikationer(notifs);

  // Write to Supabase (primary)
  try {
    await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'mark_all_read' }),
    });
  } catch {
    // Supabase unavailable — localStorage cache already updated
  }
}

/**
 * Deletes all read notifications via Supabase. Updates localStorage cache.
 */
export async function rydLaesteNotifikationer(): Promise<void> {
  // Optimistic localStorage update
  const notifs = hentNotifikationerCache().filter((n) => !n.laest);
  cacheNotifikationer(notifs);

  // Write to Supabase (primary)
  try {
    await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete_read' }),
    });
  } catch {
    // Supabase unavailable — localStorage cache already updated
  }
}

// ---------------------------------------------------------------------------
// Deprecated synchronous aliases (backward compat — prefer async versions)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `hentTrackedEjendommeCache()` for sync or `fetchTrackedEjendomme()` for async.
 * Reads tracked properties from localStorage cache only.
 *
 * @returns Cached list of tracked properties
 */
export function hentTrackedEjendomme(): TrackedEjendom[] {
  return hentTrackedEjendommeCache();
}

/**
 * @deprecated Use `fetchErTracked()` for Supabase-primary check.
 * Synchronously checks localStorage cache only.
 *
 * @param id - DAWA/DAR UUID
 * @returns true if the property is in the localStorage cache
 */
export function erTracked(id: string): boolean {
  return hentTrackedEjendommeCache().some((e) => e.id === id);
}

/**
 * @deprecated Use `fetchNotifikationer()` for Supabase-primary list.
 * Reads notifications from localStorage cache only.
 *
 * @returns Cached list of notifications
 */
export function hentNotifikationer(): EjendomNotifikation[] {
  return hentNotifikationerCache();
}

/**
 * @deprecated Use `fetchAntalUlaeste()` for Supabase-primary count.
 * Returns count of unread notifications from localStorage cache only.
 *
 * @returns Number of unread notifications in cache
 */
export function antalUlaesteNotifikationer(): number {
  return hentNotifikationerCache().filter((n) => !n.laest).length;
}
