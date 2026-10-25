/**
 * Erhvervslejemål — normalisering & sanitisering (BIZZ-2306 / ADR 0013).
 *
 * Dette modul er PRIVATLIVS-GRÆNSEN for lejemålsmodulet: `buildObservation`
 * tager et råt (transient) udbud med adresse m.m. og returnerer udelukkende de
 * afledte aggregat-felter der må persisteres. Rå adresse/kilde/URL/PII
 * forlader ALDRIG denne funktion — adressen bruges kun til at udlede område
 * (postnr/kommune leveres af kalderen) og til at danne en envejs-`dedup_hash`,
 * og kastes derefter væk. Det er denne funktion der håndhæver ADR 0013's
 * "ingen sporbarhed tilbage til kilden".
 *
 * VIGTIGT: Indsamlingen der leverer `RawListing` er BLOKERET indtil Fase 0
 * (juridisk godkendelse) er afsluttet. Dette modul er kun røret/boundary.
 *
 * Databeskyttelse: KUN erhvervsdata (ingen person-PII). Retention styres i DB.
 *
 * @module app/lib/lejemaal/normalize
 */

import { createHash } from 'node:crypto';

/** Kanonisk erhvervstype (lukket mængde — portalernes kategorier mappes ind). */
export type Erhvervstype =
  | 'kontor'
  | 'butik'
  | 'lager'
  | 'produktion'
  | 'restaurant'
  | 'klinik'
  | 'showroom'
  | 'andet';

/**
 * Råt (transient) udbud som indsamlingen leverer. Felterne `adresse` og
 * `erhvervstypeRaw` er transiente — de bruges til udledning og gemmes ALDRIG.
 */
export interface RawListing {
  /** Fuld gadeadresse — transient: bruges KUN til dedup-hash, gemmes aldrig. */
  adresse: string;
  /** Postnummer (afledt område). */
  postnr: number;
  /** Kommunenavn (afledt område). */
  kommune: string;
  /** Portalens rå kategori-tekst (mappes til kanonisk Erhvervstype). */
  erhvervstypeRaw: string;
  /** Areal i m². */
  arealM2: number;
  /** Samlet årlig leje i kr. (ekskl. drift). */
  aarligLejeKr: number;
  /** Observationsdato (ISO 'YYYY-MM-DD') — hvornår udbuddet blev set. */
  seenDate: string;
}

/**
 * Sanitiseret observation — PRÆCIS de felter der må persisteres i
 * `public.lejemaal_observation`. Bemærk: ingen `adresse`, ingen kilde, ingen URL.
 */
export interface LejemaalObservation {
  postnr: number;
  kommune: string;
  erhvervstype: Erhvervstype;
  areal_bucket: string;
  leje_kr_m2_aar: number;
  first_seen: string;
  last_seen: string;
  dedup_hash: string;
}

/** Areal-buckets (m²) — grove nok til at et aggregat ikke udpeger ét lejemål. */
const AREAL_BUCKETS: ReadonlyArray<{ max: number; label: string }> = [
  { max: 99, label: '0-99' },
  { max: 249, label: '100-249' },
  { max: 499, label: '250-499' },
  { max: 999, label: '500-999' },
  { max: Infinity, label: '1000+' },
];

/** Nøgleord → kanonisk erhvervstype (først-match vinder; rækkefølge betyder noget). */
const ERHVERVSTYPE_MATCHERS: ReadonlyArray<{ re: RegExp; type: Erhvervstype }> = [
  { re: /kontor|office|kontorfæll|coworking/i, type: 'kontor' },
  { re: /restaurant|café|cafe|bar|spise|food/i, type: 'restaurant' },
  { re: /klinik|clinic|sundhed|læge|tand|wellness/i, type: 'klinik' },
  { re: /showroom|udstilling/i, type: 'showroom' },
  { re: /butik|detail|retail|shop|forretning/i, type: 'butik' },
  { re: /produktion|industri|værksted|manufactur/i, type: 'produktion' },
  { re: /lager|logistik|warehouse|depot|storage/i, type: 'lager' },
];

/**
 * Afrunder et tal til 2 decimaler (penge/m²-pris).
 *
 * @param n - Tal der skal afrundes
 * @returns Tallet afrundet til 2 decimaler
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Finder areal-bucket-label for et givet areal.
 *
 * @param m2 - Areal i m²
 * @returns Bucket-label (fx "100-249") eller "ukendt" ved ugyldigt areal
 */
export function arealBucket(m2: number): string {
  if (!Number.isFinite(m2) || m2 <= 0) return 'ukendt';
  return AREAL_BUCKETS.find((b) => m2 <= b.max)?.label ?? '1000+';
}

/**
 * Mapper en portals rå kategori-tekst til en kanonisk {@link Erhvervstype}.
 * Ukendte/tomme kategorier bliver til 'andet'.
 *
 * @param raw - Rå kategori-tekst fra kilden
 * @returns Kanonisk erhvervstype
 */
export function normalizeErhvervstype(raw: string): Erhvervstype {
  if (!raw || typeof raw !== 'string') return 'andet';
  return ERHVERVSTYPE_MATCHERS.find((m) => m.re.test(raw))?.type ?? 'andet';
}

/**
 * Danner en stabil envejs-hash (SHA-256) af de medsendte dele. Bruges som
 * `dedup_hash` så ugentlig gen-observation af samme udbud bliver idempotent.
 * Hash'en er IKKE reversibel til adressen — den bevarer "ingen sporbarhed".
 *
 * @param parts - Dele der tilsammen identificerer udbuddet (fx adresse + type)
 * @returns SHA-256 hex-streng
 */
export function dedupHash(parts: ReadonlyArray<string | number>): string {
  const canonical = parts.map((p) => String(p).trim().toLowerCase()).join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Sanitiserer et råt udbud til en persisterbar {@link LejemaalObservation}.
 *
 * Dette er privatlivs-grænsen: den rå adresse bruges KUN til at danne
 * `dedup_hash` og indgår ALDRIG i returværdien. Resultatet indeholder kun
 * afledte aggregat-felter — ingen adresse, kilde eller URL.
 *
 * @param raw - Råt (transient) udbud fra en godkendt kilde
 * @returns Sanitiseret observation klar til upsert, eller null hvis areal/leje er ugyldig
 */
export function buildObservation(raw: RawListing): LejemaalObservation | null {
  if (!Number.isFinite(raw.arealM2) || raw.arealM2 <= 0) return null;
  if (!Number.isFinite(raw.aarligLejeKr) || raw.aarligLejeKr <= 0) return null;

  const erhvervstype = normalizeErhvervstype(raw.erhvervstypeRaw);
  const areal_bucket = arealBucket(raw.arealM2);
  const leje_kr_m2_aar = round2(raw.aarligLejeKr / raw.arealM2);

  // Adressen indgår i hash'en her og kastes derefter væk — den returneres ikke.
  const dedup_hash = dedupHash([raw.adresse, erhvervstype, areal_bucket]);

  return {
    postnr: raw.postnr,
    kommune: raw.kommune,
    erhvervstype,
    areal_bucket,
    leje_kr_m2_aar,
    first_seen: raw.seenDate,
    last_seen: raw.seenDate,
    dedup_hash,
  };
}
