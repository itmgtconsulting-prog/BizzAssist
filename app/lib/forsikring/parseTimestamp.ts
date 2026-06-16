/**
 * BIZZ-2156: Formattering af parse-tidsstempel for forsikringsdokumenter.
 *
 * Dokumentlisten viste tidligere blot "tidligere" for allerede parsede
 * dokumenter. Brugeren har brug for at vide HVORNÅR et dokument sidst blev
 * parset (parseren forbedres løbende, fornyelser uploades osv.). Denne helper
 * laver et kompakt relativt label + et præcist tooltip.
 *
 * @module lib/forsikring/parseTimestamp
 */

/** Resultat af {@link formatParseTimestamp}: kort label + præcist tooltip. */
export interface ParseTimestampDisplay {
  /** Kompakt label til badge, fx "Parset 3t siden" / "Parset 14. jun". */
  label: string;
  /** Præcist tidspunkt til title-attribut, fx "14. juni 2026 kl. 15:32". */
  tooltip: string;
}

const MAANED_KORT_DA = [
  'jan',
  'feb',
  'mar',
  'apr',
  'maj',
  'jun',
  'jul',
  'aug',
  'sep',
  'okt',
  'nov',
  'dec',
];
const MAANED_LANG_DA = [
  'januar',
  'februar',
  'marts',
  'april',
  'maj',
  'juni',
  'juli',
  'august',
  'september',
  'oktober',
  'november',
  'december',
];
const MAANED_KORT_EN = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const MAANED_LANG_EN = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Nulstil til to cifre (fx 5 → "05") til klokkeslæt. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Formattér et ISO-tidsstempel som relativt parse-label + præcist tooltip.
 *
 * Relativ logik: <1 min → "lige nu"; <60 min → "Xm siden"; <24t → "Xt siden";
 * ellers absolut dato ("14. jun" i indeværende år, "3. mar 2026" ellers).
 *
 * @param iso - ISO 8601-tidsstempel (parse-tidspunkt, typisk updated_at)
 * @param da - true for dansk, false for engelsk
 * @param now - referencetidspunkt (default: nu) — injiceres for deterministiske tests
 * @returns label + tooltip, eller null hvis iso er ugyldig/tom
 */
export function formatParseTimestamp(
  iso: string | null | undefined,
  da: boolean,
  now: Date = new Date()
): ParseTimestampDisplay | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;

  const maanedKort = da ? MAANED_KORT_DA : MAANED_KORT_EN;
  const maanedLang = da ? MAANED_LANG_DA : MAANED_LANG_EN;
  const prefix = da ? 'Parset' : 'Parsed';

  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMin / 60);

  let label: string;
  if (diffMs < 0 || diffMin < 1) {
    label = da ? `${prefix} lige nu` : `${prefix} just now`;
  } else if (diffMin < 60) {
    label = da ? `${prefix} ${diffMin}m siden` : `${prefix} ${diffMin}m ago`;
  } else if (diffHour < 24) {
    label = da ? `${prefix} ${diffHour}t siden` : `${prefix} ${diffHour}h ago`;
  } else {
    const sammeAar = d.getFullYear() === now.getFullYear();
    const datoDel = sammeAar
      ? `${d.getDate()}. ${maanedKort[d.getMonth()]}`
      : `${d.getDate()}. ${maanedKort[d.getMonth()]} ${d.getFullYear()}`;
    label = `${prefix} ${datoDel}`;
  }

  const tooltip = da
    ? `${d.getDate()}. ${maanedLang[d.getMonth()]} ${d.getFullYear()} kl. ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    : `${maanedLang[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} at ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

  return { label, tooltip };
}
