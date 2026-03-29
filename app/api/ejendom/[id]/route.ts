/**
 * GET /api/ejendom/[id]
 *
 * Server-side aggregation endpoint for property data.
 * Fetches and merges data from multiple sources:
 *  1. Datafordeler BBR v2 GraphQL — building data (opførelsesår, areal, materialer)
 *  2. Datafordeler BBR v2 GraphQL — units (enheder) for the property
 *
 * Authentication: API Key via ?apiKey= query param (frie data).
 * All Datafordeler calls are made server-side so credentials stay hidden.
 * BBR calls degrade gracefully to null on auth error.
 *
 * @param params.id - DAWA adgangsadresse UUID (also used as husnummer in BBR)
 * @returns JSON with { dawaId, bbr, enheder, bbrFejl }
 */

import { NextRequest, NextResponse } from 'next/server';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';
import {
  tagMaterialeTekst,
  ydervaegMaterialeTekst,
  varmeInstallationTekst,
  opvarmningsmiddelTekst,
  vandforsyningTekst,
  afloebsforholdTekst,
  bygAnvendelseTekst,
  bygStatusTekst,
  enhedAnvendelseTekst,
} from '@/app/lib/bbrKoder';

// ─── Types ─────────────────────────────────────────────────────────────────

/** Raw BBR bygning from Datafordeler GraphQL v2 */
export interface RawBBRBygning {
  id_lokalId?: string;
  byg026Opfoerelsesaar?: number;
  byg027OmTilbygningsaar?: number;
  byg038SamletBygningsareal?: number;
  byg039BygningensSamledeBoligAreal?: number;
  byg040BygningensSamledeErhvervsAreal?: number;
  byg041BebyggetAreal?: number;
  byg024AntalLejlighederMedKoekken?: number;
  byg025AntalLejlighederUdenKoekken?: number;
  byg054AntalEtager?: number;
  byg033Tagdaekningsmateriale?: string;
  byg032YdervaeggensMateriale?: string;
  byg056Varmeinstallation?: string;
  byg057Opvarmningsmiddel?: string;
  byg058SupplerendeVarme?: string;
  byg030Vandforsyning?: string;
  byg031Afloebsforhold?: string;
  byg021BygningensAnvendelse?: string;
  byg070Fredning?: string;
  byg071BevaringsvaerdighedReference?: string;
  byg094Revisionsdato?: string;
  status?: string;
  husnummer?: string;
}

/** Raw BBR enhed (unit) from Datafordeler GraphQL v2 */
interface RawBBREnhed {
  id_lokalId?: string;
  adresseIdentificerer?: string;
  enh020EnhedensAnvendelse?: string;
  enh023Boligtype?: string;
  enh026EnhedensSamledeAreal?: number;
  enh027ArealTilBeboelse?: number;
  enh028ArealTilErhverv?: number;
  enh031AntalVaerelser?: number;
  enh035Energiforsyning?: string;
  enh051Varmeinstallation?: string;
  enh052Opvarmningsmiddel?: string;
  bygning?: string;
  etage?: string;
  status?: string;
}

/** Normalised BBR bygning returned to client */
export interface LiveBBRBygning {
  id: string;
  opfoerelsesaar: number | null;
  ombygningsaar: number | null;
  bebyggetAreal: number | null;
  samletBygningsareal: number | null;
  samletBoligareal: number | null;
  samletErhvervsareal: number | null;
  antalBoligenheder: number | null;
  antalErhvervsenheder: number | null;
  antalEtager: number | null;
  kaelder: number | null;
  tagetage: number | null;
  tagkonstruktion: string;
  tagmateriale: string;
  ydervaeg: string;
  varmeinstallation: string;
  opvarmningsform: string;
  vandforsyning: string;
  afloeb: string;
  anvendelse: string;
  anvendelseskode: number | null;
  energimaerke: string | null;
  fredning: string | null;
  status: string | null;
  bygningsnr: number | null;
  /** Seneste revisionsdato fra BBR (byg094Revisionsdato) — ISO-dato-streng */
  revisionsdato: string | null;
}

