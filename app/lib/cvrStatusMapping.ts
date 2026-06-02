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

/** De 5 visuelle status-kategorier brugt i M&A-radar (BIZZ-1962). */
export type CvrStatusKode =
  | 'aktiv'
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
 * Regler (matcher 1:1 SQL-CASE i /api/virksomhedshandler/kandidater så
 * server-side filter og klient-side badge altid er enige):
 *   - NULL / tom / ikke-JSON           → aktiv
 *   - statustekst "Ophævelse af dekret" → aktiv (dekret hævet, selskab fortsætter)
 *   - statustekst "Regnskab og boafslutning" → oploest_konkurs (bo afsluttet)
 *   - kreditoplysningtekst sat (Konkurs/Tvangsakkord) → under_konkurs (igangværende)
 *   - ellers                            → aktiv
 *
 * @param raw - Rå status-streng fra cache (JSON-blob eller null).
 * @returns CvrStatusInfo for den udledte kategori (default 'aktiv').
 */
export function mapCvrStatus(raw: string | null | undefined): CvrStatusInfo {
  return CVR_STATUS_INFO[deriveCvrStatusKode(raw)];
}

/**
 * Som {@link mapCvrStatus}, men returnerer kun kategori-nøglen.
 *
 * @param raw - Rå status-streng fra cache (JSON-blob eller null).
 * @returns Den udledte CvrStatusKode (default 'aktiv').
 */
export function deriveCvrStatusKode(raw: string | null | undefined): CvrStatusKode {
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
