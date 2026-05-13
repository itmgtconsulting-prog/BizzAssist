/**
 * Forsikrings-gap engine — ren regelmotor.
 *
 * Tager en police + (valgfri) BBR-fakta og returnerer en liste af
 * gap-detektioner. Ingen I/O — alle eksterne data leveres via
 * GapEngineInput. Det gør motoren let at unit-teste og kører identisk
 * uafhængigt af om den kaldes fra cron, API-endpoint eller AI-tool.
 *
 * Tilføj nye checks ved at appende til CHECKS-array nederst. Hver
 * check er en ren funktion (input → DetectedGap | null).
 *
 * Severity-konvention:
 *   critical — umiddelbar økonomisk eller kontrakt-risiko
 *   warning  — anbefales udbedret men ikke akut
 *   info     — observation til opmærksomhed
 *
 * @module app/lib/forsikring/gapEngine
 */

import type { CoverageCode, DetectedGap, ForsikringCoverage, GapEngineInput } from './types';
import { COVERAGE_LABELS_DA } from './types';
import { lookupBrancheKrav, isOperationelBranche } from './brancheRisiko';

// ─── Konstanter ──────────────────────────────────────────────────

/**
 * BBR areal-afvigelse over denne tærskel udløser bagudregulering hos
 * forsikringsselskab (Alm. Brand betingelse §"Afvigelser i bebygget areal").
 */
const BBR_AREA_TOLERANCE_PCT = 15;

/** Ms i en dag — bruges til "udløber snart"-checks */
const MS_PER_DAY = 86_400_000;

/** Default varsel før hovedforfald (dage) */
const RENEWAL_WARNING_DAYS = 90;

/** Default tærskel for "aftale udløbet" advarsel (dage) */
const EXPIRY_WARNING_DAYS = 30;

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Returner true hvis policen har dækningen aktiveret (is_covered=true).
 *
 * @param coverages - Alle dækninger på policen
 * @param code - Kanonisk dækningskode
 * @returns true hvis dækningen er til stede og aktiv
 */
function hasCoverage(coverages: ForsikringCoverage[], code: CoverageCode): boolean {
  return coverages.some((c) => c.coverage_code === code && c.is_covered);
}

/**
 * Beregn antal dage mellem to datoer (positiv hvis a er før b).
 *
 * @param a - Tidligere dato
 * @param b - Senere dato
 * @returns Antal dage afrundet ned
 */
function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / MS_PER_DAY);
}

/**
 * Parse en YYYY-MM-DD streng til Date eller null.
 *
 * @param s - ISO-dato eller null
 * @returns Date eller null
 */
