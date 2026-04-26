/**
 * BIZZ-843: Normalisering af adresse-søgning til initialer-mønstre.
 *
 * Brugere skriver ofte vejnavne med initialer uden mellemrum ("HC
 * Møllersvej", "H.C. Andersens") mens DAR lagrer dem med mellemrum
 * ("H C Møllersvej"). DAWA autocomplete laver ikke fuzzy-match på
 * tværs af disse varianter → no-match.
 *
 * Denne helper ekspanderer initialer-prefix så vi kan prøve begge
 * varianter parallelt og merge resultater.
 *
 * @module app/lib/search/normalizeQuery
 */

/**
 * Strip punktummer fra initialer (H.C. → H C). Kun prefix-delen
 * hvor punktummer typisk bruges som separatorer — vi berører ikke
 * punktummer midt i ord.
 */
function stripInitialPunctuation(q: string): string {
  // Matcher prefix af 1-4 initialer med punktum, evt med space mellem
  // Eksempler: "H.C. ", "H. C. ", "H.C ", "N.J. "
  return q.replace(
    /^([A-ZÆØÅ])\.\s?([A-ZÆØÅ])\.?(\s?([A-ZÆØÅ])\.?)?(\s?([A-ZÆØÅ])\.?)?\s+/,
    (_match, a, b, _g3, c, _g5, d) => {
      const letters = [a, b, c, d].filter(Boolean).join(' ');
      return letters + ' ';
    }
  );
}

/**
 * Ekspander "HC Foo" → "H C Foo" når prefix er 2-4 store bogstaver
 * uden mellemrum efterfulgt af et ord.
 */
function expandInitialPrefix(q: string): string | null {
  // Prefix af 2-4 store bogstaver efterfulgt af mellemrum og et ord
  // Eksempler: "HC Møllersvej", "CFM Andersens", "HCA Gade"
  const match = q.match(/^([A-ZÆØÅ]{2,4})\s(.+)$/);
  if (!match) return null;
  const initials = match[1].split('').join(' ');
  return `${initials} ${match[2]}`;
}

/**
 * Ekspander "HCAndersens" → "H C Andersens" når prefix er 2-4 store
 * bogstaver direkte efterfulgt af en Stor+små bogstaver-sekvens.
 */
function expandGluedInitials(q: string): string | null {
  // Mønster: 2-4 store bogstaver efterfulgt af Stor + mindst 2 små
  // Eksempel: "HCAndersens" → H, C, Andersens
  const match = q.match(/^([A-ZÆØÅ]{2,4})([A-ZÆØÅ][a-zæøå]{2,}.*)$/);
  if (!match) return null;
  const initials = match[1].split('').join(' ');
  return `${initials} ${match[2]}`;
}

/**
 * Returner en række kandidat-queries for en given adresse-søgning.
 * Første element er altid originalen. Duplikater fjernes.
 *
 * Eksempler:
 *   "HC Møllersvej 21"     → ["HC Møllersvej 21", "H C Møllersvej 21"]
 *   "H.C. Andersens"       → ["H.C. Andersens", "H C Andersens"]
 *   "HCAndersens Boulevard" → ["HCAndersens Boulevard", "H C Andersens Boulevard"]
 *   "Strandvejen 12"       → ["Strandvejen 12"]
 *
 * Cap: max 3 varianter for at undgå fan-out mod DAWA.
 */
export function expandAddressQueryVariants(q: string): string[] {
  const trimmed = q.trim();
  if (trimmed.length === 0) return [];

  const variants = new Set<string>();
  variants.add(trimmed);

  const stripped = stripInitialPunctuation(trimmed);
  if (stripped !== trimmed) variants.add(stripped);

  const expanded = expandInitialPrefix(stripped) ?? expandInitialPrefix(trimmed);
  if (expanded) variants.add(expanded);

  const glued = expandGluedInitials(stripped) ?? expandGluedInitials(trimmed);
  if (glued) variants.add(glued);

  // Cap på 3 varianter
  return Array.from(variants).slice(0, 3);
}

/**
 * True hvis query indeholder et initialer-mønster der fortjener
 * ekspansion (hurtig guard før vi laver regex-arbejde).
 */
export function hasInitialPrefix(q: string): boolean {
  const trimmed = q.trim();
  return (
    /^[A-ZÆØÅ]\.\s?[A-ZÆØÅ]/.test(trimmed) ||
    /^[A-ZÆØÅ]{2,4}\s/.test(trimmed) ||
    /^[A-ZÆØÅ]{2,4}[A-ZÆØÅ][a-zæøå]{2,}/.test(trimmed)
  );
}
