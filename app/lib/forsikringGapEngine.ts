/**
 * Forsikrings-gap-detektionsregler og risiko-scoring engine.
 *
 * BIZZ-1226: Matcher BizzAssist-aktiver mod forsikringspolicer og
 * scorer risiko/mersalgspotentiale per gap. Bruges af
 * /api/analyse/forsikring-gap route.
 *
 * Regler:
 *   1. Ejendom uden husforsikring
 *   2. Underforsikret ejendom (<90% af vurdering)
 *   3. Realkreditgab (hæftelse > dækning)
 *   4. Bil uden forsikring
 *   5. Virksomhed uden erhvervsforsikring (>5 ansatte)
 *   6. Bestyrelsespost uden D&O
 *   7. Risikofaktorer (byggeår, materialer, forurening)
 *
 * @module app/lib/forsikringGapEngine
 */

import type { ParsedPolice, ForsikringsType } from '@/app/lib/parsePoliceFile';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Et fundet aktiv fra BizzAssist data */
export interface Aktiv {
  id: string;
  type: 'ejendom' | 'køretøj' | 'virksomhed' | 'bestyrelsespost';
  label: string;
  vaerdi: number | null;
  adresse: string | null;
  bfe: number | null;
  cvr: string | null;
  /** Registreringsnummer (biler) */
  regnr: string | null;
  /** Hæftelser (realkreditlån etc.) */
  haeftelser: number;
  /** Risikofaktorer fra BBR/matrikel */
  risikofaktorer: string[];
  /** Byggeår (ejendomme) */
  byggeaar: number | null;
  /** Antal ansatte (virksomheder) */
  ansatte: number | null;
}

/** Et identificeret gap */
export interface Gap {
  aktivId: string;
  gapType: 'uforsikret' | 'underforsikret' | 'realkreditgab' | 'manglende_ansvar' | 'risiko';
  risikoScore: number;
  risikoLabel: 'lav' | 'middel' | 'hoej' | 'kritisk';
  besked: string;
  anbefaletDaekning: number | null;
  /** Estimeret årlig præmie for mersalg (meget groft estimat) */
  estimertPraemie: number | null;
  /** Matchet police (null = uforsikret) */
  matchetPolice: ParsedPolice | null;
}

// ─── Matching ───────────────────────────────────────────────────────────────

/** Mapper aktiv-type → relevante forsikringstyper */
const AKTIV_FORSIKRING_MAP: Record<string, ForsikringsType[]> = {
  ejendom: ['husforsikring', 'bygningsforsikring'],
  køretøj: ['bilforsikring'],
  virksomhed: ['erhvervsforsikring'],
  bestyrelsespost: ['bestyrelsesansvar'],
};

/**
 * Fuzzy matcher en police mod et aktiv baseret på type og objekt.
 *
 * @param police - Forsikringspolice
 * @param aktiv - BizzAssist aktiv
 * @returns Match-score (0 = ingen match, 1+ = match styrke)
 */
function matchScore(police: ParsedPolice, aktiv: Aktiv): number {
  const relevantTypes = AKTIV_FORSIKRING_MAP[aktiv.type] ?? [];
  if (!relevantTypes.includes(police.type)) return 0;

  let score = 1;

  // Objekt-match (adresse, registreringsnummer)
  if (police.objekt && aktiv.adresse) {
    const pObj = police.objekt.toLowerCase().trim();
    const aAddr = aktiv.adresse.toLowerCase().trim();
    if (pObj === aAddr) score += 3;
    else if (pObj.includes(aAddr) || aAddr.includes(pObj)) score += 2;
  }

  // Registreringsnummer-match (biler)
  if (police.objekt && aktiv.regnr) {
    const pObj = police.objekt.toUpperCase().replace(/\s/g, '');
    const aReg = aktiv.regnr.toUpperCase().replace(/\s/g, '');
    if (pObj === aReg || pObj.includes(aReg) || aReg.includes(pObj)) score += 5;
  }

  return score;
}

/**
 * Matcher policer mod aktiver. Returnerer best-match per aktiv.
 *
 * @param aktiver - Alle fundne aktiver
 * @param policer - Kundens policer
 * @returns Map fra aktiv-ID → matchet police (null = uforsikret)
 */
function matchPolicer(aktiver: Aktiv[], policer: ParsedPolice[]): Map<string, ParsedPolice | null> {
  const usedPolicer = new Set<number>(); // linje-index af brugte policer
  const result = new Map<string, ParsedPolice | null>();

  for (const aktiv of aktiver) {
    let bestMatch: ParsedPolice | null = null;
    let bestScore = 0;
    let bestIdx = -1;

    for (let i = 0; i < policer.length; i++) {
      if (usedPolicer.has(i)) continue;
      const s = matchScore(policer[i], aktiv);
      if (s > bestScore) {
        bestScore = s;
        bestMatch = policer[i];
        bestIdx = i;
      }
    }

    if (bestMatch && bestScore > 0) {
      usedPolicer.add(bestIdx);
      result.set(aktiv.id, bestMatch);
    } else {
      result.set(aktiv.id, null);
    }
  }

  return result;
}

// ─── Risiko-scoring ─────────────────────────────────────────────────────────

/**
 * Beregner risiko-score (0-100) for et gap.
 * Højere = mere kritisk.
 *
 * @param aktiv - Aktivet med gap
 * @param gapType - Type af gap
 * @param daekningRatio - Eksisterende dækning / værdi (0-1, null = uforsikret)
 * @returns Numerisk risiko-score
 */
