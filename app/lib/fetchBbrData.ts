/**
 * Shared BBR data-fetching logic for Datafordeler BBR v2.
 *
 * Extracted from app/api/ejendom/[id]/route.ts so that both the API route
 * AND server-side page components can call it directly without an HTTP
 * round-trip. This is required on Vercel where a server component cannot
 * reliably fetch its own /api routes during SSR (no running server to call).
 *
 * @module app/lib/fetchBbrData
 */

import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';
import { BBR_WFS_ENDPOINT, BBR_GQL_ENDPOINT, DAWA_BASE_URL } from '@/app/lib/serviceEndpoints';
import { fetchDawa } from '@/app/lib/dawa';
import { darHentAdresserBatch } from '@/app/lib/dar';
import {
  tagKonstruktionTekst,
  tagMaterialeTekst,
  ydervaegMaterialeTekst,
  varmeInstallationTekst,
  opvarmningsmiddelTekst,
  supplerendeVarmeTekst,
  vandforsyningTekst,
  afloebsforholdTekst,
  bygAnvendelseTekst,
  bygStatusTekst,
  enhedAnvendelseTekst,
  boligtypeTekst,
  energiforsyningTekst,
} from '@/app/lib/bbrKoder';
import { logger } from '@/app/lib/logger';

// ─── Types ──────────────────────────────────────────────────────────────────

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
  /**
   * BIZZ-485 v2: Asbestholdigt materiale-flag fra BBR. Bruges til
   * risk-scoring på BBR-tab (rødt badge ved 'asbest').
   * NB: byg034Tagkonstruktion findes IKKE i BBR v2-schemaet (verificeret
   * 2026-04-19 — query-fejl kostede produktions-incident). Forbliver '–'.
   */
  byg036AsbestholdigtMateriale?: string;
  byg056Varmeinstallation?: string;
  byg057Opvarmningsmiddel?: string;
  byg058SupplerendeVarme?: string;
  byg030Vandforsyning?: string;
  byg031Afloebsforhold?: string;
  byg021BygningensAnvendelse?: string;
  /** Ejerforholdskode (byg066) — "10"=privatperson, "50"=andelsboligforening, "60"=almennyttigt */
  byg066Ejerforhold?: string;
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
  /** Supplerende varme (byg058), f.eks. "Brændeovn / pejs" */
  supplerendeVarme: string | null;
  /** Bevaringsværdighedsreference (byg071) — SAVE-registrering */
  bevaringsvaerdighed: string | null;
  status: string | null;
  bygningsnr: number | null;
  /** Seneste revisionsdato fra BBR (byg094Revisionsdato) — ISO-dato-streng */
  revisionsdato: string | null;
  /** Ejerforholdskode (byg066) — rå kode, f.eks. "50"=andelsboligforening */
  ejerforholdskode: string | null;
  /**
   * BIZZ-485: Rå materiale-koder bevares så UI kan lave risk-scoring uden
   * at skulle oversætte tekst tilbage til kode. Kan være null hvis BBR
   * ikke har registreret materialet.
   */
  tagkonstruktionKode: number | null;
  tagmaterialeKode: number | null;
  ydervaegKode: number | null;
  /**
   * BIZZ-485: Risk-flags udledt af materialekoderne.
   * - asbestTag: tagmateriale = 3 (fibercement/asbest)
   * - asbestYdervaeg: ydervaeg = 3 (fibercement/eternit asbest)
   * - traeYdervaeg: ydervaeg = 5 (træ) — lavere prioritet, kun info
   * - asbestEksplicit: byg036AsbestholdigtMateriale = '1' (BBR-bekræftet)
   */
  risks: {
    asbestTag: boolean;
    asbestYdervaeg: boolean;
    traeYdervaeg: boolean;
    asbestEksplicit: boolean;
  };
}

/** BIZZ-486: Raw BBR opgang (stairwell) from GraphQL */
interface RawBBROpgang {
  id_lokalId?: string;
  bygning?: string;
  opg020Elevator?: string;
  status?: string;
}

/** BIZZ-486: Raw BBR etage (floor) from GraphQL */
interface RawBBREtage {
  id_lokalId?: string;
  bygning?: string;
  eta006BygningensEtagebetegnelse?: string;
  eta020SamletArealAfEtage?: number;
  status?: string;
}

/** BIZZ-486: Normalised BBR opgang returned to client */
export interface LiveBBROpgang {
  id: string;
  bygningId: string | null;
  /** Elevator (opg020): "0"=ingen, "1"=ja */
  elevator: boolean | null;
  status: string | null;
}

/** BIZZ-486: Normalised BBR etage returned to client */
export interface LiveBBREtage {
  id: string;
  bygningId: string | null;
  /** Etagebetegnelse fra BBR (eta006), f.eks. "kl", "st", "1", "2" */
  etagebetegnelse: string | null;
  /** Samlet areal af etagen (eta020) i m² */
  samletAreal: number | null;
  status: string | null;
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
  /** Boligtype (enh023), f.eks. "Egentlig beboelseslejlighed" */
  boligtype: string | null;
  /** Energiforsyning (enh035), f.eks. "230 V el fra værk" */
  energiforsyning: string | null;
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
  /** Ejerforholdskode (byg066) — "50"=andelsboligforening, "60"=almen bolig */
  ejerforholdskode: string | null;
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
  /** BFE-nummer for ejerlejlighed (null hvis det ikke er en ejerlejlighed) */
  ejerlejlighedBfe: number | null;
  /** BFE-nummer for moderejendommen (null hvis det ikke er en ejerlejlighed) */
  moderBfe: number | null;
  /**
   * BIZZ-728: Adgangsadresse-UUID for hovedejendommen når vi er på en enhed
   * (adresse med etage/dør). Null når vi allerede er på adgangsadresse-niveau
   * eller ikke kan opløse parent. Bruges til "Gå til hovedejendom"-knap uden
   * at kræve Vurderingsportalen-match — virker derfor også for erhvervsenheder
   * og andre units hvor Vurderingsportalen ikke har opdeling.
   */
  parentAdgangsadresseId: string | null;
  /** BIZZ-486: Opgange (stairwells) per bygning */
  opgange: LiveBBROpgang[] | null;
  /** BIZZ-486: Etager (floors) per bygning */
  etager: LiveBBREtage[] | null;
  /**
   * BIZZ-484: Tekniske anlæg på adressen — solceller, varmepumper, oliefyr,
   * tanke etc. tek020Klassifikation mappes via bbrTekniskAnlaegKoder til
   * læsbar tekst på UI.
   */
  tekniskeAnlaeg: Array<{
    id_lokalId: string;
    tek020Klassifikation: string | null;
    status: string | null;
  }> | null;
  bbrFejl: string | null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

// ─── UUID helper ─────────────────────────────────────────────────────────────

/** UUID-mønster — bruges til at filtrere reference-ID'er fra tekst-felter */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── WFS helper (bygningspunkter til kort) ─────────────────────────────────

/**
 * Escapes a string value for use in OGC CQL filter expressions.
 * Replaces single quotes with two single quotes per the OGC standard.
 *
 * @param value - Raw string to escape
 * @returns Escaped string safe for embedding in CQL filter literals
 */
function escapeCqlString(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Henter BBR bygningspunkter (WGS84) fra Datafordeler WFS.
 * Bruger id_lokalId-filtrering — bygning-UUID'er hentes fra BBR_Enhed.bygning.
 * Returnerer null ved fejl eller manglende API-nøgle.
 *
 * @param bygningIds - Array af BBR Bygning id_lokalId UUID'er (fra BBR_Enhed.bygning)
 */
async function fetchBygningPunkter(bygningIds: string[]): Promise<BBRBygningPunkt[] | null> {
  // Read at call time — avoids Turbopack inlining module-level constants as empty strings at build time
  const DF_API_KEY = process.env.DATAFORDELER_API_KEY ?? '';
  if (!DF_API_KEY || bygningIds.length === 0) return null;

  // Byg CQL_FILTER med IN-udtryk for flere bygninger, eller enkelt eq for én
  const quoted = bygningIds.map((id) => `'${escapeCqlString(id)}'`).join(',');
  const cqlRaw =
    bygningIds.length === 1
      ? `id_lokalId='${escapeCqlString(bygningIds[0])}'`
      : `id_lokalId IN (${quoted})`;
  const cqlFilter = encodeURIComponent(cqlRaw);

  const url =
    `${BBR_WFS_ENDPOINT}?service=WFS&version=2.0.0&request=GetFeature` +
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
      logger.error(
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
          ejerforholdskode: p.byg066Ejerforhold != null ? String(p.byg066Ejerforhold) : null,
        };
      });
  } catch {
    return null;
  }
}

// ─── GraphQL helpers ────────────────────────────────────────────────────────

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  variables: Record<string, any>
): Promise<unknown[] | null> {
  // Read at call time — avoids Turbopack inlining module-level constants as empty strings at build time
  const DF_API_KEY = process.env.DATAFORDELER_API_KEY ?? '';
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
      logger.error(
        `[BBR GQL] HTTP ${res.status} url=${url.replace(/apiKey=[^&]+/, 'apiKey=REDACTED')}`
      );
      logger.error(`[BBR GQL] Headers:`, JSON.stringify(hdrs));
      logger.error(`[BBR GQL] Body: "${txt.slice(0, 600)}"`);
      return null;
    }

    const json = (await res.json()) as {
      data?: Record<string, { nodes?: unknown[] }>;
      errors?: unknown[];
    };

    if (json.errors?.length) {
      logger.error('[BBR GQL] GraphQL errors:', JSON.stringify(json.errors).slice(0, 600));
      return null;
    }

    // Return the nodes array from the first data key
    const firstKey = Object.keys(json.data ?? {})[0];
    const nodes = json.data?.[firstKey]?.nodes;
    return Array.isArray(nodes) ? nodes : null;
  } catch (err) {
    logger.error('[BBR GQL] Fetch error:', err);
    return null;
  }
}

