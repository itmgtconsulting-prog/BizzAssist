/**
 * sfeStruktur — BIZZ-2096: SFE-strukturopslag og dæknings-arv for forsikringsanalysen.
 *
 * Dansk ejendomsstruktur (jf. BIZZ-859): SFE → hovedejendom → ejerlejlighed.
 * En police tegnet på en SFE-adresse dækker som udgangspunkt hele strukturen
 * (alle bygninger/enheder på SFE'ens matrikler). Fx dækker en police på
 * "Gefionsvej 47A" (SFE-BFE 5322356, matrikel 65bp) også Fenrisvej 27A/27B og
 * Gefionsvej 49-57 som ligger på samme matrikel.
 *
 * Opslags-kæde (DAWA, ingen mTLS):
 *   adresse → adgangsadresse.jordstykke (ejerlavkode + matrikelnr)
 *           → jordstykker?ejerlavkode&matrikelnr → bfenummer (= SFE-BFE)
 *
 * Arve-reglen er ren ({@link applySfeArv}) så den kan unit-testes uden netværk;
 * {@link berigMedSfeStruktur} laver opslagene og kalder den.
 *
 * Datahåndtering: kun offentlige adresse-/matrikeldata (DAWA) — ingen PII.
 */

import type { MatchResult } from './assetMatcher';
import type { ForsikringPolicy } from './types';

const DAWA = 'https://api.dataforsyningen.dk';
const TIMEOUT_MS = 8000;

/**
 * Max antal unikke adresse-opslag pr. analyse (beskytter maxDuration=60).
 * BIZZ-2124: hævet fra 40 — etage/dør-stripning gør at enheder på samme
 * opgang deler cache-entry, så reelle netværkskald er langt færre.
 */
const MAX_LOOKUPS = 150;

/** Parallelitet for DAWA-opslag */
const BATCH_SIZE = 5;

/**
 * Score for dækning nedarvet via SFE-struktur. Ligger under direkte
 * adresse-match (80-100) men over MATCH_THRESHOLD (50) — og har sin egen
 * begrundelse i matchBegrundelse.ts (holdes i sync).
 */
export const SFE_ARV_SCORE = 75;

/** SFE-tilhør for et aktiv eller en police-adresse */
export interface SfeOpslag {
  /** SFE-BFE (samlet fast ejendom) som adressen ligger på */
  sfeBfe: number;
  /**
   * Ejerlavkode for adressens jordstykke. BIZZ-2128: bruges ikke længere til
   * arv (søster-SFE-kæden er fjernet, da den gav falsk dækning på tværs af
   * matrikler i store by-ejerlav) — bevares som resolvet cadastral kontekst.
   */
  ejerlavKode: number | null;
}

/** Modul-level cache pr. lambda-instans: normaliseret adresse → SFE-opslag (null = opslag fejlede) */
const adresseSfeCache = new Map<string, SfeOpslag | null>();

/**
 * Hent JSON fra DAWA med timeout. Returnerer null ved enhver fejl (best-effort).
 *
 * @param url - Fuld DAWA-URL
 * @returns Parsed JSON eller null
 */
async function fetchDawaJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Normalisér en dansk adresse til adgangsadresse-form (BIZZ-2124).
 *
 * DAWA /adgangsadresser kender ikke etage/dør, og q-søgningen giver 0 hits når
 * de medsendes ("Stjernegade 24H, 1 2, 3000 Helsingør" → ingen hit). Derfor:
 * 1. Fjern etage/dør-segmenter (", 1 2", ", 2 tv", ", 1 th", ", 2 mf",
 *    ", st", ", st. tv", ", kl", ", 1.") — kun "vejnavn husnr, postnr by" bevares
 * 2. Kollaps husnummer-mellemrum ("Torvegade 3 A" → "Torvegade 3A") — den rå
 *    PDF-form giver heller ingen DAWA-hit
 *
 * @param adresse - Fritekst-adresse, evt. med etage/dør
 * @returns Adresse uden etage/dør-segmenter og med kollapset husnummer
 */
