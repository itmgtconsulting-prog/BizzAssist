/**
 * BIZZ-2144: DMR-berigelse af bilforsikringspolicer.
 *
 * Henter køretøjsdata fra Motorregistret (DMR) via tjekbil.dk's offentlige
 * v3-API (gratis, ingen auth). Bruges til at krydstjekke en bilforsikringspolice
 * mod den faktiske registrerings- og forsikringsstatus i DMR, så vi kan opdage
 * at bilen er afmeldt, forsikret hos et andet selskab end policen angiver, kører
 * uforsikret, eller mangler lovpligtigt syn.
 *
 * GDPR: opslaget sender KUN registreringsnummeret (køretøjsdata, ikke
 * person-PII) til tjekbil.dk. Ejer-CVR/navn er ikke tilgængeligt i det
 * offentlige opslag. tjekbil.dk er tilføjet som under-databehandler i
 * app/privacy/page.tsx. Ingen lokal persistering ud over policens raw_metadata
 * (offentlige køretøjsdata, ingen retention-grænse påkrævet).
 *
 * @module app/lib/forsikring/dmr
 */

import { LruCache } from '@/app/lib/lruCache';

/** tjekbil.dk v3-endpoint pr. registreringsnummer */
const TJEKBIL_BASE = 'https://www.tjekbil.dk/api/v3/dmr/regnr';

/** 24-timers cache (CLAUDE.md: LRU + TTL for gentagne external API-calls) */
const dmrCache = new LruCache<string, DmrData | null>({ maxSize: 150, ttlMs: 86_400_000 });

/** Seneste syn (periodisk syn) fra DMR */
export interface DmrSyn {
  /** Synsdato (ISO YYYY-MM-DD) */
  synsdato: string | null;
  /** Resultat, fx "Godkendt" / "Betinget godkendt" / "Kan ikke godkendes" */
  synsresultat: string | null;
  /** Kilometerstand ved syn */
  kmstand: number | null;
}

/** Normaliseret DMR-resultat for ét køretøj */
export interface DmrData {
  /** Registreringsnummer (normaliseret, uppercase uden mellemrum) */
  regNr: string;
  /** Stelnummer (VIN) */
  stelNr: string | null;
  /** Registreringsstatus, fx "Registreret" / "Afmeldt" */
  status: string | null;
  /** Mærke, fx "VOLKSWAGEN" */
  maerke: string | null;
  /** Model, fx "CADDY" */
  model: string | null;
  /** Variant, fx "1.6 TDI BMT 75 HK" */
  variant: string | null;
  /** Drivkraft, fx "Diesel" / "El" */
  drivkraft: string | null;
  /** Første registreringsdato (ISO) */
  foersteRegistrering: string | null;
  /** Aktuelt forsikringsselskab ifølge DMR */
  forsikringSelskab: string | null;
  /** Forsikringsstatus, fx "Aktiv" / "Ophørt" */
  forsikringStatus: string | null;
  /** Hvornår nuværende forsikring blev oprettet (ISO) */
  forsikringOprettet: string | null;
  /** Antal selskabsskift i forsikringshistorikken (risk-indikator) */
  forsikringSkiftAntal: number;
  /** Seneste periodiske syn */
  sidsteSyn: DmrSyn | null;
}

/**
 * Normalisér et registreringsnummer: uppercase, fjern mellemrum/bindestreger.
 *
 * @param regnr - Råt registreringsnummer
 * @returns Normaliseret regnr, eller tom streng hvis input er tomt
 */
export function normalizeRegnr(regnr: string | null | undefined): string {
  return (regnr ?? '').toUpperCase().replace(/[\s-]/g, '');
}

/**
 * Valider at en streng ligner et dansk registreringsnummer (2 bogstaver +
 * 4-5 cifre, eller historiske formater). Bruges som input-sanitering før
 * external opslag, så vi ikke proxer vilkårlige strenge videre.
 *
 * @param regnr - Normaliseret registreringsnummer
 * @returns true hvis formatet er plausibelt
 */
export function erGyldigtRegnr(regnr: string): boolean {
  return /^[A-Z]{2}\d{3,5}$/.test(regnr) || /^[A-Z]{2}\d{2}[A-Z]\d{2}$/.test(regnr);
}

