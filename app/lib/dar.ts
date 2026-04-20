/**
 * DAR — Danmarks Adresseregister (via Datafordeler GraphQL)
 *
 * Erstatter DAWA-biblioteket, som lukker 1. juli 2026.
 * Bruger Datafordelerens GraphQL-endpoint med API-nøgle.
 *
 * Auth: process.env.DATAFORDELER_API_KEY (query-param)
 * Endpoint: https://graphql.datafordeler.dk/DAR/v1
 *
 * darHentAdresse: Ren DAR GraphQL — henter Husnummer, Adgangspunkt (koordinater),
 * Postnummer og NavngivenVej via parallelle queries. DAWA fallback hvis DAR fejler.
 *
 * darHentJordstykke: Datafordeler MAT WFS (MatGaeld662) med CQL_FILTER INTERSECTS.
 * DAWA fallback hvis MAT WFS fejler.
 *
 * @see https://datafordeler.dk/dataoversigt/dar/
 */

import {
  rensAdresseStreng,
  dawaHentAdresse as _dawaHentAdresse,
  dawaHentJordstykke as _dawaHentJordstykke,
  dawaAutocomplete as _dawaAutocomplete,
} from './dawa';
export { rensAdresseStreng } from './dawa';
import { KOMMUNE_NAVN, kommunenavnFraKode } from './kommuner';
import { proxyUrl, proxyHeaders, proxyTimeout, isProxyEnabled } from '@/app/lib/dfProxy';

// Re-export existing interfaces so consuming code doesn't need changes
export type { DawaAutocompleteResult, DawaAdresse, DawaJordstykke } from './dawa';

import type { DawaAutocompleteResult, DawaAdresse, DawaJordstykke } from './dawa';
import { logger } from '@/app/lib/logger';
import { DAR_ENDPOINT } from '@/app/lib/serviceEndpoints';
import { LruCache } from '@/app/lib/lruCache';

// BIZZ-600: LRU-cache for DAR adresse-lookups. Samme adresse-UUID slås
// typisk op flere gange i samme session (search → detail → related).
// TTL 24 timer — DAR-data er stabilt på den skala.
const darAdresseCache = new LruCache<string, DawaAdresse>({
  maxSize: 150,
  ttlMs: 86_400_000,
});

// BIZZ-600: LRU-cache for plandata zone-opslag — kvantiseret på 4 decimaler
// (~11m præcision) så koordinater inden for samme jordstykke deler cache.
// Zoneændringer er sjældne, TTL 24 timer er sikkert.
const zoneCache = new LruCache<string, string | null>({
  maxSize: 150,
  ttlMs: 86_400_000,
});

/**
 * Internal test helpers — nulstiller LRU-caches så unit-tests kan
 * verificere fetch-mocks uden cached-hit-interference.
 */
export function __clearDarCachesForTests(): void {
  darAdresseCache.clear();
  zoneCache.clear();
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Constants
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const MAT_WFS_ENDPOINT = 'https://services.datafordeler.dk/Matrikel/MatGaeld662/1/WFS';
/**
 * BIZZ-503: Datafordeler DAR WFS endpoint. Used for spatial queries
 * (reverse geocoding) that DAR GraphQL does not support.
 */
const DAR_WFS_ENDPOINT = 'https://services.datafordeler.dk/DAR/DAR/1/WFS';

/** BIZZ-505: Datafordeler MAT GraphQL endpoint for jordstykke BFE lookup. */
const MAT_GQL_URL = 'https://graphql.datafordeler.dk/MAT/v1';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * GraphQL helpers
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/**
 * Returns the DAR GraphQL endpoint URL with API key.
 * Returns null if DATAFORDELER_API_KEY is not configured.
 */
function darUrl(): string | null {
  const key = process.env.DATAFORDELER_API_KEY;
  if (!key) return null;
  return `${DAR_ENDPOINT}?apiKey=${encodeURIComponent(key)}`;
}

/**
 * Returns current ISO timestamp for bitemporal query parameters.
 */
function nowTs(): string {
  return new Date().toISOString();
}

/**
 * Executes a GraphQL query against the DAR endpoint on Datafordeler.
 * DAR bruger Connection-pattern med `nodes` og `where` (ikke `filter`).
 *
 * @param query - Inline GraphQL query string (no variables — DAR doesn't support them reliably)
 * @returns Parsed JSON data object, or null on error
 */
async function darQuery<T = Record<string, unknown>>(query: string): Promise<T | null> {
  const url = darUrl();
  if (!url) {
    logger.error('DAR: DATAFORDELER_API_KEY not set');
    return null;
  }

  // Helper — tries one URL (proxied or direct) and returns parsed data or null.
  async function tryFetch(fetchUrl: string, isProxy: boolean): Promise<T | null> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (isProxy) Object.assign(headers, proxyHeaders());
    try {
      const res = await fetch(fetchUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(isProxy ? proxyTimeout() : 8000),
      });
      if (!res.ok) {
        logger.error(
          `DAR GraphQL ${isProxy ? 'proxy' : 'direct'} error: ${res.status} ${res.statusText}`
        );
        return null;
      }
      const json = (await res.json()) as { data?: T; errors?: unknown[] };
      if (json.errors?.length) {
        logger.error(
          `DAR GraphQL ${isProxy ? 'proxy' : 'direct'} errors:`,
          JSON.stringify(json.errors).slice(0, 600)
        );
        return null;
      }
      return json.data ?? null;
    } catch (err) {
      logger.error(
        `DAR GraphQL ${isProxy ? 'proxy' : 'direct'} fetch failed:`,
        err instanceof Error ? err.message : err
      );
      return null;
    }
  }

  // Attempt 1: via Hetzner proxy (when DF_PROXY_URL is set)
  const proxyResult = await tryFetch(proxyUrl(url), isProxyEnabled());
  if (proxyResult !== null) return proxyResult;

  // Attempt 2: direct to Datafordeler (API-key auth does not require IP whitelisting)
  // This handles the case where the proxy is down or misconfigured for POST/GraphQL.
  if (isProxyEnabled()) {
    logger.warn('DAR GraphQL: proxy failed, retrying direct');
    const directResult = await tryFetch(url, false);
    if (directResult !== null) return directResult;
  }

  return null;
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Raw types fra DAR GraphQL
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

interface DarHusnummerRaw {
  id_lokalId: string;
  adgangsadressebetegnelse: string;
  husnummertekst: string;
  status: string;
  // Relationer er scalar UUID-strenge i DAR GraphQL — IKKE nestede objekter
  adgangspunkt: string; // UUID → DAR_Adgangspunkt
  navngivenVej: string; // UUID → DAR_NavngivenVej
  postnummer: string; // UUID → DAR_Postnummer
  kommuneinddeling: string; // UUID → DAR_Kommuneinddeling (NOT a 4-digit code)
  /** BIZZ-508: UUID → DAR_SupplerendeBynavn (null hvis adressen ikke har et supplerende bynavn) */
  supplerendeBynavn?: string | null;
  /** BIZZ-508: UUID → DAR_NavngivenVejKommunedel (knytter vej til specifik kommune ved vejnavne der krydser kommunegrænser) */
  navngivenVejKommunedel?: string | null;
}

/**
 * DAR_Adressepunkt — koordinater for en adgangsadresse.
 * NB: Typen hedder DAR_Adressepunkt (ikke DAR_Adgangspunkt) i GraphQL.
 * position er et SpatialPointEpsg25832Type-objekt med { wkt } underfelt.
 */
interface DarAdressepunktRaw {
  id_lokalId: string;
  position: { wkt: string }; // WKT i EPSG:25832: "POINT (726223.85 6174929.67)"
}

interface DarPostnummerRaw {
  postnr: string;
  navn: string;
}

interface DarNavngivenVejRaw {
  vejnavn: string;
}

/**
 * DAR_Kommuneinddeling — kommune-reference med 4-cifret kommunekode.
 * Husnummer.kommuneinddeling er en UUID-reference til denne entitet,
 * IKKE en direkte kommunekode. Kræver separat opslag.
 */
interface DarKommuneinddelingRaw {
  kommunekode: string; // 4-cifret kode f.eks. "0167"
  navn: string; // Kommunenavn f.eks. "Hvidovre"
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * WKT parser
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/**
 * Parses a WKT POINT string into [longitude, latitude] in WGS84.
 *
 * DAR Adressepunkt returnerer EPSG:25832 (UTM zone 32N) koordinater:
 *   "POINT (726223.85 6174929.67)" — easting, northing
 *
 * Konverterer automatisk UTM32N → WGS84 når koordinater er i UTM-range
 * (easting > 100000). Ellers antages WGS84 direkte.
 *
 * @param wkt - WKT string, f.eks. "POINT (726223.85 6174929.67)"
 * @returns [lng, lat] tuple i WGS84 eller null hvis parsing fejler
 */
function parseWktPoint(wkt: string): [number, number] | null {
  const m = wkt.match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i);
  if (!m) return null;
  const x = parseFloat(m[1]);
  const y = parseFloat(m[2]);
  if (isNaN(x) || isNaN(y)) return null;

  // Detektér EPSG:25832 (UTM32N) — easting er typisk 400000-900000
  if (x > 100000) {
    const [lng, lat] = utm32nToWgs84(x, y);
    return [lng, lat];
  }

  // Allerede WGS84
  return [x, y];
}

