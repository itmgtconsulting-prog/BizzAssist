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

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Constants
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const MAT_WFS_ENDPOINT = 'https://services.datafordeler.dk/Matrikel/MatGaeld662/1/WFS';
/**
 * BIZZ-503: Datafordeler DAR WFS endpoint. Used for spatial queries
 * (reverse geocoding) that DAR GraphQL does not support.
 */
const DAR_WFS_ENDPOINT = 'https://services.datafordeler.dk/DAR/DAR/1/WFS';

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

  // Build base variants (case), then expand each with diacritics
  const baseVariants = [...new Set([escaped, titleCase, firstUpper, hnUpperCase])];
  const allVariants = new Set<string>();
  for (const base of baseVariants) {
    for (const expanded of expandDiacritics(base)) {
      allVariants.add(expanded.replace(/"/g, '\\"'));
    }
  }
  // Cap at 10 variants to avoid excessive API calls
  const variants = [...allVariants].slice(0, 10);

  try {
    // Kør queries for alle case-varianter parallelt
    const allResults = await Promise.all(
      variants.map(async (variant) => {
        const query = `{
          DAR_Husnummer(
            first: 8
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
        }`;
        return darQuery<{ DAR_Husnummer: { nodes: DarHusnummerRaw[] } }>(query);
      })
    );

    // Dedupliker på id_lokalId
    const seen = new Set<string>();
    const nodes: DarHusnummerRaw[] = [];
    for (const data of allResults) {
      for (const h of data?.DAR_Husnummer?.nodes ?? []) {
        if (!seen.has(h.id_lokalId)) {
          seen.add(h.id_lokalId);
          nodes.push(h);
        }
      }
    }
    if (nodes.length === 0) {
      // DAR returned no results — may be IP-blocked; fall back to DAWA
      logger.warn('darAutocomplete: DAR returned 0 results, trying DAWA fallback');
      return _dawaAutocomplete(q);
    }

    return nodes.slice(0, 8).map((h): DawaAutocompleteResult => {
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
          kommunenavn: '', // Ikke tilgængelig som tekst i DAR — kun kommunekode
          x: 0, // Koordinater kræver separat adgangspunkt-opslag
          y: 0,
        },
      };
    });
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

    // Step 2: Parallelle opslag for Adgangspunkt, Postnummer, NavngivenVej og Kommuneinddeling
    const [apData, pnData, vejData, komData] = await Promise.all([
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

    return {
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
      zone: undefined, // Zone kræver Plandata WFS — udeladt for nu
    };
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
