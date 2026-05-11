/**
 * Hjælpefunktioner til virksomhedsdetaljesiden.
 *
 * Udtrukket fra VirksomhedDetaljeClient.tsx (BIZZ-1229) for at
 * holde hovedkomponenten under 2000 linjer.
 */

import type { CVRPublicData } from '@/app/api/cvr-public/route';

// ─── Tracked Companies (localStorage) ────────────────────────────────────────

const TRACKED_COMPANIES_KEY = 'ba-tracked-companies';

/** En fulgt virksomhed i localStorage */
export interface TrackedCompany {
  /** CVR-nummer */
  cvr: string;
  /** Virksomhedsnavn */
  navn: string;
  /** Unix timestamp (ms) */
  trackedSiden: number;
}

/**
 * Henter alle fulgte virksomheder fra localStorage.
 *
 * @returns Liste af fulgte virksomheder
 */
export function hentTrackedCompanies(): TrackedCompany[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(TRACKED_COMPANIES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as TrackedCompany[];
  } catch {
    return [];
  }
}

/**
 * Tjekker om en virksomhed er fulgt.
 *
 * @param cvr - CVR-nummer
 * @returns true hvis virksomheden følges
 */
export function erTrackedCompany(cvr: string): boolean {
  return hentTrackedCompanies().some((c) => c.cvr === cvr);
}

/**
 * Toggler tracking af en virksomhed — returnerer ny tilstand.
 *
 * @param cvr - CVR-nummer
 * @param navn - Virksomhedsnavn
 * @returns true hvis virksomheden nu følges, false hvis unfølget
 */
export function toggleTrackCompany(cvr: string, navn: string): boolean {
  if (typeof window === 'undefined') return false;
  const liste = hentTrackedCompanies();
  const alleredeFulgt = liste.some((c) => c.cvr === cvr);
  try {
    if (alleredeFulgt) {
      const opdateret = liste.filter((c) => c.cvr !== cvr);
      window.localStorage.setItem(TRACKED_COMPANIES_KEY, JSON.stringify(opdateret));
      return false;
    } else {
      const opdateret: TrackedCompany[] = [{ cvr, navn, trackedSiden: Date.now() }, ...liste].slice(
        0,
        50
      );
      window.localStorage.setItem(TRACKED_COMPANIES_KEY, JSON.stringify(opdateret));
      return true;
    }
  } catch {
    return alleredeFulgt;
  }
}

// ─── Ejer-rolle helpers ────────────────────────────────────────────────────────

/**
 * BIZZ-564: Identificér LEGALE ejere — IKKE Reelle Ejere (RBE).
 *
 * "Reel ejer" (Real Beneficial Owner / RBE) er en KAP-anmeldelse-konstruktion
 * fra hvidvasklovgivningen og repræsenterer NOT direkte juridisk ejerskab.
 * Diagram + ejerandels-summering må KUN inkludere legalt ejerskab (EJERREGISTER,
 * LEGALE_EJERE, INTERESSENT, FULDT_ANSVARLIG) — ellers fås duplikater og
 * ejerandel summer over 100% (en person kan både være legal ejer OG reel ejer
 * af samme virksomhed → tælles 2x).
 *
 * @param rolle - Rollenavn fra CVR
 * @returns true hvis rollen er en legal ejerrolle
 */
export function erLegalEjerRolle(rolle: string): boolean {
  const role = rolle.toUpperCase();
  // Eksklusiv check: "REEL EJER" matcher .includes('EJER') så vi MÅ filtrere
  // den fra eksplicit. Ditto "REELLE_EJERE" (variant brugt i CVR ES).
  if (role.includes('REEL')) return false;
  return (
    role.includes('EJER') ||
    role.includes('LEGALE') ||
    role.includes('INTERESSENT') ||
    // CVR ES bruger mellemrum: "Fuldt ansvarlig deltager" — matcher begge former
    (role.includes('FULDT') && role.includes('ANSVARLIG'))
  );
}

/**
 * Udtrækker aktive ejere fra en virksomheds deltagere-array.
 *
 * @param deltagere - Deltagere-array fra CVRPublicData
 * @returns Ejere med navn, enhedsNummer, erVirksomhed, ejerandel
 */
export function extractOwners(deltagere: CVRPublicData['deltagere']): {
  navn: string;
  enhedsNummer: number | null;
  erVirksomhed: boolean;
  ejerandel: string | null;
}[] {
  return (deltagere ?? [])
    .filter((d) => d.roller.some((r) => erLegalEjerRolle(r.rolle) && !r.til))
    .map((d) => {
      const ejerRolle = d.roller.find((r) => erLegalEjerRolle(r.rolle) && !r.til);
      return {
        navn: d.navn,
        enhedsNummer: d.enhedsNummer,
        erVirksomhed: d.erVirksomhed,
        ejerandel: ejerRolle?.ejerandel ?? null,
      };
    });
}

// ─── Rolle-kategorisering ────────────────────────────────────────────────────

/** Historik-prioritet: EJER → BESTYRELSE → STIFTER → REVISION → DIREKTION → ANDET */
export const rolleKategoriOrdning = [
  'EJER',
  'BESTYRELSE',
  'STIFTER',
  'REVISION',
  'DIREKTION',
  'ANDET',
];

/**
 * Mapper rollenavn til kategori.
 *
 * @param rolle - Rollenavn fra CVR
 * @returns Kategori-streng
 */
export function rolleKategori(rolle: string): string {
  const upper = rolle.toUpperCase();
  if (
    upper.includes('EJER') ||
    upper.includes('FULDT_ANSVARLIG') ||
    upper.includes('LEGALE_EJERE') ||
    upper.includes('REELLE_EJERE') ||
    upper.includes('INTERESSENT')
  )
    return 'EJER';
  if (upper.includes('BESTYRELSE') || upper.includes('TILSYNSRÅD')) return 'BESTYRELSE';
  if (upper.includes('STIFTER') || upper.includes('FOUNDER')) return 'STIFTER';
  if (upper.includes('REVISION') || upper.includes('REVISOR')) return 'REVISION';
  if (upper.includes('DIREKTION') || upper.includes('DIREKTØR')) return 'DIREKTION';
  return 'ANDET';
}

// ─── Dato-parsing ────────────────────────────────────────────────────────────

/**
 * Konverterer en dato-streng (ISO, relativ "X days ago" etc.) til sorterbar timestamp.
 * Returnerer 0 hvis datoen ikke kan parses — disse vises sidst.
 *
 * @param dateStr - Datostreng fra API-svar
 * @returns Unix timestamp i millisekunder
 */
export function parseDateForClientSort(dateStr: string | undefined): number {
  if (!dateStr) return 0;
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) return d.getTime();
  const agoMatch = dateStr.match(/(\d+)\s+(hour|day|week|month|year|time|dag|uge|m.ned|.r)/i);
  if (agoMatch) {
    const n = parseInt(agoMatch[1], 10);
    const unit = agoMatch[2].toLowerCase();
    const now = Date.now();
    if (unit.startsWith('hour') || unit.startsWith('time')) return now - n * 3_600_000;
    if (unit.startsWith('day') || unit.startsWith('dag')) return now - n * 86_400_000;
    if (unit.startsWith('week') || unit.startsWith('uge')) return now - n * 7 * 86_400_000;
    if (unit.startsWith('month') || unit.startsWith('m')) return now - n * 30 * 86_400_000;
    if (unit.startsWith('year') || unit.startsWith('.r')) return now - n * 365 * 86_400_000;
  }
  return 0;
}