/**
 * Konverterer EPSG:25832 (UTM zone 32N) → WGS84 (EPSG:4326).
 *
 * Bruger analytisk formel baseret på Karney's transverse Mercator.
 * Præcision: < 1 meter for hele Danmark.
 *
 * @param easting - UTM easting i meter
 * @param northing - UTM northing i meter
 * @returns [longitude, latitude] i WGS84 grader
 */
function utm32nToWgs84(easting: number, northing: number): [number, number] {
  // WGS84 ellipsoid
  const a = 6378137.0;
  const f = 1 / 298.257223563;
  const e2 = 2 * f - f * f;
  const e_prime2 = e2 / (1 - e2);

  // UTM zone 32N parametre
  const k0 = 0.9996;
  const lng0 = (9 * Math.PI) / 180; // central meridian for zone 32
  const falseEasting = 500000;
  const falseNorthing = 0;

  const x = easting - falseEasting;
  const y = northing - falseNorthing;

  const M = y / k0;
  const mu = M / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 * e2 * e2) / 256));

  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 * e1 * e1) / 32) * Math.sin(2 * mu) +
    ((21 * e1 * e1) / 16 - (55 * e1 * e1 * e1 * e1) / 32) * Math.sin(4 * mu) +
    ((151 * e1 * e1 * e1) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 * e1 * e1 * e1) / 512) * Math.sin(8 * mu);

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const tanPhi1 = Math.tan(phi1);

  const N1 = a / Math.sqrt(1 - e2 * sinPhi1 * sinPhi1);
  const T1 = tanPhi1 * tanPhi1;
  const C1 = e_prime2 * cosPhi1 * cosPhi1;
  const R1 = (a * (1 - e2)) / Math.pow(1 - e2 * sinPhi1 * sinPhi1, 1.5);
  const D = x / (N1 * k0);

  const lat =
    phi1 -
    ((N1 * tanPhi1) / R1) *
      ((D * D) / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * e_prime2) * D * D * D * D) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * e_prime2 - 3 * C1 * C1) *
          D *
          D *
          D *
          D *
          D *
          D) /
          720);

  const lng =
    lng0 +
    (D -
      ((1 + 2 * T1 + C1) * D * D * D) / 6 +
      ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * e_prime2 + 24 * T1 * T1) * D * D * D * D * D) /
        120) /
      cosPhi1;

  return [(lng * 180) / Math.PI, (lat * 180) / Math.PI];
}

// KOMMUNE_NAVN importeret fra ./kommuner (delt med dawa.ts)

/**
 * Forsøger at udlede kommunenavn fra en rå kommuneinddeling-værdi.
 *
 * DAR's `kommuneinddeling` felt kan returnere værdier i flere formater:
 * - 4-cifret kode: "0751" → direkte opslag i KOMMUNE_NAVN
 * - 6+ cifret kode: "389103" → første 4 cifre (nul-paddet) prøves
 * - UUID: håndteres IKKE her (kræver DAR_Kommuneinddeling query)
 *
 * @param rawCode - Rå kommuneinddeling-værdi fra DAR
 * @returns Kommunenavn eller tom streng hvis ikke fundet
 */
function resolveKommunenavnFromRawCode(rawCode: string | null | undefined): string {
  if (!rawCode) return '';

  // Direkte opslag med 4-cifret padding (håndterer "101" → "0101", "751" → "0751")
  const direct = kommunenavnFraKode(rawCode);
  if (direct) return direct;

  // Prøv at parse som nummer og pad til 4 cifre (for rene numeriske værdier)
  const num = parseInt(rawCode, 10);
  if (!isNaN(num) && num > 0) {
    // For 6-cifrede koder (f.eks. "389103"): prøv de første 3-4 cifre som kommunekode
    // DAGI kommuneinddelingskoder kan have formatet KKKKTT (kommune + type)
    const first4 = kommunenavnFraKode(Math.floor(num / 100)); // "389103" → 3891 → "3891" padded
    if (first4) return first4;

    const first3padded = kommunenavnFraKode(Math.floor(num / 1000)); // "389103" → 389 → "0389"
    if (first3padded) return first3padded;

    // Prøv de første 4 cifre direkte
    const first4str = rawCode.slice(0, 4);
    const f4 = kommunenavnFraKode(first4str);
    if (f4) return f4;

    // Prøv de første 3 cifre (pad til 4)
    const first3str = rawCode.slice(0, 3);
    const f3 = kommunenavnFraKode(first3str);
    if (f3) return f3;
  }

  return '';
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Address string parsing
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/**
 * Parses a Danish address string like "Bredgade 11A, 7280 Sønder Felding"
 * or "Søbyvej 11, Alhede, 8620 Kjellerup" into components.
 *
 * Format: "<vejnavn> <husnr>[, <suppl. bynavn>], <postnr> <postnrnavn>"
 *
 * @param betegnelse - Full address string from DAR
 * @returns Parsed components
 */
function parseAdresseBetegnelse(betegnelse: string): {
  vejnavn: string;
  husnr: string;
  postnr: string;
  postnrnavn: string;
} {
  // Split on comma — last part is "postnr postnrnavn"
  const parts = betegnelse.split(',').map((p) => p.trim());
  const lastPart = parts[parts.length - 1] ?? '';
  const firstPart = parts[0] ?? '';

  // Parse postnr (4 digits) and postnrnavn from last part
  const postMatch = lastPart.match(/^(\d{4})\s+(.+)$/);
  const postnr = postMatch?.[1] ?? '';
  const postnrnavn = postMatch?.[2] ?? '';

  // Parse vejnavn and husnr from first part
  // Format: "Bredgade 11A" or "Chr. Winthers Vej 2"
  // Husnr is the last "word" that starts with a digit
  const husMatch = firstPart.match(/^(.+?)\s+(\d+\w*)$/);
  const vejnavn = husMatch?.[1] ?? firstPart;
  const husnr = husMatch?.[2] ?? '';

  return { vejnavn, husnr, postnr, postnrnavn };
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Public API
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/**
 * BIZZ-606: Normaliser initial-forkortelser så bruger-input "HC", "H.C."
 * og "H. C." alle matcher DAWA's officielle form "H C" (space-separated
 * uden punktummer).
 *
 * Detekterer runs af 2-3 på hinanden følgende enkeltbogstavs-initialer
 * (eventuelt separeret af punktummer/mellemrum) efterfulgt af et proper-
 * noun-ord (≥3 bogstaver) og producerer stavevarianter. Eksempler:
 *   "HC Møllersvej"    → + "H C Møllersvej", "H.C. Møllersvej"
 *   "H.C. Møllersvej"  → + "HC Møllersvej", "H C Møllersvej"
 *   "A.P. Møllers"     → + "AP Møllers", "A P Møllers"
 *
 * Eksporteret for unit-test; bruges internt af darAutocomplete.
 *
 * @param s - Input-streng (case bevares — varianter respekterer input)
 * @returns Liste af stavevarianter (inkl. original)
 */
export function expandInitials(s: string): string[] {
  const results = new Set<string>([s]);
  // Efterfølgende ord skal have ≥3 bogstaver (rigtigt gadenavn) for at
  // undgå falske positive som "min gade" (2-3 + kort ord).
  // Bruger lookbehind i stedet for \b fordi \b i JS-regex kun genkender
  // ASCII-bogstaver som word-chars — Æ/Ø/Å ville ellers ikke give ordgrænse.
  const wordBoundary = '(?<![A-Za-zÆØÅæøå])';
  const streetLookahead = '(?=[A-Za-zÆØÅæøå]{3,})';
  const patterns: RegExp[] = [
    // Dotted — hver initial SKAL efterfølges af punktum. Fx "H.C. Møllersvej"
    // eller "H.C.Møllersvej". Tillader 2-3 initial-positioner.
    new RegExp(
      `${wordBoundary}([A-Za-zÆØÅæøå]\\.(?:\\s?[A-Za-zÆØÅæøå]\\.){1,2}\\s?)${streetLookahead}`,
      'g'
    ),
    // Space-separeret — "H C " / "h c " (enkelt-bogstav + mellemrum, gentaget)
    new RegExp(`${wordBoundary}((?:[A-Za-zÆØÅæøå] ){1,2}[A-Za-zÆØÅæøå] )${streetLookahead}`, 'g'),
    // Kompakt 2-3 uppercase + mellemrum — "HC Mølle" / "APM Gade"
    new RegExp(`${wordBoundary}([A-ZÆØÅ]{2,3} )${streetLookahead}`, 'g'),
  ];
  const matches: { match: string; start: number; end: number }[] = [];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      const letters = m[1].replace(/[.\s]/g, '');
      if (letters.length < 2 || letters.length > 3) continue;
      // Skip overlap med allerede fundne matches (flere patterns kan ramme
      // samme span, fx "H C Møllersvej" match'er både pattern 2 og 3)
      if (matches.some((x) => x.start < m!.index + m![1].length && x.end > m!.index)) continue;
      matches.push({ match: m[1], start: m.index, end: m.index + m[1].length });
    }
  }
  if (matches.length === 0) return [...results];

  // Uppercase initial-bogstaverne — danske adresser bruger altid store
  // initialer, så lowercase-input "hc" skal match'e "H C" i DAWA.
  const stripInitials = (raw: string): string => raw.replace(/[.\s]/g, '').toUpperCase();
  const rebuild = (formatter: (letters: string) => string): string => {
    let out = '';
    let cursor = 0;
    for (const { match, start, end } of matches) {
      out += s.slice(cursor, start);
      out += formatter(stripInitials(match));
      cursor = end;
    }
    out += s.slice(cursor);
    return out.replace(/ +/g, ' ').trim();
  };
  results.add(rebuild((ls) => ls + ' '));
  results.add(rebuild((ls) => ls.split('').join(' ') + ' '));
  results.add(rebuild((ls) => ls.split('').join('.') + '. '));
  return [...results].map((v) => v.trim()).filter((v) => v.length > 0);
}