/**
 * Konvertér en dansk DD-MM-YYYY dato (tjekbil-format) til ISO YYYY-MM-DD.
 * Returnerer null for tomme/ugyldige værdier. ISO-input passeres uændret
 * (kun dato-delen).
 *
 * @param s - Dato-streng (DD-MM-YYYY eller ISO)
 * @returns ISO YYYY-MM-DD eller null
 */
function toIsoDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const dk = s.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (dk) return `${dk[3]}-${dk[2]}-${dk[1]}`;
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return iso ? iso[1] : null;
}

/** Rå tjekbil-svarform (kun de felter vi læser) */
interface TjekbilResponse {
  basic?: {
    regNr?: string;
    stelNr?: string;
    status?: string;
    maerkeTypeNavn?: string;
    modelTypeNavn?: string;
    variantTypeNavn?: string;
    drivkraftTypeNavn?: string;
    foersteRegistreringDato?: string;
  };
  extended?: {
    insurance?: {
      selskab?: string;
      status?: string;
      oprettet?: string;
      historik?: unknown[];
    };
  };
  inspectionData?: {
    rapporter?: Array<{
      synsdato?: string;
      synsresultat?: string;
      kmstand?: number;
    }>;
  };
}

/**
 * Parse et rå tjekbil-svar til normaliseret DmrData. Vælger det nyeste syn
 * ud fra synsdato.
 *
 * @param regNr - Normaliseret registreringsnummer (fallback hvis basic mangler)
 * @param raw - Rå tjekbil-respons
 * @returns Normaliseret DmrData
 */
export function parseTjekbil(regNr: string, raw: TjekbilResponse): DmrData {
  const b = raw.basic ?? {};
  const ins = raw.extended?.insurance ?? {};
  const rapporter = raw.inspectionData?.rapporter ?? [];

  // Find seneste syn (nyeste synsdato) — synsdato er DD-MM-YYYY
  let sidsteSyn: DmrSyn | null = null;
  for (const r of rapporter) {
    const iso = toIsoDate(r.synsdato);
    if (!iso) continue;
    if (!sidsteSyn || (sidsteSyn.synsdato && iso > sidsteSyn.synsdato)) {
      sidsteSyn = {
        synsdato: iso,
        synsresultat: r.synsresultat ?? null,
        kmstand: typeof r.kmstand === 'number' ? r.kmstand : null,
      };
    }
  }

  // Forsikringshistorik: antal unikke selskabsskift (skift mellem selskaber)
  const historik = Array.isArray(ins.historik) ? ins.historik : [];

  return {
    regNr: b.regNr ? normalizeRegnr(b.regNr) : regNr,
    stelNr: b.stelNr ?? null,
    status: b.status ?? null,
    maerke: b.maerkeTypeNavn ?? null,
    model: b.modelTypeNavn ?? null,
    variant: b.variantTypeNavn ?? null,
    drivkraft: b.drivkraftTypeNavn ?? null,
    foersteRegistrering: toIsoDate(b.foersteRegistreringDato),
    forsikringSelskab: ins.selskab ?? null,
    forsikringStatus: ins.status ?? null,
    forsikringOprettet: toIsoDate(ins.oprettet),
    forsikringSkiftAntal: Math.max(0, historik.length - 1),
    sidsteSyn,
  };
}

/**
 * Hent normaliserede DMR-data for et registreringsnummer via tjekbil.dk.
 * 24-timers LRU-cache. Returnerer null ved ugyldigt regnr, timeout, non-200
 * eller uparsbart svar (fail-soft — berigelsen er best-effort).
 *
 * @param regnr - Registreringsnummer (normaliseres internt)
 * @returns DmrData eller null
 */
export async function fetchDmrByRegnr(regnr: string): Promise<DmrData | null> {
  const norm = normalizeRegnr(regnr);
  if (!erGyldigtRegnr(norm)) return null;

  const cached = dmrCache.get(norm);
  if (cached !== undefined) return cached;

  let result: DmrData | null = null;
  try {
    const res = await fetch(`${TJEKBIL_BASE}/${encodeURIComponent(norm)}`, {
      headers: {
        Accept: 'application/json',
        // Browser-UA påkrævet — tjekbil afviser tomme/bot user-agents
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const raw = (await res.json()) as TjekbilResponse;
      if (raw?.basic?.regNr || raw?.basic?.status) {
        result = parseTjekbil(norm, raw);
      }
    }
  } catch {
    result = null;
  }

  dmrCache.set(norm, result);
  return result;
}