/** Normalised BBR enhed returned to client */
export interface LiveBBREnhed {
  id: string;
  bygningId: string | null;
  /** Etagebetegnelse fra DAWA (f.eks. "st", "1", "2") */
  etage: string | null;
  /** Dørbetegnelse fra DAWA (f.eks. "tv", "th", "1") */
  doer: string | null;
  /** Fuld adressebetegnelse fra DAWA */
  adressebetegnelse: string | null;
  areal: number | null;
  arealBolig: number | null;
  arealErhverv: number | null;
  vaerelser: number | null;
  anvendelse: string;
  status: string | null;
  energimaerke: string | null;
  varmeinstallation: string;
}

/** A single BBR building point for map display */
export interface BBRBygningPunkt {
  id: string;
  lng: number;
  lat: number;
  bygningsnr: number | null;
  anvendelse: string;
  opfoerelsesaar: number | null;
  samletAreal: number | null;
  antalEtager: number | null;
  status: string | null;
}

/** BBR Ejendomsrelation — kobler husnummer til BFEnummer og matrikelinfo */
export interface BBREjendomsrelation {
  bfeNummer: number | null;
  ejendomsnummer: string | null;
  ejendomstype: string | null;
  /** Ejerlavkode (cadastralDistrictIdentifier) — bruges til DkJord API */
  ejerlavKode: number | null;
  /** Matrikelnummer — bruges til DkJord API */
  matrikelnr: string | null;
}

/** Shape of the full API response */
export interface EjendomApiResponse {
  dawaId: string;
  bbr: LiveBBRBygning[] | null;
  enheder: LiveBBREnhed[] | null;
  bygningPunkter: BBRBygningPunkt[] | null;
  ejendomsrelationer: BBREjendomsrelation[] | null;
  bbrFejl: string | null;
}

// ─── WFS helper (bygningspunkter til kort) ─────────────────────────────────

const WFS_BASE = 'https://wfs.datafordeler.dk/BBR/BBR_WFS/1.0.0/WFS';

/**
 * Henter BBR bygningspunkter (WGS84) fra Datafordeler WFS.
 * Bruger id_lokalId-filtrering — bygning-UUID'er hentes fra BBR_Enhed.bygning.
 * Returnerer null ved fejl eller manglende API-nøgle.
 *
 * @param bygningIds - Array af BBR Bygning id_lokalId UUID'er (fra BBR_Enhed.bygning)
 */
