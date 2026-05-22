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

import type {
  CoverageCode,
  DetectedGap,
  ForsikringCoverage,
  ForsikringPolicy,
  GapEngineInput,
} from './types';
import { COVERAGE_LABELS_DA } from './types';
import { lookupBrancheKrav, isOperationelBranche } from './brancheRisiko';
import type { Aktiv } from './koncernWalk';
import type { MatchResult } from './assetMatcher';

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
 * BIZZ-1609: Helper — returner true hvis aktivet IKKE er en ejendom.
 * Bygningsforsikrings-checks skal skippes for virksomheder, biler og bestyrelsesposter.
 */
function isNonEjendom(input: GapEngineInput): boolean {
  return !!input.asset && input.asset.type !== 'ejendom';
}

/**
 * GAP-001: BBR-areal afviger > 15% fra police.
 * Udløser bagudregulering af præmie hos forsikringsselskab.
 */
const checkBbrAreaMismatch: CheckFn = (input) => {
  if (isNonEjendom(input)) return null;
  const { policy, bbr } = input;
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
  return (input) => {
    // BIZZ-1609: Bygningsdæknings-checks kun relevante for ejendomme
    if (isNonEjendom(input)) return null;
    if (hasCoverage(input.coverages, code)) return null;
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
  if (isNonEjendom(input)) return null;
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
const checkBuildingUseMismatch: CheckFn = (input) => {
  if (isNonEjendom(input)) return null;
  const { policy, bbr } = input;
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

// ─── BIZZ-1634: Udvidede BBR cross-checks ──────────────────────────

/**
 * GAP-002: Antal etager — police oplyser N etager, BBR har M.
 * Relevant for forsikringssum-beregning og brandspredningsrisiko.
 */
const checkFloorMismatch: CheckFn = (input) => {
  if (isNonEjendom(input)) return null;
  const { policy, bbr } = input;
  if (!bbr || !bbr.antal_etager || !policy.building_floors) return null;
  if (policy.building_floors === bbr.antal_etager) return null;
  return {
    check_id: 'GAP-002',
    category: 'bygning',
    severity: 'warning',
    title: `Etageantal afviger: police ${policy.building_floors}, BBR ${bbr.antal_etager}`,
    description:
      `Policen oplyser ${policy.building_floors} etager, men BBR registrerer ${bbr.antal_etager}. ` +
      `Afvigende etageantal kan påvirke forsikringssummen og risiko-vurderingen.`,
    recommendation: 'Verificér etageantal og opdater policen hvis nødvendigt.',
    estimated_impact_dkk: null,
    source_data: { policy_floors: policy.building_floors, bbr_floors: bbr.antal_etager },
  };
};

/**
 * GAP-003: Opførelsesår — bygning ældre end 50 år uden udvidet rørskade/svamp-dækning.
 */
const checkOldBuildingRisk: CheckFn = (input) => {
  if (isNonEjendom(input)) return null;
  const { bbr, coverages, asOfDate } = input;
  if (!bbr || !bbr.opfoert_aar) return null;
  const age = asOfDate.getFullYear() - bbr.opfoert_aar;
  if (age < 50) return null;
  const hasRoer = hasCoverage(coverages, 'udvidet_roerskade');
  const hasSvamp = hasCoverage(coverages, 'insekt_svamp');
  if (hasRoer && hasSvamp) return null;
  const mangler = [];
  if (!hasRoer) mangler.push('udvidet rørskade');
  if (!hasSvamp) mangler.push('insekt og svamp');
  return {
    check_id: 'GAP-003',
    category: 'bygning',
    severity: 'warning',
    title: `Bygning fra ${bbr.opfoert_aar} (${age} år) mangler ${mangler.join(' + ')}`,
    description:
      `Bygningen er ${age} år gammel. Ældre bygninger har forhøjet risiko for ` +
      `rør-nedbrud og svampe-/insektangreb. Dækning for ${mangler.join(' og ')} anbefales.`,
    recommendation: `Tilføj ${mangler.join(' og ')} til policen — standardpræmie stiger typisk 5-15%.`,
    estimated_impact_dkk: null,
    source_data: { opfoert_aar: bbr.opfoert_aar, age, missing: mangler },
  };
};

/**
 * GAP-004: Blødt tag (stråtag/rør) — kræver særlige brandforsikringsbetingelser.
 * BBR tag_materiale_kode 6 = stråtag, 7 = rørtag.
 */
const checkSoftRoof: CheckFn = (input) => {
  if (isNonEjendom(input)) return null;
  const { bbr } = input;
  if (!bbr || !bbr.tag_materiale_kode) return null;
  const code = String(bbr.tag_materiale_kode).trim();
  if (code !== '6' && code !== '7') return null;
  const tagType = code === '6' ? 'stråtag' : 'rørtag';
  return {
    check_id: 'GAP-004',
    category: 'bygning',
    severity: 'critical',
    title: `Bygning med ${tagType} — kræver særlige brandbetingelser`,
    description:
      `BBR registrerer at bygningen har ${tagType} (materiale-kode ${code}). ` +
      `Stråtag og rørtag klassificeres som "blødt tag" med forhøjet brandrisiko. ` +
      `Forsikringsselskaber kræver typisk specialbetingelser, højere præmie og ` +
      `ekstra brandforebyggende foranstaltninger (røgalarm, branddør, afstandskrav).`,
    recommendation:
      'Verificér at policen eksplicit dækker blødt tag og at brandforebyggende krav er opfyldt.',
    estimated_impact_dkk: null,
    source_data: { tag_materiale_kode: code, tagType },
  };
};

/**
 * GAP-005: Kælder registreret i BBR men police mangler jordskade/stikledning-dækning.
 */
const checkBasementRisk: CheckFn = (input) => {
  if (isNonEjendom(input)) return null;
  const { bbr, coverages } = input;
  if (!bbr || !bbr.has_kaelder) return null;
  const hasJord = hasCoverage(coverages, 'jordskade');
  const hasStik = hasCoverage(coverages, 'stikledning');
  if (hasJord && hasStik) return null;
  const mangler = [];
  if (!hasJord) mangler.push('jordskade');
  if (!hasStik) mangler.push('stikledning');
  return {
    check_id: 'GAP-005',
    category: 'bygning',
    severity: 'warning',
    title: `Kælder uden ${mangler.join(' + ')}-dækning`,
    description:
      `BBR registrerer at bygningen har kælder. Kældre er udsatte for ` +
      `jordskade og stiklednings-brud. Dækning for ${mangler.join(' og ')} anbefales.`,
    recommendation: `Tilføj ${mangler.join(' og ')} til policen.`,
    estimated_impact_dkk: null,
    source_data: { has_kaelder: true, missing: mangler },
  };
};

// ─── BIZZ-1672: Ejerforening cross-checks ──────────────────────

/**
 * GAP-006: Ejerforening administrerer ejendommen — verificér fællesforsikring.
 *
 * Når en ejendom administreres af en ejerforening, bør fællesforsikringen
 * dække bygning+grund. Individuel police bør supplere med indbo/ansvar.
 */
const checkEjerforeningVerifikation: CheckFn = (input) => {
  if (!input.ejerforening || input.ejerforening.type !== 'virksomhed') return null;
  const ef = input.ejerforening;
  const label = ef.navn ?? (ef.cvr ? `CVR ${ef.cvr}` : 'Ejerforening');
  return {
    check_id: 'GAP-006',
    category: 'ejerforening',
    severity: 'warning',
    title: `${label} administrerer ejendommen — verificér fællesforsikring`,
    description:
      `Ejendommen administreres af ${label}. ` +
      `Ejerforeningens fællesforsikring bør dække bygning, grund og fællesarealer. ` +
      `Verificér at fællesforsikringen er aktiv og dækningen er tilstrækkelig.`,
    recommendation: 'Indhent kopi af ejerforeningens fællesforsikringspolice og verificér dækning.',
    estimated_impact_dkk: null,
    source_data: { ejerforening_cvr: ef.cvr, ejerforening_navn: ef.navn },
  };
};

/**
 * GAP-007: Ejerlejlighed med ejerforening — individuel indbo/ansvar anbefales.
 *
 * Fællesforsikringen dækker typisk bygning men IKKE individuel indbo og ansvar.
 */
/**
 * GAP-007: Ejerlejlighed med ejerforening — individuel hus/grundejeransvar anbefales.
 *
 * Fællesforsikringen dækker typisk bygning men individuel ansvarsdækning
 * bør supplere.
 */
const checkEjerforeningIndboDaekning: CheckFn = (input) => {
  if (!input.ejerforening || input.ejerforening.type !== 'virksomhed') return null;
  const hasAnsvar = hasCoverage(input.coverages, 'hus_grundejer_ansvar');
  const hasGlas = hasCoverage(input.coverages, 'glas');
  if (hasAnsvar && hasGlas) return null;
  const mangler = [];
  if (!hasAnsvar) mangler.push('hus/grundejeransvar');
  if (!hasGlas) mangler.push('glas');
  return {
    check_id: 'GAP-007',
    category: 'daekning',
    severity: 'info',
    title: `Ejerlejlighed med ejerforening — ${mangler.join(' + ')} anbefales`,
    description:
      `Ejerforeningens fællesforsikring dækker typisk bygning og fællesarealer, ` +
      `men individuel ${mangler.join(' og ')}-dækning bør tegnes separat.`,
    recommendation: `Tegn individuel ${mangler.join(' og ')}-dækning.`,
    estimated_impact_dkk: null,
    source_data: { missing: mangler },
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
const _checkHoejrisikoBranche: CheckFn = ({ branche, policy }) => {
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
const _checkBrancheMismatch: CheckFn = ({ branche, policy }) => {
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
  // GAP-051 (checkHoejrisikoBranche) er deaktiveret — overlapper med
  // GAP-067 (branchekrav-aggregat på portefølje-niveau) der bruger
  // faktiske coverage-koder i stedet for kun policy-tekst.
  // GAP-052 (checkBrancheMismatch) er deaktiveret — gav false-positives
  // på ansvarsforsikringer hvor "ansvarsforsikring" ikke matcher
  // branche-tekst, men dækningen er reelt korrekt for virksomheden.
  checkHoldingMedOperationel,
  // Asset-level checks (BIZZ-1364)
  checkUninsuredAsset,
  checkUnderinsuredAsset,
  checkMortgageGap,
  checkMissingDnO,
  // Police-level checks
  checkBbrAreaMismatch,
  checkBuildingUseMismatch,
  // BIZZ-1634: Udvidede BBR cross-checks
  checkFloorMismatch,
  checkOldBuildingRisk,
  checkSoftRoof,
  checkBasementRisk,
  // BIZZ-1672: Ejerforening cross-checks
  checkEjerforeningVerifikation,
  checkEjerforeningIndboDaekning,
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
  'GAP-002': 25, // etage-mismatch
  'GAP-003': 35, // gammel bygning uden rør/svamp
  'GAP-004': 55, // blødt tag (stråtag)
  'GAP-005': 30, // kælder uden jordskade/stikledning
  'GAP-006': 30, // ejerforening — verificér fællesforsikring
  'GAP-007': 20, // ejerlejlighed indbo/ansvar anbefales
  'GAP-010': 20, // glas
  'GAP-011': 15, // sanitet
  'GAP-012': 30, // insekt/svamp
  'GAP-013': 25, // restværdi
  'GAP-014': 25, // stikledning
  'GAP-020': 20, // CVR-match
  'GAP-030': 35, // udløbet
  'GAP-031': 20, // udløber snart
  // Portefølje-checks
  'GAP-060': 55, // D&O mangler (A/S)
  'GAP-061': 60, // huslejetab mangler
  'GAP-062': 40, // kollektiv bygning
  'GAP-063': 35, // cyber
  'GAP-064': 25, // retshjælp
  'GAP-065': 55, // driftstab mangler
  'GAP-066': 50, // lav præmie
  'GAP-067': 65, // branchekrav aggregat
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

// ─── Portefølje-niveau checks ──────────────────────────────────

/**
 * Input til portefølje-checks. Modtager alle aktiver, matches,
 * policer og dækninger for hele koncernen — ikke per-police.
 */
export interface PortfolioCheckInput {
  /** Alle aktiver fra koncern-walk */
  aktiver: Aktiv[];
  /** Match-resultater fra assetMatcher */
  matches: MatchResult[];
  /** Alle policer i scope */
  policer: ForsikringPolicy[];
  /** Dækninger per police-ID */
  coveragesByPolicy: Map<string, ForsikringCoverage[]>;
  /** Branchedata for hovedvirksomheden */
  branche?: {
    hovedbranche: string | null;
    hovedbranche_tekst: string | null;
    bibrancher: Array<{ kode: string; tekst: string | null }>;
  };
  /** Virksomhedsform (A/S, ApS, etc.) */
  virksomhedsform?: string | null;
  /** Samlet årlig præmie på tværs af alle policer */
  totalPraemieDkk?: number;
}

/** Type for en portefølje-check-funktion */
type PortfolioCheckFn = (input: PortfolioCheckInput) => DetectedGap | null;

/**
 * GAP-060: A/S uden D&O-police.
 * Tjekker om nogen police i porteføljen dækker D&O — ellers kritisk for A/S.
 */
const checkPortfolioDnO: PortfolioCheckFn = ({ policer, virksomhedsform }) => {
  if (!virksomhedsform) return null;
  const isAS = virksomhedsform.toUpperCase().includes('A/S');
  const isApS = virksomhedsform.toUpperCase().includes('APS');
  if (!isAS && !isApS) return null;

  const hasDnO = policer.some((p) => {
    const text = [
      p.business_activity,
      p.raw_metadata?.type as string,
      p.raw_metadata?.insurance_type as string,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return (
      text.includes('d&o') ||
      text.includes('bestyrelse') ||
      text.includes('directors') ||
      text.includes('ledelses')
    );
  });
  if (hasDnO) return null;

  return {
    check_id: 'GAP-060',
    category: 'manglende_ansvar',
    severity: isAS ? 'critical' : 'warning',
    title: `Ingen D&O-forsikring for ${virksomhedsform}`,
    description:
      `D&O (Directors & Officers) er en personlig ansvarsforsikring for bestyrelse og direktion. ` +
      `Uden D&O hæfter ledelsen personligt — med privat formue — for økonomiske krav fra aktionærer, ` +
      `kreditorer, kunder, lejere eller myndigheder ved fx påståede pligtforsømmelser, fejlagtige beslutninger, ` +
      `misvisende oplysninger i regnskabet eller manglende overholdelse af lovgivning. ` +
      (isAS
        ? `For A/S med bestyrelse er D&O kritisk: efter selskabslovens §361 har bestyrelsesmedlemmer personligt ` +
          `ansvar for tab forvoldt ved uagtsomhed. Erstatningskrav kan let nå millionbeløb og rammer den enkeltes privatøkonomi.`
        : `For ApS anbefales D&O da direktionen har personligt ansvar for tab forvoldt ved uagtsomhed. ` +
          `Uden D&O risikerer indehaver/direktør at hæfte privat for fx forkerte regnskabstal eller misvisende oplysninger til kreditorer.`),
    recommendation:
      `Tegn D&O-forsikring (bestyrelsesansvar) der dækker advokatomkostninger og erstatningskrav mod ` +
      `bestyrelses- og direktionsmedlemmer. Dækker typisk både retssagsomkostninger, forligsbeløb og ` +
      `myndighedsundersøgelser. Pris afhænger af omsætning, branche og bestyrelsens størrelse.`,
    estimated_impact_dkk: null,
    source_data: { virksomhedsform },
  };
};

/**
 * GAP-061: Huslejetab mangler for ejendomme i udlejningsselskab.
 * Tæller hvor mange ejendomme der har huslejetab-dækning vs. antal ejendomme.
 */
const checkPortfolioHuslejetab: PortfolioCheckFn = ({ matches, coveragesByPolicy, branche }) => {
  if (!branche?.hovedbranche) return null;
  const krav = lookupBrancheKrav(branche.hovedbranche);
  if (!krav || !krav.kraevede_daekninger.includes('huslejetab')) return null;

  const ejendomMatches = matches.filter((m) => m.aktiv.type === 'ejendom');
  if (ejendomMatches.length <= 1) return null;

  let medHuslejetab = 0;
  for (const m of ejendomMatches) {
    if (!m.bestMatch) continue;
    const covs = coveragesByPolicy.get(m.bestMatch.policy.id) ?? [];
    if (covs.some((c) => c.coverage_code === 'huslejetab' && c.is_covered)) {
      medHuslejetab++;
    }
  }

  const udenHuslejetab = ejendomMatches.length - medHuslejetab;
  if (udenHuslejetab === 0) return null;

  return {
    check_id: 'GAP-061',
    category: 'uforsikret',
    severity: 'critical',
    title: `Huslejetab mangler for ${udenHuslejetab} af ${ejendomMatches.length} ejendomme`,
    description:
      `Virksomheden er et udlejningsselskab med ${ejendomMatches.length} ejendomme, ` +
      `men kun ${medHuslejetab} har huslejetab-dækning. ` +
      `Ved brand eller vandskade mistes lejeindtægt fra de ${udenHuslejetab} ejendomme uden dækning.`,
    recommendation:
      'Tegn huslejetab-forsikring for alle udlejningsejendomme — enten via individuelle policer ' +
      'eller én kollektiv ejendomsforsikring med huslejetab-dækning.',
    estimated_impact_dkk: null,
    source_data: {
      total_ejendomme: ejendomMatches.length,
      med_huslejetab: medHuslejetab,
      uden_huslejetab: udenHuslejetab,
    },
  };
};

/**
 * GAP-062: Kollektiv bygningsforsikring anbefalet.
 * Ved >3 ejendomme anbefales én samlet police i stedet for enkelt-policer.
 */
const checkKollektivBygning: PortfolioCheckFn = ({ matches }) => {
  const ejendomMatches = matches.filter((m) => m.aktiv.type === 'ejendom');
  if (ejendomMatches.length <= 3) return null;

  // Tæl unikke policer der matcher ejendomme
  const uniquePolicies = new Set(
    ejendomMatches.filter((m) => m.bestMatch).map((m) => m.bestMatch!.policy.id)
  );

  // Hvis der allerede er 1-2 policer for mange ejendomme, har de sandsynligvis kollektiv
  if (uniquePolicies.size <= 2 && uniquePolicies.size > 0) return null;

  const forsikrede = ejendomMatches.filter((m) => m.bestMatch !== null).length;
  const uforsikrede = ejendomMatches.length - forsikrede;

  return {
    check_id: 'GAP-062',
    category: 'optimering',
    // Altid 'info' — kollektiv er en anbefaling, ikke en mangel.
    // Hvis ejendomme er uforsikrede dækkes det allerede af GAP-100
    // (uforsikret aktiv) på den enkelte ejendoms-række.
    severity: 'info',
    title: `${ejendomMatches.length} ejendomme — kollektiv bygningsforsikring kan overvejes`,
    description:
      `Virksomheden ejer ${ejendomMatches.length} ejendomme fordelt på ${uniquePolicies.size || 'ingen'} ` +
      `separate policer. Hvis den enkelte ejendom er korrekt forsikret er dækningen i orden — ` +
      `men én kollektiv police kan give administrative fordele og ensartet dækning på tværs af porteføljen.`,
    recommendation:
      'Indhent tilbud på kollektiv bygningsforsikring som alternativ til de individuelle policer. ' +
      'Vurder om de administrative fordele og ensartet dækning opvejer evt. ulemper.',
    estimated_impact_dkk: null,
    source_data: {
      total_ejendomme: ejendomMatches.length,
      forsikrede,
      uforsikrede,
      unikke_policer: uniquePolicies.size,
    },
  };
};

/**
 * GAP-063: Cyber-forsikring mangler.
 * Warning for virksomheder med lejerdata/betalingsinfo eller >5 ansatte.
 */
const checkPortfolioCyber: PortfolioCheckFn = ({ policer, branche, aktiver }) => {
  if (!branche?.hovedbranche) return null;

  // Brancher der håndterer persondata: udlejning, sundhed, IT, detail, engros
  const dataRisikoPrefixes = ['68', '86', '62', '47', '46', '55', '56'];
  const clean = branche.hovedbranche.replace(/\./g, '').trim();
  const isDataRisiko = dataRisikoPrefixes.some((p) => clean.startsWith(p));
  if (!isDataRisiko) return null;

  const hasCyber = policer.some((p) => {
    const text = [
      p.business_activity,
      p.raw_metadata?.type as string,
      p.raw_metadata?.insurance_type as string,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return (
      text.includes('cyber') || text.includes('it-kriminal') || text.includes('databeskyttelse')
    );
  });
  if (hasCyber) return null;

  const ejendomCount = aktiver.filter((a) => a.type === 'ejendom').length;
  return {
    check_id: 'GAP-063',
    category: 'manglende_ansvar',
    severity: 'warning',
    title: 'Ingen cyber-forsikring',
    description:
      `Virksomheden (branche: ${branche.hovedbranche_tekst ?? clean}) håndterer ` +
      (ejendomCount > 0 ? `lejerdata fra ${ejendomCount} ejendomme, ` : '') +
      `betalingsoplysninger og persondata. Uden cyber-forsikring bæres tab fra ` +
      `datalæk, ransomware eller GDPR-bøder af virksomheden selv.`,
    recommendation:
      'Overvej cyber-forsikring der dækker datalæk, ransomware, IT-kriminalitet og GDPR-bøder.',
    estimated_impact_dkk: null,
    source_data: {
      branche: branche.hovedbranche,
      ejendom_count: ejendomCount,
    },
  };
};

/**
 * GAP-064: Retshjælpsforsikring mangler.
 * Warning hvis ingen police har retshjælp-dækning.
 */
const checkPortfolioRetshjaelp: PortfolioCheckFn = ({ policer, coveragesByPolicy }) => {
  if (policer.length === 0) return null;

  // Tjek om nogen police har retshjælp i tekst eller dækninger
  const hasRetshjaelp = policer.some((p) => {
    const text = [p.business_activity, p.raw_metadata?.type as string]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (text.includes('retshjælp') || text.includes('retshjaelp')) return true;

    const covs = coveragesByPolicy.get(p.id) ?? [];
    return covs.some(
      (c) =>
        c.is_covered &&
        (c.coverage_code.includes('retshjaelp') ||
          c.coverage_label.toLowerCase().includes('retshjælp'))
    );
  });
  if (hasRetshjaelp) return null;

  return {
    check_id: 'GAP-064',
    category: 'manglende_ansvar',
    severity: 'warning',
    title: 'Ingen retshjælpsforsikring',
    description:
      'Ingen af virksomhedens policer inkluderer retshjælpsforsikring. ' +
      'Ved tvister med lejere, leverandører eller naboer dækkes advokatomkostninger ' +
      'ikke uden retshjælp-dækning.',
    recommendation:
      'Tilkøb retshjælpsforsikring — enten som tillæg til eksisterende police eller som separat police.',
    estimated_impact_dkk: null,
    source_data: {},
  };
};

/**
 * GAP-065: Driftstab mangler for udlejningsselskab.
 * Tjekker om nogen police har driftstab-dækning for udlejningsbranche.
 */
const checkPortfolioDriftstab: PortfolioCheckFn = ({
  matches,
  policer,
  coveragesByPolicy,
  branche,
  aktiver,
}) => {
  if (!branche?.hovedbranche) return null;
  const krav = lookupBrancheKrav(branche.hovedbranche);
  if (!krav || !krav.kraevede_daekninger.includes('driftstab')) return null;

  const hasDriftstab = policer.some((p) => {
    const covs = coveragesByPolicy.get(p.id) ?? [];
    if (covs.some((c) => c.coverage_code === 'driftstab' && c.is_covered)) return true;
    const text = [p.business_activity, p.raw_metadata?.type as string]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return text.includes('driftstab');
  });
  if (hasDriftstab) return null;

  // Overlap-undgåelse: For udlejningsselskaber dækker huslejetab den
  // primære driftstabsrisiko (tabt lejeindtægt). Hvis huslejetab er
  // dækket på majoriteten af ejendommene, undertrykker vi GAP-065 for
  // at undgå at dublere GAP-061 (huslejetab per ejendom) på UI.
  // Driftstab kan stadig være relevant som udvidet dækning, men det er
  // ikke en kritisk mangel når huslejetab håndterer kerneeksponeringen.
  const ejendomMatches = matches.filter((m) => m.aktiv.type === 'ejendom' && m.bestMatch);
  if (ejendomMatches.length > 0) {
    const medHuslejetab = ejendomMatches.filter((m) => {
      const covs = coveragesByPolicy.get(m.bestMatch!.policy.id) ?? [];
      return covs.some((c) => c.coverage_code === 'huslejetab' && c.is_covered);
    }).length;
    // Hvis mindst halvdelen af forsikrede ejendomme har huslejetab,
    // er driftstabsrisikoen i hovedsagen dækket — skip GAP-065.
    if (medHuslejetab >= ejendomMatches.length / 2) return null;
  }

  const ejendomCount = aktiver.filter((a) => a.type === 'ejendom').length;
  return {
    check_id: 'GAP-065',
    category: 'uforsikret',
    severity: 'warning',
    title: 'Ingen driftstabsforsikring',
    description:
      `Udlejningsselskab med ${ejendomCount} ejendomme har ingen driftstabsforsikring og ` +
      `mindre end halvdelen af ejendommene har huslejetab. Ved brand, vandskade eller storm ` +
      `der gør en ejendom ubeboelig dækker huslejetab tabt lejeindtægt, mens driftstab også ` +
      `omfatter virksomhedens øvrige faste udgifter (administration, renter, lønninger) ` +
      `i genopbygningsperioden.`,
    recommendation:
      'Overvej driftstabsforsikring som supplement til huslejetab — særligt hvis virksomheden ' +
      'har faste udgifter ud over lejeindtægterne der skal dækkes i genopbygningsperioden.',
    estimated_impact_dkk: null,
    source_data: {
      branche: branche.hovedbranche,
      ejendom_count: ejendomCount,
    },
  };
};

/**
 * GAP-066: Lav præmie i forhold til porteføljestørrelse.
 * Warning hvis samlet præmie er suspekt lav ift. antal ejendomme.
 */
const _checkLavPraemie: PortfolioCheckFn = ({ policer, aktiver }) => {
  const ejendomCount = aktiver.filter((a) => a.type === 'ejendom').length;
  if (ejendomCount <= 1) return null;

  const totalPraemie = policer.reduce((sum, p) => sum + (p.annual_premium_dkk ?? 0), 0);
  if (totalPraemie === 0) return null;

  // Tommelfingerregel: ~5.000-15.000 kr/ejendom/år for bygningsforsikring
  const praemiePerEjendom = totalPraemie / ejendomCount;
  if (praemiePerEjendom >= 3_000) return null;

  return {
    check_id: 'GAP-066',
    category: 'optimering',
    severity: 'critical',
    title: `Ekstremt lav præmie: ${Math.round(totalPraemie).toLocaleString('da-DK')} kr for ${ejendomCount} ejendomme`,
    description:
      `Samlet årlig præmie er ${Math.round(totalPraemie).toLocaleString('da-DK')} kr ` +
      `for ${ejendomCount} ejendomme (${Math.round(praemiePerEjendom).toLocaleString('da-DK')} kr/ejendom). ` +
      `Normal bygningsforsikring ligger på 5.000-15.000 kr/ejendom/år. ` +
      `Den lave præmie indikerer at ikke alle ejendomme er forsikret.`,
    recommendation:
      'Verificér at alle ejendomme er dækket af en police. Indhent tilbud på ' +
      'kollektiv bygningsforsikring for hele porteføljen.',
    estimated_impact_dkk: null,
    source_data: {
      total_praemie: totalPraemie,
      ejendom_count: ejendomCount,
      praemie_per_ejendom: Math.round(praemiePerEjendom),
    },
  };
};

/**
 * Mapping fra branchekrav-streng (fra brancheRisiko.ts) til canonical
 * CoverageCode. Bruges af GAP-067 til at verificere at de påkrævede
 * dækninger fra branchen faktisk er tilstede som coverage-rækker.
 *
 * Krav uden CoverageCode-modstykke (d&o, cyberforsikring, arbejdsskade,
 * all-risk, transportansvar, godsforsikring, maskinkasko, miljoeansvar,
 * professionelt_ansvar, behandlingsansvar, patientforsikring, indbrud,
 * rejsegods) tjekkes via policy-tekst i stedet.
 */
const KRAV_TO_COVERAGE_CODE: Record<string, CoverageCode> = {
  brand: 'brand_el',
  ejendomsforsikring: 'bygningskasko',
  erhvervsansvar: 'erhvervsansvar',
  huslejetab: 'huslejetab',
  hus_grundejer_ansvar: 'hus_grundejer_ansvar',
  driftstab: 'driftstab',
  forurening: 'forurening',
  produktansvar: 'erhvervsansvar', // produktansvar normaliseres til erhvervsansvar
};

/**
 * Læsbare labels for branchekrav-strenge (til UI-output).
 */
const KRAV_LABELS_DA: Record<string, string> = {
  brand: 'Brand',
  ejendomsforsikring: 'Ejendomsforsikring (bygningskasko)',
  erhvervsansvar: 'Erhvervsansvar',
  huslejetab: 'Huslejetab',
  hus_grundejer_ansvar: 'Hus- og grundejeransvar',
  driftstab: 'Driftstab',
  forurening: 'Forurening',
  produktansvar: 'Produktansvar',
  'd&o': 'D&O / Bestyrelsesansvar',
  cyberforsikring: 'Cyber-forsikring',
  arbejdsskade: 'Arbejdsskadeforsikring',
  'all-risk': 'All-risk',
  transportansvar: 'Transportansvar',
  godsforsikring: 'Godsforsikring',
  maskinkasko: 'Maskinkasko',
  miljoeansvar: 'Miljøansvar',
  professionelt_ansvar: 'Professionelt ansvar',
  behandlingsansvar: 'Behandlingsansvar',
  patientforsikring: 'Patientforsikring',
  indbrud: 'Indbrud',
  rejsegods: 'Rejsegods',
  kasko: 'Kasko',
  kriminalitet: 'Kriminalitetsforsikring',
};

/**
 * Tjek om en branchekrav-streng er dækket et sted i porteføljen.
 * Bruger først coverage-koder, falder tilbage til policy-tekst-søgning.
 *
 * @param krav - Branchekrav-streng (fx "huslejetab", "d&o")
 * @param policer - Alle policer i scope
 * @param coveragesByPolicy - Dækninger per police-ID
 * @returns true hvis kravet er dækket et sted
 */
function isKravCovered(
  krav: string,
  policer: ForsikringPolicy[],
  coveragesByPolicy: Map<string, ForsikringCoverage[]>
): boolean {
  const kravLower = krav.toLowerCase();
  const coverageCode = KRAV_TO_COVERAGE_CODE[kravLower];

  // 1. Tjek coverage-koder hvis kravet mapper til en kanonisk kode
  if (coverageCode) {
    for (const pol of policer) {
      const covs = coveragesByPolicy.get(pol.id) ?? [];
      if (covs.some((c) => c.coverage_code === coverageCode && c.is_covered)) {
        return true;
      }
    }
  }

  // 2. Fallback: søg i policy-tekst (business_activity, building_use, raw_metadata.type)
  //    samt i coverage-labels (for at fange varianter ikke i kanonisk liste)
  for (const pol of policer) {
    const text = [
      pol.business_activity,
      pol.building_use,
      pol.raw_metadata?.type as string | undefined,
      pol.raw_metadata?.insurance_type as string | undefined,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (text.includes(kravLower)) return true;

    // Tjek også coverage-labels (frie tekst-felter)
    const covs = coveragesByPolicy.get(pol.id) ?? [];
    if (covs.some((c) => c.is_covered && c.coverage_label.toLowerCase().includes(kravLower))) {
      return true;
    }
  }

  return false;
}

/**
 * GAP-067: Branchekrav-check på portefølje-niveau.
 *
 * Aggregerer påkrævede dækninger fra hovedbranche + alle bibrancher
 * og verificerer at hver krævet dækning findes et sted i porteføljen
 * (via coverage-koder ELLER policy-tekst).
 *
 * Adskiller sig fra GAP-051 (per-police, tekst-baseret) ved at:
 * - Aggregerer på tværs af hovedbranche + bibrancher
 * - Tjekker faktiske coverage-koder, ikke kun policy-tekst
 * - Rapporterer ÉT samlet gap med alle manglende dækninger
 */
const checkBranchekravPortfolio: PortfolioCheckFn = ({ branche, policer, coveragesByPolicy }) => {
  if (!branche?.hovedbranche || policer.length === 0) return null;

  // Saml påkrævede dækninger fra hovedbranche + bibrancher
  const allKrav = new Set<string>();
  const kravKilder = new Map<string, string>(); // krav → branche-label
  const hovedKrav = lookupBrancheKrav(branche.hovedbranche);
  if (hovedKrav) {
    for (const k of hovedKrav.kraevede_daekninger) {
      allKrav.add(k.toLowerCase());
      kravKilder.set(k.toLowerCase(), hovedKrav.label);
    }
  }
  for (const b of branche.bibrancher) {
    const biKrav = lookupBrancheKrav(b.kode);
    if (biKrav) {
      for (const k of biKrav.kraevede_daekninger) {
        if (!allKrav.has(k.toLowerCase())) {
          allKrav.add(k.toLowerCase());
          kravKilder.set(k.toLowerCase(), biKrav.label);
        }
      }
    }
  }

  if (allKrav.size === 0) return null;

  // Find manglende krav
  const manglende: Array<{ krav: string; kilde: string }> = [];
  for (const krav of allKrav) {
    if (!isKravCovered(krav, policer, coveragesByPolicy)) {
      manglende.push({ krav, kilde: kravKilder.get(krav) ?? 'branche' });
    }
  }

  if (manglende.length === 0) return null;

  const manglendeLabels = manglende.map((m) => KRAV_LABELS_DA[m.krav] ?? m.krav).join(', ');
  const kilderLabels = Array.from(new Set(manglende.map((m) => m.kilde))).join(', ');

  return {
    check_id: 'GAP-067',
    category: 'branche',
    severity: 'critical',
    title: `Branchekrav: ${manglende.length} påkrævet${manglende.length > 1 ? 'e' : ''} dækning${manglende.length > 1 ? 'er' : ''} mangler`,
    description:
      `Virksomhedens registrerede aktiviteter (${kilderLabels}) kræver dækninger der ` +
      `ikke findes i porteføljen: ${manglendeLabels}. ` +
      `Uden disse dækninger kan erstatning bortfalde for aktiviteter der er ` +
      `omfattet af branchekoden.`,
    recommendation:
      `Tegn de manglende dækninger eller udvid eksisterende policer. ` +
      `Hvis aktiviteten ikke længere udøves, opdater CVR-registreringen.`,
    estimated_impact_dkk: null,
    source_data: {
      hovedbranche: branche.hovedbranche,
      bibrancher: branche.bibrancher.map((b) => b.kode),
      manglende_krav: manglende.map((m) => m.krav),
      manglende_labels: manglende.map((m) => KRAV_LABELS_DA[m.krav] ?? m.krav),
    },
  };
};

/**
 * GAP-070: Dobbelt-forsikring — samme ejendom (adresse) dækket af 2+ policer.
 */
const checkDobbeltForsikring: PortfolioCheckFn = ({ policer }) => {
  const adresseMap = new Map<string, string[]>();
  for (const p of policer) {
    const addr = (p.property_address ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!addr || addr.length < 5) continue;
    const existing = adresseMap.get(addr) ?? [];
    existing.push(p.policy_number);
    adresseMap.set(addr, existing);
  }
  const doubles = [...adresseMap.entries()].filter(([, nums]) => nums.length >= 2);
  if (doubles.length === 0) return null;
  const first = doubles[0];
  return {
    check_id: 'GAP-070',
    category: 'optimering',
    severity: 'warning',
    title: `Dobbelt-forsikring: ${doubles.length} adresse${doubles.length > 1 ? 'r' : ''} dækket af flere policer`,
    description:
      `${doubles.length} ejendom${doubles.length > 1 ? 'me' : ''} er forsikret af 2+ policer. ` +
      `Eksempel: "${first[0]}" dækkes af police ${first[1].join(' + ')}. ` +
      `Ved dobbelt-forsikring betaler kunden unødvendig præmie.`,
    recommendation: 'Konsolidér dækningen til én police per ejendom.',
    estimated_impact_dkk: null,
    source_data: { doubles: doubles.map(([a, nums]) => ({ adresse: a, policer: nums })) },
  };
};

/**
 * GAP-071: Dæknings-overlap — samme coverage_code på 2+ policer for samme adresse.
 */
const checkDaekningsOverlap: PortfolioCheckFn = ({ policer, coveragesByPolicy }) => {
  const adresseCoverages = new Map<string, Map<string, string[]>>();
  for (const p of policer) {
    const addr = (p.property_address ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!addr || addr.length < 5) continue;
    const covs = coveragesByPolicy.get(p.id) ?? [];
    for (const c of covs) {
      if (!c.is_covered) continue;
      const covMap = adresseCoverages.get(addr) ?? new Map<string, string[]>();
      const existing = covMap.get(c.coverage_code) ?? [];
      existing.push(p.policy_number);
      covMap.set(c.coverage_code, existing);
      adresseCoverages.set(addr, covMap);
    }
  }
  const overlaps: Array<{ adresse: string; coverage: string; policer: string[] }> = [];
  for (const [addr, covMap] of adresseCoverages) {
    for (const [code, nums] of covMap) {
      if (nums.length >= 2) overlaps.push({ adresse: addr, coverage: code, policer: nums });
    }
  }
  if (overlaps.length === 0) return null;
  const ex = overlaps[0];
  return {
    check_id: 'GAP-071',
    category: 'optimering',
    severity: 'info',
    title: `Dæknings-overlap: ${overlaps.length} dækning${overlaps.length > 1 ? 'er' : ''} er dubleret`,
    description:
      `${overlaps.length} dækningstype${overlaps.length > 1 ? 'r' : ''} findes i flere policer ` +
      `for samme ejendom. Eksempel: "${ex.coverage}" på "${ex.adresse}" ` +
      `dækkes af police ${ex.policer.join(' + ')}.`,
    recommendation: 'Fjern dubletter fra den mindst fordelagtige police.',
    estimated_impact_dkk: null,
    source_data: { overlaps },
  };
};

/**
 * Alle portefølje-checks i præsentationsrækkefølge.
 */
const PORTFOLIO_CHECKS: readonly PortfolioCheckFn[] = [
  checkBranchekravPortfolio,
  checkPortfolioDnO,
  checkPortfolioDriftstab,
  checkPortfolioHuslejetab,
  checkKollektivBygning,
  // GAP-066 (checkLavPraemie) er deaktiveret — produktet udtaler sig
  // ikke om økonomi/præmie-niveau, kun om dækningsmangler. Hvis præmien
  // er suspekt lav fordi ikke alle ejendomme er forsikrede, fanges det
  // allerede af GAP-100 (uforsikret aktiv) på den enkelte ejendoms-række.
  checkPortfolioCyber,
  checkPortfolioRetshjaelp,
  // BIZZ-1635: Dobbelt-forsikring og overlap-detektion
  checkDobbeltForsikring,
  checkDaekningsOverlap,
];

/**
 * Kør portefølje-niveau checks på tværs af alle aktiver og policer.
 *
 * Disse checks supplerer per-police/per-aktiv checks fra runGapEngine
 * og fanger mangler der kun er synlige når man ser hele porteføljen samlet:
 * - Manglende D&O for A/S (GAP-060)
 * - Huslejetab mangler for ejendomme (GAP-061)
 * - Kollektiv bygningsforsikring anbefalet (GAP-062)
 * - Cyber-forsikring mangler (GAP-063)
 * - Retshjælp mangler (GAP-064)
 * - Driftstab mangler for udlejning (GAP-065)
 * - Lav præmie vs. portefølje (GAP-066)
 *
 * @param input - Portefølje-data: aktiver, matches, policer, dækninger
 * @returns Liste af detekterede portefølje-gaps
 */
export function runPortfolioChecks(input: PortfolioCheckInput): DetectedGap[] {
  const results: DetectedGap[] = [];
  for (const check of PORTFOLIO_CHECKS) {
    try {
      const result = check(input);
      if (result) results.push(result);
    } catch {
      continue;
    }
  }
  return results;
}
