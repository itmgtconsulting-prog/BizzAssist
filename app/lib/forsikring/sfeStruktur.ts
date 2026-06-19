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
import { logger } from '@/app/lib/logger';

/**
 * BIZZ-2134: Check om to jordstykke-polygoner er tilstødende (deler matrikelgrænse).
 * Beregner mindste afstand mellem polygon-punkter — < 2m = tilstødende.
 */
function arePolygonsAdjacent(
  poly1: Array<[number, number]>,
  poly2: Array<[number, number]>
): boolean {
  const THRESHOLD_M = 2;
  const COS_LAT = Math.cos((56 * Math.PI) / 180);
  for (const p1 of poly1) {
    for (const p2 of poly2) {
      const dx = (p1[0] - p2[0]) * 111000 * COS_LAT;
      const dy = (p1[1] - p2[1]) * 111000;
      if (dx * dx + dy * dy < THRESHOLD_M * THRESHOLD_M) return true;
    }
  }
  return false;
}

/** Cache for jordstykke-polygoner (BFE → polygon coords) */
const polygonCache = new Map<number, Array<[number, number]> | null>();

/**
 * Hent jordstykke-polygon for et BFE fra DAWA (cached).
 */
async function fetchPolygon(bfe: number): Promise<Array<[number, number]> | null> {
  if (polygonCache.has(bfe)) return polygonCache.get(bfe) ?? null;
  try {
    const r = await fetch(
      `https://api.dataforsyningen.dk/jordstykker?bfenummer=${bfe}&format=geojson`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!r.ok) {
      polygonCache.set(bfe, null);
      return null;
    }
    const gj = (await r.json()) as {
      features?: Array<{ geometry?: { coordinates?: Array<Array<[number, number]>> } }>;
    };
    const poly = gj.features?.[0]?.geometry?.coordinates?.[0] ?? null;
    polygonCache.set(bfe, poly);
    return poly;
  } catch {
    polygonCache.set(bfe, null);
    return null;
  }
}

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
  let normaliseret = tilAdgangsadresse(adresse);
  // BIZZ-2133: Range-adresser ("47A-51") → brug start-adressen ("47A") for DAWA-opslag
  normaliseret = normaliseret.replace(/(\d+[A-Za-z]?)\s*-\s*\d+[A-Za-z]?/, '$1');
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
 * Læs ejer-CVR fra et aktivs koncernwalk-metadata.
 *
 * @param m - Match-resultat
 * @returns Ejer-CVR eller null
 */
function ejerCvrAf(m: MatchResult): string | null {
  const cvr = (m.aktiv.rawData as { ejer_cvr?: unknown } | undefined)?.ejer_cvr;
  return typeof cvr === 'string' && cvr.length > 0 ? cvr : null;
}

/**
 * Ren arve-regel: annotér aktiver med SFE-struktur og nedarv dækning fra
 * policer på SFE-adresser til umatchede aktiver PÅ SAMME SFE.
 *
 * BIZZ-2128: Den tidligere søster-SFE-KÆDE (BIZZ-2118 — DÆKNINGS-arv på tværs
 * af forskellige SFE'er i samme ejerlav) er FJERNET. I store by-ejerlav (fx
 * "Helsingør Bygrunde") var "samme ejerlav + samme ejer" alt for løst og gav
 * falsk dækning. Kun direkte arv inden for SAMME SFE-BFE giver dækning (det
 * fysisk korrekte tilfælde, fx Gefionsvej 47A → Fenrisvej 27A/27B på samme
 * matrikel — inkl. hovedejendomme og ejerlejligheder under SFE'en).
 *
 * BIZZ-2130: Søster-SFE-relationen ANNOTERES dog stadig (uden dækning), så
 * brugeren kan se at et uforsikret aktiv ligger i samme ejerlav som en dækket
 * SFE og vurdere om det skal medforsikres.
 *
 * Muterer matches in-place (samme konvention som route'ns øvrige berigelse):
 * - Alle ejendoms-aktiver med kendt SFE får `rawData.sfe_bfe` + `rawData.sfe_niveau`
 *   ('sfe' når aktivets eget BFE er SFE-BFE'et, ellers 'underliggende')
 * - Umatchede aktiver hvis SFE er dækket af en police får `bestMatch` med
 *   score {@link SFE_ARV_SCORE} og `rawData.daekket_via_sfe = { sfe_bfe, sfe_adresse }`
 * - BIZZ-2130: Umatchede aktiver hvis SFE er en søster-SFE (samme ejerlav,
 *   samme ejer som en dækket SFE — men IKKE samme SFE-BFE) får KUN
 *   `rawData.soester_sfe = { sfe_bfe, sfe_adresse }` (ingen bestMatch/dækning)
 *
 * @param matches - Match-resultater fra matchAssetsToPolicies
 * @param aktivSfe - Aktiv-index → SFE-opslag (kun ejendoms-aktiver med opslag)
 * @param policySfe - SFE-BFE → dækkende police
 * @returns Antal nedarvede dækninger + policy-IDs forankret i porteføljen
 */