async function fetchBygningPunkter(bygningIds: string[]): Promise<BBRBygningPunkt[] | null> {
  if (!DF_API_KEY || bygningIds.length === 0) return null;

  // Byg CQL_FILTER med IN-udtryk for flere bygninger, eller enkelt eq for én
  const quoted = bygningIds.map((id) => `'${id}'`).join(',');
  const cqlRaw =
    bygningIds.length === 1 ? `id_lokalId='${bygningIds[0]}'` : `id_lokalId IN (${quoted})`;
  const cqlFilter = encodeURIComponent(cqlRaw);

  const url =
    `${WFS_BASE}?service=WFS&version=2.0.0&request=GetFeature` +
    `&typeName=bbr_v001:bygning_current` +
    `&outputFormat=application%2Fjson` +
    `&srsName=EPSG:4326` +
    `&count=1000` +
    `&CQL_FILTER=${cqlFilter}` +
    `&apikey=${DF_API_KEY}`;

  try {
    const res = await fetch(proxyUrl(url), {
      headers: { ...proxyHeaders() },
      signal: AbortSignal.timeout(proxyTimeout()),
      next: { revalidate: 3600 },
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(
        `[BBR WFS] HTTP ${res.status} for ids=${bygningIds.join(',')}: ${errText.slice(0, 400)}`
      );
      return null;
    }

    const json = (await res.json()) as {
      features?: Array<{
        geometry?: { coordinates?: [number, number] };
        properties?: Record<string, unknown>;
      }>;
    };

    if (!json.features) return null;

    return json.features
      .filter((f) => f.geometry?.coordinates)
      .map((f) => {
        const p = f.properties ?? {};
        const coords = f.geometry!.coordinates!;
        return {
          id: String(p.id_lokalId ?? ''),
          lng: coords[0],
          lat: coords[1],
          bygningsnr: p.byg007Bygningsnummer != null ? Number(p.byg007Bygningsnummer) : null,
          anvendelse: bygAnvendelseTekst(
            p.byg021BygningensAnvendelse != null
              ? parseInt(String(p.byg021BygningensAnvendelse), 10)
              : undefined
          ),
          opfoerelsesaar: p['byg026Opførelsesår'] != null ? Number(p['byg026Opførelsesår']) : null,
          samletAreal:
            p.byg038SamletBygningsareal != null ? Number(p.byg038SamletBygningsareal) : null,
          antalEtager: p.byg054AntalEtager != null ? Number(p.byg054AntalEtager) : null,
          status: p.status != null ? bygStatusTekst(parseInt(String(p.status), 10)) : null,
        };
      });
  } catch {
    return null;
  }
}

// ─── GraphQL helpers ────────────────────────────────────────────────────────

const BBR_GQL_BASE = 'https://graphql.datafordeler.dk/BBR/v2';
const DF_API_KEY = process.env.DATAFORDELER_API_KEY ?? '';

/** Base URL for DAWA (Danmarks Adresser Web API) — gratis, ingen auth */
const DAWA_BASE = 'https://api.dataforsyningen.dk';

/**
 * Hjælpefunktion: sender en GraphQL POST til et Datafordeler GraphQL endpoint.
 * Returnerer nodes-arrayet fra første data-nøgle, eller null ved fejl.
 *
 * @param base - Base URL for GraphQL endpointet
 * @param query - GraphQL query streng
 * @param variables - GraphQL variabler
 */
async function fetchDatafordelerGraphQL(
  base: string,
  query: string,
  variables: Record<string, string>
): Promise<unknown[] | null> {
  if (!DF_API_KEY) return null;

  const directUrl = `${base}?apiKey=${DF_API_KEY}`;
  const url = proxyUrl(directUrl);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...proxyHeaders() },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(proxyTimeout()),
      cache: 'no-store',
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const hdrs = Object.fromEntries(res.headers.entries());
      console.error(
        `[BBR GQL] HTTP ${res.status} url=${url.replace(/apiKey=[^&]+/, 'apiKey=REDACTED')}`
      );
      console.error(`[BBR GQL] Headers:`, JSON.stringify(hdrs));
      console.error(`[BBR GQL] Body: "${txt.slice(0, 600)}"`);
      return null;
    }

    const json = (await res.json()) as {
      data?: Record<string, { nodes?: unknown[] }>;
      errors?: unknown[];
    };

    if (json.errors?.length) {
      console.error('[BBR GQL] GraphQL errors:', JSON.stringify(json.errors).slice(0, 600));
      return null;
    }

    // Return the nodes array from the first data key
    const firstKey = Object.keys(json.data ?? {})[0];
    const nodes = json.data?.[firstKey]?.nodes;
    return Array.isArray(nodes) ? nodes : null;
  } catch (err) {
    console.error('[BBR GQL] Fetch error:', err);
    return null;
  }
}

/**
 * Sender en GraphQL-forespørgsel til Datafordeler BBR v2.
 * Wrapper om fetchDatafordelerGraphQL med BBR base URL.
 */
async function fetchBBRGraphQL(
  query: string,
  variables: Record<string, string>
): Promise<unknown[] | null> {
  return fetchDatafordelerGraphQL(BBR_GQL_BASE, query, variables);
}

/**
 * Henter BFEnummer (BestemtFastEjendom-nummer) via DAWA jordstykker-API.
 *
 * DAWA er gratis og kræver ingen autentificering. Flowet er:
 *   1. Hent jordstykke-reference (ejerlavkode + matrikelnr) fra DAWA adgangsadresse
 *   2. Hent BFEnummer fra DAWA jordstykker-endpoint
 *
 * Datafordeler EBR GraphQL-endpointet eksisterer ikke — DAWA er den korrekte kilde.
 * Håndterer både adresse-UUID og adgangsadresse-UUID som input.
 *
 * @param dawaId - DAWA adresse- eller adgangsadresse-UUID (fra route-param)
 * @returns { bfeNummer, adgangsadresseId } — bfeNummer null ved fejl,
 *          adgangsadresseId er adgangsadresse-UUID (bruges til BBR_Bygning husnummer-felt)
 */
