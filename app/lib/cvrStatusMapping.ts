/**
 * cvrStatusMapping — afkoder CVR's rå status-blob til 5 visuelle kategorier.
 *
 * BIZZ-1962: M&A-radar skal kunne markere + filtrere ophørte/konkursramte
 * selskaber. Datakilden er `cvr_virksomhed.status`, som i vores cache er en
 * JSON-streng fra CVR's livsforløb/kreditoplysning (IKKE en ren statuskode):
 *
 *   { "statuskode": 3, "statustekst": "Regnskab og boafslutning",
 *     "kreditoplysningkode": 3, "kreditoplysningtekst": "Konkurs",
 *     "periode": { "gyldigFra": "...", "gyldigTil": "..." },
 *     "sidstOpdateret": "..." }
 *
 * NULL = ingen kredit-/insolvenshændelse registreret = reelt aktiv. Felterne
 * `statustekst` + `kreditoplysningtekst` driver kategoriseringen. Bemærk at den
 * cachede kilde KUN indeholder insolvens-hændelser (Konkurs/Tvangsakkord) — de
 * generelle livscyklus-statusser (Fusioneret, Tvangsopløst) findes ikke i denne
 * kolonne, men kategorierne defineres alligevel så filteret er fuldstændigt og
 * fremtidssikret hvis kilden senere beriges.
 *
 * @module app/lib/cvrStatusMapping
 */

/** De visuelle status-kategorier brugt i M&A-radar (BIZZ-1962, BIZZ-1974). */
export type CvrStatusKode =
  | 'aktiv'
  | 'ophoert'
  | 'under_konkurs'
  | 'oploest_konkurs'
  | 'fusioneret'
  | 'tvangsoploest';

/** Visuel + tekstuel beskrivelse af en status-kategori. */
export interface CvrStatusInfo {
  /** Maskinlæsbar kategori-nøgle (bruges i filter + URL). */
  kode: CvrStatusKode;
  /** Dansk label. */
  label: string;
  /** Engelsk label. */
  labelEn: string;
  /** Tailwind-klasse til den lille farvede prik (badge-indikator). */
  dotClass: string;
  /** Tailwind-klasser til et fuldt badge (baggrund + tekst). */
  badgeClass: string;
}

/**
 * Registry over alle 5 kategorier med farver + labels. Rækkefølgen her er den
 * rækkefølge filter-dropdownen viser kategorierne i (aktiv → mest "ophørt").
 */
export const CVR_STATUS_INFO: Record<CvrStatusKode, CvrStatusInfo> = {
  aktiv: {
    kode: 'aktiv',
    label: 'Aktiv',
    labelEn: 'Active',
    dotClass: 'bg-emerald-400',
    badgeClass: 'bg-emerald-500/20 text-emerald-300',
  },
  // BIZZ-1974: Selskab med en registreret ophørsdato (cvr_virksomhed.ophoert).
  // Dette er det autoritative "ophørt"-signal — uafhængigt af insolvens-blobben.
  ophoert: {
    kode: 'ophoert',
    label: 'Ophørt',
    labelEn: 'Ceased',
    dotClass: 'bg-slate-400',
    badgeClass: 'bg-slate-500/20 text-slate-300',
  },
  under_konkurs: {
    kode: 'under_konkurs',
    label: 'Under konkurs',
    labelEn: 'In bankruptcy',
    dotClass: 'bg-amber-400',
    badgeClass: 'bg-amber-500/20 text-amber-300',
  },
  oploest_konkurs: {
    kode: 'oploest_konkurs',
    label: 'Opløst efter konkurs',
    labelEn: 'Dissolved (bankruptcy)',
    dotClass: 'bg-red-500',
    badgeClass: 'bg-red-500/20 text-red-300',
  },
  fusioneret: {
    kode: 'fusioneret',
    label: 'Fusioneret',
    labelEn: 'Merged',
    dotClass: 'bg-purple-400',
    badgeClass: 'bg-purple-500/20 text-purple-300',
  },
  tvangsoploest: {
    kode: 'tvangsoploest',
    label: 'Tvangsopløst / ophørt',
    labelEn: 'Forced dissolution / ceased',
    dotClass: 'bg-slate-400',
    badgeClass: 'bg-slate-500/20 text-slate-300',
  },
};

