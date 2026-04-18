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
   * BIZZ-485 (reverted): byg034Tagkonstruktion blev fjernet fra GraphQL-
   * queryen da feltnavnet fik hele BBR-queryen til at fejle i produktion
   * (fikseret 2026-04-19 efter rapport om tom BBR-tab). Tagkonstruktion
   * forbliver '–' i UI indtil korrekt schema-feltnavn er verificeret.
   */
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
   */
  risks: {
    asbestTag: boolean;
    asbestYdervaeg: boolean;
    traeYdervaeg: boolean;
  };
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
  variables: Record<string, string>
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
  variables: Record<string, string>
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

  const bbrFejl = !(process.env.DATAFORDELER_API_KEY ?? '')
    ? 'Datafordeler API-nøgle ikke konfigureret.'
    : bbr === null
      ? 'BBR-data ikke tilgængeligt. Tjek at DATAFORDELER_API_KEY er sat i .env.local.'
      : null;

  return {
    bbr,
    enheder,
    bygningPunkter,
    ejendomsrelationer,
    ejerlejlighedBfe,
    moderBfe,
    bbrFejl,
  };
}