function parseDate(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ─── Individual checks ───────────────────────────────────────────

/**
 * Type for en check-funktion.
 *
 * @param input - Gap engine input (policy + bbr + date)
 * @returns Detected gap eller null hvis check passerer
 */
type CheckFn = (input: GapEngineInput) => DetectedGap | null;

/**
 * GAP-001: BBR-areal afviger > 15% fra police.
 * Udløser bagudregulering af præmie hos forsikringsselskab.
 */
const checkBbrAreaMismatch: CheckFn = ({ policy, bbr }) => {
  if (!bbr || policy.building_area_m2 === null || bbr.bebygget_areal_m2 === null) {
    return null;
  }
  const policeArea = policy.building_area_m2;
  const bbrArea = bbr.bebygget_areal_m2;
  if (policeArea === 0) return null;
  const diffPct = Math.abs((bbrArea - policeArea) / policeArea) * 100;
  if (diffPct <= BBR_AREA_TOLERANCE_PCT) return null;
  return {
    check_id: 'GAP-001',
    category: 'areal',
    severity: 'critical',
    title: `BBR-areal afviger ${diffPct.toFixed(1)}% fra police`,
    description:
      `Policen oplyser ${policeArea} m² bebygget areal, men BBR har registreret ` +
      `${bbrArea} m². Forsikringsbetingelsen accepterer kun afvigelser op til ` +
      `${BBR_AREA_TOLERANCE_PCT}% — afvigelser herudover udløser bagudregulering ` +
      `af præmie op til 2 år tilbage.`,
    recommendation:
      'Verificér det korrekte areal i BBR og opdater policen via mægler ' +
      'snarest muligt for at undgå bagudregulering.',
    estimated_impact_dkk: null,
    source_data: { policy_m2: policeArea, bbr_m2: bbrArea, diff_pct: diffPct },
  };
};

/**
 * Faktor-funktion: bygger checks for manglende standarddækninger.
 *
 * @param code - Kanonisk dækningskode
 * @param checkId - Unik check-ID
 * @param severity - Hvor kritisk er det at dækningen mangler
 * @param description - Beskrivelse af risikoen
 * @returns CheckFn der detekterer manglende dækning
 */
function makeMissingCoverageCheck(
  code: CoverageCode,
  checkId: string,
  severity: 'info' | 'warning' | 'critical',
  description: string
): CheckFn {
  return ({ coverages }) => {
    if (hasCoverage(coverages, code)) return null;
    return {
      check_id: checkId,
      category: 'daekning',
      severity,
      title: `Manglende dækning: ${COVERAGE_LABELS_DA[code]}`,
      description,
      recommendation: `Overvej at tilkøbe ${COVERAGE_LABELS_DA[code].toLowerCase()}-dækning.`,
      estimated_impact_dkk: null,
      source_data: { missing_coverage: code },
    };
  };
}

/** GAP-010: Mangler glas-dækning */
const checkMissingGlas = makeMissingCoverageCheck(
  'glas',
  'GAP-010',
  'warning',
  'Glas-dækning mangler. Knust rude eller udskiftning af termoglas er ofte ' +
    'tæt på selvrisikoen — uden dækning bæres skaden af forsikringstager.'
);

/** GAP-011: Mangler sanitet-dækning */
const checkMissingSanitet = makeMissingCoverageCheck(
  'sanitet',
  'GAP-011',
  'info',
  'Sanitet-dækning mangler. Skader på toiletkummer, håndvaske og badekar ' +
    'erstattes ikke uden særskilt dækning.'
);

/** GAP-012: Mangler insekt/svamp-dækning (kritisk for ældre bygninger) */
const checkMissingInsektSvamp: CheckFn = (input) => {
  if (hasCoverage(input.coverages, 'insekt_svamp')) return null;
  const buildYear = input.policy.building_year_built;
  // Skærp severity for bygninger >50 år
  const isOldBuilding = buildYear !== null && buildYear < input.asOfDate.getFullYear() - 50;
  return {
    check_id: 'GAP-012',
    category: 'daekning',
    severity: isOldBuilding ? 'critical' : 'warning',
    title: 'Manglende dækning: Insekt og svamp',
    description: isOldBuilding
      ? `Bygningen er fra ${buildYear} (${input.asOfDate.getFullYear() - buildYear} år gammel). ` +
        `Træværk i ældre bygninger er højrisiko for husbukke, hussvamp og rådborebiller. ` +
        `Uden dækning bæres skader på bærende konstruktioner af ejeren.`
      : 'Insekt- og svampedækning mangler. Skader på træværk fra husbukke, ' +
        'hussvamp eller rådborebiller erstattes ikke.',
    recommendation: 'Tilkøb insekt- og svampedækning, særligt vigtigt ved bygninger over 50 år.',
    estimated_impact_dkk: null,
    source_data: { missing_coverage: 'insekt_svamp', build_year: buildYear },
  };
};

/** GAP-013: Mangler restværdi-dækning (50%-reglen) */
const checkMissingRestvaerdi = makeMissingCoverageCheck(
  'restvaerdi',
  'GAP-013',
  'warning',
  'Restværdi-dækning mangler. Hvis bygningen beskadiges over 50% kan ' +
    'forsikringstager blive tvunget til at nedrive resten på egen regning. ' +
    'Restværdi-dækningen erstatter de uskadte bygningsdele.'
);

/** GAP-014: Mangler stikledning-dækning */
const checkMissingStikledning = makeMissingCoverageCheck(
  'stikledning',
  'GAP-014',
  'warning',
  'Stikledning-dækning mangler. Lækager eller brud på rør i jorden mellem ' +
    'bygning og hovedledning er kostbare at udbedre — ofte 50.000-200.000 kr.'
);

/** GAP-020: Forsikringstager-CVR matcher ikke ejer på adressen */
const checkPolicyholderCvrMatch: CheckFn = ({ policy }) => {
  // Denne check er en placeholder — kræver tinglysning-data der hentes
  // separat. For MVP flagger vi blot hvis CVR er null (kan ikke verificeres).
  if (policy.policyholder_cvr) return null;
  return {
    check_id: 'GAP-020',
    category: 'identitet',
    severity: 'info',
    title: 'Forsikringstager-CVR mangler',
    description:
      'Policen har ingen CVR-nummer for forsikringstager. Uden CVR kan ' +
      'vi ikke automatisk verificere at forsikringstager er den faktiske ' +
      'ejer i Tingbogen.',
    recommendation: 'Anmod mægler om at tilføje CVR-nummer på forsikringstager til policen.',
    estimated_impact_dkk: null,
    source_data: {},
  };
};

/** GAP-030: Aftale udløbet eller udløber snart */
const checkExpiry: CheckFn = ({ policy, asOfDate }) => {
  const expiry = parseDate(policy.effective_to);
  if (!expiry) return null;
  const daysUntilExpiry = daysBetween(asOfDate, expiry);

  if (daysUntilExpiry < 0) {
    return {
      check_id: 'GAP-030',
      category: 'aftale',
      severity: 'critical',
      title: `Aftaleperiode udløbet for ${Math.abs(daysUntilExpiry)} dage siden`,
      description:
        `Policen havde aftale-udløb ${policy.effective_to}. Hvis policen ikke ` +
        `er fornyet er ejendommen muligvis uden dækning.`,
      recommendation: 'Verificér med forsikringsselskab eller mægler at policen er fornyet.',
      estimated_impact_dkk: null,
      source_data: { effective_to: policy.effective_to, days_overdue: -daysUntilExpiry },
    };
  }
  if (daysUntilExpiry <= EXPIRY_WARNING_DAYS) {
    return {
      check_id: 'GAP-030',
      category: 'aftale',
      severity: 'warning',
      title: `Aftaleperiode udløber om ${daysUntilExpiry} dage`,
      description:
        `Policen udløber ${policy.effective_to}. Genforhandl eller fornyelse ` +
        `bør initieres for at sikre uafbrudt dækning.`,
      recommendation:
        'Kontakt mægler for genforhandling — opsigelse i flerårige aftaler ' +
        'koster typisk 20% af årlig præmie.',
      estimated_impact_dkk: null,
      source_data: { effective_to: policy.effective_to, days_until: daysUntilExpiry },
    };
  }
  return null;
};

/** GAP-031: Hovedforfald inden for varslingsperioden */
const checkRenewalUpcoming: CheckFn = ({ policy, asOfDate }) => {
  const renewal = parseDate(policy.main_renewal_date);
  if (!renewal) return null;
  const daysUntil = daysBetween(asOfDate, renewal);
  if (daysUntil < 0 || daysUntil > RENEWAL_WARNING_DAYS) return null;
  return {
    check_id: 'GAP-031',
    category: 'aftale',
    severity: 'info',
    title: `Hovedforfald om ${daysUntil} dage`,
    description:
      `Policens hovedforfald er ${policy.main_renewal_date}. Det er det rette ` +
      `tidspunkt at evaluere om dækningerne stadig matcher behovet.`,
    recommendation:
      'Gennemgå dækningsoversigten og overvej om der er ændringer i ' +
      'bygningsanvendelse, lejere eller koncernstruktur der bør anmeldes.',
    estimated_impact_dkk: null,
    source_data: { main_renewal_date: policy.main_renewal_date },
  };
};

/** GAP-040: BBR-anvendelse vs. police-virksomhedsart */
const checkBuildingUseMismatch: CheckFn = ({ policy, bbr }) => {
  if (!bbr || !bbr.anvendelse_label || !policy.business_activity) return null;
  const bbrLower = bbr.anvendelse_label.toLowerCase();
  const policeLower = policy.business_activity.toLowerCase();
  // Heuristik: hvis ingen ord overlapper, er det sandsynligvis et mismatch.
  // Brugeren får en advarsel der skal vurderes manuelt.
  const policeWords = policeLower.split(/\s+/).filter((w) => w.length > 3);
  const overlap = policeWords.some((w) => bbrLower.includes(w));
  if (overlap) return null;
  return {
    check_id: 'GAP-040',
    category: 'risikoforandring',
    severity: 'warning',
    title: 'Police-virksomhedsart matcher ikke BBR-anvendelse',
    description:
      `Policen er tegnet til "${policy.business_activity}", men BBR registrerer ` +
      `bygningen som "${bbr.anvendelse_label}". Forsikringsbetingelserne ` +
      `kræver at ændring af anvendelse meddeles selskabet — ellers kan ` +
      `erstatning bortfalde helt eller delvist.`,
    recommendation:
      'Anmeld den aktuelle bygningsanvendelse til selskab/mægler hvis ' +
      'BBR-værdien er korrekt. Ellers ret BBR.',
    estimated_impact_dkk: null,
    source_data: {
      police_activity: policy.business_activity,
      bbr_use: bbr.anvendelse_label,
    },
  };
};

// ─── Registry ────────────────────────────────────────────────────

/**
 * Alle aktive checks. Tilføj nye checks her — gap-engine kalder dem
 * sekventielt og samler ikke-null resultater.
 *
// ─── BIZZ-1377: Branchekode-baserede checks ─────────────────────

/**
 * GAP-050: Multibranche — firma med 2+ branchekoder men police kun for én.
 */
const checkMultibranche: CheckFn = ({ branche, policy }) => {
  if (!branche || !branche.hovedbranche) return null;
  if (branche.bibrancher.length === 0) return null;

  const policyActivity = (policy.business_activity ?? '').toLowerCase();
  const uncovered = branche.bibrancher.filter((b) => {
    const tekst = (b.tekst ?? '').toLowerCase();
    return tekst.length > 3 && !policyActivity.includes(tekst.slice(0, 8));
  });

  if (uncovered.length === 0) return null;

  return {
    check_id: 'GAP-050',
    category: 'branche',
    severity: 'critical',
    title: `Multibranche: ${uncovered.length} aktivitet${uncovered.length > 1 ? 'er' : ''} ikke dækket`,
    description: `Firmaet har ${branche.bibrancher.length + 1} registrerede branchekoder, men policen er kun tegnet til "${policy.business_activity ?? 'ukendt'}". Uforsikrede brancher: ${uncovered.map((b) => b.tekst).join(', ')}.`,
    recommendation:
      'Udvid policen til at dække alle registrerede aktiviteter — ellers kan erstatning bortfalde for uforsikrede aktiviteter.',
    estimated_impact_dkk: null,
    source_data: {
      bibrancher: uncovered.map((b) => b.kode),
      police_activity: policy.business_activity,
    },
  };
};

/**
 * GAP-051: Højrisiko-branche mangler specifikke dækninger.
 */
const checkHoejrisikoBranche: CheckFn = ({ branche, policy }) => {
  if (!branche?.hovedbranche) return null;
  const krav = lookupBrancheKrav(branche.hovedbranche);
  if (!krav || krav.kategori !== 'hoejrisiko') return null;

  const policyText = [policy.business_activity, policy.building_use]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const manglende = krav.kraevede_daekninger.filter((d) => !policyText.includes(d.toLowerCase()));

  if (manglende.length === 0) return null;

  return {
    check_id: 'GAP-051',
    category: 'branche',
    severity: 'critical',
    title: `Højrisiko-branche (${krav.label}): mangler ${manglende.length} dækning${manglende.length > 1 ? 'er' : ''}`,
    description: `Branche "${krav.label}" kræver: ${krav.kraevede_daekninger.join(', ')}. Mangler: ${manglende.join(', ')}.`,
    recommendation: `Kontakt forsikringsmægler for at tilkøbe manglende dækninger for ${krav.label}-aktivitet.`,
    estimated_impact_dkk: null,
    source_data: { branche: branche.hovedbranche, krav: krav.kraevede_daekninger, manglende },
  };
};

/**
 * GAP-052: CVR-branche matcher ikke police-virksomhedsart.
 */
const checkBrancheMismatch: CheckFn = ({ branche, policy }) => {
  if (!branche?.hovedbranche_tekst || !policy.business_activity) return null;

  const cvrTekst = branche.hovedbranche_tekst.toLowerCase();
  const policeTekst = policy.business_activity.toLowerCase();

  // Overlap-check: mindst ét ord-prefix med 4+ tegn skal matche
  const cvrWords = cvrTekst.split(/\s+/).filter((w) => w.length >= 4);
  const policeWords = policeTekst.split(/\s+/).filter((w) => w.length >= 4);
  const hasOverlap = cvrWords.some((cw) =>
    policeWords.some((pw) => cw.startsWith(pw.slice(0, 5)) || pw.startsWith(cw.slice(0, 5)))
  );

  if (hasOverlap) return null;

  return {
    check_id: 'GAP-052',
    category: 'branche',
    severity: 'critical',
    title: 'CVR-branche matcher ikke police',
    description: `CVR registrerer branchen som "${branche.hovedbranche_tekst}", men policen er tegnet som "${policy.business_activity}". Forsikringsselskabet kan afvise erstatning ved forkert virksomhedsart.`,
    recommendation:
      'Opdater policens virksomhedsart så den matcher CVR-registreringen, eller opdater CVR hvis branchen er ændret.',
    estimated_impact_dkk: null,
    source_data: {
      cvr_branche: branche.hovedbranche_tekst,
      police_activity: policy.business_activity,
    },
  };
};

/**
 * GAP-053: Holding med operationel bibranche.
 */
const checkHoldingMedOperationel: CheckFn = ({ branche }) => {
  if (!branche?.hovedbranche) return null;
  const krav = lookupBrancheKrav(branche.hovedbranche);
  if (!krav || krav.kategori !== 'holding') return null;

  const operationelle = branche.bibrancher.filter((b) => isOperationelBranche(b.kode));
  if (operationelle.length === 0) return null;

  return {
    check_id: 'GAP-053',
    category: 'branche',
    severity: 'warning',
    title: `Holding med ${operationelle.length} operationel${operationelle.length > 1 ? 'le' : ''} bibranche${operationelle.length > 1 ? 'r' : ''}`,
    description: `Holdingselskab (${branche.hovedbranche_tekst ?? 'holding'}) har operationelle bibrancher: ${operationelle.map((b) => b.tekst ?? b.kode).join(', ')}. Disse kræver erhvervsforsikring ud over D&O.`,
    recommendation:
      'Tegn erhvervsforsikring der dækker de operationelle aktiviteter, eller flyt dem til et driftsselskab med egen police.',
    estimated_impact_dkk: null,
    source_data: {
      hovedbranche: branche.hovedbranche,
      operationelle: operationelle.map((b) => b.kode),
    },
  };
};

// ─── BIZZ-1364: Asset-level checks ──────────────────────────────

/**
 * GAP-100: Uforsikret aktiv — ingen matchende police fundet.
 * Severity: critical hvis værdi > 1M DKK, ellers warning.
 *
 * @param input - GapEngineInput med asset-data
 * @returns DetectedGap eller null
 */
function checkUninsuredAsset(input: GapEngineInput): DetectedGap | null {
  if (!input.asset || input.asset.matchScore !== 0) return null;
  // matchScore === 0 betyder ingen match fundet
  const value = input.asset.vaerdiDkk ?? 0;
  const severity = value > 1_000_000 ? 'critical' : 'warning';
  return {
    check_id: 'GAP-100',
    category: 'uforsikret',
    severity,
    title: 'Uforsikret aktiv',
    description: `Aktivet har ingen matchende forsikringspolice. Estimeret værdi: ${value > 0 ? `${Math.round(value / 1000)}k DKK` : 'ukendt'}.`,
    recommendation: 'Tegn forsikring der dækker dette aktiv — kontakt forsikringsmægler.',
    estimated_impact_dkk: value > 0 ? value : null,
    source_data: { asset_type: input.asset.type, vaerdi: value },
  };
}

/**
 * GAP-101: Underforsikret aktiv — police-sum < 90% af aktiv-værdi.
 * Severity: critical hvis < 70%, ellers warning.
 *
 * @param input - GapEngineInput med asset-data
 * @returns DetectedGap eller null
 */
function checkUnderinsuredAsset(input: GapEngineInput): DetectedGap | null {
  if (!input.asset) return null;
  const value = input.asset.vaerdiDkk;
  const insured = input.policy.sum_insured_dkk;
  if (!value || !insured || value <= 0) return null;
  const ratio = insured / value;
  if (ratio >= 0.9) return null;
  const severity = ratio < 0.7 ? 'critical' : 'warning';
  const pct = Math.round(ratio * 100);
  return {
    check_id: 'GAP-101',
    category: 'underforsikret',
    severity,
    title: 'Underforsikret aktiv',
    description: `Forsikringssum (${Math.round(insured / 1000)}k DKK) dækker kun ${pct}% af aktivets estimerede værdi (${Math.round(value / 1000)}k DKK).`,
    recommendation: 'Forhøj forsikringssummen til mindst 100% af aktivets værdi.',
    estimated_impact_dkk: value - insured,
    source_data: { vaerdi: value, insured, ratio: pct },
  };
}

/**
 * GAP-102: Realkredit-gab — tinglyste hæftelser > police-sum.
 * Severity: critical (panthaver-risiko).
 *
 * @param input - GapEngineInput med asset-data
 * @returns DetectedGap eller null
 */
function checkMortgageGap(input: GapEngineInput): DetectedGap | null {
  if (!input.asset) return null;
  const haeftelser = input.asset.haeftelserDkk;
  const insured = input.policy.sum_insured_dkk;
  if (!haeftelser || !insured || haeftelser <= 0) return null;
  if (insured >= haeftelser) return null;
  return {
    check_id: 'GAP-102',
    category: 'realkredit',
    severity: 'critical',
    title: 'Hæftelser overstiger forsikringssum',
    description: `Tinglyste hæftelser (${Math.round(haeftelser / 1000)}k DKK) overstiger forsikringssummen (${Math.round(insured / 1000)}k DKK). Panthaver risikerer tab ved totalskade.`,
    recommendation:
      'Forhøj forsikringssummen til mindst hæftelsesbeløbet eller aftal specifik panthavergaranti.',
    estimated_impact_dkk: haeftelser - insured,
    source_data: { haeftelser, insured },
  };
}

/**
 * GAP-103: Manglende D&O — bestyrelsespost i A/S uden D&O-police.
 * Severity: critical for A/S, warning for ApS.
 *
 * @param input - GapEngineInput med asset-data
 * @returns DetectedGap eller null
 */
function checkMissingDnO(input: GapEngineInput): DetectedGap | null {
  if (!input.asset || input.asset.type !== 'bestyrelsespost') return null;
  // Tjek om policen er en D&O-type
  const policyText = [input.policy.business_activity, input.policy.raw_metadata?.type as string]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const isDnO =
    policyText.includes('d&o') ||
    policyText.includes('bestyrelse') ||
    policyText.includes('directors');
  if (isDnO) return null; // Allerede dækket
  const isAS = input.asset.virksomhedsform === 'A/S';
  return {
    check_id: 'GAP-103',
    category: 'manglende_ansvar',
    severity: isAS ? 'critical' : 'warning',
    title: 'Manglende D&O-forsikring',
    description: `Bestyrelsespost uden Directors & Officers forsikring. ${isAS ? 'Personligt ansvar for A/S-bestyrelsesmedlemmer.' : 'Anbefales for ApS-bestyrelser.'}`,
    recommendation:
      'Tegn D&O-forsikring der dækker bestyrelses- og direktionsmedlemmers personlige ansvar.',
    estimated_impact_dkk: null,
    source_data: { asset_type: 'bestyrelsespost', virksomhedsform: input.asset.virksomhedsform },
  };
}

/**
 * Rækkefølge afspejler præsentations-prioritet i UI:
 *   1. Kritiske kontrakt-risici (areal, anvendelse)
 *   2. Manglende dækninger (kritisk → warning → info)
 *   3. Tids-baserede (udløb, hovedforfald)
 *   4. Identitets-checks (CVR-match)
 */
const CHECKS: readonly CheckFn[] = [
  // Branchekode-checks (BIZZ-1377)
  checkMultibranche,
  checkHoejrisikoBranche,
  checkBrancheMismatch,
  checkHoldingMedOperationel,
  // Asset-level checks (BIZZ-1364)
  checkUninsuredAsset,
  checkUnderinsuredAsset,
  checkMortgageGap,
  checkMissingDnO,
  // Police-level checks
  checkBbrAreaMismatch,
  checkBuildingUseMismatch,
  checkMissingInsektSvamp,
  checkMissingRestvaerdi,
  checkMissingStikledning,
  checkMissingGlas,
  checkMissingSanitet,
  checkExpiry,
  checkRenewalUpcoming,
  checkPolicyholderCvrMatch,
];

/**
 * Kør alle checks og returner detekterede gaps.
 *
 * Pure function — ingen I/O. Caller persisterer resultatet i
 * forsikring_gaps og håndterer dedup mod tidligere kørsler.
 *
 * @param input - Policy + coverages + (valgfri) BBR-fakta + dato
 * @returns Liste af detekterede gaps i præsentations-rækkefølge
 *
 * @example
 * const gaps = runGapEngine({
 *   policy,
 *   coverages,
 *   bbr: bbrFacts,
 *   asOfDate: new Date(),
 * });
 * // gaps.forEach(gap => console.log(gap.severity, gap.title));
 */
export function runGapEngine(input: GapEngineInput): DetectedGap[] {
  const results: DetectedGap[] = [];
  for (const check of CHECKS) {
    try {
      const result = check(input);
      if (result) results.push(result);
    } catch {
      // Check-funktioner skal være rene og ikke kaste — men hvis en
      // alligevel gør det skal en enkelt fejlende check ikke afbryde
      // hele analysen. Vi swallow'er bevidst og fortsætter.
      continue;
    }
  }
  return results;
}

// ─── BIZZ-1365: Risk-scoring ────────────────────────────────────

/** Base-score pr. gap-check-ID */
const GAP_BASE_SCORES: Record<string, number> = {
  'GAP-100': 60, // uforsikret
  'GAP-101': 40, // underforsikret
  'GAP-102': 70, // mortgage
  'GAP-103': 50, // D&O
  'GAP-001': 45, // areal-mismatch
  'GAP-040': 35, // anvendelse-mismatch
  'GAP-010': 20, // glas
  'GAP-011': 15, // sanitet
  'GAP-012': 30, // insekt/svamp
  'GAP-013': 25, // restværdi
  'GAP-014': 25, // stikledning
  'GAP-020': 20, // CVR-match
  'GAP-030': 35, // udløbet
  'GAP-031': 20, // udløber snart
};

/**
 * Beregn risk-score 0-100 for en gap baseret på type + asset-faktorer.
 *
 * @param gap - Detekteret gap
 * @param asset - Optionelt asset (for modifiers)
 * @returns Score 0-100
 */
export function computeRiskScore(gap: DetectedGap, asset?: GapEngineInput['asset']): number {
  let score = GAP_BASE_SCORES[gap.check_id] ?? 30;

  // Modifiers baseret på asset
  if (asset) {
    // Bygning > 50 år
    if (asset.byggeaar && new Date().getFullYear() - asset.byggeaar > 50) {
      score += 15;
    }
    // Aktiv-værdi > 5M
    if (asset.vaerdiDkk && asset.vaerdiDkk > 10_000_000) {
      score += 20;
    } else if (asset.vaerdiDkk && asset.vaerdiDkk > 5_000_000) {
      score += 10;
    }
    // Hæftelser
    if (asset.haeftelserDkk && asset.haeftelserDkk > 0) {
      score += 10;
    }
  }

  return Math.min(100, Math.max(0, score));
}

/** Severity-label baseret på risk-score */
export type RiskLabel = 'lav' | 'middel' | 'høj' | 'kritisk';

/**
 * Afled severity-label fra risk-score.
 *
 * @param score - 0-100
 * @returns Severity-label
 */
export function riskLabel(score: number): RiskLabel {
  if (score >= 76) return 'kritisk';
  if (score >= 51) return 'høj';
  if (score >= 26) return 'middel';
  return 'lav';
}

/**
 * Tæl gaps pr. severity. Bruges til UI-badges og sundheds-score.
 *
 * @param gaps - Liste af detekterede gaps
 * @returns Antal pr. severity
 */
export function countBySeverity(gaps: DetectedGap[]): {
  critical: number;
  warning: number;
  info: number;
} {
  return {
    critical: gaps.filter((g) => g.severity === 'critical').length,
    warning: gaps.filter((g) => g.severity === 'warning').length,
    info: gaps.filter((g) => g.severity === 'info').length,
  };
}