/**
 * Sender en GraphQL-forespørgsel til Datafordeler BBR v2.
 * Wrapper om fetchDatafordelerGraphQL med BBR base URL.
 */
async function fetchBBRGraphQL(
  query: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  variables: Record<string, any>
): Promise<unknown[] | null> {
  return fetchDatafordelerGraphQL(BBR_GQL_ENDPOINT, query, variables);
}

// ─── BFE lookup ─────────────────────────────────────────────────────────────

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
  ejerlejlighedBfe: number | null;
  moderBfe: number | null;
  adgangsadresseId: string;
  ejerlavKode: number | null;
  matrikelnr: string | null;
}> {
  try {
    let ejerlavKode: number | undefined;
    let matrikelnr: string | undefined;
    let adgangsadresseId = dawaId;
    let harEtage = false;
    let adresseTekst: string | null = null;
    let etage: string | null = null;
    let doer: string | null = null;
    /** Kommunekode fra adgangsadresse — bruges til at afvise tværkommunale EL-falske positiver */
    let adgKommunekode: string | null = null;

    // Trin 1a: Forsøg direkte som adgangsadresse
    const adgRes = await fetchDawa(
      `${DAWA_BASE_URL}/adgangsadresser/${dawaId}`,
      { signal: AbortSignal.timeout(5000), next: { revalidate: 3600 } },
      { caller: 'fetchBbrData.adgangsadresse' }
    );

    if (adgRes.ok) {
      const adg = (await adgRes.json()) as {
        jordstykke?: { ejerlav?: { kode?: number }; matrikelnr?: string };
        adressebetegnelse?: string;
        kommune?: { kode?: string };
      };
      ejerlavKode = adg?.jordstykke?.ejerlav?.kode;
      matrikelnr = adg?.jordstykke?.matrikelnr;
      // Sæt adresseTekst selv for adgangsadresser — nødvendigt for at Vurderingsportalen-søgning
      // kører i Trin 3. Uden dette springes EL-detektionen over for ejerlejligheder navigeret
      // til via adgangsadresse-UUID (f.eks. fra autocomplete eller kortvisning).
      adresseTekst = adg?.adressebetegnelse ?? null;
      adgKommunekode = adg?.kommune?.kode ?? null;
    } else {
      // Trin 1b: ID er en adresse (med etage/dør) — hent adgangsadresse via /adresser/{id}
      const adrRes = await fetchDawa(
        `${DAWA_BASE_URL}/adresser/${dawaId}`,
        { signal: AbortSignal.timeout(5000), next: { revalidate: 3600 } },
        { caller: 'fetchBbrData.adresse' }
      );
      if (!adrRes.ok)
        return {
          bfeNummer: null,
          ejerlejlighedBfe: null,
          moderBfe: null,
          adgangsadresseId: dawaId,
          ejerlavKode: null,
          matrikelnr: null,
        };

      const adr = (await adrRes.json()) as {
        etage?: string;
        dør?: string;
        adgangsadresse?: {
          id?: string;
          jordstykke?: { ejerlav?: { kode?: number }; matrikelnr?: string };
          kommune?: { kode?: string };
        };
        adressebetegnelse?: string;
      };
      adgangsadresseId = adr?.adgangsadresse?.id ?? dawaId;
      ejerlavKode = adr?.adgangsadresse?.jordstykke?.ejerlav?.kode;
      matrikelnr = adr?.adgangsadresse?.jordstykke?.matrikelnr;
      harEtage = !!(adr?.etage || adr?.dør);
      adresseTekst = adr?.adressebetegnelse ?? null;
      etage = adr?.etage ?? null;
      doer = adr?.dør ?? null;
      // BIZZ: Sæt adgKommunekode også her — uden denne springer cross-kommune-
      // validering over når property kun har et adresse-id (med etage/dør) i
      // stedet for et adgangsadresse-id. Det førte til at Vurderingsportalen-
      // hits fra andre kommuner blev accepteret som ejerlejligheds-BFE
      // (f.eks. Søbyvej 11 i Hvidovre fik BFE 4050546 fra Skive).
      adgKommunekode = adr?.adgangsadresse?.kommune?.kode ?? null;
    }

    if (!ejerlavKode || !matrikelnr) {
      return {
        bfeNummer: null,
        ejerlejlighedBfe: null,
        moderBfe: null,
        adgangsadresseId,
        ejerlavKode: null,
        matrikelnr: null,
      };
    }

    // BIZZ-254: Trin 2 + 3 kører parallelt (uafhængige af hinanden)
    // Trin 2: Hent BFEnummer fra jordstykker-endpoint (= moderejendommens BFE)
    const jordBfePromise = fetchDawa(
      `${DAWA_BASE_URL}/jordstykker/${ejerlavKode}/${matrikelnr}`,
      { signal: AbortSignal.timeout(5000), next: { revalidate: 3600 } },
      { caller: 'fetchBbrData.jordstykker.moder' }
    )
      .then(async (jsRes) => {
        if (!jsRes.ok) return null;
        const js = (await jsRes.json()) as { bfenummer?: number };
        return js?.bfenummer ?? null;
      })
      .catch(() => null);

    // Trin 3: Find ejerlejlighedens BFE via Vurderingsportalen ES.
    // Kører ALTID når adresseTekst er tilgængeligt — ikke kun for adresser med etage/dør.
    // Nogle ejerlejligheder har ingen etage/dør-betegnelse (registreret som adgangsadresse)
    // og ville ellers fejlagtigt mangle EL-badge.
    // Validering: uden harEtage accepteres kun en kandidat der er FORSKELLIG fra jordBfe
    // — det udelukker normale enfamiliehuse hvor Vurderingsportalen returnerer grundstykke-BFE.
    let ejerlejlighedBfe: number | null = null;
    // BIZZ-254: Start ES fetch in parallel with jordstykke fetch (Trin 2)
    // jordBfe promise is awaited inside the loop when needed for validation
    const jordBfe = await jordBfePromise;
    if (adresseTekst) {
      try {
        const esUrl = 'https://api-fs.vurderingsportalen.dk/preliminaryproperties/_search';
        const addrParts = adresseTekst.split(',')[0]; // "Vejnavn Nr" uden etage
        const esQuery: Record<string, unknown> = {
          size: 20,
          query: { bool: { must: [{ match_phrase: { address: addrParts } }] } },
        };
        const esRes = await fetch(esUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
          body: JSON.stringify(esQuery),
          signal: AbortSignal.timeout(8000),
        });
        if (esRes.ok) {
          const esData = (await esRes.json()) as {
            hits?: { hits?: { _source: Record<string, unknown> }[] };
          };
          const hits = esData?.hits?.hits ?? [];
          // Match etage + dør.
          // Når harEtage=true (fuld adresse): match præcist på floor + door.
          // Når harEtage=false (adgangsadresse uden etage/dør info, fx fra autocomplete
          // eller kortvisning): acceptér ethvert hit der adskiller sig fra jordBfe —
          // dette detekterer ejerlejligheder i flerfamiliehuse selvom den specifikke
          // etage/dør ikke er kendt (vi har kun adressen, ikke lejligheden).
          for (const hit of hits) {
            const s = hit._source;
            if (!s.bfeNumbers) continue;
            const candidate = parseInt(String(s.bfeNumbers), 10);
            if (isNaN(candidate)) continue;
            if (harEtage) {
              // Præcis match på etage og dør
              const hitFloor = String(s.floor ?? '').toLowerCase();
              const hitDoor = String(s.door ?? '').toLowerCase();
              const matchFloor = etage ? hitFloor === etage.toLowerCase() : !hitFloor;
              const matchDoor = doer ? hitDoor === doer.toLowerCase() : !hitDoor;
              if (!matchFloor || !matchDoor) continue;
            } else {
              // Adgangsadresse: kun acceptér BFE der adskiller sig fra grundstykke-BFE
              // (undgår at markere enfamiliehuse som ejerlejlighed)
              if (jordBfe != null && candidate === jordBfe) continue;
              // Tværkommune-validering: afvis kandidat hvis den tilhører en anden kommune.
              // Vurderingsportalen ES søger på tværs af hele Danmark, så "Søbyvej 11" kan
              // matche i f.eks. Skive selvom vores adresse er i Hvidovre. Vi slår kandidatens
              // BFE op via DAWA jordstykker for at bekræfte kommunekoden stemmer.
              if (adgKommunekode) {
                try {
                  const verifyRes = await fetchDawa(
                    `${DAWA_BASE_URL}/jordstykker?bfenummer=${candidate}&per_side=1`,
                    { signal: AbortSignal.timeout(3000), next: { revalidate: 3600 } },
                    { caller: 'fetchBbrData.jordstykker.verify' }
                  );
                  if (verifyRes.ok) {
                    const verifyData = (await verifyRes.json()) as Array<{
                      kommune?: { kode?: string };
                    }>;
                    const candidateKommunekode = verifyData[0]?.kommune?.kode;
                    if (candidateKommunekode && candidateKommunekode !== adgKommunekode) continue;
                  }
                } catch {
                  /* validering fejlede — acceptér kandidaten for at undgå false negatives */
                }
              }
            }
            ejerlejlighedBfe = candidate;
            break;
          }
        }
      } catch {
        /* Vurderingsportalen er valgfri */
      }
    }

    // Bestem primær BFE: ejerlejlighed hvis fundet, ellers jordstykke
    const primaryBfe = ejerlejlighedBfe ?? jordBfe;

    return {
      bfeNummer: primaryBfe,
      ejerlejlighedBfe,
      moderBfe: ejerlejlighedBfe ? jordBfe : null, // Kun sæt moderBfe hvis det er en ejerlejlighed
      adgangsadresseId,
      ejerlavKode: ejerlavKode ?? null,
      matrikelnr: matrikelnr ?? null,
    };
  } catch {
    return {
      bfeNummer: null,
      ejerlejlighedBfe: null,
      moderBfe: null,
      adgangsadresseId: dawaId,
      ejerlavKode: null,
      matrikelnr: null,
    };
  }
}