export function tilAdgangsadresse(adresse: string): string {
  const dele = adresse
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
  // Etage/dør-segment: etage = "st", "kl", "kl2", "1", "1." (1-2 cifre — postnr
  // har 4 og rammes ikke); dør = "tv", "th", "mf" eller dørnummer
  const erEtageDoer = (s: string) =>
    /^(st|kl\d{0,2}|\d{1,2})\.?(\s+(tv|th|mf|\d{1,4})\.?)?$/i.test(s);
  // Første segment er altid "vejnavn husnr" og bevares
  const beholdte = dele.filter((d, i) => i === 0 || !erEtageDoer(d));
  return beholdte.join(', ').replace(/\b(\d+)\s+([a-zæøå])\b/gi, '$1$2');
}

/**
 * Resolve SFE-opslag (SFE-BFE + ejerlavkode) for en dansk adresse via DAWA
 * (adgangsadresse → jordstykke → BFE). Adressen normaliseres først med
 * {@link tilAdgangsadresse} så ejerlejligheds-adresser med etage/dør resolver
 * til samme SFE som basisadressen (BIZZ-2124).
 *
 * @param adresse - Fritekst-adresse, fx "Gefionsvej 47A, 3000 Helsingør"
 * @returns SFE-opslag eller null hvis adressen ikke kan resolves
 */
export async function resolveSfeForAdresse(adresse: string): Promise<SfeOpslag | null> {
  const normaliseret = tilAdgangsadresse(adresse);
  const key = normaliseret.toLowerCase().trim();
  if (!key) return null;
  const cached = adresseSfeCache.get(key);
  if (cached !== undefined) return cached;

  const adresser = (await fetchDawaJson(
    `${DAWA}/adgangsadresser?q=${encodeURIComponent(normaliseret)}&per_side=1`
  )) as Array<{
    adressebetegnelse?: string;
    jordstykke?: { ejerlav?: { kode?: number }; matrikelnr?: string };
  }> | null;

  const hit = adresser?.[0];
  const ejerlav = hit?.jordstykke?.ejerlav?.kode;
  const matrikelnr = hit?.jordstykke?.matrikelnr;
  // Guard mod fuzzy-mismatches: husnummeret i input skal optræde i DAWA-hittet
  const husnrMatch = (() => {
    const husnr = key.match(/\b(\d+[a-zæøå]?)\b/)?.[1];
    if (!husnr || !hit?.adressebetegnelse) return true;
    return hit.adressebetegnelse.toLowerCase().includes(` ${husnr}`);
  })();

  if (!ejerlav || !matrikelnr || !husnrMatch) {
    adresseSfeCache.set(key, null);
    return null;
  }

  const jordstykker = (await fetchDawaJson(
    `${DAWA}/jordstykker?ejerlavkode=${ejerlav}&matrikelnr=${encodeURIComponent(matrikelnr)}&format=json`
  )) as Array<{ bfenummer?: number }> | null;

  const sfeBfe = jordstykker?.[0]?.bfenummer ?? null;
  const opslag: SfeOpslag | null = sfeBfe ? { sfeBfe, ejerlavKode: ejerlav } : null;
  adresseSfeCache.set(key, opslag);
  return opslag;
}

/** Police-dækning på SFE-niveau: SFE-BFE → police + den adresse der udløste dækningen */
export type PolicySfeMap = Map<
  number,
  { policy: ForsikringPolicy; sfeAdresse: string; ejerlavKode: number | null }
>;

/** Aktiv-index (i matches-array) → SFE-opslag */
export type AktivSfeMap = Map<number, SfeOpslag>;