/**
 * Henter adresse-autocomplete-forslag fra DAR (Datafordeler GraphQL).
 * Returnerer op til 8 resultater matchende søgestrengen.
 *
 * DAR GraphQL bruger Connection-pattern med `nodes` og `where`.
 * Relationsfelter er scalar UUID'er — adressekomponenter parses
 * fra `adgangsadressebetegnelse` strengen.
 *
 * @param q - Søgestreng (f.eks. "Bredgade 1" eller "Søbyvej 11")
 * @returns Liste af normaliserede autocomplete-resultater
 */
export async function darAutocomplete(q: string): Promise<DawaAutocompleteResult[]> {
  if (!q || q.trim().length < 2) return [];

  const trimmed = q.trim();
  const escaped = trimmed.replace(/"/g, '\\"');
  const ts = nowTs();

  /**
   * DAR GraphQL `startsWith` er case-sensitive.
   * Danske adresser starter altid med stort bogstav ("Bredgade", "Søbyvej").
   * Vi prøver først brugerens input som-det-er, derefter med Title Case,
   * og til sidst med rent stort første bogstav — og merger resultaterne.
   *
   * Derudover expanderer vi ASCII→diacritic varianter:
   * "o" → "ø", "ae" → "æ", "aa" → "å", "oe" → "ø"
   * så brugeren kan skrive "sobyvej" og finde "Søbyvej".
   */
  const titleCase = trimmed.replace(/\b\w/g, (c) => c.toUpperCase());
  const firstUpper = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  // Husnummer-bogstav (f.eks. "64b" → "64B") — \b\w fanger ikke digit→letter overgang
  const hnUpperCase = titleCase.replace(/(\d)([a-z])/g, (_, d, l) => d + l.toUpperCase());

  /**
   * Expand ASCII to Danish diacritics for fuzzy address matching.
   * Generates variants where common ASCII substitutions are replaced with
   * their Danish equivalents (e.g. "sobyvej" → "søbyvej", "aeroe" → "ærø").
   *
   * @param s - Input string (any case)
   * @returns Array of unique diacritic variants
   */
  function expandDiacritics(s: string): string[] {
    // Replacement pairs: [ascii, danish] — order matters (longer first)
    const pairs: [string, string][] = [
      ['ae', 'æ'],
      ['oe', 'ø'],
      ['aa', 'å'],
    ];
    const results = new Set<string>([s]);

    // Apply each replacement independently to catch single substitutions
    for (const [ascii, danish] of pairs) {
      const lower = s.toLowerCase();
      let idx = lower.indexOf(ascii);
      while (idx !== -1) {
        const variant = s.slice(0, idx) + danish + s.slice(idx + ascii.length);
        results.add(variant);
        idx = lower.indexOf(ascii, idx + 1);
      }
    }

    // Also try replacing single "o" with "ø" (common: "sobyvej" → "søbyvej")
    // Only for "o" not already part of "oe"
    const lower = s.toLowerCase();
    for (let i = 0; i < lower.length; i++) {
      if (lower[i] === 'o' && lower[i + 1] !== 'e') {
        const variant = s.slice(0, i) + 'ø' + s.slice(i + 1);
        results.add(variant);
      }
    }

    return [...results];
  }

  // BIZZ-606: Ekstra base-variant hvor 2-3 lowercase-bogstaver i starten
  // uppercase'es til initial-form ("hc møllersvej" → "HC møllersvej").
  // Dette samarbejder med expandInitials' uppercase-pattern så variation
  // "HC/H C/H.C." også genereres for lowercase-input.
  const lowerPrefixUpper = (() => {
    const mx = trimmed.match(/^([a-zæøå]{2,3})(\s)/);
    if (!mx) return trimmed;
    return mx[1].toUpperCase() + mx[2] + trimmed.slice(mx[0].length);
  })();

  // Build base variants (case), expand initials, then expand each with diacritics
  const baseVariants = [
    ...new Set([escaped, titleCase, firstUpper, hnUpperCase, lowerPrefixUpper]),
  ];
  const initialsExpanded = new Set<string>();
  for (const base of baseVariants) {
    for (const v of expandInitials(base)) initialsExpanded.add(v);
  }
  const allVariants = new Set<string>();
  for (const base of initialsExpanded) {
    for (const expanded of expandDiacritics(base)) {
      allVariants.add(expanded.replace(/"/g, '\\"'));
    }
  }
  // Cap at 12 variants to avoid excessive API calls (was 10 — initial expansion
  // adds up to 3 extra variants per initial-run, so slight bump is reasonable)
  const variants = [...allVariants].slice(0, 12);

  try {
    // BIZZ-608: Kør queries for alle case-varianter parallelt MOD BÅDE
    // DAR_Husnummer (adgangsadresser = hovedejendomme) OG DAR_Adresse
    // (adresser med etage/dør = ejerlejligheder). Tidligere fik brugeren kun
    // hovedejendommen tilbage selvom de måske ledte efter en bestemt
    // lejlighed — ejerlejligheden var usynlig i dropdown.
    const allResults = await Promise.all(
      variants.flatMap((variant) => [
        darQuery<{ DAR_Husnummer: { nodes: DarHusnummerRaw[] } }>(`{
          DAR_Husnummer(
            first: 6
            virkningstid: "${ts}"
            registreringstid: "${ts}"
            where: { adgangsadressebetegnelse: { startsWith: "${variant}" } }
          ) {
            nodes {
              id_lokalId
              adgangsadressebetegnelse
              husnummertekst
              status
            }
          }
        }`),
        // BIZZ-608: DAR_Adresse for ejerlejligheder med etage/dør.
        // adressebetegnelse indeholder fulde "Vej 1, 2. tv, 1234 By"-strengen.
        darQuery<{
          DAR_Adresse: {
            nodes: Array<{
              id_lokalId: string;
              adressebetegnelse?: string;
              etagebetegnelse?: string;
              doerbetegnelse?: string;
              status?: string;
            }>;
          };
        }>(`{
          DAR_Adresse(
            first: 6
            virkningstid: "${ts}"
            registreringstid: "${ts}"
            where: { adressebetegnelse: { startsWith: "${variant}" } }
          ) {
            nodes {
              id_lokalId
              adressebetegnelse
              etagebetegnelse
              doerbetegnelse
              status
            }
          }
        }`),
      ])
    );

    // Dedupliker husnumre
    const seenHn = new Set<string>();
    const husnumre: DarHusnummerRaw[] = [];
    // Dedupliker adresser (ejerlejligheder)
    const seenAdr = new Set<string>();
    const adresser: Array<{
      id_lokalId: string;
      adressebetegnelse?: string;
      etagebetegnelse?: string;
      doerbetegnelse?: string;
    }> = [];

    for (let i = 0; i < allResults.length; i++) {
      const data = allResults[i];
      if (i % 2 === 0) {
        // DAR_Husnummer-resultat
        const hnData = data as { DAR_Husnummer?: { nodes?: DarHusnummerRaw[] } } | null;
        for (const h of hnData?.DAR_Husnummer?.nodes ?? []) {
          if (!seenHn.has(h.id_lokalId)) {
            seenHn.add(h.id_lokalId);
            husnumre.push(h);
          }
        }
      } else {
        // DAR_Adresse-resultat
        const adrData = data as {
          DAR_Adresse?: {
            nodes?: Array<{
              id_lokalId: string;
              adressebetegnelse?: string;
              etagebetegnelse?: string;
              doerbetegnelse?: string;
            }>;
          };
        } | null;
        for (const a of adrData?.DAR_Adresse?.nodes ?? []) {
          // Skip adresser uden etage/dør — de er identiske med adgangsadressen
          // og ville bare give duplikerede entries.
          const harSubAdresse =
            (a.etagebetegnelse && a.etagebetegnelse.length > 0) ||
            (a.doerbetegnelse && a.doerbetegnelse.length > 0);
          if (!harSubAdresse) continue;
          if (!seenAdr.has(a.id_lokalId)) {
            seenAdr.add(a.id_lokalId);
            adresser.push(a);
          }
        }
      }
    }

    if (husnumre.length === 0 && adresser.length === 0) {
      // DAR returned no results — may be IP-blocked; fall back to DAWA
      logger.warn('darAutocomplete: DAR returned 0 results, trying DAWA fallback');
      return _dawaAutocomplete(q);
    }

    const husnummerResults: DawaAutocompleteResult[] = husnumre
      .slice(0, 5)
      .map((h): DawaAutocompleteResult => {
        const parsed = parseAdresseBetegnelse(h.adgangsadressebetegnelse);
        return {
          type: 'adgangsadresse',
          tekst: rensAdresseStreng(h.adgangsadressebetegnelse),
          adresse: {
            id: h.id_lokalId,
            vejnavn: parsed.vejnavn,
            husnr: h.husnummertekst || parsed.husnr,
            postnr: parsed.postnr,
            postnrnavn: parsed.postnrnavn,
            kommunenavn: '',
            x: 0,
            y: 0,
          },
        };
      });

    // BIZZ-608: Map adresser (ejerlejligheder) til 'adresse'-type så UI kan
    // vise "Lejlighed"-badge og linke direkte til den specifikke BFE.
    const adresseResults: DawaAutocompleteResult[] = adresser
      .slice(0, 5)
      .map((a): DawaAutocompleteResult => {
        const parsed = parseAdresseBetegnelse(a.adressebetegnelse ?? '');
        return {
          type: 'adresse',
          tekst: rensAdresseStreng(a.adressebetegnelse ?? ''),
          adresse: {
            id: a.id_lokalId,
            vejnavn: parsed.vejnavn,
            husnr: parsed.husnr,
            etage: a.etagebetegnelse ?? undefined,
            dør: a.doerbetegnelse ?? undefined,
            postnr: parsed.postnr,
            postnrnavn: parsed.postnrnavn,
            kommunenavn: '',
            x: 0,
            y: 0,
          },
        };
      });

    // Interleave: hovedejendomme først, så lejligheder — giver naturlig
    // rækkefølge hvor brugere der tastede "Arnold Nielsens Blvd 62A" ser
    // hovedejendommen øverst + de 2 lejligheder under.
    return [...husnummerResults, ...adresseResults].slice(0, 10);
  } catch (err) {
    logger.error('darAutocomplete fejl, falder tilbage til DAWA:', err);
    // Fallback til DAWA (gratis, ingen auth/IP-krav) — virker indtil 1. juli 2026
    return _dawaAutocomplete(q);
  }
}

/**
 * Henter fuld adressedetalje fra DAR GraphQL ud fra Husnummer UUID.
 *
 * Udfører parallelle queries mod DAR GraphQL:
 * 1. DAR_Husnummer — adgangsadressebetegnelse, husnummertekst, status, relation-UUIDs
 * 2. DAR_Adgangspunkt — WKT POINT koordinater
 * 3. DAR_Postnummer — postnr + navn
 * 4. DAR_NavngivenVej — vejnavn tekst
 *
 * Faldback til DAWA hvis DAR GraphQL fejler (DAWA lukker 1. juli 2026).
 *
 * @param id - DAR Husnummer UUID (id_lokalId)
 * @returns DawaAdresse-kompatibelt objekt eller null
 */
export async function darHentAdresse(id: string): Promise<DawaAdresse | null> {
  // BIZZ-600: Cache-hit returnerer direkte uden DAR-kald.
  const cached = darAdresseCache.get(id);
  if (cached) return cached;

  const ts = nowTs();
  const escaped = id.replace(/"/g, '\\"');

  try {
    // Step 1: Hent Husnummer med relation-UUIDs
    const hnQuery = `{
      DAR_Husnummer(
        where: { id_lokalId: { eq: "${escaped}" } }
        virkningstid: "${ts}"
        registreringstid: "${ts}"
      ) {
        nodes {
          id_lokalId
          adgangsadressebetegnelse
          husnummertekst
          status
          adgangspunkt
          navngivenVej
          postnummer
          kommuneinddeling
          supplerendeBynavn
          navngivenVejKommunedel
        }
      }
    }`;

    const hnData = await darQuery<{
      DAR_Husnummer: { nodes: DarHusnummerRaw[] };
    }>(hnQuery);

    const hn = hnData?.DAR_Husnummer?.nodes?.[0];
    if (!hn) {
      // DAR fandt intet — fallback til DAWA
      logger.warn('darHentAdresse: Husnummer ikke fundet i DAR, falder tilbage til DAWA');
      return _dawaHentAdresse(id);
    }

    // Step 2: Parallelle opslag for Adgangspunkt, Postnummer, NavngivenVej,
    // Kommuneinddeling, BIZZ-508 SupplerendeBynavn og BIZZ-508 NavngivenVejKommunedel
    const [apData, pnData, vejData, komData, sbData, nvkData] = await Promise.all([
      // Adressepunkt → koordinater (EPSG:25832 WKT)
      // NB: Typen hedder DAR_Adressepunkt i GraphQL (ikke DAR_Adgangspunkt).
      // position er SpatialPointEpsg25832Type med { wkt } underfelt.
      hn.adgangspunkt
        ? darQuery<{ DAR_Adressepunkt: { nodes: DarAdressepunktRaw[] } }>(`{
            DAR_Adressepunkt(
              where: { id_lokalId: { eq: "${hn.adgangspunkt}" } }
              virkningstid: "${ts}"
              registreringstid: "${ts}"
            ) { nodes { id_lokalId position { wkt } } }
          }`)
        : Promise.resolve(null),

      // Postnummer → postnr + navn
      hn.postnummer
        ? darQuery<{ DAR_Postnummer: { nodes: DarPostnummerRaw[] } }>(`{
            DAR_Postnummer(
              where: { id_lokalId: { eq: "${hn.postnummer}" } }
              virkningstid: "${ts}"
              registreringstid: "${ts}"
            ) { nodes { postnr navn } }
          }`)
        : Promise.resolve(null),

      // NavngivenVej → vejnavn
      hn.navngivenVej
        ? darQuery<{ DAR_NavngivenVej: { nodes: DarNavngivenVejRaw[] } }>(`{
            DAR_NavngivenVej(
              where: { id_lokalId: { eq: "${hn.navngivenVej}" } }
              virkningstid: "${ts}"
              registreringstid: "${ts}"
            ) { nodes { vejnavn } }
          }`)
        : Promise.resolve(null),

      // Kommuneinddeling → kommunekode + navn
      // NB: kommuneinddeling er en UUID-reference, IKKE en direkte kommunekode.
      // DAR returnerer f.eks. "389103" som ID — vi skal slå det op for at få den
      // 4-cifrede kommunekode (f.eks. "0167") og kommunenavnet (f.eks. "Hvidovre").
      hn.kommuneinddeling
        ? darQuery<{ DAR_Kommuneinddeling: { nodes: DarKommuneinddelingRaw[] } }>(`{
            DAR_Kommuneinddeling(
              where: { id_lokalId: { eq: "${hn.kommuneinddeling}" } }
              virkningstid: "${ts}"
              registreringstid: "${ts}"
            ) { nodes { kommunekode navn } }
          }`)
        : Promise.resolve(null),

      // BIZZ-508: SupplerendeBynavn → navn (fx "Vejlgårde")
      hn.supplerendeBynavn
        ? darQuery<{ DAR_SupplerendeBynavn: { nodes: Array<{ navn: string }> } }>(`{
            DAR_SupplerendeBynavn(
              where: { id_lokalId: { eq: "${hn.supplerendeBynavn}" } }
              virkningstid: "${ts}"
              registreringstid: "${ts}"
            ) { nodes { navn } }
          }`)
        : Promise.resolve(null),

      // BIZZ-508: NavngivenVejKommunedel → kommuneinddeling-UUID
      // Relevant når en navngiven vej strækker sig over flere kommuner
      // (sjælden edge case) — vi henter kommune-referencen herfra for at
      // kende den KORREKTE kommunetilhørighed for netop dette husnummer,
      // frem for blot husnummer.kommuneinddeling.
      hn.navngivenVejKommunedel
        ? darQuery<{
            DAR_NavngivenVejKommunedel: {
              nodes: Array<{ kommune: string | null; vejkode: string | null }>;
            };
          }>(`{
            DAR_NavngivenVejKommunedel(
              where: { id_lokalId: { eq: "${hn.navngivenVejKommunedel}" } }
              virkningstid: "${ts}"
              registreringstid: "${ts}"
            ) { nodes { kommune vejkode } }
          }`)
        : Promise.resolve(null),
    ]);

    // Parse koordinater fra WKT POINT (EPSG:25832 → WGS84)
    const apNode = apData?.DAR_Adressepunkt?.nodes?.[0];
    const coords = apNode?.position?.wkt ? parseWktPoint(apNode.position.wkt) : null;

    // Hvis DAR ikke returnerede gyldige koordinater, brug DAWA som fallback
    // (DAR Adgangspunkt kan mangle position-felt eller returnere uventet format)
    if (!coords || (coords[0] === 0 && coords[1] === 0)) {
      logger.warn(
        'darHentAdresse: Adgangspunkt mangler koordinater i DAR, falder tilbage til DAWA'
      );
      const dawaResult = await _dawaHentAdresse(id);
      if (dawaResult && (dawaResult.x !== 0 || dawaResult.y !== 0)) {
        // Berig med kommunenavn fra DAR Kommuneinddeling-opslag hvis DAWA mangler det
        if (!dawaResult.kommunenavn) {
          const komFallbackNode = komData?.DAR_Kommuneinddeling?.nodes?.[0];
          if (komFallbackNode?.navn) {
            dawaResult.kommunenavn = komFallbackNode.navn;
          } else if (komFallbackNode?.kommunekode) {
            dawaResult.kommunenavn = kommunenavnFraKode(komFallbackNode.kommunekode);
          } else {
            dawaResult.kommunenavn = resolveKommunenavnFromRawCode(hn.kommuneinddeling);
          }
        }
        return dawaResult;
      }
    }

    // Parse postnummer
    const pnNode = pnData?.DAR_Postnummer?.nodes?.[0];

    // Parse vejnavn
    const vejNode = vejData?.DAR_NavngivenVej?.nodes?.[0];

    // Fallback: parse adgangsadressebetegnelse for manglende felter
    const parsed = parseAdresseBetegnelse(hn.adgangsadressebetegnelse);

    // Kommunenavn fra DAR_Kommuneinddeling opslag (foretrukken) eller statisk mapping som fallback.
    // DAR_Kommuneinddeling returnerer kommunekode (4-cifret, f.eks. "0167") og navn direkte.
    // Hvis DAR_Kommuneinddeling query fejler (entiteten kan mangle i visse API-versioner),
    // forsøger vi at udlede kommunekoden fra kommuneinddeling-værdien via padding/trimning.
    const komNode = komData?.DAR_Kommuneinddeling?.nodes?.[0];
    const kommunenavn =
      komNode?.navn ||
      kommunenavnFraKode(komNode?.kommunekode) ||
      resolveKommunenavnFromRawCode(hn.kommuneinddeling) ||
      '';

    // BIZZ-508: Udtræk supplerendeBynavn-navn (fx "Vejlgårde")
    const sbNode = sbData?.DAR_SupplerendeBynavn?.nodes?.[0];

    // BIZZ-508: Udtræk vejkode fra NavngivenVejKommunedel.
    // Log warning hvis nvkNode.kommune afviger fra hn.kommuneinddeling (edge case for
    // vejnavne der krydser kommunegrænser) så vi er klar over data-diskrepansen.
    const nvkNode = nvkData?.DAR_NavngivenVejKommunedel?.nodes?.[0];
    if (nvkNode?.kommune && hn.kommuneinddeling && nvkNode.kommune !== hn.kommuneinddeling) {
      logger.warn(
        '[darHentAdresse] NavngivenVejKommunedel.kommune afviger fra Husnummer.kommuneinddeling ' +
          `(${nvkNode.kommune} vs ${hn.kommuneinddeling}) — cross-kommune vej detekteret for ${hn.id_lokalId}`
      );
    }

    const result: DawaAdresse = {
      id: hn.id_lokalId,
      vejnavn: vejNode?.vejnavn ?? parsed.vejnavn,
      husnr: hn.husnummertekst || parsed.husnr,
      postnr: pnNode?.postnr ?? parsed.postnr,
      postnrnavn: pnNode?.navn ?? parsed.postnrnavn,
      kommunenavn,
      regionsnavn: '', // Ikke tilgængelig i DAR — kræver DAGI-opslag
      x: coords?.[0] ?? 0,
      y: coords?.[1] ?? 0,
      adressebetegnelse: rensAdresseStreng(hn.adgangsadressebetegnelse),
      // BIZZ-509: Zone er en planloven-attribut og lever i Plandata.dk —
      // ikke i DAR. Slå op i plandata WFS når vi har WGS84-koordinater.
      // Ikke-kritisk: null hvis plandata er utilgængelig.
      zone: coords ? ((await hentZoneFraPlandata(coords[0], coords[1])) ?? undefined) : undefined,
      // BIZZ-508: Supplerende bynavn fra DAR (fx "Vejlgårde")
      supplerendebynavn: sbNode?.navn ?? undefined,
      // BIZZ-508: Vejkode fra NavngivenVejKommunedel — kommunens lokale vejnummer
      vejkode: nvkNode?.vejkode ?? undefined,
    };
    // BIZZ-600: Cache kun succesfulde opslag — fejl skal retries.
    darAdresseCache.set(id, result);
    return result;
  } catch (err) {
    // DAR fejlede — fallback til DAWA mens den stadig virker
    logger.error('darHentAdresse fejl, falder tilbage til DAWA:', err);
    return _dawaHentAdresse(id);
  }
}

/**
 * Henter jordstykke (matrikel) for en koordinat via Datafordeler MAT WFS.
 *
 * Bruger MatGaeld662 WFS med CQL_FILTER INTERSECTS for koordinatbaseret opslag.
 * Falder tilbage til DAWA hvis MAT WFS fejler (DAWA lukker 1. juli 2026).
 *
 * @param lng - Længdegrad (WGS84)
 * @param lat - Breddegrad (WGS84)
 * @returns Jordstykke-data eller null
 */
export async function darHentJordstykke(lng: number, lat: number): Promise<DawaJordstykke | null> {
  const apiKey = process.env.DATAFORDELER_API_KEY;

  // Forsøg 1: Datafordeler MAT WFS
  if (apiKey) {
    try {
      const cql = `INTERSECTS(geometri,POINT(${lng} ${lat}))`;
      const params = new URLSearchParams({
        service: 'WFS',
        request: 'GetFeature',
        typeName: 'mat:Jordstykke_Gaeldende',
        srsName: 'EPSG:4326',
        CQL_FILTER: cql,
        outputFormat: 'json',
        apiKey,
      });

      const res = await fetch(proxyUrl(`${MAT_WFS_ENDPOINT}?${params.toString()}`), {
        headers: { ...proxyHeaders() },
        signal: AbortSignal.timeout(proxyTimeout()),
      });

      if (res.ok) {
        const geojson = (await res.json()) as {
          features?: Array<{
            properties?: Record<string, unknown>;
            geometry?: { coordinates?: unknown };
          }>;
        };

        const feature = geojson.features?.[0];
        if (feature?.properties) {
          const p = feature.properties;

          // Matrikelnummer: "matrikelnummer" eller "matrnr"
          const matrikelnr = (p.matrikelnummer ?? p.matrnr ?? p.matrikelnr ?? '') as string;

          // Ejerlavsnavn og -kode
          const ejerlavsnavn = (p.ejerlavsnavn ?? p.ejerlavsNavn ?? '') as string;
          const ejerlavskode = Number(p.ejerlavskode ?? p.ejerlavsKode ?? 0) || 0;

          // Registreret areal
          const areal = Number(p.registreretareal ?? p.registreretAreal ?? p.areal ?? 0) || 0;

          // Kommune
          const kommunekode = String(p.kommunekode ?? p.kommuneKode ?? '').padStart(4, '0');
          const kommunenavn = (p.kommunenavn ?? KOMMUNE_NAVN[kommunekode] ?? '') as string;

          // Visuelt center — forsøg at beregne fra geometri centroid eller brug koordinaterne
          const visueltcenter: [number, number] = [lng, lat];

          return {
            matrikelnr,
            ejerlav: { navn: ejerlavsnavn, kode: ejerlavskode },
            areal_m2: areal,
            kommune: { navn: kommunenavn, kode: Number(kommunekode) || 0 },
            visueltcenter,
          };
        }
      } else {
        logger.warn(`darHentJordstykke MAT WFS fejl: ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      logger.error('darHentJordstykke MAT WFS fejl:', err);
    }
  }

  // Forsøg 2: DAWA fallback (virker indtil 1. juli 2026)
  try {
    return await _dawaHentJordstykke(lng, lat);
  } catch (err) {
    logger.error('darHentJordstykke DAWA fallback fejl:', err);
    return null;
  }
}

/**
 * Returnerer true hvis `id` ser ud som et DAR/DAWA UUID.
 * Returnerer false for vejnavn-id'er (starter med 'vejnavn:') og mock-id'er.
 *
 * @param id - ID-streng at teste
 */
export function erDarId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/**
 * BIZZ-504: GeoJSON FeatureCollection of address points inside a bbox.
 * Properties kept minimal (`husnr` only) so the response matches the
 * legacy DAWA shape used by the map layer.
 */
export interface DarHusnumreFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: { husnr: string };
  }>;
}

/**
 * BIZZ-504: Hent alle husnumre inden for en WGS84 bbox via Datafordeler
 * DAR WFS. Bruger WFS `bbox` parameter på husnummer/position geometri —
 * WFS understøtter dette natively, ingen CQL_FILTER nødvendig.
 *
 * Returnerer:
 *   - `null` hvis DATAFORDELER_API_KEY mangler, WFS fejler eller svaret
 *     ikke kan parses → caller skal falde tilbage til DAWA
 *   - Tom `features`-liste hvis bbox er gyldig men ingen adresser findes
 *   - Udfyldt FeatureCollection med Point-features ellers
 *
 * Never throws; alle fejl logges.
 *
 * @param w - West længdegrad (WGS84)
 * @param s - South breddegrad (WGS84)
 * @param e - East længdegrad (WGS84)
 * @param n - North breddegrad (WGS84)
 * @param maxFeatures - Hard cap (default 1000 for kort-layeret)
 */
export async function darHusnumreBbox(
  w: number,
  s: number,
  e: number,
  n: number,
  maxFeatures = 1000
): Promise<DarHusnumreFeatureCollection | null> {
  const apiKey = process.env.DATAFORDELER_API_KEY;
  if (!apiKey) {
    logger.warn(
      'darHusnumreBbox: DATAFORDELER_API_KEY not set — skipping DAR, caller should fall back to DAWA'
    );
    return null;
  }

  try {
    // WFS 2.0 standard: bbox filter as "minx,miny,maxx,maxy,srsName".
    // srsName ensures the coordinates are interpreted as WGS84 regardless
    // of server default.
    const params = new URLSearchParams({
      service: 'WFS',
      version: '2.0.0',
      request: 'GetFeature',
      typeNames: 'DAR:Husnummer_Gaeldende',
      srsName: 'EPSG:4326',
      bbox: `${w},${s},${e},${n},EPSG:4326`,
      outputFormat: 'json',
      count: String(maxFeatures),
      apiKey,
    });

    const res = await fetch(proxyUrl(`${DAR_WFS_ENDPOINT}?${params.toString()}`), {
      headers: { ...proxyHeaders() },
      signal: AbortSignal.timeout(proxyTimeout()),
    });

    if (!res.ok) {
      logger.warn(`darHusnumreBbox DAR WFS fejl: ${res.status} ${res.statusText}`);
      return null;
    }

    const geojson = (await res.json()) as {
      features?: Array<{
        properties?: Record<string, unknown>;
        geometry?: { type?: string; coordinates?: unknown };
      }>;
    };

    if (!Array.isArray(geojson.features)) return null;

    const features: DarHusnumreFeatureCollection['features'] = [];
    for (const f of geojson.features) {
      const coords = f.geometry?.coordinates;
      // Accept only Point geometries with numeric [lng, lat]
      if (
        f.geometry?.type !== 'Point' ||
        !Array.isArray(coords) ||
        typeof coords[0] !== 'number' ||
        typeof coords[1] !== 'number'
      ) {
        continue;
      }
      const husnr = String(
        f.properties?.husnummertekst ?? f.properties?.husnummer ?? f.properties?.husnr ?? ''
      );
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [coords[0], coords[1]] },
        properties: { husnr },
      });
    }

    return { type: 'FeatureCollection', features };
  } catch (err) {
    logger.error('darHusnumreBbox DAR WFS fetch failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * BIZZ-503: Reverse geocoding via Datafordeler DAR WFS
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/**
 * Result shape of a successful reverse geocode.
 * Keeps the `id` nullable — DAR WFS occasionally returns a feature without an
 * address UUID attached.
 */
export interface DarReverseResult {
  /** Human-readable address string, e.g. "Bredgade 1, 1260 København K" */
  adresse: string;
  /** DAR Husnummer UUID when available (navigable in our app) */
  id: string | null;
}

/**
 * BIZZ-503: Reverse-geocode a WGS84 coordinate via Datafordeler DAR WFS.
 *
 * Uses CQL_FILTER DWITHIN on the `husnummer:position` geometry to find
 * address points within ~50m of the input coordinate. Returns the first
 * result (WFS does not sort by distance, but density of Danish addresses
 * makes the nearest match reliable inside 50m).
 *
 * Returns null when:
 *   - DATAFORDELER_API_KEY is not set
 *   - WFS returns no features
 *   - WFS errors (non-2xx) — callers should fall back to DAWA
 *
 * Never throws; all errors are logged.
 *
 * @param lng - Længdegrad (WGS84)
 * @param lat - Breddegrad (WGS84)
 * @returns DarReverseResult or null
 */
export async function darReverseGeocode(
  lng: number,
  lat: number
): Promise<DarReverseResult | null> {
  const apiKey = process.env.DATAFORDELER_API_KEY;
  if (!apiKey) {
    logger.warn(
      'darReverseGeocode: DATAFORDELER_API_KEY not set — skipping DAR, caller should fall back to DAWA'
    );
    return null;
  }

  try {
    // DWITHIN with 50m radius. Denmark's address density is such that any
    // address this close is effectively "the one" the user clicked. If no
    // feature is returned we return null and the caller falls back to DAWA.
    const cql = `DWITHIN(husnummer/position,POINT(${lng} ${lat}),50,meters)`;
    const params = new URLSearchParams({
      service: 'WFS',
      version: '2.0.0',
      request: 'GetFeature',
      typeNames: 'DAR:Husnummer_Gaeldende',
      srsName: 'EPSG:4326',
      CQL_FILTER: cql,
      outputFormat: 'json',
      count: '1',
      apiKey,
    });

    const res = await fetch(proxyUrl(`${DAR_WFS_ENDPOINT}?${params.toString()}`), {
      headers: { ...proxyHeaders() },
      signal: AbortSignal.timeout(proxyTimeout()),
    });

    if (!res.ok) {
      logger.warn(`darReverseGeocode DAR WFS fejl: ${res.status} ${res.statusText}`);
      return null;
    }

    const geojson = (await res.json()) as {
      features?: Array<{
        properties?: Record<string, unknown>;
        id?: string;
      }>;
    };

    const feature = geojson.features?.[0];
    if (!feature?.properties) return null;

    const p = feature.properties;
    // DAR exposes husnummer + adresseUuid under slightly varying names depending
    // on output format version. Guard all three common casings.
    const vejnavn = (p.vejnavn ?? p.vejNavn ?? '') as string;
    const husnr = (p.husnummertekst ?? p.husnummer ?? p.husnr ?? '') as string;
    const postnr = String(p.postnummer ?? p.postnr ?? '').trim();
    const postnrnavn = (p.postdistriktnavn ?? p.postnrnavn ?? '') as string;
    const id =
      (p.adresseUuid as string | null) ??
      (p.husnummerUuid as string | null) ??
      (feature.id as string | null) ??
      null;

    const adresseParts = [`${vejnavn} ${husnr}`.trim()];
    if (postnr) adresseParts.push(`${postnr} ${postnrnavn}`.trim());
    const adresse = adresseParts.filter(Boolean).join(', ');

    if (!adresse) return null;

    return { adresse, id };
  } catch (err) {
    logger.error(
      'darReverseGeocode DAR WFS fetch failed:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * BIZZ-509: Plandata WFS — zone classification (Byzone/Landzone/Sommerhus)
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/**
 * BIZZ-509: Zone data (Byzone / Landzone / Sommerhus) is a planloven
 * concept and officially lives in Plandata.dk — not DAWA. We used to pull
 * it from DAWA's `adgangsadresser.zone` field because that was the
 * convenient path, but DAWA shuts down 2026-07-01 so we have to go to
 * source.
 *
 * Plandata.dk's GeoServer WFS is the same one `/api/plandata` already
 * uses for lokalplaner / kommuneplanrammer. No API key, SRID=4326 prefix
 * required in CQL (otherwise coords are interpreted as EPSG:25832 and
 * the spatial query returns nothing).
 */
const PLANDATA_WFS_ENDPOINT = 'https://geoserver.plandata.dk/geoserver/wfs';

/**
 * BIZZ-509: Resolve zone classification for a WGS84 coordinate via
 * Plandata.dk WFS. Returns "Byzone", "Landzone", "Sommerhuszone" or null.
 *
 * The "zonekort_vedtaget_v" layer covers the entire country — a properly
 * classified coordinate always hits one polygon. Layer naming is
 * defensively tried against a small list of historical variants because
 * plandata.dk has renamed layers in the past.
 *
 * Never throws. Returns null on any fetch/parse failure so `darHentAdresse`
 * can continue without zone data.
 *
 * @param lng - Længdegrad (WGS84)
 * @param lat - Breddegrad (WGS84)
 */
export async function hentZoneFraPlandata(lng: number, lat: number): Promise<string | null> {
  // BIZZ-600: Cache-nøgle kvantiseret til 4 decimaler (~11m) så mindre
  // koordinat-variationer inden for samme jordstykke deler cache.
  const cacheKey = `${lng.toFixed(4)}_${lat.toFixed(4)}`;
  const cached = zoneCache.get(cacheKey);
  if (cached !== undefined) return cached;

  // SRID=4326; prefix is load-bearing — without it GeoServer treats coords
  // as EPSG:25832 (UTM32N) and returns zero features.
  const cql = encodeURIComponent(`INTERSECTS(geometri,SRID=4326;POINT(${lng} ${lat}))`);

  // Try layers in order. Stop at the first one that returns a feature.
  // pdk: prefix is the current convention (matches other plandata layers).
  const LAYERS = ['pdk:theme_pdk_zonekort_vedtaget_v', 'plandk:zonekort'];

  for (const typeName of LAYERS) {
    try {
      const url =
        `${PLANDATA_WFS_ENDPOINT}?service=WFS&version=1.0.0&request=GetFeature` +
        `&typeName=${encodeURIComponent(typeName)}` +
        `&outputFormat=application/json` +
        `&CQL_FILTER=${cql}` +
        `&maxFeatures=1`;

      const res = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        next: { revalidate: 86400 },
      });
      if (!res.ok) continue;

      const json = (await res.json()) as {
        features?: Array<{ properties?: Record<string, unknown> }>;
      };
      const props = json.features?.[0]?.properties;
      if (!props) continue;

      // Field name varies across layer versions. Try each in priority order.
      const rawZone =
        props.zone ?? props.zone_navn ?? props.zonekode ?? props.zoneKode ?? props.betegnelse;
      if (typeof rawZone !== 'string' || rawZone.length === 0) continue;

      const normalized = normaliseZone(rawZone);
      zoneCache.set(cacheKey, normalized);
      return normalized;
    } catch (err) {
      logger.warn(
        `hentZoneFraPlandata: layer=${typeName} failed`,
        err instanceof Error ? err.message : err
      );
      // Try next layer
    }
  }

  // Cache også null-resultater så vi ikke re-spørger på hvert kald.
  zoneCache.set(cacheKey, null);
  return null;
}

/**
 * Normalise zone label returned by plandata.dk to the canonical values
 * the UI expects. Historically the service has returned numeric codes
 * ("1"/"2"/"3"), short labels ("Byzone"), and longer phrases
 * ("Sommerhusområde"). Map them to the trio used throughout the app.
 *
 * @param raw - Raw zone string or numeric code from plandata
 */
function normaliseZone(raw: string): string {
  const t = raw.trim().toLowerCase();
  if (t === '1' || t.startsWith('by')) return 'Byzone';
  if (t === '2' || t.startsWith('sommerhus')) return 'Sommerhuszone';
  if (t === '3' || t.startsWith('land')) return 'Landzone';
  return raw; // pass through unrecognised values so the UI can show them
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * BIZZ-507: DAR GraphQL — batch resolve etage/dør for BBR_Enhed UUIDs
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/**
 * BIZZ-507: Per-adresse-UUID minimal shape used by BBR enhed enrichment.
 * Keeps the same keys the legacy DAWA batch returned so callers can swap
 * the implementation without further changes.
 */
export interface DarAdresseUnit {
  etage: string | null;
  doer: string | null;
  adressebetegnelse: string;
}

/**
 * BIZZ-507: Batch-resolve `etagebetegnelse` + `doerbetegnelse` for a list
 * of DAR adresse UUIDs (typically `BBR_Enhed.adresseIdentificerer`).
 *
 * Uses DAR GraphQL's `in: [...]` filter so a whole block of flats comes
 * back in one query. This replaces the DAWA batch call
 * `/adresser?id=…&id=…&struktur=mini` — that endpoint dies 2026-07-01.
 *
 * Returns:
 *   - Map<uuid, DarAdresseUnit> with one entry per UUID DAR knows about
 *   - Empty map on any error / missing API key so callers can fall back
 *     to DAWA without a null-check branch
 *
 * Never throws.
 *
 * @param ids - Array of DAR adresse UUIDs
 */
export async function darHentAdresserBatch(
  ids: readonly string[]
): Promise<Map<string, DarAdresseUnit>> {
  const result = new Map<string, DarAdresseUnit>();
  if (!process.env.DATAFORDELER_API_KEY) {
    logger.warn(
      'darHentAdresserBatch: DATAFORDELER_API_KEY not set — returning empty map, caller should fall back to DAWA'
    );
    return result;
  }

  // Filter to real UUID shape + dedupe. Empty / malformed IDs short-circuit
  // so we never send a bogus `in:[]` query.
  const uniqueUuids = Array.from(
    new Set(
      ids.filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    )
  );
  if (uniqueUuids.length === 0) return result;

  const ts = nowTs();
  const quotedIds = uniqueUuids.map((id) => `"${id.replace(/"/g, '\\"')}"`).join(', ');
  // DAR caps `first` at some internal limit; request more than we have so
  // the whole batch fits. The typical caller passes ≤50 UUIDs.
  const first = Math.max(uniqueUuids.length, 50);

  const data = await darQuery<{
    DAR_Adresse: {
      nodes: Array<{
        id_lokalId: string;
        adressebetegnelse?: string;
        etagebetegnelse?: string;
        doerbetegnelse?: string;
      }>;
    };
  }>(`{
    DAR_Adresse(
      where: { id_lokalId: { in: [${quotedIds}] } }
      virkningstid: "${ts}"
      registreringstid: "${ts}"
      first: ${first}
    ) {
      nodes {
        id_lokalId
        adressebetegnelse
        etagebetegnelse
        doerbetegnelse
      }
    }
  }`);

  for (const node of data?.DAR_Adresse?.nodes ?? []) {
    if (!node.id_lokalId) continue;
    result.set(node.id_lokalId, {
      etage: node.etagebetegnelse && node.etagebetegnelse.length > 0 ? node.etagebetegnelse : null,
      doer: node.doerbetegnelse && node.doerbetegnelse.length > 0 ? node.doerbetegnelse : null,
      adressebetegnelse: node.adressebetegnelse ?? '',
    });
  }

  return result;
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * BIZZ-510: MAT WFS — paginated bulk jordstykker for sitemap generation
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/**
 * Minimal jordstykke-shape used for sitemap generation.
 * Covers the subset of fields the cron job needs — no geometry, no
 * fredning/strandbeskyttelse, since slug + BFE is all it writes.
 */
export interface MatJordstykkeBulk {
  bfenummer: number;
  matrikelnr: string;
  ejerlavsnavn: string;
  ejerlavskode: number;
}

/**
 * BIZZ-510: Page through Datafordeler MAT WFS `Jordstykke_Gaeldende` to
 * enumerate every jordstykke with a BFE number. Used by the sitemap cron
 * job to replace the DAWA `/jordstykker` endpoint before the 2026-07-01
 * shutdown.
 *
 * WFS pagination uses `startIndex` (0-based) + `count` (page size). An
 * empty feature array signals the end of the dataset. Field names are
 * read defensively — MatGaeld662 has historically varied between
 * `bfenummer` / `bfeNummer`, `matrikelnr` / `matrnr`, etc.
 *
 * Returns `null` on any fetch / parse failure so the caller can fall back
 * to DAWA. Never throws.
 *
 * @param startIndex - 0-based offset into the jordstykker dataset
 * @param count      - Max features to return (MatGaeld662 caps at 1000)
 */
export async function matListJordstykker(
  startIndex: number,
  count: number
): Promise<MatJordstykkeBulk[] | null> {
  const apiKey = process.env.DATAFORDELER_API_KEY;
  if (!apiKey) {
    logger.warn(
      'matListJordstykker: DATAFORDELER_API_KEY not set — skipping MAT, caller should fall back to DAWA'
    );
    return null;
  }

  try {
    const params = new URLSearchParams({
      service: 'WFS',
      version: '2.0.0',
      request: 'GetFeature',
      typeNames: 'mat:Jordstykke_Gaeldende',
      srsName: 'EPSG:4326',
      outputFormat: 'json',
      count: String(count),
      startIndex: String(startIndex),
      apiKey,
    });

    const res = await fetch(proxyUrl(`${MAT_WFS_ENDPOINT}?${params.toString()}`), {
      headers: { ...proxyHeaders() },
      signal: AbortSignal.timeout(proxyTimeout()),
    });

    if (!res.ok) {
      logger.warn(`matListJordstykker MAT WFS fejl: ${res.status} ${res.statusText}`);
      return null;
    }

    const geojson = (await res.json()) as {
      features?: Array<{ properties?: Record<string, unknown> }>;
    };

    if (!Array.isArray(geojson.features)) return null;

    const result: MatJordstykkeBulk[] = [];
    for (const f of geojson.features) {
      const p = f.properties;
      if (!p) continue;
      const bfeRaw = p.bfenummer ?? p.bfeNummer ?? p.BFEnummer;
      const bfe =
        typeof bfeRaw === 'number' ? bfeRaw : typeof bfeRaw === 'string' ? Number(bfeRaw) : NaN;
      if (!bfe || !Number.isFinite(bfe)) continue;

      const matrikelnr = String(p.matrikelnummer ?? p.matrnr ?? p.matrikelnr ?? '');
      const ejerlavsnavn = String(p.ejerlavsnavn ?? p.ejerlavsNavn ?? '');
      const ejerlavskodeRaw = p.ejerlavskode ?? p.ejerlavsKode ?? p.ejerlav_kode ?? 0;
      const ejerlavskode =
        typeof ejerlavskodeRaw === 'number'
          ? ejerlavskodeRaw
          : typeof ejerlavskodeRaw === 'string'
            ? Number(ejerlavskodeRaw) || 0
            : 0;

      if (!matrikelnr && !ejerlavsnavn) continue;

      result.push({ bfenummer: bfe, matrikelnr, ejerlavsnavn, ejerlavskode });
    }

    return result;
  } catch (err) {
    logger.error(
      'matListJordstykker MAT WFS fetch failed:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * BIZZ-506: DAR GraphQL — resolve full adresse UUID for ejerlejligheder
 * (adgangsadresse + etage + dør combination)
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/**
 * BIZZ-506: Resolve a full DAR `adresse` UUID for a specific unit by
 * chaining DAR GraphQL queries:
 *   1. DAR_NavngivenVej(vejnavn)        → vej-UUID(s)
 *   2. DAR_Postnummer(postnr)           → postnr-UUID
 *   3. DAR_Husnummer(husnummertekst +
 *      postnummer-UUID + navngivenVej)  → husnummer-UUID
 *   4. DAR_Adresse(husnummer-UUID +
 *      etagebetegnelse + doerbetegnelse) → final adresse-UUID
 *
 * Used by ejerlejlighed flows where we have split fields (vejnavn, husnr,
 * postnr, etage, dør) from EJF but need the DAR adresseIdentificerer to
 * query BBR_Enhed. DAWA /adresser?vejnavn=… is the pre-2026-07-01
 * equivalent; callers should fall back to it on null.
 *
 * Never throws. Returns null on any missing API key, empty chain result,
 * or GraphQL error.
 *
 * Cost: up to 4 GraphQL round-trips per call. Batch at the caller level
 * when resolving many units from the same address list.
 *
 * @param input - Split address components
 */
export async function darResolveAdresseId(input: {
  vejnavn: string;
  husnr: string;
  postnr: string;
  etage?: string | null;
  doer?: string | null;
}): Promise<string | null> {
  if (!process.env.DATAFORDELER_API_KEY) {
    logger.warn(
      'darResolveAdresseId: DATAFORDELER_API_KEY not set — skipping DAR, caller should fall back to DAWA'
    );
    return null;
  }

  const ts = nowTs();
  const esc = (s: string) => s.replace(/"/g, '\\"');

  // Step 1: NavngivenVej (vejnavne kan forekomme flere gange i landet →
  // vi henter op til 20 kandidater og filtrerer via postnummer i trin 3).
  const vejData = await darQuery<{
    DAR_NavngivenVej: { nodes: Array<{ id_lokalId: string }> };
  }>(`{
    DAR_NavngivenVej(
      where: { vejnavn: { eq: "${esc(input.vejnavn)}" } }
      virkningstid: "${ts}"
      registreringstid: "${ts}"
      first: 20
    ) { nodes { id_lokalId } }
  }`);
  const vejUuids = new Set((vejData?.DAR_NavngivenVej?.nodes ?? []).map((n) => n.id_lokalId));
  if (vejUuids.size === 0) return null;

  // Step 2: Postnummer
  const postnrData = await darQuery<{
    DAR_Postnummer: { nodes: Array<{ id_lokalId: string }> };
  }>(`{
    DAR_Postnummer(
      where: { postnr: { eq: "${esc(input.postnr)}" } }
      virkningstid: "${ts}"
      registreringstid: "${ts}"
      first: 1
    ) { nodes { id_lokalId } }
  }`);
  const postnrUuid = postnrData?.DAR_Postnummer?.nodes?.[0]?.id_lokalId;
  if (!postnrUuid) return null;

  // Step 3: Husnummer — match husnummertekst + postnr, then filter by vej-UUIDs
  const husnummerData = await darQuery<{
    DAR_Husnummer: { nodes: Array<{ id_lokalId: string; navngivenVej: string }> };
  }>(`{
    DAR_Husnummer(
      where: {
        husnummertekst: { eq: "${esc(input.husnr)}" }
        postnummer: { eq: "${postnrUuid}" }
      }
      virkningstid: "${ts}"
      registreringstid: "${ts}"
      first: 20
    ) { nodes { id_lokalId navngivenVej } }
  }`);
  const husnummerMatch = (husnummerData?.DAR_Husnummer?.nodes ?? []).find((h) =>
    vejUuids.has(h.navngivenVej)
  );
  if (!husnummerMatch) return null;

  // Step 4: Adresse — composite match on husnummer + etage + dør.
  // Etage or dør being absent is fine (ground-floor, single-entry flats) —
  // we still require an exact match on whatever is provided.
  const adresseWhereParts = [`husnummer: { eq: "${husnummerMatch.id_lokalId}" }`];
  if (input.etage) {
    adresseWhereParts.push(`etagebetegnelse: { eq: "${esc(input.etage)}" }`);
  }
  if (input.doer) {
    adresseWhereParts.push(`doerbetegnelse: { eq: "${esc(input.doer)}" }`);
  }

  const adresseData = await darQuery<{
    DAR_Adresse: { nodes: Array<{ id_lokalId: string }> };
  }>(`{
    DAR_Adresse(
      where: { ${adresseWhereParts.join(', ')} }
      virkningstid: "${ts}"
      registreringstid: "${ts}"
      first: 1
    ) { nodes { id_lokalId } }
  }`);
  return adresseData?.DAR_Adresse?.nodes?.[0]?.id_lokalId ?? null;
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * BIZZ-505: MAT GraphQL — jordstykke by BFE with ejerlav-name resolution
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/**
 * Shape returned by matHentJordstykkeByBfe — intentionally kept close to the
 * legacy DAWA `/jordstykker?bfenummer=` response so the /api/adresse/jordstykke
 * route can return a compatible payload without caller changes.
 */
export interface MatJordstykkeByBfe {
  matrikelnr: string;
  registreretAreal: number | null;
  vejareal: number | null;
  ejerlav: {
    /** 7-digit ejerlavskode, e.g. 1161451 — may be 0 if MAT_Ejerlav lookup fails */
    kode: number;
    /** Ejerlavsnavn (e.g. "Søgård Hgd., Kliplev Sogn") — null if resolution fails */
    navn: string | null;
  };
}

/**
 * BIZZ-505: Look up a jordstykke by BFE number via MAT GraphQL and resolve
 * the associated ejerlav name.
 *
 * Pipeline:
 *   1. MAT_SamletFastEjendom(BFEnummer=bfe) → jordstykke with ejerlavLokalId (UUID)
 *   2. MAT_Ejerlav(id_lokalId=ejerlavLokalId) → ejerlavskode + ejerlavsnavn
 *
 * Returns null on:
 *   - DATAFORDELER_API_KEY missing
 *   - MAT GraphQL errors or empty result
 *   - Schema drift (defensive field reading)
 *
 * Caller (`/api/adresse/jordstykke?bfe=…`) falls back to DAWA on null.
 *
 * @param bfe - BFE number (positive integer)
 */
export async function matHentJordstykkeByBfe(bfe: number): Promise<MatJordstykkeByBfe | null> {
  const apiKey = process.env.DATAFORDELER_API_KEY;
  if (!apiKey) {
    logger.warn(
      'matHentJordstykkeByBfe: DATAFORDELER_API_KEY not set — skipping MAT, caller should fall back to DAWA'
    );
    return null;
  }

  const nowIso = new Date().toISOString();
  const url = `${MAT_GQL_URL}?apiKey=${encodeURIComponent(apiKey)}`;

  // Helper — minimal GraphQL POST with JSON response. Returns parsed data
  // or null on any error so the pipeline can fall back cleanly.
  async function gqlQuery<T extends object>(query: string): Promise<T | null> {
    try {
      const res = await fetch(proxyUrl(url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...proxyHeaders() },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(proxyTimeout()),
      });
      if (!res.ok) {
        logger.warn(`MAT GraphQL fejl: ${res.status} ${res.statusText}`);
        return null;
      }
      const json = (await res.json()) as { data?: T; errors?: unknown[] };
      if (json.errors?.length) {
        logger.warn('MAT GraphQL errors:', JSON.stringify(json.errors).slice(0, 400));
        return null;
      }
      return json.data ?? null;
    } catch (err) {
      logger.error('MAT GraphQL fetch failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  // Step 1: SamletFastEjendom → jordstykke
  const sfeQuery = `{
    MAT_SamletFastEjendom(
      first: 1
      virkningstid: "${nowIso}"
      registreringstid: "${nowIso}"
      where: { BFEnummer: { eq: ${bfe} } }
    ) {
      nodes {
        BFEnummer
        jordstykkeSamlesISamletFastEjendom(first: 1) {
          nodes {
            id_lokalId
            matrikelnummer
            registreretAreal
            vejareal
            ejerlavLokalId
          }
        }
      }
    }
  }`;

  const sfeData = await gqlQuery<{
    MAT_SamletFastEjendom?: {
      nodes?: Array<{
        jordstykkeSamlesISamletFastEjendom?: {
          nodes?: Array<{
            matrikelnummer?: string;
            registreretAreal?: number;
            vejareal?: number;
            ejerlavLokalId?: string;
          }>;
        };
      }>;
    };
  }>(sfeQuery);

  const js =
    sfeData?.MAT_SamletFastEjendom?.nodes?.[0]?.jordstykkeSamlesISamletFastEjendom?.nodes?.[0];
  if (!js || !js.matrikelnummer) {
    logger.warn(`matHentJordstykkeByBfe: no jordstykke for BFE ${bfe}`);
    return null;
  }

  const matrikelnr = String(js.matrikelnummer);
  const registreretAreal = typeof js.registreretAreal === 'number' ? js.registreretAreal : null;
  const vejareal = typeof js.vejareal === 'number' ? js.vejareal : null;
  const ejerlavLokalId = typeof js.ejerlavLokalId === 'string' ? js.ejerlavLokalId : null;

  // Step 2: Resolve ejerlav name + kode. If this fails the jordstykke is
  // still useful (matrikelnr + areal) so we return with navn=null, kode=0.
  let ejerlavKode = 0;
  let ejerlavNavn: string | null = null;

  if (ejerlavLokalId) {
    const ejerlavQuery = `{
      MAT_Ejerlav(
        first: 1
        virkningstid: "${nowIso}"
        registreringstid: "${nowIso}"
        where: { id_lokalId: { eq: "${ejerlavLokalId}" } }
      ) {
        nodes {
          ejerlavskode
          ejerlavsnavn
        }
      }
    }`;
    const ejerlavData = await gqlQuery<{
      MAT_Ejerlav?: {
        nodes?: Array<{
          ejerlavskode?: number | string;
          ejerlavsnavn?: string;
        }>;
      };
    }>(ejerlavQuery);
    const row = ejerlavData?.MAT_Ejerlav?.nodes?.[0];
    if (row) {
      const kodeRaw = row.ejerlavskode;
      ejerlavKode =
        typeof kodeRaw === 'number'
          ? kodeRaw
          : typeof kodeRaw === 'string'
            ? Number(kodeRaw) || 0
            : 0;
      ejerlavNavn = typeof row.ejerlavsnavn === 'string' ? row.ejerlavsnavn : null;
    }
  }

  return {
    matrikelnr,
    registreretAreal,
    vejareal,
    ejerlav: { kode: ejerlavKode, navn: ejerlavNavn },
  };
}
