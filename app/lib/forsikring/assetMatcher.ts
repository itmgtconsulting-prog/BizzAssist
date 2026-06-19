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
 * BIZZ-1973: Parse en normaliseret adresse til { vejnavn, husnr-nummer, postnr }.
 * Husnummer-bogstav stripes ("47a" → "47") så matchet bliver bogstav-agnostisk.
 *
 * @param norm - Allerede normaliseret adresse (via normalize())
 * @returns Strukturerede dele, eller null hvis vejnavn+husnr ikke kunne udledes
 */
function parseStreetAddr(norm: string): {
  vejnavn: string;
  husnr: string;
  /** Slut-husnr ved range-adresse ("47a-51" → husnrTil="51"), ellers null */
  husnrTil: string | null;
  postnr: string | null;
} | null {
  const tokens = norm.split(' ').filter(Boolean);
  // Husnummer = første token der starter med et ciffer (evt. efterfulgt af bogstav)
  let husnrIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (/^\d+[a-z]?$/.test(tokens[i])) {
      husnrIdx = i;
      break;
    }
  }
  // Kræv mindst ét vejnavn-token før husnummeret
  if (husnrIdx <= 0) return null;
  const vejnavn = tokens.slice(0, husnrIdx).join(' ');
  const husnr = tokens[husnrIdx].replace(/[a-z]+$/, ''); // strip bogstav → kun nummer
  // Range-detektion: næste token er et 1-3 cifret tal (normalize erstatter "-"
  // med mellemrum, så "47a-51" → "47a 51" → tokens ["47a", "51"]). 4-cifrede
  // tokens er postnumre, ikke slut-husnumre.
  let husnrTil: string | null = null;
  const nextIdx = husnrIdx + 1;
  if (nextIdx < tokens.length && /^\d{1,3}[a-z]?$/.test(tokens[nextIdx])) {
    const candidate = parseInt(tokens[nextIdx].replace(/[a-z]+$/, ''), 10);
    const start = parseInt(husnr, 10);
    // Kun et range hvis slut > start og forskellen er rimelig (maks 100)
    if (!isNaN(candidate) && !isNaN(start) && candidate > start && candidate - start <= 100) {
      husnrTil = tokens[nextIdx].replace(/[a-z]+$/, '');
    }
  }
  // Postnummer = et 4-cifret token efter husnummeret (og evt. range-slut)
  let postnr: string | null = null;
  const searchFrom = husnrTil ? nextIdx + 1 : nextIdx;
  for (let i = searchFrom; i < tokens.length; i++) {
    if (/^\d{4}$/.test(tokens[i])) {
      postnr = tokens[i];
      break;
    }
  }
  return { vejnavn, husnr, husnrTil, postnr };
}

/**
 * BIZZ-1973: Afgør om to adresser med rimelig sikkerhed refererer til samme
 * ejendom. Bruges til at advare når en uploadet police dækker en adresse der
 * hverken ejes eller administreres af forsikringssejeren.
 *
 * Matchet er husnummer-bogstav-agnostisk ("Stjernegade 17" = "Stjernegade 17A")
 * jf. BIZZ-1908, og kræver at postnummeret matcher når begge adresser har et
 * (så "Hovedgade 5" i to forskellige byer ikke fejlmatcher).
 *
 * Forstår husnummer-ranges ("Gefionsvej 47A-51" matcher "Gefionsvej 49")
 * — typisk for forsikringspolicer der dækker flere bygninger på samme vej.
 *
 * @param a - Første adresse (rå streng, fx police.property_address)
 * @param b - Anden adresse (rå streng, fx en porteføljeejendoms adresse)
 * @returns true hvis adresserne sandsynligvis er samme ejendom
 */