async function fetchBFENummer(dawaId: string): Promise<{
  bfeNummer: number | null;
  adgangsadresseId: string;
  ejerlavKode: number | null;
  matrikelnr: string | null;
}> {
  try {
    let ejerlavKode: number | undefined;
    let matrikelnr: string | undefined;
    let adgangsadresseId = dawaId;

    // Trin 1a: Forsøg direkte som adgangsadresse
    const adgRes = await fetch(`${DAWA_BASE}/adgangsadresser/${dawaId}`, {
      signal: AbortSignal.timeout(5000),
      next: { revalidate: 3600 },
    });

    if (adgRes.ok) {
      const adg = (await adgRes.json()) as {
        jordstykke?: { ejerlav?: { kode?: number }; matrikelnr?: string };
      };
      ejerlavKode = adg?.jordstykke?.ejerlav?.kode;
      matrikelnr = adg?.jordstykke?.matrikelnr;
    } else {
      // Trin 1b: ID er en adresse (med etage/dør) — hent adgangsadresse via /adresser/{id}
      const adrRes = await fetch(`${DAWA_BASE}/adresser/${dawaId}`, {
        signal: AbortSignal.timeout(5000),
        next: { revalidate: 3600 },
      });
      if (!adrRes.ok)
        return { bfeNummer: null, adgangsadresseId: dawaId, ejerlavKode: null, matrikelnr: null };

      const adr = (await adrRes.json()) as {
        adgangsadresse?: {
          id?: string;
          jordstykke?: { ejerlav?: { kode?: number }; matrikelnr?: string };
        };
      };
      adgangsadresseId = adr?.adgangsadresse?.id ?? dawaId;
      ejerlavKode = adr?.adgangsadresse?.jordstykke?.ejerlav?.kode;
      matrikelnr = adr?.adgangsadresse?.jordstykke?.matrikelnr;
    }

    if (!ejerlavKode || !matrikelnr) {
      return { bfeNummer: null, adgangsadresseId, ejerlavKode: null, matrikelnr: null };
    }

    // Trin 2: Hent BFEnummer fra jordstykker-endpoint
    const jsRes = await fetch(`${DAWA_BASE}/jordstykker/${ejerlavKode}/${matrikelnr}`, {
      signal: AbortSignal.timeout(5000),
      next: { revalidate: 3600 },
    });
    if (!jsRes.ok) {
      return {
        bfeNummer: null,
        adgangsadresseId,
        ejerlavKode: ejerlavKode ?? null,
        matrikelnr: matrikelnr ?? null,
      };
    }

    const js = (await jsRes.json()) as { bfenummer?: number };
    return {
      bfeNummer: js?.bfenummer ?? null,
      adgangsadresseId,
      ejerlavKode: ejerlavKode ?? null,
      matrikelnr: matrikelnr ?? null,
    };
  } catch {
    return { bfeNummer: null, adgangsadresseId: dawaId, ejerlavKode: null, matrikelnr: null };
  }
}

/** Returns a DafDateTime string for the current moment (CET/CEST). */
function nowDafDateTime(): string {
  // Datafordeler requires timezone offset format: 2026-03-23T12:00:00+01:00
  const now = new Date();
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const mm = String(Math.abs(offset) % 60).padStart(2, '0');
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `${sign}${hh}:${mm}`
  );
}

// ─── BBR normalisation ──────────────────────────────────────────────────────

/**
 * Normalises a raw BBR bygning record into client-friendly shape.
 * @param raw - Raw JSON object from Datafordeler BBR GraphQL
 */
