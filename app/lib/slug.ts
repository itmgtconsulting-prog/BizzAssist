/**
 * SEO-venlig slug-generator til BizzAssist offentlige sider.
 *
 * Konverterer adresser og virksomhedsnavne til URL-sikre slugs:
 *   "Arnold Nielsens Boulevard 62A, 2650 Hvidovre" → "arnold-nielsens-boulevard-62a-2650-hvidovre"
 *   "NOVO NORDISK A/S" → "novo-nordisk-a-s"
 *
 * Håndterer danske tegn (æ→ae, ø→oe, å→aa) og alle specialtegn.
 */

/** Tabel over danske og andre special-tegn → ASCII-ækvivalenter */
const CHAR_MAP: Record<string, string> = {
  æ: 'ae',
  ø: 'oe',
  å: 'aa',
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  é: 'e',
  è: 'e',
  ê: 'e',
  ë: 'e',
  á: 'a',
  à: 'a',
  â: 'a',
  ã: 'a',
  ó: 'o',
  ò: 'o',
  ô: 'o',
  õ: 'o',
  ú: 'u',
  ù: 'u',
  û: 'u',
  í: 'i',
  ì: 'i',
  î: 'i',
  ï: 'i',
  ñ: 'n',
  ç: 'c',
  ß: 'ss',
};

/**
 * Genererer en SEO-venlig slug fra et vilkårligt input.
 *
 * @param input - Adresse, virksomhedsnavn eller anden tekst
 * @returns URL-sikker, lowercase slug med bindestreger
 */
export function generateSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[æøåäöüéèêëáàâãóòôõúùûíìîïñçß]/g, (char) => CHAR_MAP[char] ?? char)
    .replace(/[^a-z0-9\s-]/g, ' ') // Erstat specialtegn (/, ., (, ) etc.) med space
    .replace(/\s+/g, '-') // Space → bindestreg
    .replace(/-+/g, '-') // Sammenflet multiple bindestreger
    .replace(/^-|-$/g, ''); // Trim bindestreger i start/slut
}

/**
 * Genererer slug til ejendomsside fra DAWA adresse-komponenter.
 *
 * @param vejnavn - Vejnavn, f.eks. "Arnold Nielsens Boulevard"
 * @param husnr - Husnummer, f.eks. "62A"
 * @param postnr - Postnummer, f.eks. "2650"
 * @param postnrnavn - Bynavn, f.eks. "Hvidovre"
 * @returns Slug som "arnold-nielsens-boulevard-62a-2650-hvidovre"
 */
export function generateEjendomSlug(
  vejnavn: string,
  husnr: string,
  postnr: string,
  postnrnavn: string
): string {
  return generateSlug(`${vejnavn} ${husnr} ${postnr} ${postnrnavn}`);
}

/**
 * Genererer slug til virksomhedsside fra CVR-navn.
 *
 * @param navn - Virksomhedsnavn, f.eks. "NOVO NORDISK A/S"
 * @returns Slug som "novo-nordisk-a-s"
 */
export function generateVirksomhedSlug(navn: string): string {
  return generateSlug(navn);
}