/** Alle kategori-nøgler i visnings-rækkefølge (til filter-dropdown). */
export const CVR_STATUS_KODER: CvrStatusKode[] = [
  'aktiv',
  'ophoert',
  'under_konkurs',
  'oploest_konkurs',
  'fusioneret',
  'tvangsoploest',
];

/** Form på den afkodede status-JSON (kun de felter vi bruger). */
interface RawCvrStatus {
  statustekst?: string | null;
  kreditoplysningtekst?: string | null;
}

/**
 * Afkoder en rå `cvr_virksomhed.status`-værdi til en visuel kategori.
 *
 * @param raw - Rå status-streng fra cache (JSON-blob eller null).
 * @param ophoert - Autoritativ ophørsdato (cvr_virksomhed.ophoert, ISO el. null).
 * @returns CvrStatusInfo for den udledte kategori (default 'aktiv').
 */
export function mapCvrStatus(
  raw: string | null | undefined,
  ophoert?: string | null
): CvrStatusInfo {
  return CVR_STATUS_INFO[deriveCvrStatusKode(raw, ophoert)];
}

/**
 * Som {@link mapCvrStatus}, men returnerer kun kategori-nøglen.
 *
 * Regler (matcher 1:1 SQL-CASE i /api/virksomhedshandler/kandidater så
 * server-side filter og klient-side badge altid er enige):
 *   - insolvens fra status-JSON (Konkurs/boafslutning) → under_konkurs/oploest_konkurs
 *     (mere specifik end et generelt "ophørt", så den vinder)
 *   - ellers ophoert-dato sat og <= i dag → ophoert (BIZZ-1974: autoritativt signal,
 *     fanger selskaber hvor status-blobben er NULL men ophørsdatoen er synket)
 *   - ellers → aktiv
 *
 * @param raw - Rå status-streng fra cache (JSON-blob eller null).
 * @param ophoert - Autoritativ ophørsdato (cvr_virksomhed.ophoert, ISO el. null).
 * @returns Den udledte CvrStatusKode (default 'aktiv').
 */
export function deriveCvrStatusKode(
  raw: string | null | undefined,
  ophoert?: string | null
): CvrStatusKode {
  const fromStatusBlob = deriveFromStatusBlob(raw);
  // Insolvens-status fra blobben er mere specifik end et generelt "ophørt".
  if (fromStatusBlob !== 'aktiv') return fromStatusBlob;
  // BIZZ-1974: ophoert-dato er det autoritative ophørs-signal når blobben er tom.
  if (isOphoert(ophoert)) return 'ophoert';
  return 'aktiv';
}

/**
 * Afkoder KUN status-JSON-blobben (insolvens-livsforløb) til en kategori.
 *
 * @param raw - Rå status-streng fra cache (JSON-blob eller null).
 * @returns Kategori udledt af blobben (default 'aktiv').
 */
function deriveFromStatusBlob(raw: string | null | undefined): CvrStatusKode {
  if (!raw) return 'aktiv';
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return 'aktiv';

  let parsed: RawCvrStatus;
  try {
    parsed = JSON.parse(trimmed) as RawCvrStatus;
  } catch {
    return 'aktiv';
  }

  const statustekst = typeof parsed.statustekst === 'string' ? parsed.statustekst : null;
  const kreditoplysningtekst =
    typeof parsed.kreditoplysningtekst === 'string' ? parsed.kreditoplysningtekst : null;

  if (statustekst === 'Ophævelse af dekret') return 'aktiv';
  if (statustekst === 'Regnskab og boafslutning') return 'oploest_konkurs';
  if (kreditoplysningtekst) return 'under_konkurs';
  return 'aktiv';
}

/**
 * Afgør om en ophørsdato betyder selskabet reelt er ophørt (sat og ikke i fremtiden).
 *
 * @param ophoert - ISO-dato-streng eller null.
 * @returns true hvis selskabet har en effektiv ophørsdato.
 */
function isOphoert(ophoert: string | null | undefined): boolean {
  if (!ophoert) return false;
  const trimmed = ophoert.trim();
  if (!trimmed) return false;
  // Sammenlign på dato-niveau (YYYY-MM-DD) for at matche SQL's CURRENT_DATE-check.
  const today = new Date().toISOString().slice(0, 10);
  return trimmed.slice(0, 10) <= today;
}