/** Resultat af SFE-berigelsen */
export interface SfeArvResultat {
  /** Antal aktiver der fik nedarvet dækning */
  inherited: number;
  /**
   * BIZZ-2118: Policy-IDs hvis forsikringssted resolver til en SFE som
   * porteføljens aktiver tilhører (direkte eller via søster-SFE-kæden).
   * Bruges til at undertrykke "uden for porteføljen"-advarslen — en police
   * der anvendes til SFE-arv kan ikke samtidig være uden for porteføljen.
   */
  portefoeljePolicyIds: Set<string>;
}

/**
 * Ren arve-regel: annotér aktiver med SFE-struktur og nedarv dækning fra
 * policer på SFE-adresser til umatchede aktiver PÅ SAMME SFE.
 *
 * BIZZ-2128: Den tidligere søster-SFE-kæde (BIZZ-2118 — arv på tværs af
 * forskellige SFE'er i samme ejerlav med samme ejer) er FJERNET. I store
 * by-ejerlav (fx "Helsingør Bygrunde") var "samme ejerlav + samme ejer" alt
 * for løst og gav falsk dækning: en enkelt bygningspolice på én adresse blev
 * arvet til alle ejerens fysisk adskilte ejendomme i hele bymidten. Kun
 * direkte arv inden for SAMME SFE-BFE bevares (det fysisk korrekte tilfælde,
 * fx Gefionsvej 47A → Fenrisvej 27A/27B på samme matrikel).
 *
 * Muterer matches in-place (samme konvention som route'ns øvrige berigelse):
 * - Alle ejendoms-aktiver med kendt SFE får `rawData.sfe_bfe` + `rawData.sfe_niveau`
 *   ('sfe' når aktivets eget BFE er SFE-BFE'et, ellers 'underliggende')
 * - Umatchede aktiver hvis SFE er dækket af en police får `bestMatch` med
 *   score {@link SFE_ARV_SCORE} og `rawData.daekket_via_sfe = { sfe_bfe, sfe_adresse }`
 *
 * @param matches - Match-resultater fra matchAssetsToPolicies
 * @param aktivSfe - Aktiv-index → SFE-opslag (kun ejendoms-aktiver med opslag)
 * @param policySfe - SFE-BFE → dækkende police
 * @returns Antal nedarvede dækninger + policy-IDs forankret i porteføljen
 */
export function applySfeArv(
  matches: MatchResult[],
  aktivSfe: AktivSfeMap,
  policySfe: PolicySfeMap
): SfeArvResultat {
  // Forankrede SFE-BFE'er: aktiver forankret på en SFE (via adresse-opslag
  // ELLER fordi aktivets eget BFE er SFE-BFE'et). Bruges til at undertrykke
  // "uden for porteføljen"-advarslen for policer hvis SFE rummer aktiver.
  const forankredeSfeBfes = new Set<number>();
  for (const [idx, opslag] of aktivSfe) {
    const m = matches[idx];
    if (!m || m.aktiv.type !== 'ejendom') continue;
    forankredeSfeBfes.add(opslag.sfeBfe);
  }
  for (const m of matches) {
    if (m.aktiv.type === 'ejendom' && m.aktiv.bfe) {
      forankredeSfeBfes.add(m.aktiv.bfe);
    }
  }

  // Policer hvis SFE er forankret i porteføljen → må ikke flages "uden for porteføljen".
  const portefoeljePolicyIds = new Set<string>();
  for (const [sfeBfe, entry] of policySfe) {
    if (forankredeSfeBfes.has(sfeBfe)) portefoeljePolicyIds.add(entry.policy.id);
  }

  let inherited = 0;
  for (const [idx, opslag] of aktivSfe) {
    const m = matches[idx];
    if (!m || m.aktiv.type !== 'ejendom') continue;

    // Strukturel annotering til UI-gruppering/sortering
    m.aktiv.rawData = {
      ...m.aktiv.rawData,
      sfe_bfe: opslag.sfeBfe,
      sfe_niveau: m.aktiv.bfe === opslag.sfeBfe ? 'sfe' : 'underliggende',
    };

    if (m.bestMatch) continue; // direkte match vinder altid over arv

    // Direkte SFE-arv: policen er tegnet på aktivets egen SFE-adresse
    const daekning = policySfe.get(opslag.sfeBfe);
    if (daekning) {
      m.bestMatch = { policy: daekning.policy, score: SFE_ARV_SCORE };
      m.aktiv.rawData = {
        ...m.aktiv.rawData,
        daekket_via_sfe: { sfe_bfe: opslag.sfeBfe, sfe_adresse: daekning.sfeAdresse },
      };
      inherited++;
    }
  }
  return { inherited, portefoeljePolicyIds };
}