export async function applySfeArv(
  matches: MatchResult[],
  aktivSfe: AktivSfeMap,
  policySfe: PolicySfeMap
): Promise<SfeArvResultat> {
  // BIZZ-2130: Ejere pr. SFE — til søster-SFE-annoteringen kræves samme ejer
  // på begge sider (ellers ville hele ejerlav-fæller blive flaget).
  const sfeEjere = new Map<number, Set<string>>();
  const tilfoejEjer = (sfeBfe: number, cvr: string | null) => {
    if (!cvr) return;
    const set = sfeEjere.get(sfeBfe) ?? new Set<string>();
    set.add(cvr);
    sfeEjere.set(sfeBfe, set);
  };
  // Forankrede SFE-BFE'er: aktiver forankret på en SFE (via adresse-opslag
  // ELLER fordi aktivets eget BFE er SFE-BFE'et). Bruges til at undertrykke
  // "uden for porteføljen"-advarslen for policer hvis SFE rummer aktiver.
  const forankredeSfeBfes = new Set<number>();
  for (const [idx, opslag] of aktivSfe) {
    const m = matches[idx];
    if (!m || m.aktiv.type !== 'ejendom') continue;
    forankredeSfeBfes.add(opslag.sfeBfe);
    tilfoejEjer(opslag.sfeBfe, ejerCvrAf(m));
  }
  for (const m of matches) {
    if (m.aktiv.type === 'ejendom' && m.aktiv.bfe) {
      forankredeSfeBfes.add(m.aktiv.bfe);
      tilfoejEjer(m.aktiv.bfe, ejerCvrAf(m));
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

    // 1) Direkte SFE-arv: policen er tegnet på aktivets egen SFE-adresse → DÆKNING
    const daekning = policySfe.get(opslag.sfeBfe);
    if (daekning) {
      m.bestMatch = { policy: daekning.policy, score: SFE_ARV_SCORE };
      m.aktiv.rawData = {
        ...m.aktiv.rawData,
        daekket_via_sfe: { sfe_bfe: opslag.sfeBfe, sfe_adresse: daekning.sfeAdresse },
      };
      inherited++;
      continue;
    }

    // 2) BIZZ-2130 + BIZZ-2134: Søster-SFE — aktivets SFE ligger i SAMME ejerlav
    //    som en dækket SFE, med SAMME ejer, OG matrikler der er fysisk tilstødende
    //    (deler matrikelgrænse, ikke adskilt af vej). ANNOTÉR kun (ingen dækning).
    if (opslag.ejerlavKode == null) continue;
    const aktivEjer = ejerCvrAf(m);
    if (!aktivEjer) continue;
    for (const [polSfeBfe, entry] of policySfe) {
      if (entry.ejerlavKode !== opslag.ejerlavKode || polSfeBfe === opslag.sfeBfe) continue;
      if (!sfeEjere.get(polSfeBfe)?.has(aktivEjer)) continue;

      // BIZZ-2134: Polygon adjacency check — kun tilstødende matrikler
      try {
        const [polyAktiv, polyPol] = await Promise.all([
          fetchPolygon(opslag.sfeBfe),
          fetchPolygon(polSfeBfe),
        ]);
        if (!polyAktiv || !polyPol || !arePolygonsAdjacent(polyAktiv, polyPol)) continue;
      } catch {
        continue; // Ved fejl: skip (konservativt)
      }

      m.aktiv.rawData = {
        ...m.aktiv.rawData,
        soester_sfe: { sfe_bfe: polSfeBfe, sfe_adresse: entry.sfeAdresse },
      };
      logger.log(`[sfeStruktur] Søster-SFE: ${m.aktiv.adresse} tilstødende ${entry.sfeAdresse}`);
      break;
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

  // 2. SFE-opslag for ejendoms-aktiver (adresse → DAWA, fallback: BFE → jordstykke)
  const aktivSfe: AktivSfeMap = new Map();
  await runBatched(
    ejendomIdx.map(({ m, i }) => async () => {
      let opslag = await resolveSfeForAdresse((m.aktiv.adresse ?? '').trim());
      // Fallback for markjorder/grunde uden adgangsadresse: BFE → DAWA jordstykke
      if (!opslag && m.aktiv.bfe) {
        try {
          const jord = (await fetchDawaJson(
            `${DAWA}/jordstykker?bfenummer=${m.aktiv.bfe}&format=json`
          )) as Array<{
            bfenummer?: number;
            sfeejendomsnr?: number;
            ejerlav?: { kode?: number };
          }> | null;
          if (jord?.[0]) {
            const sfeBfe = jord[0].sfeejendomsnr ?? jord[0].bfenummer;
            const ejerlavKode = jord[0].ejerlav?.kode ?? null;
            if (sfeBfe) opslag = { sfeBfe, ejerlavKode };
          }
        } catch {
          /* best-effort */
        }
      }
      if (opslag) aktivSfe.set(i, opslag);
    })
  );

  // 3. Ren arve-regel
  return await applySfeArv(matches, aktivSfe, policySfe);
}
