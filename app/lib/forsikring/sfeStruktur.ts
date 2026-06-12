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

/** Max antal unikke adresse-opslag pr. analyse (beskytter maxDuration=60) */
const MAX_LOOKUPS = 40;

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
}

/** Modul-level cache pr. lambda-instans: normaliseret adresse → SFE-BFE (null = opslag fejlede) */
const adresseSfeCache = new Map<string, number | null>();

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
 * Resolve SFE-BFE for en dansk adresse via DAWA (adgangsadresse → jordstykke → BFE).
 *
 * @param adresse - Fritekst-adresse, fx "Gefionsvej 47A, 3000 Helsingør"
 * @returns SFE-BFE eller null hvis adressen ikke kan resolves
 */
export async function resolveSfeBfeForAdresse(adresse: string): Promise<number | null> {
  const key = adresse.toLowerCase().trim();
  if (!key) return null;
  const cached = adresseSfeCache.get(key);
  if (cached !== undefined) return cached;

  const adresser = (await fetchDawaJson(
    `${DAWA}/adgangsadresser?q=${encodeURIComponent(adresse)}&per_side=1`
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
  adresseSfeCache.set(key, sfeBfe);
  return sfeBfe;
}

/** Police-dækning på SFE-niveau: SFE-BFE → police + den adresse der udløste dækningen */
export type PolicySfeMap = Map<number, { policy: ForsikringPolicy; sfeAdresse: string }>;

/** Aktiv-index (i matches-array) → SFE-BFE */
export type AktivSfeMap = Map<number, number>;

/**
 * Ren arve-regel: annotér aktiver med SFE-struktur og nedarv dækning fra
 * policer på SFE-adresser til umatchede aktiver i samme SFE.
 *
 * Muterer matches in-place (samme konvention som route'ns øvrige berigelse):
 * - Alle ejendoms-aktiver med kendt SFE får `rawData.sfe_bfe` + `rawData.sfe_niveau`
 *   ('sfe' når aktivets eget BFE er SFE-BFE'et, ellers 'underliggende')
 * - Umatchede aktiver hvis SFE er dækket af en police får `bestMatch` med
 *   score {@link SFE_ARV_SCORE} og `rawData.daekket_via_sfe = { sfe_bfe, sfe_adresse }`
 *
 * @param matches - Match-resultater fra matchAssetsToPolicies
 * @param aktivSfe - Aktiv-index → SFE-BFE (kun ejendoms-aktiver med opslag)
 * @param policySfe - SFE-BFE → dækkende police
 * @returns Antal aktiver der fik nedarvet dækning
 */
export function applySfeArv(
  matches: MatchResult[],
  aktivSfe: AktivSfeMap,
  policySfe: PolicySfeMap
): number {
  let inherited = 0;
  for (const [idx, sfeBfe] of aktivSfe) {
    const m = matches[idx];
    if (!m || m.aktiv.type !== 'ejendom') continue;

    // Strukturel annotering til UI-gruppering/sortering
    m.aktiv.rawData = {
      ...m.aktiv.rawData,
      sfe_bfe: sfeBfe,
      sfe_niveau: m.aktiv.bfe === sfeBfe ? 'sfe' : 'underliggende',
    };

    if (m.bestMatch) continue; // direkte match vinder altid over arv

    const daekning = policySfe.get(sfeBfe);
    if (!daekning) continue;

    m.bestMatch = { policy: daekning.policy, score: SFE_ARV_SCORE };
    m.aktiv.rawData = {
      ...m.aktiv.rawData,
      daekket_via_sfe: { sfe_bfe: sfeBfe, sfe_adresse: daekning.sfeAdresse },
    };
    inherited++;
  }
  return inherited;
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
 * @returns Antal aktiver der fik nedarvet dækning via SFE
 */
export async function berigMedSfeStruktur(
  matches: MatchResult[],
  policer: ForsikringPolicy[]
): Promise<number> {
  const ejendomIdx = matches
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.aktiv.type === 'ejendom' && (m.aktiv.adresse ?? '').trim().length > 0)
    .slice(0, MAX_LOOKUPS);

  const policerMedAdresse = policer.filter((p) => (p.property_address ?? '').trim().length > 0);
  if (ejendomIdx.length === 0 || policerMedAdresse.length === 0) return 0;

  // 1. SFE-opslag for police-forsikringssteder
  const policySfe: PolicySfeMap = new Map();
  await runBatched(
    policerMedAdresse.map((p) => async () => {
      const adresse = (p.property_address ?? '').trim();
      const sfeBfe = await resolveSfeBfeForAdresse(adresse);
      if (sfeBfe && !policySfe.has(sfeBfe)) {
        policySfe.set(sfeBfe, { policy: p, sfeAdresse: adresse });
      }
    })
  );

  // 2. SFE-opslag for ejendoms-aktiver
  const aktivSfe: AktivSfeMap = new Map();
  await runBatched(
    ejendomIdx.map(({ m, i }) => async () => {
      const sfeBfe = await resolveSfeBfeForAdresse((m.aktiv.adresse ?? '').trim());
      if (sfeBfe) aktivSfe.set(i, sfeBfe);
    })
  );

  // 3. Ren arve-regel
  return applySfeArv(matches, aktivSfe, policySfe);
}
