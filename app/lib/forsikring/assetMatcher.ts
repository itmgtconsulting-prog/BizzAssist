/**
 * assetMatcher — Matcher aktiver mod forsikringspolicer.
 *
 * BIZZ-1363: Pure function der tager Aktiv[] + ForsikringPolicy[]
 * og returnerer match-resultater med score 0-100.
 *
 * @module
 */

import type { Aktiv } from './koncernWalk';
import type { ForsikringPolicy } from './types';

/** Resultat af én aktiv↔police matching */
export interface MatchResult {
  /** Aktiv der blev matchet */
  aktiv: Aktiv;
  /** Bedste match (null = uforsikret) */
  bestMatch: { policy: ForsikringPolicy; score: number } | null;
  /** Alle kandidater sorteret efter score */
  candidates: Array<{ policy: ForsikringPolicy; score: number }>;
}

/** Score-threshold: under dette = ingen match (uforsikret) */
const MATCH_THRESHOLD = 50;

/**
 * Normalisér en streng til sammenligning (lowercase, trim, fjern special chars).
 *
 * @param s - Input streng
 * @returns Normaliseret streng
 */
function normalize(s: string | null | undefined): string {
  if (!s) return '';
  return (
    s
      .toLowerCase()
      // BIZZ-1592: æ/ø/å → ae/oe/aa så "Helsingør" matcher "Helsingoer"
      // (forsikrings-policer skrives ofte uden diakritiske tegn)
      .replace(/æ/g, 'ae')
      .replace(/ø/g, 'oe')
      .replace(/å/g, 'aa')
      // Fjern øvrige diakritiske tegn (é, ü, osv) via NFD-dekomposition
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[.,\-/\\]/g, ' ')
      // BIZZ-1592: fjern "nr." / "nr" token mellem vejnavn og husnummer
      // ("Stengade nr. 7" → "stengade 7") så det matcher "Stengade 7"
      .replace(/\bnr\.?\b\s*/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      // BIZZ-1393: Normalisér husnummer-bogstaver: "47 a" → "47a"
      .replace(/(\d+)\s+([a-z])\b/g, '$1$2')
  );
}

/**
 * BIZZ-1441: Strip etage/dør fra adresse for ejerlejlighed-matching.
 * "gefionsvej 47a 1 sal th 3000 helsingoer" → "gefionsvej 47a 3000 helsingoer"
 *
 * @param addr - Normaliseret adresse
 * @returns Adresse uden etage/dør detaljer
 */