export function normaliseBygning(raw: RawBBRBygning): LiveBBRBygning {
  const parseCode = (v: string | undefined) => (v != null ? parseInt(v, 10) : undefined);

  return {
    id: raw.id_lokalId ?? '',
    opfoerelsesaar: raw.byg026Opfoerelsesaar ?? null,
    ombygningsaar: raw.byg027OmTilbygningsaar ?? null,
    bebyggetAreal: raw.byg041BebyggetAreal ?? null,
    samletBygningsareal: raw.byg038SamletBygningsareal ?? null,
    samletBoligareal: raw.byg039BygningensSamledeBoligAreal ?? null,
    samletErhvervsareal: raw.byg040BygningensSamledeErhvervsAreal ?? null,
    antalBoligenheder:
      (raw.byg024AntalLejlighederMedKoekken ?? 0) + (raw.byg025AntalLejlighederUdenKoekken ?? 0) ||
      null,
    antalErhvervsenheder: null,
    antalEtager: raw.byg054AntalEtager ?? null,
    kaelder: null,
    tagetage: null,
    tagkonstruktion: '–',
    tagmateriale: tagMaterialeTekst(parseCode(raw.byg033Tagdaekningsmateriale)),
    ydervaeg: ydervaegMaterialeTekst(parseCode(raw.byg032YdervaeggensMateriale)),
    varmeinstallation: varmeInstallationTekst(parseCode(raw.byg056Varmeinstallation)),
    opvarmningsform: opvarmningsmiddelTekst(parseCode(raw.byg057Opvarmningsmiddel)),
    vandforsyning: vandforsyningTekst(parseCode(raw.byg030Vandforsyning)),
    afloeb: afloebsforholdTekst(parseCode(raw.byg031Afloebsforhold)),
    anvendelse: bygAnvendelseTekst(parseCode(raw.byg021BygningensAnvendelse)),
    anvendelseskode: parseCode(raw.byg021BygningensAnvendelse) ?? null,
    energimaerke: null,
    fredning: raw.byg070Fredning ?? null,
    status: raw.status != null ? bygStatusTekst(parseInt(raw.status, 10)) : null,
    bygningsnr: null, // udfyldes fra WFS bygningPunkter efter fetch
    revisionsdato: raw.byg094Revisionsdato ?? null,
  };
}

/** UUID-mønster — bruges til at filtrere reference-ID'er fra tekst-felter */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Normalises a raw BBR enhed record into client-friendly shape.
 * Bemærk: `etage` i BBR GraphQL returneres som reference-UUID, ikke etagenummer.
 * Vi filtrerer UUID'er fra og returnerer null.
 * @param raw - Raw JSON object from Datafordeler BBR GraphQL
 */
export function normaliseEnhed(raw: RawBBREnhed): LiveBBREnhed {
  const parseCode = (v: string | undefined) => (v != null ? parseInt(v, 10) : undefined);

  // Etage-felt er en UUID-reference i BBR GraphQL — vis '–' i UI
  const etageValue = raw.etage && !UUID_RE.test(raw.etage) ? raw.etage : null;

  return {
    id: raw.id_lokalId ?? '',
    bygningId: (raw.bygning && !UUID_RE.test(raw.bygning) ? null : raw.bygning) ?? null,
    etage: etageValue,
    doer: null, // udfyldes fra DAWA efter fetch
    adressebetegnelse: null, // udfyldes fra DAWA efter fetch
    areal: raw.enh026EnhedensSamledeAreal ?? null,
    arealBolig: raw.enh027ArealTilBeboelse ?? null,
    arealErhverv: raw.enh028ArealTilErhverv ?? null,
    vaerelser: raw.enh031AntalVaerelser ?? null,
    anvendelse: enhedAnvendelseTekst(parseCode(raw.enh020EnhedensAnvendelse)),
    status: raw.status ?? null,
    energimaerke: null,
    varmeinstallation: varmeInstallationTekst(parseCode(raw.enh051Varmeinstallation)),
  };
}

// ─── GraphQL queries ────────────────────────────────────────────────────────

const BYGNING_QUERY = `
  query($vt: DafDateTime!, $id: String!) {
    BBR_Bygning(first: 100, virkningstid: $vt, where: { husnummer: { eq: $id } }) {
      nodes {
        id_lokalId
        byg026Opfoerelsesaar
        byg027OmTilbygningsaar
        byg038SamletBygningsareal
        byg039BygningensSamledeBoligAreal
        byg040BygningensSamledeErhvervsAreal
        byg041BebyggetAreal
        byg024AntalLejlighederMedKoekken
        byg025AntalLejlighederUdenKoekken
        byg054AntalEtager
        byg033Tagdaekningsmateriale
        byg032YdervaeggensMateriale
        byg056Varmeinstallation
        byg057Opvarmningsmiddel
        byg058SupplerendeVarme
        byg030Vandforsyning
        byg031Afloebsforhold
        byg021BygningensAnvendelse
        byg070Fredning
        byg071BevaringsvaerdighedReference
        byg094Revisionsdato
        status
        husnummer
      }
    }
  }
`;