function beregRisikoScore(
  aktiv: Aktiv,
  gapType: Gap['gapType'],
  daekningRatio: number | null
): number {
  let score = 0;

  // Base score per gap-type
  switch (gapType) {
    case 'uforsikret':
      score = 60;
      break;
    case 'underforsikret':
      score = 40 + (1 - (daekningRatio ?? 0)) * 30; // højere gap = højere score
      break;
    case 'realkreditgab':
      score = 70; // kritisk — långiver kræver dækning
      break;
    case 'manglende_ansvar':
      score = 50;
      break;
    case 'risiko':
      score = 30;
      break;
  }

  // Modifiers baseret på aktiv-egenskaber
  if (aktiv.vaerdi && aktiv.vaerdi > 5_000_000) score += 10;
  if (aktiv.vaerdi && aktiv.vaerdi > 10_000_000) score += 10;
  if (aktiv.byggeaar && aktiv.byggeaar < 1960) score += 10; // asbest-risiko
  if (aktiv.risikofaktorer.length > 0) score += 5 * aktiv.risikofaktorer.length;
  if (aktiv.haeftelser > 0) score += 10; // hæftelser = långiver kræver dækning

  return Math.min(100, Math.round(score));
}

/** Mapper numerisk score til label */
function scoreToLabel(score: number): Gap['risikoLabel'] {
  if (score >= 75) return 'kritisk';
  if (score >= 50) return 'hoej';
  if (score >= 30) return 'middel';
  return 'lav';
}

// ─── Gap-detektion ──────────────────────────────────────────────────────────

/**
 * Kører fuld gap-analyse: matcher policer mod aktiver og identificerer gaps.
 *
 * @param aktiver - Alle fundne aktiver fra BizzAssist
 * @param policer - Kundens eksisterende policer
 * @returns Array af gaps sorteret efter risiko (højest først)
 */
export function detectGaps(aktiver: Aktiv[], policer: ParsedPolice[]): Gap[] {
  const matches = matchPolicer(aktiver, policer);
  const gaps: Gap[] = [];

  for (const aktiv of aktiver) {
    const police = matches.get(aktiv.id) ?? null;

    if (!police) {
      // Uforsikret
      const gapType =
        aktiv.type === 'bestyrelsespost' ? ('manglende_ansvar' as const) : ('uforsikret' as const);
      const score = beregRisikoScore(aktiv, gapType, null);
      gaps.push({
        aktivId: aktiv.id,
        gapType,
        risikoScore: score,
        risikoLabel: scoreToLabel(score),
        besked:
          gapType === 'manglende_ansvar'
            ? `Bestyrelsespost i ${aktiv.label} uden D&O-forsikring`
            : `${aktiv.label} er ikke dækket af nogen forsikringspolice`,
        anbefaletDaekning: aktiv.vaerdi,
        estimertPraemie: aktiv.vaerdi ? Math.round(aktiv.vaerdi * 0.002) : null,
        matchetPolice: null,
      });
      continue;
    }

    // Tjek underforsikring
    if (aktiv.vaerdi && police.daekningssum) {
      const ratio = police.daekningssum / aktiv.vaerdi;
      if (ratio < 0.9) {
        const score = beregRisikoScore(aktiv, 'underforsikret', ratio);
        gaps.push({
          aktivId: aktiv.id,
          gapType: 'underforsikret',
          risikoScore: score,
          risikoLabel: scoreToLabel(score),
          besked: `Dækning ${police.daekningssum.toLocaleString('da-DK')} DKK er ${Math.round(ratio * 100)}% af vurdering ${aktiv.vaerdi.toLocaleString('da-DK')} DKK`,
          anbefaletDaekning: aktiv.vaerdi,
          estimertPraemie: Math.round((aktiv.vaerdi - police.daekningssum) * 0.002),
          matchetPolice: police,
        });
      }
    }

    // Realkreditgab: hæftelse > dækning
    if (aktiv.haeftelser > 0 && police.daekningssum && aktiv.vaerdi) {
      // Hæftelsesbeløbet kendes ikke præcist — brug vurdering som proxy
      // Longiver kræver typisk fuld dækning af ejendomsværdi
      if (police.daekningssum < aktiv.vaerdi * 0.8) {
        const score = beregRisikoScore(aktiv, 'realkreditgab', police.daekningssum / aktiv.vaerdi);
        gaps.push({
          aktivId: aktiv.id,
          gapType: 'realkreditgab',
          risikoScore: score,
          risikoLabel: scoreToLabel(score),
          besked: `Ejendom har ${aktiv.haeftelser} hæftelse(r) — dækning bør mindst matche ejendomsværdi`,
          anbefaletDaekning: aktiv.vaerdi,
          estimertPraemie: null,
          matchetPolice: police,
        });
      }
    }

    // Risikofaktorer
    if (aktiv.risikofaktorer.length > 0) {
      const score = beregRisikoScore(aktiv, 'risiko', null);
      gaps.push({
        aktivId: aktiv.id,
        gapType: 'risiko',
        risikoScore: score,
        risikoLabel: scoreToLabel(score),
        besked: `Risikofaktorer: ${aktiv.risikofaktorer.join(', ')}`,
        anbefaletDaekning: null,
        estimertPraemie: null,
        matchetPolice: police,
      });
    }
  }

  // Sortér: højest risiko først
  return gaps.sort((a, b) => b.risikoScore - a.risikoScore);
}