// ─── Date helper ─────────────────────────────────────────────────────────────

/**
 * BIZZ-569 / BIZZ-575 v2: Lightweight BBR-area fetch by BFE-nummer.
 *
 * Bruges af /api/ejendomme-by-owner/enrich(-batch) til at berige property-
 * cards med bolig/erhverv m² uden at fetche den fulde BBR-payload (enheder,
 * opgange, materialer m.m.).
 *
 * BIZZ-575 v2 root cause: BBR-API returnerer DUPLIKATER af samme bygning
 * (identisk id_lokalId optræder N gange — fx 4× for Bibliotekvej 58).
 * Den oprindelige sum gav derfor 4× det rigtige tal (1.149 × 4 = 4.596).
 * Schema'en understøtter IKKE bfeNummer-filter på hverken BBR_Grund
 * eller BBR_Bygning (verificeret via probe), så filtrering må ske via
 * id_lokalId-deduplikering + status-filter (status=7 = nedrevet).
 *
 * @param bfe     - BFE-nummer (kun til logging — filtrering sker via dawaId)
 * @param dawaId  - DAWA adgangsadresse-UUID (husnummer i BBR_Bygning)
 * @returns { boligAreal, erhvervsAreal, samletBygningsareal } — null hvis BBR ikke svarer
 */
/**
 * BIZZ-629: Resolve et BFE-nummer til en adgangsadresse-UUID via DAWA
 * jordstykker. Bruges som fallback i fetchBbrAreasByBfe når klienten ikke
 * har sendt dawaId med, eller når dawaId'en er stale/ikke matcher
 * BBR_Bygning.husnummer.
 *
 * Strategy: DAWA /jordstykker?bfenummer=X returnerer matriklen for BFE'en.
 * Derfra kan vi slå adgangsadresser op på samme (ejerlavkode, matrikelnr)
 * og pick første match. Fungerer for både normale ejendomme og
 * ejerlejligheder (hovedmatrikel-adressen bruges).
 *
 * @param bfe - BFE-nummer
 * @returns adgangsadresse-UUID eller null hvis ikke findbart
 */
async function resolveBfeToAdgangsadresseId(bfe: number): Promise<string | null> {
  try {
    const jordRes = await fetchDawa(
      `${DAWA_BASE_URL}/jordstykker?bfenummer=${bfe}&per_side=1`,
      { signal: AbortSignal.timeout(5000), next: { revalidate: 86400 } },
      { caller: 'fetchBbrAreasByBfe.resolve-bfe' }
    );
    if (jordRes.ok) {
      const arr = (await jordRes.json()) as Array<{
        ejerlav?: { kode?: number };
        matrikelnr?: string;
      }>;
      const jord = arr[0];
      if (jord?.ejerlav?.kode && jord.matrikelnr) {
        const adgRes = await fetchDawa(
          `${DAWA_BASE_URL}/adgangsadresser?ejerlavkode=${jord.ejerlav.kode}&matrikelnr=${encodeURIComponent(jord.matrikelnr)}&per_side=1`,
          { signal: AbortSignal.timeout(5000), next: { revalidate: 86400 } },
          { caller: 'fetchBbrAreasByBfe.resolve-adgangsadresse' }
        );
        if (adgRes.ok) {
          const adgArr = (await adgRes.json()) as Array<{ id?: string }>;
          if (adgArr[0]?.id) return adgArr[0].id;
        }
      }
    }
    // BIZZ-629 v5: DAWA /jordstykker indekserer KUN jordstykke-BFE'er, ikke
    // ejerlejlighed- eller erhvervsejendom-BFE'er. For fx BFE 226629 (Arnold
    // Nielsens Boulevard 62B, erhvervsejendom) returnerer DAWA tom og vi
    // faldt igennem til null. Vurderingsportalen ES indekserer derimod ALLE
    // BFE'er (både jordstykker, ejerlejligheder og erhvervsejendomme) og
    // returnerer adgangsAdresseID direkte — brug det som sekundær fallback.
    return await lookupAdgangsadresseByBfeViaVurderingsportalen(bfe);
  } catch {
    return null;
  }
}

/**
 * BIZZ-629 v5 / BIZZ-596: Slå BFE op i Vurderingsportalen ES og resolve til
 * DAWA adresse-UUID — den fulde unit-adresse (med etage/dør for ejerlejligheder).
 *
 * OBS: Vurderingsportalens felter "adresseID" og "adgangsAdresseID" er IKKE
 * DAWA-UUID'er — de peger på interne IDs. Vi henter adresse-teksten fra
 * Vurderingsportalen og slår den op i DAWA /adresser for at få den rigtige
 * DAWA adresse-UUID. Den UUID fungerer som adresseIdentificerer i BBR_Enhed
 * (matcher lejligheden direkte for ejerlejligheder). BBR_Bygning-fallbacken
 * i fetchBbrAreasByBfe probe'r adresse → adgangsadresse via DAWA.
 *
 * @param bfe - BFE-nummer (ejerlejlighed, erhvervsejendom, eller SFE)
 * @returns DAWA adresse-UUID (med etage/dør for ejerlejligheder) eller null
 */
