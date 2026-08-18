/**
 * Match matrikel-adresser (vej + husnr) mod ejer-/andelsforeninger i CVR.
 *
 * Ejerforeninger er IKKE ejere i ejf_ejerskab og deres registrerede
 * beliggenhedsadresse (adresse_json) peger typisk på administrator, ikke
 * ejendommen. Det pålidelige signal er FORENINGENS NAVN, der bogstaveligt
 * indeholder ejendommens vej + husnr (fx "E/F Falkoner Alle 54",
 * "Falkoneralle 53", "A/B Falkoner Alle 65-67"). Denne modul udleder
 * husnumre fra navnet og matcher dem mod en matrikels husnumre.
 *
 * @module app/lib/daekningsanalyse/ejerforeningMatch
 */

/** En forenings-kandidat fra cvr_virksomhed. */
export interface ForeningCandidate {
  navn: string;
  cvr: string | null;
}

/**
 * Normalisér tekst: lowercase + fjern diakritiske tegn (é→e), bevar å/ø/æ som
 * bogstaver via NFD kun på combining marks.
 *
 * @param s - Input
 * @returns Normaliseret streng
 */
function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Gade-nøgle: normaliseret uden mellemrum/tegn — så "Falkoner Alle",
 * "Falkoner Allé" og "Falkoneralle" giver samme nøgle.
 *
 * @param street - Vejnavn
 * @returns Nøgle (kun a-z0-9 + å/ø/æ)
 */
export function streetKey(street: string): string {
  return norm(street).replace(/[^a-z0-9åøæ]/g, '');
}

/**
 * Længste ord i et vejnavn — bruges som distinktivt ILIKE-net i kandidat-query
 * (undgår korte fælles ord som "vej"/"alle"/"gade").
 *
 * @param street - Vejnavn
 * @returns Længste ord (normaliseret), eller hele nøglen hvis ét ord
 */
export function longestStreetWord(street: string): string {
  const words = norm(street)
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9åøæ]/g, ''))
    .filter(Boolean);
  if (words.length === 0) return streetKey(street);
  return words.reduce((a, b) => (b.length > a.length ? b : a));
}

/**
 * Byg et flekst regex der matcher et vejnavn i en forenings-navn med valgfri
 * mellemrum ("falkoneralle"/"falkoner alle") og efterfølgende husnr(-interval).
 *
 * @param street - Vejnavn
 * @returns Global RegExp med grupper (husnrFra, husnrTil?)
 */
function streetHusnrRegex(street: string): RegExp {
  const words = norm(street)
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9åøæ]/g, ''))
    .filter(Boolean);
  const pat = words.join('\\s*');
  return new RegExp(`${pat}\\s*\\.?\\s*(\\d{1,3})(?:\\s*[-\\u2013/]\\s*(\\d{1,3}))?`, 'g');
}

/**
 * Udled husnumre for en given gade fra en forenings-navn. Ekspanderer små
 * intervaller PARITETS-bevidst: danske husnr-intervaller er samme side af vejen
 * ("57-61" = 57,59,61 — IKKE 58,60), så ens-paritets-endepunkter ekspanderes med
 * skridt 2. Kun ved forskellig paritet (sjældent) medtages alle mellemtal.
 *
 * @param navn - Forenings-navn
 * @param street - Vejnavn at lede efter
 * @returns Liste af husnr-strenge (uden dubletter)
 */
export function foreningHusnumre(navn: string, street: string): string[] {
  const n = norm(navn);
  const re = streetHusnrRegex(street);
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(n)) !== null) {
    const a = parseInt(m[1], 10);
    out.add(String(a));
    if (m[2]) {
      const b = parseInt(m[2], 10);
      if (b > a && b - a <= 40) {
        const step = (b - a) % 2 === 0 ? 2 : 1; // ens paritet → hop 2 (samme vejside)
        for (let h = a + step; h <= b; h += step) out.add(String(h));
      }
    }
  }
  return [...out];
}

/**
 * Byg et opslags-indeks: (gade-nøgle | husnr) → forening. Første kandidat vinder.
 *
 * @param candidates - Forenings-kandidater fra CVR
 * @param streets - Vejnavne i analysen
 * @returns Map fra "streetKey|husnr" til forening
 */
export function buildForeningIndex(
  candidates: ForeningCandidate[],
  streets: string[]
): Map<string, ForeningCandidate> {
  const idx = new Map<string, ForeningCandidate>();
  for (const c of candidates) {
    for (const st of streets) {
      const sk = streetKey(st);
      for (const h of foreningHusnumre(c.navn, st)) {
        const key = `${sk}|${h}`;
        if (!idx.has(key)) idx.set(key, c);
      }
    }
  }
  return idx;
}

/**
 * Find foreningen for en matrikels (vej, husnumre). Første husnr med match vinder.
 *
 * @param vej - Vejnavn
 * @param husnumre - Matrikelens husnumre (tal eller "18B")
 * @param idx - Indeks fra buildForeningIndex
 * @returns Forening eller null
 */
export function matchForening(
  vej: string,
  husnumre: string[],
  idx: Map<string, ForeningCandidate>
): ForeningCandidate | null {
  const sk = streetKey(vej);
  for (const h of husnumre) {
    const num = String(h).replace(/[^0-9]/g, '');
    if (!num) continue;
    const c = idx.get(`${sk}|${num}`);
    if (c) return c;
  }
  return null;
}

/**
 * Parse en resolve-adresse-label-linje ("Vejnavn h1, h2, …") til vej + husnumre.
 *
 * @param line - Én linje fra adresserLabel
 * @returns { vej, husnumre } eller null
 */
export function parseLabelLine(line: string): { vej: string; husnumre: string[] } | null {
  const m = line.trim().match(/^(.+?)\s+(\d.*)$/);
  if (!m) return null;
  const husnumre = m[2]
    .split(',')
    .map((s) => (s.trim().match(/\d+/) || [])[0])
    .filter((x): x is string => !!x);
  if (husnumre.length === 0) return null;
  return { vej: m[1].trim(), husnumre };
}