export function addressesMatch(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  // Etage/dør-tolerant sammenligning
  const baseA = stripFloorDoor(na);
  const baseB = stripFloorDoor(nb);
  if (baseA && baseB && (baseA === baseB || baseA.includes(baseB) || baseB.includes(baseA))) {
    return true;
  }
  // Struktureret sammenligning: vejnavn + husnr-nummer (bogstav-agnostisk) + postnr
  const pa = parseStreetAddr(baseA || na);
  const pb = parseStreetAddr(baseB || nb);
  if (!pa || !pb) return false;
  if (pa.vejnavn !== pb.vejnavn) return false;
  // Postnr skal matche når begge har et — ellers er gade+husnr nok
  if (pa.postnr && pb.postnr && pa.postnr !== pb.postnr) return false;
  // Eksakt husnr-match
  if (pa.husnr === pb.husnr) return true;
  // Range-match: "47a-51" matcher alle husnumre i [47..51]
  if (pa.husnrTil || pb.husnrTil) {
    const inRange = (single: string, fra: string, til: string): boolean => {
      const n = parseInt(single, 10);
      const f = parseInt(fra, 10);
      const t = parseInt(til, 10);
      return !isNaN(n) && !isNaN(f) && !isNaN(t) && n >= f && n <= t;
    };
    if (pa.husnrTil && !pb.husnrTil) return inRange(pb.husnr, pa.husnr, pa.husnrTil);
    if (pb.husnrTil && !pa.husnrTil) return inRange(pa.husnr, pb.husnr, pb.husnrTil);
    // Begge er ranges — check overlap
    if (pa.husnrTil && pb.husnrTil) {
      const af = parseInt(pa.husnr, 10),
        at = parseInt(pa.husnrTil, 10);
      const bf = parseInt(pb.husnr, 10),
        bt = parseInt(pb.husnrTil, 10);
      return !isNaN(af) && !isNaN(at) && !isNaN(bf) && !isNaN(bt) && af <= bt && bf <= at;
    }
  }
  return false;
}

/**
 * BIZZ-2120: Koncern-kontekst afledt af aktiverne i analysen. Bruges til at
 * afvise policer tegnet af virksomheder uden for kundens koncern, så en anden
 * kundes police i samme tenant aldrig kan "dække" et aktiv.
 */
interface KoncernKontekst {
  /** CVR-numre for alle virksomheder i koncern-walket */
  cvrs: Set<string>;
  /** Normaliserede virksomhedsnavne for alle virksomheder i koncern-walket */
  navne: string[];
}

/** Sikret/medforsikret virksomhed parsed fra policen (BIZZ-2120) */
interface InsuredCompany {
  navn: string;
  cvr?: string | null;
}

/**
 * BIZZ-2120: Læs policens parsede sikrede-virksomheds-liste fra raw_metadata.
 *
 * @param policy - Police fra DB
 * @returns Liste af sikrede selskaber, eller null hvis ikke parsed
 */
function getInsuredCompanies(policy: ForsikringPolicy): InsuredCompany[] | null {
  const raw = policy.raw_metadata?.insured_companies;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw.filter((c): c is InsuredCompany => !!c && typeof c.navn === 'string');
}

/**
 * BIZZ-2120: Afgør om policens forsikringstager hører til kundens koncern —
 * via CVR-match eller normaliseret navnematch mod koncern-virksomhederne.
 *
 * @param policy - Police fra DB
 * @param koncern - Koncern-kontekst fra aktiverne
 * @returns true hvis forsikringstager er en del af koncernen
 */
function policyholderIKoncern(policy: ForsikringPolicy, koncern: KoncernKontekst): boolean {
  if (policy.policyholder_cvr && koncern.cvrs.has(policy.policyholder_cvr)) return true;
  const phNavn = normalize(policy.policyholder_name);
  if (!phNavn) return false;
  return koncern.navne.some(
    (n) => n.length > 0 && (n === phNavn || n.includes(phNavn) || phNavn.includes(n))
  );
}

/**
 * Beregn match-score mellem et aktiv og en police.
 *
 * @param aktiv - Aktiv fra koncern-walk
 * @param policy - Police fra DB
 * @param koncern - BIZZ-2120: Koncern-kontekst for kryds-kunde-afvisning
 * @returns Score 0-100 (højere = bedre match)
 */
function computeMatchScore(
  aktiv: Aktiv,
  policy: ForsikringPolicy,
  koncern: KoncernKontekst
): number {
  switch (aktiv.type) {
    case 'ejendom':
      return scoreEjendom(aktiv, policy);
    case 'virksomhed':
      return scoreVirksomhed(aktiv, policy, koncern);
    case 'bil':
      return scoreBil(aktiv, policy);
    case 'bestyrelsespost':
      return scoreBestyrelsespost(aktiv, policy);
    default:
      return 0;
  }
}