async function lookupAdgangsadresseByBfeViaVurderingsportalen(bfe: number): Promise<string | null> {
  try {
    const esRes = await fetch(
      'https://api-fs.vurderingsportalen.dk/preliminaryproperties/_search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: JSON.stringify({
          size: 5,
          query: { match_phrase: { bfeNumbers: String(bfe) } },
        }),
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!esRes.ok) return null;
    const data = (await esRes.json()) as {
      hits?: {
        hits?: Array<{
          _score?: number;
          _source: { address?: string; isParentProperty?: boolean };
        }>;
      };
    };
    const hits = data.hits?.hits ?? [];
    // Prioriter isParentProperty=true hits — disse sidder på moderejendommen.
    const sorted = [...hits].sort(
      (a, b) => (b._source?.isParentProperty ? 1 : 0) - (a._source?.isParentProperty ? 1 : 0)
    );
    for (const hit of sorted) {
      const address = hit._source?.address;
      if (!address) continue;
      const dawaRes = await fetchDawa(
        `${DAWA_BASE_URL}/adresser?q=${encodeURIComponent(address)}&per_side=1&struktur=mini`,
        { signal: AbortSignal.timeout(5000), next: { revalidate: 86400 } },
        { caller: 'lookupAdgangsadresseByBfeViaVurderingsportalen.dawa' }
      );
      if (!dawaRes.ok) continue;
      // BIZZ-596: Returnér den fulde adresse-UUID (id) — IKKE adgangsadresseid.
      // adresse-UUID indeholder etage/dør for ejerlejligheder og er det BBR_Enhed
      // kræver i adresseIdentificerer-filteret. BBR_Bygning-pathen probe'r
      // adresse → adgangsadresse når nødvendigt (se fetchBbrAreasByBfe).
      const adrArr = (await dawaRes.json()) as Array<{
        id?: string;
        adgangsadresseid?: string;
      }>;
      const adrId = adrArr[0]?.id ?? adrArr[0]?.adgangsadresseid;
      if (adrId) return adrId;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * BIZZ-629 v5: Slå matrikel-areal op for et BFE der ikke er et jordstykke-BFE
 * (fx ejerlejligheder og erhvervsejendomme). DAWA /jordstykker?bfenummer=X
 * returnerer tom for sådanne BFE'er. Vi må derfor først resolve til en
 * adgangsadresse, derfra hente jordstykke-referencen (ejerlavkode+matrikelnr)
 * og slå registreretareal op på selve jordstykket.
 *
 * @param bfe - BFE-nummer (ejerlejlighed eller erhvervsejendom)
 * @returns Matrikel-areal i m² eller null hvis ikke findbart
 */
export async function resolveMatrikelArealByBfe(bfe: number): Promise<number | null> {
  try {
    const resolvedId = await lookupAdgangsadresseByBfeViaVurderingsportalen(bfe);
    if (!resolvedId) return null;
    // BIZZ-596: lookup-helperen returnerer nu adresse-UUID (med etage/dør for
    // ejerlejligheder). Prøv først som adgangsadresse — hvis 404, prøv som
    // adresse og chain til dens adgangsadresseid.
    let ejerlavkode: number | undefined;
    let matrikelnr: string | undefined;

    const adgRes = await fetchDawa(
      `${DAWA_BASE_URL}/adgangsadresser/${resolvedId}`,
      { signal: AbortSignal.timeout(5000), next: { revalidate: 86400 } },
      { caller: 'resolveMatrikelArealByBfe.adgangsadresse' }
    );
    if (adgRes.ok) {
      const adg = (await adgRes.json()) as {
        ejerlav?: { kode?: number };
        matrikelnr?: string;
      };
      ejerlavkode = adg.ejerlav?.kode;
      matrikelnr = adg.matrikelnr;
    } else {
      // ID var en adresse-UUID — hent adgangsadresse via /adresser/{id}
      const adrRes = await fetchDawa(
        `${DAWA_BASE_URL}/adresser/${resolvedId}`,
        { signal: AbortSignal.timeout(5000), next: { revalidate: 86400 } },
        { caller: 'resolveMatrikelArealByBfe.adresse' }
      );
      if (!adrRes.ok) return null;
      const adr = (await adrRes.json()) as {
        adgangsadresse?: { ejerlav?: { kode?: number }; matrikelnr?: string };
      };
      ejerlavkode = adr.adgangsadresse?.ejerlav?.kode;
      matrikelnr = adr.adgangsadresse?.matrikelnr;
    }
    if (!ejerlavkode || !matrikelnr) return null;
    const jordRes = await fetchDawa(
      `${DAWA_BASE_URL}/jordstykker/${ejerlavkode}/${encodeURIComponent(matrikelnr)}`,
      { signal: AbortSignal.timeout(5000), next: { revalidate: 86400 } },
      { caller: 'resolveMatrikelArealByBfe.jordstykke' }
    );
    if (!jordRes.ok) return null;
    const jord = (await jordRes.json()) as { registreretareal?: number | null };
    return jord.registreretareal ?? null;
  } catch {
    return null;
  }
}

export async function fetchBbrAreasByBfe(
  bfe: number,
  dawaId?: string | null
): Promise<{
  boligAreal: number | null;
  erhvervsAreal: number | null;
  samletBygningsareal: number | null;
} | null> {
  const vt = nowDafDateTime();
  // BIZZ-629: Hvis dawaId mangler, prøv at resolve via BFE → DAWA
  // jordstykker → adgangsadresse på samme matrikel. Giver os en brugbar
  // UUID til BBR_Bygning-queryen. Uden denne fallback returnerede
  // fetchBbrAreasByBfe null så snart dawaId manglede — fx ved direkte
  // API-kald til /enrich?bfe=X uden dawaId-param.
  let effectiveDawaId: string | null = dawaId ?? null;
  if (!effectiveDawaId) {
    effectiveDawaId = await resolveBfeToAdgangsadresseId(bfe);
    if (!effectiveDawaId) return null;
  }

  // BIZZ-637: For ejerlejligheder er dawaId et adresse-UUID (med etage/dør),
  // og de korrekte areal-felter sidder i BBR_Enhed — ikke BBR_Bygning, der
  // ville returnere hele bygningens samlede areal. Prøv BBR_Enhed FØRST:
  // hvis der er enhed-match, bruger vi enh027/028 (bolig/erhverv pr. enhed)
  // plus enh026 som samlet. Kun når BBR_Enhed ikke matcher (normal ejendom
  // uden etage/dør) falder vi tilbage til BBR_Bygning-queryen.
  try {
    const enhedNodes = await fetchBBRGraphQL(
      `query($vt: DafDateTime!, $id: String!) {
        BBR_Enhed(first: 50, virkningstid: $vt, where: { adresseIdentificerer: { eq: $id } }) {
          nodes {
            id_lokalId
            enh026EnhedensSamledeAreal
            enh027ArealTilBeboelse
            enh028ArealTilErhverv
            status
          }
        }
      }`,
      { vt, id: effectiveDawaId }
    );
    if (Array.isArray(enhedNodes) && enhedNodes.length > 0) {
      // Dedupliker + filtrér nedrevne (status 7)
      const seen = new Set<string>();
      let bolig = 0;
      let erhverv = 0;
      let samlet = 0;
      for (const n of enhedNodes as Array<{
        id_lokalId?: string;
        enh026EnhedensSamledeAreal?: number | null;
        enh027ArealTilBeboelse?: number | null;
        enh028ArealTilErhverv?: number | null;
        status?: string | number | null;
      }>) {
        if (!n.id_lokalId || seen.has(n.id_lokalId)) continue;
        seen.add(n.id_lokalId);
        if (n.status != null && String(n.status) === '7') continue;
        if (n.enh027ArealTilBeboelse != null) bolig += Number(n.enh027ArealTilBeboelse);
        if (n.enh028ArealTilErhverv != null) erhverv += Number(n.enh028ArealTilErhverv);
        if (n.enh026EnhedensSamledeAreal != null) samlet += Number(n.enh026EnhedensSamledeAreal);
      }
      // BIZZ-629: Kun returnér BBR_Enhed-resultatet hvis vi faktisk fik et
      // positivt areal — ellers fald igennem til BBR_Bygning. Tidligere
      // satte vi any=true så snart et felt var != null (selv hvis 0), hvilket
      // betød at kommercielle ejendomme med BBR_Enhed-noder uden beboelse
      // returnerede { null, null, null } i stedet for de korrekte
      // bygnings-areal-tal. Regression ift. BIZZ-637.
      if (bolig > 0 || erhverv > 0 || samlet > 0) {
        return {
          boligAreal: bolig > 0 ? bolig : null,
          erhvervsAreal: erhverv > 0 ? erhverv : null,
          samletBygningsareal: samlet > 0 ? samlet : null,
        };
      }
    }
  } catch {
    // Ignorer BBR_Enhed-fejl — fald igennem til Bygning-opslaget nedenfor.
  }

  // BIZZ-731: For ejerlejligheder gav den første BBR_Enhed-query med
  // adresseIdentificerer = adresse-UUID (med etage/dør) ofte 0 matches
  // fordi BBR_Enhed.adresseIdentificerer i praksis lagrer adgangsadresse-
  // UUID'en for nogle registreringer. I stedet for at falde direkte ned til
  // BBR_Bygning (hvor byg039 ofte er null for bygninger med ejerlejligheder),
  // prøv at resolve adresse → adgangsadresse og hente ALLE enheder i
  // bygningen, for derefter at matche på ejerlejlighedens adresse-UUID.
  try {
    const { fetchDawa: fd } = await import('@/app/lib/dawa');
    // Probe current effectiveDawaId: er det en adresse (med etage/dør) eller adgangsadresse?
    const probeRes = await fd(
      `${DAWA_BASE_URL}/adresser/${effectiveDawaId}?struktur=mini`,
      { signal: AbortSignal.timeout(5000), next: { revalidate: 86400 } },
      { caller: 'fetchBbrAreasByBfe.probe-unit' }
    );
    if (probeRes.ok) {
      const adresse = (await probeRes.json()) as {
        adgangsadresseid?: string | null;
        id?: string;
      };
      const adgangsId = adresse.adgangsadresseid;
      if (adgangsId && adgangsId !== effectiveDawaId) {
        // Vi er på en specifik enhed. Hent alle enheder i bygningen (via
        // adgangsadresse) og filtrér til den der matcher vores adresse-UUID.
        const buildingEnheder = await fetchBBRGraphQL(
          `query($vt: DafDateTime!, $id: String!) {
            BBR_Enhed(first: 200, virkningstid: $vt, where: { adresseIdentificerer: { eq: $id } }) {
              nodes {
                id_lokalId
                adresseIdentificerer
                enh026EnhedensSamledeAreal
                enh027ArealTilBeboelse
                enh028ArealTilErhverv
                status
              }
            }
          }`,
          { vt, id: adgangsId }
        );
        if (Array.isArray(buildingEnheder) && buildingEnheder.length > 0) {
          // Find enhed der matcher vores oprindelige adresse-UUID (effectiveDawaId)
          const match = (
            buildingEnheder as Array<{
              id_lokalId?: string;
              adresseIdentificerer?: string;
              enh026EnhedensSamledeAreal?: number | null;
              enh027ArealTilBeboelse?: number | null;
              enh028ArealTilErhverv?: number | null;
              status?: string | number | null;
            }>
          ).find(
            (n) => n.adresseIdentificerer === effectiveDawaId && String(n.status ?? '') !== '7'
          );
          if (match) {
            const bolig = Number(match.enh027ArealTilBeboelse ?? 0);
            const erhverv = Number(match.enh028ArealTilErhverv ?? 0);
            const samlet = Number(match.enh026EnhedensSamledeAreal ?? 0);
            if (bolig > 0 || erhverv > 0 || samlet > 0) {
              return {
                boligAreal: bolig > 0 ? bolig : null,
                erhvervsAreal: erhverv > 0 ? erhverv : null,
                samletBygningsareal: samlet > 0 ? samlet : null,
              };
            }
          }
        }
      }
    }
  } catch {
    // Ignorer — fald igennem til Bygning-opslaget nedenfor.
  }

  const bbrQuery = `query($vt: DafDateTime!, $id: String!) {
      BBR_Bygning(first: 100, virkningstid: $vt, where: { husnummer: { eq: $id } }) {
        nodes {
          id_lokalId
          byg038SamletBygningsareal
          byg039BygningensSamledeBoligAreal
          byg040BygningensSamledeErhvervsAreal
          status
        }
      }
    }`;

  let nodes = await fetchBBRGraphQL(bbrQuery, { vt, id: effectiveDawaId });

  // BIZZ-629: For ejerlejligheder peger dawaId på adresse-UUID'en (med
  // etage/dør) — ikke adgangsadresse-UUID'en BBR_Bygning.husnummer kræver.
  // BIZZ-576's UUID-skift brød derfor Bolig/Erhverv-mapping på kortene.
  // Hvis første opslag intet gav, prøv at resolve adresse → adgangsadresse
  // via DAWA og gentag BBR-queryen mod den rigtige UUID.
  if (!Array.isArray(nodes) || nodes.length === 0) {
    try {
      const { fetchDawa } = await import('@/app/lib/dawa');
      const probeRes = await fetchDawa(
        `https://api.dataforsyningen.dk/adresser/${effectiveDawaId}?struktur=mini`,
        { signal: AbortSignal.timeout(5000), next: { revalidate: 86400 } },
        { caller: 'fetchBbrAreasByBfe.adresse-probe' }
      );
      if (probeRes.ok) {
        const adresse = (await probeRes.json()) as { adgangsadresseid?: string | null };
        const adgangsId = adresse.adgangsadresseid;
        if (adgangsId && adgangsId !== effectiveDawaId) {
          nodes = await fetchBBRGraphQL(bbrQuery, { vt, id: adgangsId });
        }
      }
    } catch {
      // Ignorer probe-fejl — prøver ekstra BFE-baseret fallback nedenfor.
    }
  }

  // BIZZ-629: Hvis stadig tom — prøv at resolve BFE → adgangsadresse via
  // DAWA jordstykker (BFE matcher direkte i jordstykke-indekset). Flere
  // kommercielle BFE'er havde stale/forkerte dawaId i ejf_ejerskab og kom
  // derfor igennem som null-areal før denne fallback.
  if ((!Array.isArray(nodes) || nodes.length === 0) && bfe) {
    const resolved = await resolveBfeToAdgangsadresseId(bfe);
    if (resolved && resolved !== effectiveDawaId) {
      nodes = await fetchBBRGraphQL(bbrQuery, { vt, id: resolved });
    }
  }

  // BIZZ-691: Sidste fallback — BBR_Grund direkte på BFE-nummer.
  // VP og DAWA jordstykker dækker ikke alle BFE-typer (erhverv, ejerlejlighed).
  // BBR_Grund.bestemtFastEjendomBFENr matcher alle BFE-typer og giver os
  // bygnings-UUID'er → BBR_Bygning areal-opslag.
  if ((!Array.isArray(nodes) || nodes.length === 0) && bfe) {
    try {
      const grundNodes = await fetchBBRGraphQL(
        `query($vt: DafDateTime!, $bfe: Int!) {
          BBR_Grund(first: 10, virkningstid: $vt, where: { bestemtFastEjendomBFENr: { eq: $bfe } }) {
            nodes {
              bygningPaaGrund { bygning { nodes { id_lokalId } } }
            }
          }
        }`,
        { vt, bfe }
      );
      if (Array.isArray(grundNodes) && grundNodes.length > 0) {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const bygIds: string[] = grundNodes.flatMap((g: any) =>
          (g.bygningPaaGrund?.bygning?.nodes ?? []).map((b: any) => b.id_lokalId).filter(Boolean)
        );
        /* eslint-enable @typescript-eslint/no-explicit-any */
        if (bygIds.length > 0) {
          const bygQuery = `query($vt: DafDateTime!, $ids: [String!]!) {
            BBR_Bygning(first: 100, virkningstid: $vt, where: { id_lokalId: { in: $ids } }) {
              nodes {
                id_lokalId
                byg038SamletBygningsareal
                byg039BygningensSamledeBoligAreal
                byg040BygningensSamledeErhvervsAreal
                status
              }
            }
          }`;
          nodes = await fetchBBRGraphQL(bygQuery, { vt, ids: bygIds });
        }
      }
    } catch {
      // Ignorer BBR_Grund fallback-fejl
    }
  }

  if (!Array.isArray(nodes) || nodes.length === 0) {
    logger.warn(
      `[fetchBbrAreasByBfe] BBR_Bygning tom for BFE ${bfe} (dawaId=${effectiveDawaId?.slice(0, 8)}…)`
    );
    return null;
  }

  // BIZZ-575 v2: Dedupliker på id_lokalId. BBR returnerer ofte samme bygning
  // flere gange (formentlig pga. flere virkningsperioder, ejer-relationer
  // eller adresse-relationer). Uden dedup summerer vi kunstigt × N.
  const seen = new Set<string>();
  const unique: RawBBRBygning[] = [];
  for (const raw of nodes as RawBBRBygning[]) {
    const id = raw.id_lokalId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(raw);
  }

  let bolig = 0;
  let erhverv = 0;
  let samlet = 0;
  let any = false;
  for (const n of unique) {
    // BIZZ-575: Status "7" = nedrevet/slettet — skip så aflyste bygninger
    // ikke pumper arealet kunstigt op.
    if (n.status != null && String(n.status) === '7') continue;
    if (n.byg039BygningensSamledeBoligAreal != null) {
      bolig += Number(n.byg039BygningensSamledeBoligAreal);
      any = true;
    }
    if (n.byg040BygningensSamledeErhvervsAreal != null) {
      erhverv += Number(n.byg040BygningensSamledeErhvervsAreal);
      any = true;
    }
    if (n.byg038SamletBygningsareal != null) {
      samlet += Number(n.byg038SamletBygningsareal);
      any = true;
    }
  }
  if (!any) return null;
  return {
    boligAreal: bolig > 0 ? bolig : null,
    erhvervsAreal: erhverv > 0 ? erhverv : null,
    samletBygningsareal: samlet > 0 ? samlet : null,
  };
}

/**
 * BIZZ-484: Hentet liste af tekniske anlæg (solceller, varmepumper, oliefyr,
 * etc.) for en adgangsadresse. Returnerer rå BBR_TekniskAnlaeg-noder med
 * id_lokalId, tek020Klassifikation, status. Klassifikationskode mappes
 * til læsbar tekst via bbrTekniskAnlaegKoder.ts på UI-siden.
 *
 * @param dawaId - DAWA adgangsadresse-UUID (husnummer-feltet)
 * @returns Array af tekniske anlæg, eller null ved fejl
 */
export async function fetchBbrTekniskAnlaegByDawaId(dawaId: string): Promise<Array<{
  id_lokalId: string;
  tek020Klassifikation: string | null;
  status: string | null;
}> | null> {
  if (!dawaId) return null;
  const vt = nowDafDateTime();
  const nodes = await fetchBBRGraphQL(
    `query($vt: DafDateTime!, $id: String!) {
      BBR_TekniskAnlaeg(first: 100, virkningstid: $vt, where: { husnummer: { eq: $id } }) {
        nodes {
          id_lokalId
          tek020Klassifikation
          status
        }
      }
    }`,
    { vt, id: dawaId }
  );
  if (!Array.isArray(nodes)) return null;
  // Dedupliker på id_lokalId (samme issue som BBR_Bygning — virkningsperioder)
  const seen = new Set<string>();
  const unique: Array<{
    id_lokalId: string;
    tek020Klassifikation: string | null;
    status: string | null;
  }> = [];
  for (const raw of nodes as Array<{
    id_lokalId?: string;
    tek020Klassifikation?: string;
    status?: string;
  }>) {
    if (!raw.id_lokalId || seen.has(raw.id_lokalId)) continue;
    // Skip status=7 (nedrevet/slettet)
    if (raw.status != null && String(raw.status) === '7') continue;
    seen.add(raw.id_lokalId);
    unique.push({
      id_lokalId: raw.id_lokalId,
      tek020Klassifikation: raw.tek020Klassifikation ?? null,
      status: raw.status ?? null,
    });
  }
  return unique;
}

/**
 * @deprecated BIZZ-575 — Bruger fetchBbrAreasByBfe i stedet for at få
 * korrekt BFE-isolation. Beholdt midlertidigt for backwards-compat hvis
 * andre call-sites refererer den.
 */
export async function fetchBbrAreasByDawaId(dawaId: string): Promise<{
  boligAreal: number | null;
  erhvervsAreal: number | null;
  samletBygningsareal: number | null;
} | null> {
  if (!dawaId) return null;
  const vt = nowDafDateTime();
  const query = `
    query($vt: DafDateTime!, $id: String!) {
      BBR_Bygning(first: 100, virkningstid: $vt, where: { husnummer: { eq: $id } }) {
        nodes {
          byg038SamletBygningsareal
          byg039BygningensSamledeBoligAreal
          byg040BygningensSamledeErhvervsAreal
          status
        }
      }
    }
  `;
  const nodes = await fetchBBRGraphQL(query, { vt, id: dawaId });
  if (!Array.isArray(nodes) || nodes.length === 0) return null;
  let bolig = 0;
  let erhverv = 0;
  let samlet = 0;
  let any = false;
  for (const n of nodes as RawBBRBygning[]) {
    if (n.status != null && String(n.status) === '7') continue;
    if (n.byg039BygningensSamledeBoligAreal != null) {
      bolig += Number(n.byg039BygningensSamledeBoligAreal);
      any = true;
    }
    if (n.byg040BygningensSamledeErhvervsAreal != null) {
      erhverv += Number(n.byg040BygningensSamledeErhvervsAreal);
      any = true;
    }
    if (n.byg038SamletBygningsareal != null) {
      samlet += Number(n.byg038SamletBygningsareal);
      any = true;
    }
  }
  if (!any) return null;
  return {
    boligAreal: bolig > 0 ? bolig : null,
    erhvervsAreal: erhverv > 0 ? erhverv : null,
    samletBygningsareal: samlet > 0 ? samlet : null,
  };
}

/**
 * BIZZ-724: Resolve enhed-specific BFE + areal for a single unit adresse-UUID.
 * Used by /api/ejerlejligheder to enrich the lejligheds-liste with real BFE
 * numbers and m² for each unit. Unlike fetchBbrAreasByDawaId (which sums at
 * the bygning level), this targets BBR_Enhed — the unit-level source.
 *
 * @param dawaId - Adresse-UUID med etage/dør (specific unit)
 * @returns {bfe, areal} or null if no unit match
 */
export async function resolveEnhedByDawaId(dawaId: string): Promise<{
  bfe: number | null;
  areal: number | null;
} | null> {
  if (!dawaId) return null;
  const vt = nowDafDateTime();

  type EnhedNode = {
    id_lokalId?: string;
    adresseIdentificerer?: string;
    enh026EnhedensSamledeAreal?: number | null;
    enh027ArealTilBeboelse?: number | null;
    enh028ArealTilErhverv?: number | null;
    status?: string | number | null;
  };

  const pickAreal = (n: EnhedNode): number | null => {
    const bolig = Number(n.enh027ArealTilBeboelse ?? 0);
    const erhverv = Number(n.enh028ArealTilErhverv ?? 0);
    const samlet = Number(n.enh026EnhedensSamledeAreal ?? 0);
    return bolig > 0 ? bolig : erhverv > 0 ? erhverv : samlet > 0 ? samlet : null;
  };

  // Step 1: Try direct BBR_Enhed match by adresseIdentificerer = dawaId
  let matchedAreal: number | null = null;
  try {
    const directNodes = await fetchBBRGraphQL(
      `query($vt: DafDateTime!, $id: String!) {
        BBR_Enhed(first: 20, virkningstid: $vt, where: { adresseIdentificerer: { eq: $id } }) {
          nodes {
            id_lokalId
            enh026EnhedensSamledeAreal
            enh027ArealTilBeboelse
            enh028ArealTilErhverv
            status
          }
        }
      }`,
      { vt, id: dawaId }
    );
    const directList = Array.isArray(directNodes) ? (directNodes as EnhedNode[]) : [];
    const directMatch = directList.find((n) => String(n.status ?? '') !== '7');
    if (directMatch) matchedAreal = pickAreal(directMatch);
  } catch {
    /* fall through */
  }

  // Step 2: If no direct match, probe adgangsadresse and filter by adresseIdentificerer
  if (matchedAreal == null) {
    try {
      const { fetchDawa: fd } = await import('@/app/lib/dawa');
      const probeRes = await fd(
        `${DAWA_BASE_URL}/adresser/${dawaId}?struktur=mini`,
        { signal: AbortSignal.timeout(5000), next: { revalidate: 86400 } },
        { caller: 'resolveEnhedByDawaId.probe' }
      );
      if (probeRes.ok) {
        const adresse = (await probeRes.json()) as { adgangsadresseid?: string | null };
        const adgangsId = adresse.adgangsadresseid;
        if (adgangsId && adgangsId !== dawaId) {
          const buildingNodes = await fetchBBRGraphQL(
            `query($vt: DafDateTime!, $id: String!) {
              BBR_Enhed(first: 200, virkningstid: $vt, where: { adresseIdentificerer: { eq: $id } }) {
                nodes {
                  id_lokalId
                  adresseIdentificerer
                  enh026EnhedensSamledeAreal
                  enh027ArealTilBeboelse
                  enh028ArealTilErhverv
                  status
                }
              }
            }`,
            { vt, id: adgangsId }
          );
          const list = Array.isArray(buildingNodes) ? (buildingNodes as EnhedNode[]) : [];
          const match = list.find(
            (n) => n.adresseIdentificerer === dawaId && String(n.status ?? '') !== '7'
          );
          if (match) matchedAreal = pickAreal(match);
        }
      }
    } catch {
      /* fall through */
    }
  }

  // Step 3: Resolve BFE via Vurderingsportalen ES — their index maps
  // (vejnavn, husnr, etage, dør) → specific ejerlejligheds-BFE.
  // Reuse the existing DAWA-resolve pattern: probe for adresse-betegnelse
  // then match the VP row that has a bfeNumber we can parse.
  let matchedBfe: number | null = null;
  try {
    const { fetchDawa: fd } = await import('@/app/lib/dawa');
    const adrRes = await fd(
      `${DAWA_BASE_URL}/adresser/${dawaId}?struktur=mini`,
      { signal: AbortSignal.timeout(3000), next: { revalidate: 86400 } },
      { caller: 'resolveEnhedByDawaId.vp-prep' }
    );
    if (adrRes.ok) {
      const adr = (await adrRes.json()) as {
        betegnelse?: string;
        adressebetegnelse?: string;
        etage?: string;
        dør?: string;
      };
      const betegnelse = (adr.betegnelse ?? adr.adressebetegnelse ?? '').split(',')[0].trim();
      if (betegnelse) {
        const esRes = await fetch(
          'https://api-fs.vurderingsportalen.dk/preliminaryproperties/_search',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
            body: JSON.stringify({
              size: 20,
              query: { bool: { must: [{ match_phrase: { address: betegnelse } }] } },
            }),
            signal: AbortSignal.timeout(5000),
          }
        );
        if (esRes.ok) {
          const esData = (await esRes.json()) as {
            hits?: {
              hits?: Array<{ _source: { bfeNumbers?: unknown; floor?: string; door?: string } }>;
            };
          };
          const targetFloor = (adr.etage ?? '').toLowerCase();
          const targetDoor = (adr.dør ?? '').toLowerCase();
          for (const hit of esData.hits?.hits ?? []) {
            const s = hit._source;
            if (!s.bfeNumbers) continue;
            const hitFloor = String(s.floor ?? '').toLowerCase();
            const hitDoor = String(s.door ?? '').toLowerCase();
            if (hitFloor !== targetFloor) continue;
            if (targetDoor && hitDoor !== targetDoor) continue;
            const candidate = parseInt(String(s.bfeNumbers), 10);
            if (!isNaN(candidate)) {
              matchedBfe = candidate;
              break;
            }
          }
        }
      }
    }
  } catch {
    /* VP is optional — non-fatal */
  }

  if (matchedBfe == null && matchedAreal == null) return null;
  return { bfe: matchedBfe, areal: matchedAreal };
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

  // BIZZ-485 (reverted): tagkonstruktion fjernet fra query — sættes til null.
  const tagkonstruktionKode = null;
  const tagmaterialeKode = parseCode(raw.byg033Tagdaekningsmateriale) ?? null;
  const ydervaegKode = parseCode(raw.byg032YdervaeggensMateriale) ?? null;

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
    // BIZZ-485: Tagkonstruktion hentes nu fra byg034 i stedet for hårdkodet '–'
    tagkonstruktion: tagKonstruktionTekst(tagkonstruktionKode),
    tagmateriale: tagMaterialeTekst(tagmaterialeKode),
    ydervaeg: ydervaegMaterialeTekst(ydervaegKode),
    varmeinstallation: varmeInstallationTekst(parseCode(raw.byg056Varmeinstallation)),
    opvarmningsform: opvarmningsmiddelTekst(parseCode(raw.byg057Opvarmningsmiddel)),
    vandforsyning: vandforsyningTekst(parseCode(raw.byg030Vandforsyning)),
    afloeb: afloebsforholdTekst(parseCode(raw.byg031Afloebsforhold)),
    anvendelse: bygAnvendelseTekst(parseCode(raw.byg021BygningensAnvendelse)),
    anvendelseskode: parseCode(raw.byg021BygningensAnvendelse) ?? null,
    energimaerke: null,
    fredning: raw.byg070Fredning ?? null,
    supplerendeVarme: raw.byg058SupplerendeVarme
      ? supplerendeVarmeTekst(parseInt(raw.byg058SupplerendeVarme, 10))
      : null,
    bevaringsvaerdighed: raw.byg071BevaringsvaerdighedReference ?? null,
    status: raw.status != null ? bygStatusTekst(parseInt(raw.status, 10)) : null,
    bygningsnr: null, // udfyldes fra WFS bygningPunkter efter fetch
    revisionsdato: raw.byg094Revisionsdato ?? null,
    ejerforholdskode: raw.byg066Ejerforhold ?? null,
    // BIZZ-485: Rå materialekoder + udledte risk-flags til UI-badges.
    // Asbest-kode 3 for både tagmateriale og ydervæg flagger sundhedsrisiko
    // (asbestforbud siden 1986, men stadig tilladt i eksisterende byggeri).
    tagkonstruktionKode,
    tagmaterialeKode,
    ydervaegKode,
    risks: {
      asbestTag: tagmaterialeKode === 3,
      asbestYdervaeg: ydervaegKode === 3,
      traeYdervaeg: ydervaegKode === 5,
      // BIZZ-485 v2: BBR's eksplicitte asbest-flag (byg036). Værdien '1' =
      // bekræftet asbestholdigt materiale (sundhedsrisiko).
      asbestEksplicit: raw.byg036AsbestholdigtMateriale === '1',
    },
  };
}

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
    boligtype: raw.enh023Boligtype ? boligtypeTekst(raw.enh023Boligtype) : null,
    energiforsyning: raw.enh035Energiforsyning
      ? energiforsyningTekst(parseCode(raw.enh035Energiforsyning))
      : null,
    status: raw.status ?? null,
    energimaerke: null,
    varmeinstallation: varmeInstallationTekst(parseCode(raw.enh051Varmeinstallation)),
  };
}