function stripFloorDoor(addr: string): string {
  return (
    addr
      // Fjern "X. sal", "X sal", "st", "kld", "kl" (etage)
      .replace(/\b\d+\s*sal\b/g, '')
      .replace(/\bst\b/g, '')
      .replace(/\bkld?\b/g, '')
      // Fjern "th", "tv", "mf" (dør-side)
      .replace(/\b(th|tv|mf)\b/g, '')
      // Fjern "lejl", "lejlighed" + nummer
      .replace(/\blejl(?:ighed)?\s*\d*/g, '')
      // Fjern "dør" + nummer/bogstav
      .replace(/\bd(?:ø|oe)r\s*\w*/g, '')
      // Clean up whitespace
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Beregn match-score mellem et aktiv og en police.
 *
 * @param aktiv - Aktiv fra koncern-walk
 * @param policy - Police fra DB
 * @returns Score 0-100 (højere = bedre match)
 */
function computeMatchScore(aktiv: Aktiv, policy: ForsikringPolicy): number {
  switch (aktiv.type) {
    case 'ejendom':
      return scoreEjendom(aktiv, policy);
    case 'virksomhed':
      return scoreVirksomhed(aktiv, policy);
    case 'bil':
      return scoreBil(aktiv, policy);
    case 'bestyrelsespost':
      return scoreBestyrelsespost(aktiv, policy);
    default:
      return 0;
  }
}

/**
 * Score ejendom ↔ police match.
 * BFE-match = 100, adresse-match = 90, delvis adresse = 60.
 *
 * @param aktiv - Ejendom-aktiv
 * @param policy - Police
 * @returns Score 0-100
 */
function scoreEjendom(aktiv: Aktiv, policy: ForsikringPolicy): number {
  // BFE-match: eksakt
  if (aktiv.bfe && policy.property_bfe && String(aktiv.bfe) === String(policy.property_bfe)) {
    return 100;
  }

  // BIZZ-1488/1492/1552: Adresse-match — brug KUN property_address.
  // policyholder_address er ofte virksomhedens HQ (fx "Belvedere Ejendomme A/S,
  // København S") og matcher aldrig de faktiske ejendomme. CVR-fallback nedenfor
  // dækker tilfældet hvor policen er tegnet på CVR-niveau uden specifik adresse.
  const aktivAddr = normalize(aktiv.adresse || aktiv.label);
  const policyAddr = normalize(policy.property_address);

  // CVR-fallback: hvis policen mangler property_address men har policyholder_cvr
  // der matcher ejer-CVR på aktivet, betragter vi det som en svag policiel dækning.
  const ejerCvr = (aktiv.rawData as Record<string, unknown> | undefined)?.ejer_cvr as
    | string
    | undefined;
  const cvrFallbackMatch =
    !!ejerCvr && !!policy.policyholder_cvr && ejerCvr === policy.policyholder_cvr;

  if (!aktivAddr || !policyAddr) {
    // BIZZ-1488: CVR-baseret fallback — policyholder tegner forsikring for sine ejendomme
    if (cvrFallbackMatch) {
      return 45; // Under MATCH_THRESHOLD (50) — vises som kandidat, men tæller ikke som forsikret
    }
    return 0;
  }

  // Eksakt adresse-match
  if (aktivAddr === policyAddr) return 90;

  // BIZZ-1393: Tjek om adresser indeholder hinanden (håndterer "Stengade 7" vs "Stengade 7, 3000 Helsingør")
  if (aktivAddr.includes(policyAddr) || policyAddr.includes(aktivAddr)) {
    return 85;
  }

  // BIZZ-1441: Etage/dør-tolerant match — strip sal/dør og sammenlign base-adresser
  const aktivBase = stripFloorDoor(aktivAddr);
  const policyBase = stripFloorDoor(policyAddr);
  if (
    aktivBase &&
    policyBase &&
    (aktivBase === policyBase || aktivBase.includes(policyBase) || policyBase.includes(aktivBase))
  ) {
    return 82;
  }

  // Delvis match: vejnavn + husnr
  const aktivParts = aktivAddr.split(' ');
  const policyParts = policyAddr.split(' ');
  if (aktivParts.length >= 2 && policyParts.length >= 2) {
    // Tjek om første 2 tokens matcher (typisk "stengade 7" eller "gefionsvej 45a")
    if (aktivParts[0] === policyParts[0] && aktivParts[1] === policyParts[1]) {
      return 80;
    }
    // Vejnavn + husnr-prefix (47a vs 47)
    if (
      aktivParts[0] === policyParts[0] &&
      (aktivParts[1].startsWith(policyParts[1]) || policyParts[1].startsWith(aktivParts[1]))
    ) {
      return 70;
    }
    // Vejnavn alene
    if (aktivParts[0] === policyParts[0]) {
      return 40;
    }
  }

  // BIZZ-1488/1492/1552: Hvis adresse-match fejler fuldstændigt MEN CVR matcher,
  // vis som kandidat men tæl IKKE som forsikret (score under threshold).
  if (cvrFallbackMatch) {
    return 45;
  }

  return 0;
}

/**
 * Score virksomhed ↔ police match.
 * CVR-match = 100, navn-match = 75.
 *
 * @param aktiv - Virksomhed-aktiv
 * @param policy - Police
 * @returns Score 0-100
 */
function scoreVirksomhed(aktiv: Aktiv, policy: ForsikringPolicy): number {
  // CVR-match
  if (aktiv.cvr && policy.policyholder_cvr && aktiv.cvr === policy.policyholder_cvr) {
    return 100;
  }

  // Navn-match
  const aktivNavn = normalize(aktiv.label);
  const policyNavn = normalize(policy.policyholder_name);
  if (aktivNavn && policyNavn && aktivNavn === policyNavn) return 75;

  // Delvis navne-match (indeholder hinanden)
  if (aktivNavn && policyNavn) {
    if (aktivNavn.includes(policyNavn) || policyNavn.includes(aktivNavn)) return 60;
  }

  return 0;
}

/**
 * Score bil ↔ police match.
 * Registreringsnr-match = 100.
 *
 * @param aktiv - Bil-aktiv
 * @param policy - Police
 * @returns Score 0-100
 */
function scoreBil(aktiv: Aktiv, policy: ForsikringPolicy): number {
  if (!aktiv.regnr) return 0;
  const normalizedRegnr = aktiv.regnr.replace(/\s/g, '').toUpperCase();
  // Tjek om policen nævner registreringsnummeret i metadata eller adresse
  const policyText = normalize(
    [policy.property_address, policy.business_activity, JSON.stringify(policy.raw_metadata)].join(
      ' '
    )
  );
  if (policyText.includes(normalizedRegnr.toLowerCase())) return 100;
  return 0;
}

/**
 * Score bestyrelsespost ↔ police match (D&O).
 * CVR-match + D&O type = 100.
 *
 * @param aktiv - Bestyrelsespost-aktiv
 * @param policy - Police
 * @returns Score 0-100
 */
function scoreBestyrelsespost(aktiv: Aktiv, policy: ForsikringPolicy): number {
  // D&O policer har typisk "bestyrelse" eller "D&O" i business_activity eller metadata
  const policyText = normalize(
    [policy.business_activity, policy.raw_metadata?.type as string].join(' ')
  );
  const isDnO =
    policyText.includes('d&o') ||
    policyText.includes('bestyrelse') ||
    policyText.includes('directors');

  if (!isDnO) return 0;

  // CVR-match på selskabet
  if (aktiv.cvr && policy.policyholder_cvr && aktiv.cvr === policy.policyholder_cvr) return 100;
  return 40;
}

/**
 * Match aktiver mod policer og returnér match-resultater.
 * Pure function — idempotent, ingen side-effekter.
 *
 * @param aktiver - Aktiver fra koncern-walk
 * @param policer - Policer fra DB
 * @returns MatchResult pr. aktiv
 */
export function matchAssetsToPolicies(
  aktiver: Aktiv[],
  policer: ForsikringPolicy[]
): MatchResult[] {
  return aktiver.map((aktiv) => {
    const candidates = policer
      .map((policy) => ({ policy, score: computeMatchScore(aktiv, policy) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);

    const bestMatch =
      candidates.length > 0 && candidates[0].score >= MATCH_THRESHOLD ? candidates[0] : null;

    return { aktiv, bestMatch, candidates };
  });
}