const ENHED_QUERY = `
  query($vt: DafDateTime!, $id: String!) {
    BBR_Enhed(first: 100, virkningstid: $vt, where: { adresseIdentificerer: { eq: $id } }) {
      nodes {
        id_lokalId
        adresseIdentificerer
        enh020EnhedensAnvendelse
        enh023Boligtype
        enh026EnhedensSamledeAreal
        enh027ArealTilBeboelse
        enh028ArealTilErhverv
        enh031AntalVaerelser
        enh035Energiforsyning
        enh051Varmeinstallation
        enh052Opvarmningsmiddel
        bygning
        etage
        status
      }
    }
  }
`;

/**
 * Batch-henter DAWA-adressedata for en liste af adresse-UUIDs.
 * Returnerer et map fra UUID → { etage, doer, adressebetegnelse }.
 * Bruger DAWA's bulk-endpoint (kommaseparerede IDs) for effektivitet.
 *
 * @param ids - Array af DAWA adresse-UUIDs (fra BBR_Enhed.adresseIdentificerer)
 */
async function fetchDAWAEnhedAdresser(
  ids: string[]
): Promise<Map<string, { etage: string | null; doer: string | null; adressebetegnelse: string }>> {
  const result = new Map<
    string,
    { etage: string | null; doer: string | null; adressebetegnelse: string }
  >();
  const uuids = ids.filter((id) => UUID_RE.test(id));
  if (uuids.length === 0) return result;

  try {
    const params = uuids.map((id) => `id=${encodeURIComponent(id)}`).join('&');
    const res = await fetch(`${DAWA_BASE}/adresser?${params}&struktur=mini`, {
      signal: AbortSignal.timeout(8000),
      next: { revalidate: 3600 },
    });
    if (!res.ok) return result;
    const data = (await res.json()) as Array<Record<string, unknown>>;
    for (const item of data) {
      const itemId = typeof item.id === 'string' ? item.id : null;
      if (!itemId) continue;
      const etage = typeof item.etage === 'string' && item.etage ? item.etage : null;
      const doer = typeof item.dør === 'string' && item.dør ? item.dør : null;
      const adressebetegnelse =
        typeof item.adressebetegnelse === 'string'
          ? item.adressebetegnelse
          : `${item.vejnavn ?? ''} ${item.husnr ?? ''}`.trim();
      result.set(itemId, { etage, doer, adressebetegnelse });
    }
  } catch {
    // silent fail — adressedata er nice-to-have, ikke kritisk
  }
  return result;
}

// ─── Route handler ─────────────────────────────────────────────────────────