/**
 * BIZZ-2153: Parse en normaliseret adresse til vejnavn + husnr + husbogstav,
 * inkl. et evt. bogstav-interval. En police tegnet på "Stjernegade 24 A-H"
 * normaliseres til "stjernegade 24a h ..." — dvs. husnr-tokenet bærer
 * start-bogstavet ("24a") og det efterfølgende ensomme bogstav-token ("h")
 * angiver intervallets slut.
 *
 * @param norm - Allerede normaliseret adresse (via normalize())
 * @returns { vejnavn, husnr, bogstav, til, postnr } eller null
 */
function parseHusbogstav(norm: string): {
  vejnavn: string;
  husnr: string;
  bogstav: string | null;
  /** Slut-bogstav ved interval ("24 A-H" → til="h"), ellers null */
  til: string | null;
  postnr: string | null;
} | null {
  const tokens = norm.split(' ').filter(Boolean);
  // Husnummer = første token der starter med et ciffer (evt. efterfulgt af bogstav)
  let idx = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (/^\d+[a-z]?$/.test(tokens[i])) {
      idx = i;
      break;
    }
  }
  // Kræv mindst ét vejnavn-token før husnummeret
  if (idx <= 0) return null;
  const m = tokens[idx].match(/^(\d+)([a-z])?$/)!;
  const husnr = m[1];
  const bogstav = m[2] ?? null;
  // Interval-slut: et ensomt enkelt-bogstav-token umiddelbart efter, større end start
  let til: string | null = null;
  const next = tokens[idx + 1];
  if (bogstav && next && /^[a-z]$/.test(next) && next > bogstav) {
    til = next;
  }
  // Postnummer = første 4-cifrede token efter husnummeret
  const postnr = tokens.slice(idx + 1).find((t) => /^\d{4}$/.test(t)) ?? null;
  return { vejnavn: tokens.slice(0, idx).join(' '), husnr, bogstav, til, postnr };
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

  // BIZZ-2153: Bogstav-interval — en police tegnet på "Stjernegade 24 A-H"
  // dækker hele opgangsrækken 24A..24H. normalize() splitter intervallet
  // ("24 A-H" → "24a h"), så uden dette matcher kun 24A (intervallets start)
  // direkte, mens 24B-H falder igennem til svagere SFE-arv.
  const pPol = parseHusbogstav(policyAddr);
  const pAk = parseHusbogstav(aktivAddr);
  if (
    pPol &&
    pAk &&
    pPol.til &&
    pPol.bogstav &&
    pAk.bogstav &&
    pPol.vejnavn === pAk.vejnavn &&
    pPol.husnr === pAk.husnr &&
    (!pPol.postnr || !pAk.postnr || pPol.postnr === pAk.postnr) &&
    pAk.bogstav >= pPol.bogstav &&
    pAk.bogstav <= pPol.til
  ) {
    return 80;
  }

  // BIZZ-2158: Sekundære adgangsadresser — en SFE kan have flere adresser
  // (fx Gyldenstræde 8A + Stengade 10A på matrikel 519). Policer tegnet på
  // sekundære adresser skal matche det primære aktiv.
  const secondaryAddresses = (aktiv.rawData as Record<string, unknown> | undefined)
    ?.secondaryAddresses as string[] | undefined;
  if (secondaryAddresses) {
    for (const secAddr of secondaryAddresses) {
      const normSec = normalize(secAddr);
      if (!normSec) continue;
      if (normSec === policyAddr) return 88;
      if (normSec.includes(policyAddr) || policyAddr.includes(normSec)) return 83;
      const secBase = stripFloorDoor(normSec);
      if (
        secBase &&
        policyBase &&
        (secBase === policyBase || secBase.includes(policyBase) || policyBase.includes(secBase))
      ) {
        return 80;
      }
    }
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
function scoreVirksomhed(aktiv: Aktiv, policy: ForsikringPolicy, koncern: KoncernKontekst): number {
  // CVR-match (eksakt)
  if (aktiv.cvr && policy.policyholder_cvr && aktiv.cvr === policy.policyholder_cvr) {
    return 100;
  }

  const aktivNavn = normalize(aktiv.label);

  // BIZZ-2120: Har policen en parsed sikrede-liste, matches PR. SIKRET SELSKAB
  // — kun virksomheder på listen kan dækkes af policen, og den brede 70-regel
  // nedenfor springes over (policen har eksplicit afgrænset hvem den dækker).
  const insured = getInsuredCompanies(policy);
  if (insured) {
    for (const c of insured) {
      if (aktiv.cvr && c.cvr && aktiv.cvr === c.cvr) return 95;
      const cNavn = normalize(c.navn);
      if (
        aktivNavn &&
        cNavn &&
        (aktivNavn === cNavn || aktivNavn.includes(cNavn) || cNavn.includes(aktivNavn))
      ) {
        return 85;
      }
    }
    return 0;
  }

  // Navn-match mod forsikringstager (policen er tegnet AF dette selskab)
  const policyNavn = normalize(policy.policyholder_name);
  if (aktivNavn && policyNavn && aktivNavn === policyNavn) return 75;

  // Delvis navne-match (indeholder hinanden)
  if (aktivNavn && policyNavn) {
    if (aktivNavn.includes(policyNavn) || policyNavn.includes(aktivNavn)) return 60;
  }

  // BIZZ-2164: En koncern-erhvervs-/ansvarspolice dækker IKKE automatisk alle
  // søsterselskaber — kun forsikringstageren (matchet ovenfor via CVR/navn) og
  // de NAVNGIVNE medforsikrede (insured_companies, håndteret ovenfor). RACEHALL-
  // fejlen: ansvarspolicen RPXDK40.000244 (tegnet af Racehall København) dækker
  // kun Racehall København + de medforsikrede Racehall Ejendomme/Aarhus — IKKE
  // SKIINVEST eller Racehall Holding. Den tidligere BIZZ-1620-regel gav alle
  // koncern-selskaber score 70 (= dækket), hvilket fejlagtigt markerede ikke-
  // navngivne søstre som forsikrede og skjulte et reelt dækningshul.
  //
  // Når policen mangler en parsed sikrede-liste kan vi ikke fastslå at en søster
  // er dækket, så et erhvervs-/ansvars-policematch vises nu kun som svag KANDIDAT
  // (score 45 < MATCH_THRESHOLD) — synlig i candidates til mægler-gennemgang, men
  // tæller ikke som forsikret. Upload den fulde police (med medforsikrede) for at
  // få de navngivne datterselskaber korrekt markeret som dækket (score 85/95).
  const coverageText = normalize(
    [policy.insurance_form, policy.business_activity, policy.policyholder_name].join(' ')
  );
  if (
    (coverageText.includes('erhverv') ||
      coverageText.includes('virksomhed') ||
      coverageText.includes('ansvar') ||
      coverageText.includes('drift') ||
      coverageText.includes('koncern')) &&
    policyholderIKoncern(policy, koncern)
  ) {
    return 45;
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
  // BIZZ-2120: Koncern-kontekst = virksomhederne i koncern-walket. Bruges af
  // scoreVirksomhed til at kræve at policens forsikringstager hører til
  // kundens egen koncern før den brede erhvervsaktivitets-regel (70) anvendes.
  const koncern: KoncernKontekst = {
    cvrs: new Set(
      aktiver.filter((a) => a.type === 'virksomhed' && a.cvr).map((a) => a.cvr as string)
    ),
    navne: aktiver
      .filter((a) => a.type === 'virksomhed')
      .map((a) => normalize(a.label))
      .filter((n) => n.length > 0),
  };
  return aktiver.map((aktiv) => {
    const candidates = policer
      .map((policy) => ({ policy, score: computeMatchScore(aktiv, policy, koncern) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);

    const bestMatch =
      candidates.length > 0 && candidates[0].score >= MATCH_THRESHOLD ? candidates[0] : null;

    return { aktiv, bestMatch, candidates };
  });
}
