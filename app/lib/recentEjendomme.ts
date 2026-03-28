/**
 * Seneste sete ejendomme — localStorage-historik.
 *
 * Gemmer op til MAX_RECENT ejendomme som brugeren har besøgt.
 * Data skrives fra ejendomsdetaljeside ([id]/page.tsx) og læses
 * på ejendomslistesiden (ejendomme/page.tsx).
 *
 * Kræver klient-side kald (localStorage) — må ikke importeres i Server Components.
 */

export const RECENT_EJENDOMME_KEY = 'ba-seneste-ejendomme';
export const MAX_RECENT_EJENDOMME = 6;

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

/**
 * Henter historiklisten fra localStorage.
 * Returnerer tom liste hvis localStorage ikke er tilgængeligt eller data er korrupt.
 */
export function hentRecentEjendomme(): RecentEjendom[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_EJENDOMME_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as RecentEjendom[];
  } catch {
    return [];
  }
}

/**
 * Tilføjer eller opdaterer en ejendom i historikken.
 * Nyeste vises øverst — dubletter fjernes automatisk.
 * Listen trimmes til MAX_RECENT_EJENDOMME.
 *
 * @param ejendom - Ejendom at registrere som set
 */
export function gemRecentEjendom(ejendom: Omit<RecentEjendom, 'senestiSet'>): void {
  if (typeof window === 'undefined') return;
  try {
    const eksisterende = hentRecentEjendomme().filter((e) => e.id !== ejendom.id);
    const opdateret: RecentEjendom[] = [
      { ...ejendom, senestiSet: Date.now() },
      ...eksisterende,
    ].slice(0, MAX_RECENT_EJENDOMME);
    window.localStorage.setItem(RECENT_EJENDOMME_KEY, JSON.stringify(opdateret));
  } catch {
    /* ignorer kvote-fejl */
  }
}
