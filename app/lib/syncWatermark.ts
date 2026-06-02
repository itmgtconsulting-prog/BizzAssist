/**
 * Persistent watermark-helpers for inkrementel CVR delta-sync (BIZZ-1976).
 *
 * Rene, side-effekt-frie funktioner så de kan unit-testes uden DB/CVR-kald.
 * Watermark baseres på CVR-feltet `sidstIndlaest` (feed-ankomst), ikke
 * `sidstOpdateret` (element-ændring) — se migration 168 for begrundelse.
 *
 * @module lib/syncWatermark
 */

/** Default safety-overlap: genoptag watermark minus dette antal minutter for
 *  at undgå grænse-tab pga. ES-eventual-consistency / sub-minut-timing. */
export const DEFAULT_OVERLAP_MINUTES = 60;

/**
 * Beregner ISO-fra-tidspunkt for næste sync-kørsel.
 *
 * Med et gemt watermark: genoptag fra (watermark − overlap) — selv-helende
 * efter nedetid, da watermark ikke flytter sig ved manglende kørsler.
 * Uden watermark (første kørsel / bootstrap): fald tilbage til et fast
 * (now − fallbackWindowDays) vindue.
 *
 * @param watermark - Sidste gemte watermark (ISO) eller null
 * @param fallbackWindowDays - Bootstrap-vindue i dage når watermark mangler
 * @param overlapMinutes - Safety-overlap trukket fra watermark
 * @param now - Reference-nutid (injiceres for testbarhed)
 * @returns ISO-streng for `from`-grænsen til CVR ES range-query
 */
export function computeSyncFrom(
  watermark: string | null | undefined,
  fallbackWindowDays: number,
  overlapMinutes: number,
  now: Date
): string {
  if (watermark) {
    const wmMs = Date.parse(watermark);
    if (!Number.isNaN(wmMs)) {
      return new Date(wmMs - overlapMinutes * 60_000).toISOString();
    }
  }
  return new Date(now.getTime() - fallbackWindowDays * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Returnerer den seneste (største) af to ISO-tidsstempler.
 *
 * Bruges til at akkumulere MAX(sidstIndlaest) på tværs af ES-sider. Ignorerer
 * null/ugyldige værdier, så et enkelt manglende felt ikke nulstiller maxet.
 *
 * @param a - Nuværende max (ISO) eller null
 * @param b - Kandidat (ISO) eller null
 * @returns Den seneste gyldige ISO-værdi, eller null hvis begge er ugyldige
 */
export function maxIso(a: string | null | undefined, b: string | null | undefined): string | null {
  const am = a ? Date.parse(a) : NaN;
  const bm = b ? Date.parse(b) : NaN;
  const aValid = !Number.isNaN(am);
  const bValid = !Number.isNaN(bm);
  if (aValid && bValid) return am >= bm ? (a as string) : (b as string);
  if (aValid) return a as string;
  if (bValid) return b as string;
  return null;
}

/**
 * Afgør om et nyt watermark må gemmes (kun fremad — aldrig regredér).
 *
 * Beskytter mod at en delvis/fejlende kørsel skubber watermark baglæns og
 * dermed re-henter (harmløst) eller — værre — at et tomt resultat sætter
 * watermark til null.
 *
 * @param current - Eksisterende gemt watermark (ISO) eller null
 * @param candidate - Nyt foreslået watermark (ISO) eller null
 * @returns True hvis candidate er gyldigt OG strengt nyere end current
 */
export function shouldAdvanceWatermark(
  current: string | null | undefined,
  candidate: string | null | undefined
): boolean {
  if (!candidate) return false;
  const cand = Date.parse(candidate);
  if (Number.isNaN(cand)) return false;
  if (!current) return true;
  const cur = Date.parse(current);
  if (Number.isNaN(cur)) return true;
  return cand > cur;
}