/**
 * GET /api/ejendom/[id]
 * Aggregates property BBR data for the given DAWA adgangsadresse UUID.
 *
 * @param _req - Next.js request (unused)
 * @param context - Route context with the DAWA id
 * @returns { dawaId, bbr, enheder, bbrFejl }
 */
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse<EjendomApiResponse>> {
  const { id } = await context.params;

  // UUID validation
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(id)) {
    return NextResponse.json(
      {
        dawaId: id,
        bbr: null,
        enheder: null,
        bygningPunkter: null,
        ejendomsrelationer: null,
        bbrFejl: 'Ugyldigt adresse-id',
      },
      { status: 400 }
    );
  }

  const vt = nowDafDateTime();

  // Resolve adgangsadresse-UUID og BFEnummer.
  // Nødvendigt fordi DAWA-ID kan være enten en adresse- eller adgangsadresse-UUID.
  // BBR_Bygning.husnummer kræver adgangsadresse-UUID; BBR_Enhed.adresseIdentificerer
  // accepterer begge typer, så vi bruger original id for enheder.
  const { bfeNummer, adgangsadresseId, ejerlavKode, matrikelnr } = await fetchBFENummer(id);

  // Hent bygninger og enheder parallelt med korrekte UUIDs.
  const [rawBygninger, rawEnheder] = await Promise.all([
    fetchBBRGraphQL(BYGNING_QUERY, { vt, id: adgangsadresseId }),
    fetchBBRGraphQL(ENHED_QUERY, { vt, id }),
  ]);

  // Udtræk unikke bygning-UUID'er fra enheder (primær kilde)
  const fraEnheder: string[] = rawEnheder
    ? (rawEnheder as RawBBREnhed[])
        .map((e) => e.bygning)
        .filter((b): b is string => typeof b === 'string' && b.length > 0)
    : [];

  // Fallback: brug id_lokalId fra rawBygninger hvis enheder ikke giver bygning-UUID'er
  // (fx adresser der er registreret direkte på bygningen uden enheder)
  const fraBygninger: string[] = rawBygninger
    ? (rawBygninger as RawBBRBygning[])
        .map((b) => b.id_lokalId)
        .filter((bId): bId is string => typeof bId === 'string' && bId.length > 0)
    : [];

  const bygningIds = [...new Set([...fraEnheder, ...fraBygninger])];

  const bygningPunkter = await fetchBygningPunkter(bygningIds);

  // Dedupliker BBR-data — BBR GraphQL kan returnere samme objekt i flere virkningsperioder.
  // Vi beholder kun ét objekt pr. id_lokalId (første forekomst er nyeste virkningstid).
  const deduplicerBBR = <T extends { id_lokalId?: string }>(arr: T[]): T[] => {
    const seen = new Set<string>();
    return arr.filter((item) => {
      const key = item.id_lokalId ?? '';
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const rawBygningerUnique = rawBygninger ? deduplicerBBR(rawBygninger as RawBBRBygning[]) : null;
  const rawEnhederUnique = rawEnheder ? deduplicerBBR(rawEnheder as RawBBREnhed[]) : null;

  // Byg et map fra bygnings-UUID → bygningsnr fra WFS-punkterne (byg007Bygningsnummer)
  const bygningsnrFraWFS = new Map<string, number>();
  if (bygningPunkter) {
    for (const p of bygningPunkter) {
      if (p.id && p.bygningsnr != null) bygningsnrFraWFS.set(p.id, p.bygningsnr);
    }
  }

  const bbr = rawBygningerUnique
    ? rawBygningerUnique.map((raw) => {
        const b = normaliseBygning(raw);
        b.bygningsnr = bygningsnrFraWFS.get(b.id) ?? null;
        return b;
      })
    : null;

  const enhederRaw = rawEnhederUnique ? rawEnhederUnique.map(normaliseEnhed) : null;

  // Batch-hent DAWA-adresser for alle enheder — giver etage, dør og fuld adresse
  let enheder = enhederRaw;
  if (enhederRaw && enhederRaw.length > 0) {
    const adresseIds = (rawEnhederUnique as RawBBREnhed[])
      .map((e) => e.adresseIdentificerer)
      .filter((id): id is string => typeof id === 'string' && UUID_RE.test(id));
    const dawaMap = await fetchDAWAEnhedAdresser(adresseIds);

    enheder = enhederRaw.map((e, idx) => {
      const adresseId = (rawEnhederUnique as RawBBREnhed[])[idx]?.adresseIdentificerer;
      const dawa = adresseId ? dawaMap.get(adresseId) : undefined;
      if (!dawa) return e;
      return {
        ...e,
        etage: dawa.etage ?? e.etage,
        doer: dawa.doer ?? e.doer,
        adressebetegnelse: dawa.adressebetegnelse,
      };
    });
  }

  // Map DAWA BFEnummer + matrikelinfo → BBREjendomsrelation shape
  const ejendomsrelationer: BBREjendomsrelation[] | null =
    bfeNummer != null
      ? [{ bfeNummer, ejendomsnummer: null, ejendomstype: null, ejerlavKode, matrikelnr }]
      : null;

  const bbrFejl = !DF_API_KEY
    ? 'Datafordeler API-nøgle ikke konfigureret.'
    : bbr === null
      ? 'BBR-data ikke tilgængeligt. Tjek at DATAFORDELER_API_KEY er sat i .env.local.'
      : null;

  return NextResponse.json(
    { dawaId: id, bbr, enheder, bygningPunkter, ejendomsrelationer, bbrFejl },
    {
      status: 200,
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
    }
  );
}