// ─── BIZZ-486: Opgang/Etage normalisation ──────────────────────────────────

/**
 * Normalises raw BBR opgang. Elevator kode: "1"=ja, "0"=ingen, andet=ukendt.
 */
function normaliseOpgang(raw: RawBBROpgang): LiveBBROpgang {
  return {
    id: raw.id_lokalId ?? '',
    bygningId: raw.bygning ?? null,
    elevator: raw.opg020Elevator === '1' ? true : raw.opg020Elevator === '0' ? false : null,
    status: raw.status ?? null,
  };
}

/**
 * Normalises raw BBR etage.
 */
function normaliseEtage(raw: RawBBREtage): LiveBBREtage {
  return {
    id: raw.id_lokalId ?? '',
    bygningId: raw.bygning ?? null,
    etagebetegnelse: raw.eta006BygningensEtagebetegnelse ?? null,
    samletAreal: raw.eta020SamletArealAfEtage ?? null,
    status: raw.status ?? null,
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
        byg036AsbestholdigtMateriale
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

/**
 * Fallback-query der slår en bygning op via id_lokalId.
 * Bruges når BYGNING_QUERY (husnummer-match) returnerer 0 resultater men
 * ENHED_QUERY har enheder med bygnings-UUIDs (fx ejerlejligheder i komplekser
 * med adgang registreret under et andet husnummer end lejlighedens adresse).
 */
const BYGNING_BY_ID_QUERY = `
  query($vt: DafDateTime!, $id: String!) {
    BBR_Bygning(first: 100, virkningstid: $vt, where: { id_lokalId: { eq: $id } }) {
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
        byg036AsbestholdigtMateriale
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
 * BIZZ-360: Query der henter alle BBR_Enhed for en given bygning UUID.
 * Bruges til at finde enheder (ejerlejligheder) på en hovedejendom, hvor
 * enhederne har individuelle adresse-UUIDs og ikke kan slås op via
 * adresseIdentificerer på adgangsadressen.
 *
 * @param bygningId - BBR Bygning id_lokalId UUID
 */
const ENHED_BY_BYGNING_QUERY = `
  query($vt: DafDateTime!, $id: String!) {
    BBR_Enhed(first: 200, virkningstid: $vt, where: { bygning: { eq: $id } }) {
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

/** BIZZ-486: Hent opgange for en bygning (schema verificeret 2026-04-19 probe) */
const OPGANG_BY_BYGNING_QUERY = `
  query($vt: DafDateTime!, $id: String!) {
    BBR_Opgang(first: 50, virkningstid: $vt, where: { bygning: { eq: $id } }) {
      nodes {
        id_lokalId
        bygning
        opg020Elevator
        status
      }
    }
  }
`;

/** BIZZ-486: Hent etager for en bygning (schema verificeret 2026-04-19 probe) */
const ETAGE_BY_BYGNING_QUERY = `
  query($vt: DafDateTime!, $id: String!) {
    BBR_Etage(first: 50, virkningstid: $vt, where: { bygning: { eq: $id } }) {
      nodes {
        id_lokalId
        bygning
        eta006BygningensEtagebetegnelse
        eta020SamletArealAfEtage
        status
      }
    }
  }
`;

/**
 * Batch-henter adresse-data (etage, dør, adressebetegnelse) for en liste
 * af adresse-UUIDs. Bruges til at berige BBR-enheder (ejerlejligheder).
 *
 * BIZZ-507: Primært via Datafordeler DAR_Adresse med `in:[…]` filter for
 * at batch'e hele bygninger i ét kald. Falder tilbage til DAWA for
 * manglende UUIDs (der sker f.eks. når nye adresser ikke er i DAR endnu,
 * eller når DATAFORDELER_API_KEY ikke er sat lokalt).
 *
 * @param ids - Array af adresse-UUIDs (fra BBR_Enhed.adresseIdentificerer)
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

  // ── Primær: DAR_Adresse batch ───────────────────────────────────────────
  try {
    const darMap = await darHentAdresserBatch(uuids);
    for (const [id, unit] of darMap) {
      result.set(id, unit);
    }
  } catch {
    // darHentAdresserBatch never throws, but guard anyway
  }

  // ── Fallback: DAWA for UUIDs DAR didn't know about ──────────────────────
  const missing = uuids.filter((id) => !result.has(id));
  if (missing.length === 0) return result;

  try {
    const params = missing.map((id) => `id=${encodeURIComponent(id)}`).join('&');
    const res = await fetchDawa(
      `${DAWA_BASE_URL}/adresser?${params}&struktur=mini`,
      { signal: AbortSignal.timeout(8000), next: { revalidate: 3600 } },
      { caller: 'fetchBbrData.adresser.batch.fallback' }
    );
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

// ─── Orchestration ───────────────────────────────────────────────────────────

/**
 * Henter og aggregerer BBR-data for en given DAWA adgangsadresse UUID.
 *
 * Kan kaldes direkte fra server components uden HTTP round-trip — modsat
 * /api/ejendom/[id] som kræver en kørende server at kalde.
 *
 * @param dawaId - DAWA adgangsadresse UUID (eller adresse-UUID med etage/dør)
 * @returns Aggregeret BBR-response (identisk med /api/ejendom/[id] uden dawaId-feltet)
 */
export async function fetchBbrForAddress(
  dawaId: string
): Promise<Omit<EjendomApiResponse, 'dawaId'>> {
  const vt = nowDafDateTime();

  // Resolve adgangsadresse-UUID og BFEnummer.
  // Nødvendigt fordi DAWA-ID kan være enten en adresse- eller adgangsadresse-UUID.
  // BBR_Bygning.husnummer kræver adgangsadresse-UUID; BBR_Enhed.adresseIdentificerer
  // accepterer begge typer, så vi bruger original id for enheder.
  const { bfeNummer, ejerlejlighedBfe, moderBfe, adgangsadresseId, ejerlavKode, matrikelnr } =
    await fetchBFENummer(dawaId);

  // Hent bygninger og enheder parallelt med korrekte UUIDs.
  const [rawBygninger, rawEnheder] = await Promise.all([
    fetchBBRGraphQL(BYGNING_QUERY, { vt, id: adgangsadresseId }),
    fetchBBRGraphQL(ENHED_QUERY, { vt, id: dawaId }),
  ]);

  // Udtræk unikke bygning-UUID'er fra enheder (primær kilde)
  let fraEnheder: string[] = rawEnheder
    ? (rawEnheder as RawBBREnhed[])
        .map((e) => e.bygning)
        .filter((b): b is string => typeof b === 'string' && b.length > 0)
    : [];

  // ── Hovedejendom fallback ────────────────────────────────────────────────
  // For hovedejendomme (adgangsadresse uden etage/dør, med ejerlejligheder) returnerer
  // hverken BYGNING_QUERY eller ENHED_QUERY resultater, fordi bygningens husnummer
  // er registreret under en anden adgangsadresse (f.eks. Plads 16 vs 18).
  // Løsning: find en lejligheds-adresse via DAWA BFE-opslag og brug den til at hente
  // enheder → bygnings-UUID.
  let effectiveRawEnheder = rawEnheder;
  if (
    (!rawBygninger || rawBygninger.length === 0) &&
    (!rawEnheder || rawEnheder.length === 0) &&
    ejerlejlighedBfe
  ) {
    try {
      // Strategi: find BBR_Grund via adgangsadresser på matriklen → grund UUID → BBR_Bygning
      let grundId: string | null = null;

      // Trin 1: Prøv BBR_Grund med vores adgangsadresse
      const grundResult = await fetchBBRGraphQL(
        `query($vt: DafDateTime!, $id: String!) { BBR_Grund(first: 1, virkningstid: $vt, where: { husnummer: { eq: $id } }) { nodes { id_lokalId } } }`,
        { vt, id: adgangsadresseId }
      );
      grundId = (grundResult as { id_lokalId: string }[])?.[0]?.id_lokalId ?? null;

      // Trin 2: Ingen grund? Find andre adgangsadresser på samme matrikel via DAWA
      if (!grundId && ejerlavKode && matrikelnr) {
        const adgRes = await fetchDawa(
          `${DAWA_BASE_URL}/adgangsadresser?ejerlavkode=${ejerlavKode}&matrikelnr=${encodeURIComponent(matrikelnr)}&per_side=10`,
          { signal: AbortSignal.timeout(5000), next: { revalidate: 3600 } },
          { caller: 'fetchBbrData.adgangsadresser.samme-matrikel' }
        );
        if (adgRes.ok) {
          const adgangsadresser = (await adgRes.json()) as { id: string }[];
          for (const adg of adgangsadresser) {
            if (adg.id === adgangsadresseId) continue;
            const altGrund = await fetchBBRGraphQL(
              `query($vt: DafDateTime!, $id: String!) { BBR_Grund(first: 1, virkningstid: $vt, where: { husnummer: { eq: $id } }) { nodes { id_lokalId } } }`,
              { vt, id: adg.id }
            );
            grundId = (altGrund as { id_lokalId: string }[])?.[0]?.id_lokalId ?? null;
            if (grundId) break;
          }
        }
      }

      // Trin 3: Har grund → hent bygninger og alle enheder via grund UUID
      if (grundId) {
        const grundBygQuery = BYGNING_QUERY.replace('husnummer: { eq: $id }', 'grund: { eq: $id }');
        const grundBygninger = await fetchBBRGraphQL(grundBygQuery, { vt, id: grundId });
        if (grundBygninger && grundBygninger.length > 0) {
          // Udtræk bygnings-UUID'er til WFS-punktopslag
          fraEnheder = (grundBygninger as RawBBRBygning[])
            .map((b) => b.id_lokalId)
            .filter((id): id is string => typeof id === 'string');

          // BIZZ-360: Hent alle enheder (ejerlejligheder) for hver bygning.
          // ENHED_QUERY filtrerer på adresseIdentificerer (lejlighedens adresse-UUID),
          // som ikke matcher adgangsadressen for moderejedommen. Vi bruger i stedet
          // ENHED_BY_BYGNING_QUERY der filtrerer direkte på bygnings-UUID'en.
          const enhedResultater = await Promise.all(
            fraEnheder.map((bygId) => fetchBBRGraphQL(ENHED_BY_BYGNING_QUERY, { vt, id: bygId }))
          );
          const kombineredeEnheder = enhedResultater.flatMap((r) => r ?? []);
          if (kombineredeEnheder.length > 0) {
            effectiveRawEnheder = kombineredeEnheder;
            logger.log(
              `[fetchBBR] Hovedejendom: fandt ${kombineredeEnheder.length} enheder via bygning(er) under BBR_Grund ${grundId}`
            );
          } else {
            // Ingen enheder fra bygning-opslag — behold tomme enheder
            effectiveRawEnheder = rawEnheder;
          }

          logger.log(
            `[fetchBBR] Hovedejendom: fandt ${grundBygninger.length} bygning(er) via BBR_Grund ${grundId}`
          );
        }
      }
    } catch {
      // Fallback fejler stille — BBR-tab viser bare tom data
    }
  }

  // Fallback: hvis BYGNING_QUERY returnerede 0 resultater men enheder refererer til
  // bygnings-UUIDs (fx ejerlejligheder i komplekser hvor bygningens husnummer-adresse
  // adskiller sig fra lejlighedens adresse), hent bygningerne via id_lokalId.
  let effectiveRawBygninger = rawBygninger;
  if ((!rawBygninger || rawBygninger.length === 0) && fraEnheder.length > 0) {
    const uniqueBygIds = [...new Set(fraEnheder)];
    const fallbackResults = await Promise.all(
      uniqueBygIds.map((bygId) => fetchBBRGraphQL(BYGNING_BY_ID_QUERY, { vt, id: bygId }))
    );
    const combined = fallbackResults.flatMap((r) => r ?? []);
    if (combined.length > 0) {
      effectiveRawBygninger = combined;
    }
  }

  // ── BIZZ-321: Bygning-til-enhed fallback ────────────────────────────────────
  // ENHED_QUERY filtrerer på adresseIdentificerer, som kun matcher individuelle
  // lejlighedsadresser — ikke adgangsadressen for en hel bygning.
  // Hvis vi har bygninger men stadig ingen enheder, henter vi enheder direkte via
  // bygnings-UUID (ENHED_BY_BYGNING_QUERY) for at undgå "Enheder: 0" på BBR-tab.
  // Gælder fx parcelhuse og erhvervsbygninger hvor alle enheder er knyttet til
  // bygningen men ikke til en individuel adresseidentificerer der matcher dawaId.
  if (
    (!effectiveRawEnheder || effectiveRawEnheder.length === 0) &&
    effectiveRawBygninger &&
    effectiveRawBygninger.length > 0
  ) {
    try {
      const bygIds = (effectiveRawBygninger as RawBBRBygning[])
        .map((b) => b.id_lokalId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      const uniqueBygIds = [...new Set(bygIds)];
      const enhedResultater = await Promise.all(
        uniqueBygIds.map((bygId) => fetchBBRGraphQL(ENHED_BY_BYGNING_QUERY, { vt, id: bygId }))
      );
      const kombineredeEnheder = enhedResultater.flatMap((r) => r ?? []);
      if (kombineredeEnheder.length > 0) {
        effectiveRawEnheder = kombineredeEnheder;
        // Re-extract building IDs from the newly found enheder
        fraEnheder = kombineredeEnheder
          .map((e) => (e as RawBBREnhed).bygning)
          .filter((b): b is string => typeof b === 'string' && b.length > 0);
        logger.log(
          `[fetchBBR] BIZZ-321: fandt ${kombineredeEnheder.length} enheder via bygning-opslag for ${dawaId}`
        );
      }
    } catch {
      // Fallback fejler stille — BBR-tab viser bare tomme enheder
    }
  }

  // Fallback: brug id_lokalId fra rawBygninger hvis enheder ikke giver bygning-UUID'er
  // (fx adresser der er registreret direkte på bygningen uden enheder)
  const fraBygninger: string[] = effectiveRawBygninger
    ? (effectiveRawBygninger as RawBBRBygning[])
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

  const rawBygningerUnique = effectiveRawBygninger
    ? deduplicerBBR(effectiveRawBygninger as RawBBRBygning[])
    : null;
  const rawEnhederUnique = effectiveRawEnheder
    ? deduplicerBBR(effectiveRawEnheder as RawBBREnhed[])
    : null;

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

  // BIZZ-321: Fallback BFE lookup if fetchBFENummer returned null but we have matrikel info
  let effectiveBfe = bfeNummer;
  if (!effectiveBfe && ejerlavKode && matrikelnr) {
    try {
      const jsRes = await fetchDawa(
        `${DAWA_BASE_URL}/jordstykker/${ejerlavKode}/${matrikelnr}`,
        { signal: AbortSignal.timeout(5000) },
        { caller: 'fetchBbrData.jordstykker.fallback' }
      );
      if (jsRes.ok) {
        const js = (await jsRes.json()) as { bfenummer?: number };
        effectiveBfe = js?.bfenummer ?? null;
      }
    } catch {
      /* fallback non-fatal */
    }
  }

  // Map DAWA BFEnummer + matrikelinfo → BBREjendomsrelation shape
  const ejendomsrelationer: BBREjendomsrelation[] | null =
    effectiveBfe != null
      ? [
          {
            bfeNummer: effectiveBfe,
            ejendomsnummer: null,
            ejendomstype: null,
            ejerlavKode,
            matrikelnr,
          },
        ]
      : null;

  // BIZZ-486: Hent opgange + etager parallelt for alle byggninger.
  // Fejl her er ikke-fatale — enhedstabellen fungerer uden denne data.
  let opgange: LiveBBROpgang[] | null = null;
  let etager: LiveBBREtage[] | null = null;
  if (bbr && bbr.length > 0) {
    try {
      const bygIds = bbr.map((b) => b.id).filter((id): id is string => !!id);
      const [rawOpgangResults, rawEtageResults] = await Promise.all([
        Promise.all(
          bygIds.map((bygId) =>
            fetchBBRGraphQL(OPGANG_BY_BYGNING_QUERY, { vt, id: bygId }).catch(() => null)
          )
        ),
        Promise.all(
          bygIds.map((bygId) =>
            fetchBBRGraphQL(ETAGE_BY_BYGNING_QUERY, { vt, id: bygId }).catch(() => null)
          )
        ),
      ]);
      const rawOpgange = rawOpgangResults.flatMap((r) => (r ?? []) as RawBBROpgang[]);
      const rawEtager = rawEtageResults.flatMap((r) => (r ?? []) as RawBBREtage[]);
      // Dedupliker — BBR returnerer nogle gange duplikater for samme id_lokalId
      const dedupeOpg = new Map<string, RawBBROpgang>();
      for (const o of rawOpgange) if (o.id_lokalId) dedupeOpg.set(o.id_lokalId, o);
      const dedupeEta = new Map<string, RawBBREtage>();
      for (const e of rawEtager) if (e.id_lokalId) dedupeEta.set(e.id_lokalId, e);
      opgange = [...dedupeOpg.values()].map(normaliseOpgang);
      etager = [...dedupeEta.values()].map(normaliseEtage);

      // BIZZ-487 (re-implemented 2026-04-19): Aggregér kælder/tagetage-areal
      // pr. bygning fra BBR_Etage. byg077KaelderAreal/byg078TagetageAreal
      // eksisterer IKKE i skemaet — vi udleder fra eta006BygningensEtagebetegnelse.
      for (const b of bbr) {
        const bygEtager = etager.filter(
          (e) => e.bygningId === b.id && e.status !== '7' && e.samletAreal != null
        );
        const kaelderSum = bygEtager
          .filter((e) => e.etagebetegnelse === 'kl')
          .reduce((sum, e) => sum + (e.samletAreal ?? 0), 0);
        const tagetageSum = bygEtager
          .filter((e) => e.etagebetegnelse === 'tag')
          .reduce((sum, e) => sum + (e.samletAreal ?? 0), 0);
        if (kaelderSum > 0) b.kaelder = kaelderSum;
        if (tagetageSum > 0) b.tagetage = tagetageSum;
      }
    } catch (err) {
      logger.warn('[fetchBBR] Opgang/Etage fetch fejlede:', err);
      // Ikke-fatal — fortsæt med null
    }
  }

  // BIZZ-484: Hent tekniske anlæg parallelt — non-fatal hvis det fejler.
  let tekniskeAnlaeg: Array<{
    id_lokalId: string;
    tek020Klassifikation: string | null;
    status: string | null;
  }> | null = null;
  try {
    tekniskeAnlaeg = await fetchBbrTekniskAnlaegByDawaId(adgangsadresseId);
  } catch (err) {
    logger.warn('[fetchBBR] TekniskAnlaeg fetch fejlede:', err);
  }

  const bbrFejl = !(process.env.DATAFORDELER_API_KEY ?? '')
    ? 'Datafordeler API-nøgle ikke konfigureret.'
    : bbr === null
      ? 'BBR-data ikke tilgængeligt. Tjek at DATAFORDELER_API_KEY er sat i .env.local.'
      : null;

  // BIZZ-728: Parent adgangsadresse — sat når input-dawaId er en "adresse" (med etage/dør)
  // og adgangsadresseId derfor er forskellig. Bruges til "Gå til hovedejendom"-navigation
  // uafhængigt af Vurderingsportalen-opslag, så det også virker for erhvervsenheder o.lign.
  const parentAdgangsadresseId =
    adgangsadresseId && adgangsadresseId !== dawaId ? adgangsadresseId : null;

  return {
    bbr,
    enheder,
    bygningPunkter,
    ejendomsrelationer,
    ejerlejlighedBfe,
    moderBfe,
    parentAdgangsadresseId,
    opgange,
    etager,
    tekniskeAnlaeg,
    bbrFejl,
  };
}