/**
 * Kør promise-funktioner i batches af BATCH_SIZE (begrænset parallelitet).
 *
 * @param tasks - Funktioner der starter hver sit opslag
 */
async function runBatched(tasks: Array<() => Promise<void>>): Promise<void> {
  for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
    await Promise.all(tasks.slice(i, i + BATCH_SIZE).map((t) => t()));
  }
}

/**
 * Berig match-resultater med SFE-struktur og nedarvet police-dækning (BIZZ-2096).
 *
 * Resolver SFE-BFE for (1) alle police-forsikringssteder og (2) alle
 * ejendoms-aktiver med adresse (cappet til {@link MAX_LOOKUPS}), og anvender
 * derefter den rene arve-regel {@link applySfeArv}. Best-effort: fejlede
 * opslag springes over uden at analysen fejler.
 *
 * @param matches - Match-resultater fra matchAssetsToPolicies (muteres)
 * @param policer - Analysens policer
 * @returns Antal nedarvede dækninger + policy-IDs forankret i porteføljen
 */
export async function berigMedSfeStruktur(
  matches: MatchResult[],
  policer: ForsikringPolicy[]
): Promise<SfeArvResultat> {
  const alleEjendomIdx = matches
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.aktiv.type === 'ejendom' && (m.aktiv.adresse ?? '').trim().length > 0);
  // BIZZ-2124: log eksplicit når der cappes, så stille drop af aktiver opdages
  if (alleEjendomIdx.length > MAX_LOOKUPS) {
    console.warn(
      `[sfeStruktur] ${alleEjendomIdx.length} ejendoms-aktiver overstiger MAX_LOOKUPS=${MAX_LOOKUPS} — ${alleEjendomIdx.length - MAX_LOOKUPS} springes over i SFE-arven`
    );
  }
  const ejendomIdx = alleEjendomIdx.slice(0, MAX_LOOKUPS);

  const policerMedAdresse = policer.filter((p) => (p.property_address ?? '').trim().length > 0);
  if (ejendomIdx.length === 0 || policerMedAdresse.length === 0) {
    return { inherited: 0, portefoeljePolicyIds: new Set() };
  }

  // 1. SFE-opslag for police-forsikringssteder
  const policySfe: PolicySfeMap = new Map();
  await runBatched(
    policerMedAdresse.map((p) => async () => {
      const adresse = (p.property_address ?? '').trim();
      const opslag = await resolveSfeForAdresse(adresse);
      if (opslag && !policySfe.has(opslag.sfeBfe)) {
        policySfe.set(opslag.sfeBfe, {
          policy: p,
          sfeAdresse: adresse,
          ejerlavKode: opslag.ejerlavKode,
        });
      }
    })
  );

  // 2. SFE-opslag for ejendoms-aktiver
  const aktivSfe: AktivSfeMap = new Map();
  await runBatched(
    ejendomIdx.map(({ m, i }) => async () => {
      const opslag = await resolveSfeForAdresse((m.aktiv.adresse ?? '').trim());
      if (opslag) aktivSfe.set(i, opslag);
    })
  );

  // 3. Ren arve-regel
  return applySfeArv(matches, aktivSfe, policySfe);
}
