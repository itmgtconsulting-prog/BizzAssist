/**
 * Fulgte ejendomme — localStorage-baseret tracking.
 *
 * Gemmer ejendomme brugeren følger, med et simpelt notifikationssystem
 * der registrerer ændringer (BBR, ejerskifte, vurdering) ved besøg.
 *
 * Migreres til Supabase `saved_entities` (is_monitored=true) når
 * auth-flow er fuldt integreret. Se lib/db/tenant.ts → savedEntities.
 *
 * Kræver klient-side kald (localStorage) — må ikke importeres i Server Components.
 */

export const TRACKED_KEY = 'ba-tracked-ejendomme';
export const NOTIFICATIONS_KEY = 'ba-notifikationer';
export const MAX_TRACKED = 50;

/** En fulgt ejendom */
export interface TrackedEjendom {
  /** DAWA/DAR adgangsadresse UUID */
  id: string;
  /** Fuld adressestreng f.eks. "Vestergade 3, 8870 Langå" */
  adresse: string;
  /** Postnummer */
  postnr: string;
  /** Bynavn */
  by: string;
  /** Kommunenavn */
  kommune: string;
  /** BBR anvendelsestekst */
  anvendelse: string | null;
  /** Unix timestamp (ms) for hvornår brugeren startede tracking */
  trackedSiden: number;
}

/** Notifikation om ændring på en fulgt ejendom */
export interface EjendomNotifikation {
  /** Unik notifikations-ID */
  id: string;
  /** Reference til tracked ejendom ID */
  ejendomId: string;
  /** Adresse for visning */
  adresse: string;
  /** Type af ændring */
  type: 'bbr' | 'vurdering' | 'ejerskifte' | 'energi' | 'plan' | 'generel';
  /** Beskrivelse af ændringen */
  besked: string;
  /** Unix timestamp (ms) */
  tidspunkt: number;
  /** Om brugeren har set den */
  laest: boolean;
}

/**
 * Henter alle fulgte ejendomme fra localStorage.
 *
 * @returns Liste af fulgte ejendomme, sorteret efter tracking-dato (nyeste først)
 */
export function hentTrackedEjendomme(): TrackedEjendom[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(TRACKED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as TrackedEjendom[];
  } catch {
    return [];
  }
}

/**
 * Tjekker om en ejendom er fulgt.
 *
 * @param id - DAWA/DAR UUID
 * @returns true hvis ejendommen følges
 */
export function erTracked(id: string): boolean {
  return hentTrackedEjendomme().some((e) => e.id === id);
}

/**
 * Starter tracking af en ejendom.
 * Ignorerer duplikater. Trimmer til MAX_TRACKED.
 *
 * @param ejendom - Ejendom-data at tracke
 */
export function trackEjendom(ejendom: Omit<TrackedEjendom, 'trackedSiden'>): void {
  if (typeof window === 'undefined') return;
  try {
    const eksisterende = hentTrackedEjendomme();
    if (eksisterende.some((e) => e.id === ejendom.id)) return;
    const opdateret: TrackedEjendom[] = [
      { ...ejendom, trackedSiden: Date.now() },
      ...eksisterende,
    ].slice(0, MAX_TRACKED);
    window.localStorage.setItem(TRACKED_KEY, JSON.stringify(opdateret));
  } catch {
    /* ignorer kvote-fejl */
  }
}

/**
 * Stopper tracking af en ejendom og fjerner relaterede notifikationer.
 *
 * @param id - DAWA/DAR UUID
 */
export function untrackEjendom(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    const opdateret = hentTrackedEjendomme().filter((e) => e.id !== id);
    window.localStorage.setItem(TRACKED_KEY, JSON.stringify(opdateret));
    // Fjern relaterede notifikationer
    const notifs = hentNotifikationer().filter((n) => n.ejendomId !== id);
    window.localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(notifs));
  } catch {
    /* ignorer */
  }
}

/**
 * Toggler tracking af en ejendom — returnerer ny tilstand.
 *
 * @param ejendom - Ejendom-data
 * @returns true hvis ejendommen nu følges, false hvis unfølget
 */
export function toggleTrackEjendom(ejendom: Omit<TrackedEjendom, 'trackedSiden'>): boolean {
  if (erTracked(ejendom.id)) {
    untrackEjendom(ejendom.id);
    return false;
  } else {
    trackEjendom(ejendom);
    return true;
  }
}

/**
 * Henter alle notifikationer fra localStorage.
 *
 * @returns Liste af notifikationer, nyeste først
 */
export function hentNotifikationer(): EjendomNotifikation[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(NOTIFICATIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as EjendomNotifikation[];
  } catch {
    return [];
  }
}

/**
 * Returnerer antal ulæste notifikationer.
 */
export function antalUlaesteNotifikationer(): number {
  return hentNotifikationer().filter((n) => !n.laest).length;
}

/**
 * Markerer en notifikation som læst.
 *
 * @param id - Notifikations-ID
 */
export function markerSomLaest(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    const notifs = hentNotifikationer().map((n) => (n.id === id ? { ...n, laest: true } : n));
    window.localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(notifs));
  } catch {
    /* ignorer */
  }
}

/**
 * Markerer alle notifikationer som læste.
 */
export function markerAlleSomLaest(): void {
  if (typeof window === 'undefined') return;
  try {
    const notifs = hentNotifikationer().map((n) => ({ ...n, laest: true }));
    window.localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(notifs));
  } catch {
    /* ignorer */
  }
}

/**
 * Fjerner alle læste notifikationer.
 */
export function rydLaesteNotifikationer(): void {
  if (typeof window === 'undefined') return;
  try {
    const notifs = hentNotifikationer().filter((n) => !n.laest);
    window.localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(notifs));
  } catch {
    /* ignorer */
  }
}
