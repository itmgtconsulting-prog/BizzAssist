/**
 * GET /api/ejendomme-by-owner
 *
 * Finder alle ejendomme ejet af virksomheder (CVR) eller personer (enhedsNummer).
 * Bruges til at vise ejendomsportefølje på virksomheds-, person- og ejersider.
 *
 * Flow:
 *   1a. For hvert CVR: forespørg EJFCustom_EjerskabBegraenset via FlexibleCurrent med ejendeVirksomhedCVRNr filter
 *   1b. For hvert enhedsNummer: forespørg EJFCustom_EjerskabBegraenset via FlexibleCurrent med ejendePersonEnhedsNummer filter
 *   2. For hvert unikt BFE: hent adressedata via DAWA /bfe/{bfe} endpoint
 *   3. Returner beriget liste med adresse, ejendomstype og DAWA-id til detaljeside-link
 *
 * Autentificering: OAuth Shared Secret (primær) + mTLS Certifikat (fallback).
 *
 * BIZZ-264: Added enhedsNummer parameter for direct person-owned properties.
 *
 * @param cvr - Kommasepareret liste af CVR-numre (maks. 30) — optional if enhedsNummer provided
 * @param enhedsNummer - Kommasepareret liste af person enhedsNummer (maks. 10) — optional if cvr provided
 * @returns { ejendomme: EjendomSummary[], totalBfe: number, manglerNoegle: boolean, manglerAdgang: boolean, fejl: string | null }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { parseQuery as _parseQuery } from '@/app/lib/validate';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';
import { getCertOAuthToken, isCertAuthConfigured } from '@/app/lib/dfCertAuth';
import { logger } from '@/app/lib/logger';
import { getSharedOAuthToken } from '@/app/lib/dfTokenCache';
import { resolveTenantId } from '@/lib/api/auth';
import {
  EJF_GQL_ENDPOINT,
  DATAFORDELER_TOKEN_URL,
  DAWA_BASE_URL,
} from '@/app/lib/serviceEndpoints';
import { fetchDawa } from '@/app/lib/dawa';

/** Zod schema for /api/ejendomme-by-owner query params */
const _querySchema = z.object({
  cvr: z.string().min(1),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(5),
});

/** Forlæng Vercel serverless timeout til 30 sek. (kræver Pro-plan) */
export const maxDuration = 30;

// ─── Types ───────────────────────────────────────────────────────────────────

/** Opsummerede data for én ejendom i porteføljeoversigten */
export interface EjendomSummary {
  /** BFE-nummer (Bestemt Fast Ejendom) */
  bfeNummer: number;
  /** CVR-nummer på den virksomhed der ejer ejendommen */
  ownerCvr: string;
  /** Vejnavn + husnr (f.eks. "Nørre Voldgade 11") */
  adresse: string | null;
  /** Postnummer (f.eks. "1358") */
  postnr: string | null;
  /** Postdistrikt/by (f.eks. "København K") */
  by: string | null;
  /** Kommunenavn */
  kommune: string | null;
  /** Kommunekode (4 cifre, f.eks. "0101") — til vurderingsopslag */
  kommuneKode: string | null;
  /** Ejendomstype fra DAWA (f.eks. "Normal ejendom", "Ejerlejlighed") */
  ejendomstype: string | null;
  /** DAWA adgangsadresse UUID — bruges til link til ejendomsdetaljeside */
  dawaId: string | null;
  /** Ejer-andel (faktisk ejerandel fra EJF, f.eks. "100%") */
  ejerandel?: string | null;
  /** BIZZ-455: false hvis ejendommen er solgt (CVR ikke længere aktuel ejer) */
  aktiv?: boolean;
  /** BIZZ-455: Dato hvor CVR ophørte som ejer (ISO-dato) — kun for solgte */
  solgtDato?: string | null;
  /** BIZZ-397: Progressive enrichment fields — populated client-side after initial load */
  /** Bygningsareal i m² fra BBR */
  areal?: number | null;
  /** Seneste ejendomsvurdering i DKK */
  vurdering?: number | null;
  /** Vurderingsår */
  vurderingsaar?: number | null;
  /** Ejer-navn (person eller virksomhedsnavn) */
  ejerNavn?: string | null;
  /** Købesum i DKK fra seneste handel */
  koebesum?: number | null;
  /** Overtagelsesdato fra seneste handel */
  koebsdato?: string | null;
}

/** API-svaret fra denne route */
export interface EjendommeByOwnerResponse {
  /** Liste af fundne ejendomme for den angivne side */
  ejendomme: EjendomSummary[];
  /** Det totale antal BFE-numre fundet */
  totalBfe: number;
  /** Offset der blev brugt i denne forespørgsel */
  offset: number;
  /** Limit der blev brugt i denne forespørgsel */
  limit: number;
  /** true hvis OAuth-nøgler mangler i miljøvariabler */
  manglerNoegle: boolean;
  /** true hvis Datafordeler returnerer 403 (Dataadgang-ansøgning mangler) */
  manglerAdgang: boolean;
  /** Fejlbesked eller null */
  fejl: string | null;
}

// ─── Konstanter ─────────────────────────────────────────────────────────────

/** Maks antal CVR-numre der accepteres per kald */
const MAX_CVR = 30;
/** Maks antal BFE-numre per batch (sikkerhedsloft) */
const MAX_BATCH = 50;
/** Standard antal BFE-numre i første batch */
const DEFAULT_LIMIT = 5;
/** Maks antal samtidige DAWA BFE-opslag */
const DAWA_CONCURRENCY = 10;

// ─── OAuth token cache ───────────────────────────────────────────────────────

/** Delt token-cache (genbruges på tværs af requests i serverprocessen) */
let _cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Henter et gyldigt OAuth Bearer token fra Datafordeler via client_credentials.
 * Cacher tokenet og fornyer automatisk 60 sek. inden udløb.
 *
 * @returns Bearer token som streng, eller null hvis credentials mangler
 */
async function _getOAuthToken(): Promise<string | null> {
  if (_cachedToken && Date.now() < _cachedToken.expiresAt - 60_000) {
    return _cachedToken.token;
  }

  const clientId = process.env.DATAFORDELER_OAUTH_CLIENT_ID;
  const clientSecret = process.env.DATAFORDELER_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  try {
    const res = await fetch(proxyUrl(DATAFORDELER_TOKEN_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...proxyHeaders() },
      body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${encodeURIComponent(clientSecret)}`,
      signal: AbortSignal.timeout(proxyTimeout()),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { access_token: string; expires_in: number };
    _cachedToken = {
      token: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
    return _cachedToken.token;
  } catch {
    return null;
  }
}

// ─── Rå typer fra EJF GraphQL ────────────────────────────────────────────────

interface RawEjerskab {
  bestemtFastEjendomBFENr: number | null;
  ejendeVirksomhedCVRNr: number | null;
  virkningFra: string | null;
  faktiskEjerandel_taeller: number | null;
  faktiskEjerandel_naevner: number | null;
}

interface GqlResult<T> {
  data?: Record<string, { nodes?: T[] }>;
  errors?: { message: string; extensions?: { code?: string } }[];
}

// ─── EJF GraphQL hjælpefunktion ──────────────────────────────────────────────

/**
 * Sender EJF GraphQL forespørgsel for ét CVR-nummer og returnerer aktuelle BFE-numre.
 *
 * @param cvr - CVR-nummer (numerisk) at forespørge
 * @param token - OAuth Bearer token
 * @returns { bfeNumre: number[]; authError: boolean } eller null ved netværksfejl
 */
async function hentBfeByCvr(
  cvr: number,
  token: string
): Promise<{
  bfeNumre: number[];
  ejerandelByBfe: Map<number, string>;
  authError: boolean;
} | null> {
  const virkningstid = new Date().toISOString();

  const query = `{
    EJFCustom_EjerskabBegraenset(
      first: 500
      virkningstid: "${virkningstid}"
      where: {
        ejendeVirksomhedCVRNr: { eq: ${cvr} }
      }
    ) {
      nodes {
        bestemtFastEjendomBFENr
        ejendeVirksomhedCVRNr
        virkningFra
        faktiskEjerandel_taeller
        faktiskEjerandel_naevner
      }
    }
  }`;

  try {
    const res = await fetch(proxyUrl(EJF_GQL_ENDPOINT), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...proxyHeaders(),
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(proxyTimeout()),
      // BIZZ-367: Revalidate frequently so a fixed auth credential is picked up within
      // minutes rather than the previous 3600s window. EJF ownership data changes slowly
      // so 300s is still cache-friendly for normal use.
      next: { revalidate: 300 },
    });

    if (res.status === 403) return { bfeNumre: [], ejerandelByBfe: new Map(), authError: true };
    if (!res.ok) return null;

    const json = (await res.json()) as GqlResult<RawEjerskab>;

    const authError =
      json.errors?.some(
        (e) => e.extensions?.code === 'DAF-AUTH-0001' || e.message?.includes('not authorized')
      ) ?? false;
    if (authError) return { bfeNumre: [], ejerandelByBfe: new Map(), authError: true };

    const nodes = json.data?.EJFCustom_EjerskabBegraenset?.nodes ?? [];
    const bfeNumre = nodes
      .map((n) => n.bestemtFastEjendomBFENr)
      .filter((b): b is number => b != null);

    // Build map of BFE → ejerandel string (e.g. "50%", "100%")
    const ejerandelByBfe = new Map<number, string>();
    for (const n of nodes) {
      if (n.bestemtFastEjendomBFENr == null) continue;
      const t = n.faktiskEjerandel_taeller;
      const nav = n.faktiskEjerandel_naevner;
      if (t != null && nav != null && nav > 0) {
        const pct = Math.round((t / nav) * 100);
        ejerandelByBfe.set(n.bestemtFastEjendomBFENr, `${pct}%`);
      }
    }

    return { bfeNumre, ejerandelByBfe, authError: false };
  } catch {
    return null;
  }
}

/**
 * Sender EJF GraphQL forespørgsel for ét person enhedsNummer og returnerer aktuelle BFE-numre.
 * BIZZ-264: Direkte personejede ejendomme via EJF.
 *
 * @param enhedsNummer - Person enhedsNummer at forespørge
 * @param token - OAuth Bearer token
 * @returns { bfeNumre: number[]; authError: boolean } eller null ved netværksfejl
 */
async function hentBfeByPerson(
  enhedsNummer: number,
  token: string
): Promise<{ bfeNumre: number[]; authError: boolean } | null> {
  const virkningstid = new Date().toISOString();

  const query = `{
    EJFCustom_EjerskabBegraenset(
      first: 500
      virkningstid: "${virkningstid}"
      where: {
        ejendePersonEnhedsNummer: { eq: ${enhedsNummer} }
      }
    ) {
      nodes {
        bestemtFastEjendomBFENr
        virkningFra
      }
    }
  }`;

  try {
    const res = await fetch(proxyUrl(EJF_GQL_ENDPOINT), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...proxyHeaders(),
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(proxyTimeout()),
      // BIZZ-369: Same short revalidation as hentBfeByCvr — ensures a fixed EJF
      // credential is reflected within ~5 minutes rather than 1 hour.
      next: { revalidate: 300 },
    });

    if (res.status === 403) return { bfeNumre: [], authError: true };
    if (!res.ok) return null;

    const json = (await res.json()) as GqlResult<RawEjerskab>;

    const authError =
      json.errors?.some(
        (e) => e.extensions?.code === 'DAF-AUTH-0001' || e.message?.includes('not authorized')
      ) ?? false;
    if (authError) return { bfeNumre: [], authError: true };

    const nodes = json.data?.EJFCustom_EjerskabBegraenset?.nodes ?? [];
    const bfeNumre = nodes
      .map((n) => n.bestemtFastEjendomBFENr)
      .filter((b): b is number => b != null);

    return { bfeNumre, authError: false };
  } catch {
    return null;
  }
}

// ─── DAWA BFE adresse-opslag ─────────────────────────────────────────────────

interface DawaBfeAdresse {
  adresse: string | null;
  postnr: string | null;
  by: string | null;
  kommune: string | null;
  kommuneKode: string | null;
  ejendomstype: string | null;
  dawaId: string | null;
}

/**
 * Internal implementation — fetches address and property type for a BFE number via DAWA.
 * Call hentDawaBfeData (the deduplicated wrapper) instead of this directly.
 *
 * @param bfe - BFE-nummer at slå op
 * @returns Adresseoplysninger og DAWA adgangsadresse-UUID
 */
async function _hentDawaBfeDataImpl(bfe: number): Promise<DawaBfeAdresse> {
  const empty: DawaBfeAdresse = {
    adresse: null,
    postnr: null,
    by: null,
    kommune: null,
    kommuneKode: null,
    ejendomstype: null,
    dawaId: null,
  };

  try {
    const res = await fetchDawa(
      `${DAWA_BASE_URL}/bfe/${bfe}`,
      { signal: AbortSignal.timeout(10000), next: { revalidate: 86400 } },
      { caller: 'ejendomme-by-owner.bfe' }
    );
    if (!res.ok) return empty;

    const json = (await res.json()) as {
      ejendomstype?: string;
      beliggenhedsadresse?: {
        id?: string;
        vejnavn?: string;
        husnr?: string;
        postnr?: string;
        postnrnavn?: string;
        kommunekode?: string;
        kommunenavn?: string;
      };
      jordstykker?: Array<{
        husnumre?: Array<{ id?: string }>;
        ejerlav?: { navn?: string };
        kommune?: { kode?: string; navn?: string };
      }>;
    };

    const bel = json.beliggenhedsadresse;
    if (bel) {
      const adresseStr = bel.vejnavn ? `${bel.vejnavn} ${bel.husnr ?? ''}`.trim() : null;
      /* Hent DAWA adgangsadresse UUID — enten direkte fra beliggenhedsadresse.id
         eller fra jordstykker[0].husnumre[0].id (fallback) */
      const dawaId = bel.id ?? json.jordstykker?.[0]?.husnumre?.[0]?.id ?? null;

      return {
        adresse: adresseStr,
        postnr: bel.postnr ?? null,
        by: bel.postnrnavn ?? null,
        kommune: bel.kommunenavn ?? null,
        kommuneKode: bel.kommunekode ?? null,
        ejendomstype: json.ejendomstype ?? null,
        dawaId: dawaId ?? null,
      };
    }

    /* Fallback: resolve address from jordstykker → husnumre → adgangsadresse.
     * Samlet ejendomme without beliggenhedsadresse often have jordstykker with
     * husnumre UUIDs that point to actual street addresses in DAWA. */
    const js = json.jordstykker?.[0];
    const husnumreId = js?.husnumre?.[0]?.id as string | undefined;

    if (husnumreId) {
      try {
        const addrRes = await fetchDawa(
          `${DAWA_BASE_URL}/adgangsadresser/${husnumreId}?struktur=mini`,
          { signal: AbortSignal.timeout(5000), next: { revalidate: 86400 } },
          { caller: 'ejendomme-by-owner.adgangsadresser.husnumre' }
        );
        if (addrRes.ok) {
          const addr = (await addrRes.json()) as {
            id?: string;
            vejnavn?: string;
            husnr?: string;
            postnr?: string;
            postnrnavn?: string;
            kommunekode?: string;
            kommunenavn?: string;
          };
          if (addr.vejnavn) {
            return {
              adresse: `${addr.vejnavn} ${addr.husnr ?? ''}`.trim(),
              postnr: addr.postnr ?? null,
              by: addr.postnrnavn ?? null,
              kommune: addr.kommunenavn ?? null,
              kommuneKode: addr.kommunekode ?? null,
              ejendomstype: json.ejendomstype ?? null,
              dawaId: addr.id ?? husnumreId,
            };
          }
        }
      } catch {
        /* ignore — fallback to ejerlav below */
      }
    }

    /* Last resort: use ejerlav name (cadastral district) as address */
    if (js?.ejerlav?.navn) {
      return {
        adresse: js.ejerlav.navn,
        postnr: null,
        by: null,
        kommune: js.kommune?.navn ?? null,
        kommuneKode: js.kommune?.kode ?? null,
        ejendomstype: json.ejendomstype ?? null,
        dawaId: husnumreId ?? null,
      };
    }

    return { ...empty, ejendomstype: json.ejendomstype ?? null };
  } catch {
    return empty;
  }
}

// ─── BBR GraphQL BFE→address fallback ────────────────────────────────────────

/**
 * Resolves BFE→address via Vurderingsportalen Elasticsearch when DAWA fails.
 * VP is a public API that has address data for most Danish properties.
 * Requires browser-like User-Agent to pass CloudFront WAF.
 *
 * @param bfe - BFE-nummer
 * @returns Partial DawaBfeAdresse with address fields, or empty
 */
async function _hentVPAdresseForBfe(bfe: number): Promise<DawaBfeAdresse> {
  const empty: DawaBfeAdresse = {
    adresse: null,
    postnr: null,
    by: null,
    kommune: null,
    kommuneKode: null,
    ejendomstype: null,
    dawaId: null,
  };

  try {
    // Call VP directly (not via proxy) — VP works from Vercel with browser User-Agent.
    // The proxy server doesn't whitelist api-fs.vurderingsportalen.dk.
    const res = await fetch('https://api-fs.vurderingsportalen.dk/preliminaryproperties/_search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({
        query: { term: { bfeNumbers: bfe } },
        size: 1,
        _source: [
          'address',
          'roadName',
          'houseNumber',
          'zipcode',
          'postDistrict',
          'adgangsAdresseID',
          'juridiskKategori',
          'municipalityNumber',
        ],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return empty;

    const data = (await res.json()) as {
      hits?: {
        hits?: Array<{
          _source?: {
            address?: string;
            roadName?: string;
            houseNumber?: string;
            zipcode?: string;
            postDistrict?: string;
            adgangsAdresseID?: string;
            juridiskKategori?: string;
            municipalityNumber?: string;
          };
        }>;
      };
    };
    const src = data.hits?.hits?.[0]?._source;
    if (!src?.address) return empty;

    const adresse =
      src.roadName && src.houseNumber
        ? `${src.roadName} ${src.houseNumber}`.trim()
        : (src.address.split(',')[0]?.trim() ?? null);

    // BIZZ-521 follow-up: VP's adgangsAdresseID er ofte forældet og
    // returnerer 404 mod current DAWA — links bliver brudt. Valider mod
    // DAWA og brug i stedet current adgangsadresse-UUID når muligt.
    // Hvis opslaget fejler, dropper vi dawaId helt så UI ikke linker til
    // en død ressource.
    let freshDawaId: string | null = null;
    if (src.roadName && src.houseNumber && src.zipcode) {
      try {
        const probeUrl = `${DAWA_BASE_URL}/adgangsadresser?vejnavn=${encodeURIComponent(src.roadName)}&husnr=${encodeURIComponent(src.houseNumber)}&postnr=${encodeURIComponent(src.zipcode)}&struktur=mini&per_side=1`;
        const probeRes = await fetchDawa(
          probeUrl,
          { signal: AbortSignal.timeout(5000), next: { revalidate: 86400 } },
          { caller: 'ejendomme-by-owner.vp-fresh-dawa-id' }
        );
        if (probeRes.ok) {
          const arr = (await probeRes.json()) as Array<{ id?: string }>;
          freshDawaId = arr?.[0]?.id ?? null;
        }
      } catch {
        // Lad freshDawaId være null
      }
    }

    return {
      adresse,
      postnr: src.zipcode ?? null,
      by: src.postDistrict ?? null,
      kommune: null,
      kommuneKode: src.municipalityNumber ? String(src.municipalityNumber).padStart(4, '0') : null,
      ejendomstype: src.juridiskKategori ?? null,
      // Kun behold dawaId hvis current DAWA kender den — ellers null så
      // UI falder tilbage til ikke-klikbart kort i stedet for brudt link.
      dawaId: freshDawaId,
    };
  } catch {
    return empty;
  }
}

// ─── DAWA BFE deduplication ──────────────────────────────────────────────────

/**
 * Module-level map of in-flight DAWA BFE requests.
 * Prevents duplicate concurrent fetches for the same BFE number within a
 * single serverless instance — multiple concurrent route invocations requesting
 * the same BFE will share a single fetch promise.
 */
const _bfeFetchInFlight = new Map<number, Promise<DawaBfeAdresse>>();

/**
 * Deduplicated wrapper around _hentDawaBfeDataImpl.
 * If a fetch for the same BFE is already in flight, returns the existing promise
 * rather than issuing a duplicate HTTP request.
 *
 * @param bfe - BFE-nummer at slå op
 * @returns Adresseoplysninger og DAWA adgangsadresse-UUID
 */
async function hentDawaBfeData(bfe: number): Promise<DawaBfeAdresse> {
  const cached = _bfeFetchInFlight.get(bfe);
  if (cached) return cached;
  const promise = _hentDawaBfeDataImpl(bfe).then(async (result) => {
    // BIZZ-450: If DAWA returned no address, try BBR GraphQL as fallback.
    // DAWA /bfe/{bfe} endpoint is being deprecated; BBR is the authoritative source.
    if (!result.adresse) {
      const vpResult = await _hentVPAdresseForBfe(bfe);
      if (vpResult.adresse) return { ...result, ...vpResult };
    }
    return result;
  });
  _bfeFetchInFlight.set(bfe, promise);
  void promise.finally(() => _bfeFetchInFlight.delete(bfe));
  return promise;
}

// ─── Hjælpefunktion: kør med begrænset parallelisme ─────────────────────────

/**
 * Kører en asynkron funktion over et array med maks. `concurrency` samtidige kald.
 *
 * @param items - Input-array
 * @param concurrency - Maks. samtidige promises
 * @param fn - Async funktion der behandler hvert element
 * @returns Array af resultater i samme rækkefølge som input
 */
async function pMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ─── Route handler ───────────────────────────────────────────────────────────

/**
 * GET /api/ejendomme-by-owner?cvr=12345678&offset=0&limit=5
 *
 * Returnerer én side af de aktuelt ejede ejendomme for de angivne CVR-numre.
 * Bruges til progressiv load: første kald henter de første `limit` ejendomme,
 * efterfølgende kald øger `offset` for at hente næste batch.
 *
 * @param request - Next.js request med ?cvr= kommasepareret liste, ?offset= og ?limit=
 * @returns EjendommeByOwnerResponse
 */
export async function GET(request: NextRequest): Promise<NextResponse<EjendommeByOwnerResponse>> {
  const auth = await resolveTenantId();
  if (!auth)
    return NextResponse.json({ error: 'Unauthorized' } as unknown as EjendommeByOwnerResponse, {
      status: 401,
    });
  const hasSharedSecret = !!(
    process.env.DATAFORDELER_OAUTH_CLIENT_ID && process.env.DATAFORDELER_OAUTH_CLIENT_SECRET
  );
  const hasCert = isCertAuthConfigured();

  const { searchParams } = request.nextUrl;

  /* Paginering: ?offset=0&limit=5 */
  const offset = Math.max(0, parseInt(searchParams.get('offset') ?? '0', 10) || 0);
  const limit = Math.min(
    MAX_BATCH,
    Math.max(1, parseInt(searchParams.get('limit') ?? `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT)
  );

  if (!hasSharedSecret && !hasCert) {
    return NextResponse.json({
      ejendomme: [],
      totalBfe: 0,
      offset,
      limit,
      manglerNoegle: true,
      manglerAdgang: false,
      fejl: null,
    });
  }

  const cvrParam = searchParams.get('cvr') ?? '';
  const enhedsNummerParam = searchParams.get('enhedsNummer') ?? '';

  if (!cvrParam && !enhedsNummerParam) {
    return NextResponse.json(
      {
        ejendomme: [],
        totalBfe: 0,
        offset,
        limit,
        manglerNoegle: false,
        manglerAdgang: false,
        fejl: 'cvr eller enhedsNummer parameter er påkrævet',
      },
      { status: 400 }
    );
  }

  /* Parsér og validér CVR-numre */
  const rawCvrs = cvrParam
    ? cvrParam
        .split(',')
        .map((s) => s.trim().replace(/\D/g, ''))
        .filter((s) => s.length >= 7 && s.length <= 8)
    : [];

  const cvrNumre = [...new Set(rawCvrs.map((s) => parseInt(s, 10)))].slice(0, MAX_CVR);

  /* BIZZ-264: Parsér og validér person enhedsNummer */
  const rawEnheder = enhedsNummerParam
    ? enhedsNummerParam
        .split(',')
        .map((s) => s.trim().replace(/\D/g, ''))
        .filter((s) => s.length >= 1 && s.length <= 15)
    : [];

  const enhedsNumre = [...new Set(rawEnheder.map((s) => parseInt(s, 10)))].slice(0, 10);

  if (cvrNumre.length === 0 && enhedsNumre.length === 0) {
    return NextResponse.json(
      {
        ejendomme: [],
        totalBfe: 0,
        offset,
        limit,
        manglerNoegle: false,
        manglerAdgang: false,
        fejl: 'Ingen gyldige CVR-numre eller enhedsNumre angivet',
      },
      { status: 400 }
    );
  }

  /* Hent OAuth token */
  let token: string | null = null;

  if (hasSharedSecret) {
    token = await getSharedOAuthToken();
  }

  /* Fallback: mTLS certifikat */
  if (!token && hasCert) {
    token = await getCertOAuthToken();
  }

  if (!token) {
    return NextResponse.json({
      ejendomme: [],
      totalBfe: 0,
      offset,
      limit,
      manglerNoegle: false,
      manglerAdgang: false,
      fejl: 'Kunne ikke hente OAuth token',
    });
  }

  try {
    /* ── Trin 1: Find alle BFE-numre (CVR + person lookups parallelt) ── */
    const cvrSettled =
      cvrNumre.length > 0
        ? await Promise.allSettled(cvrNumre.map((cvr) => hentBfeByCvr(cvr, token!)))
        : [];

    // BIZZ-264: Person lookups via enhedsNummer
    const personSettled =
      enhedsNumre.length > 0
        ? await Promise.allSettled(enhedsNumre.map((en) => hentBfeByPerson(en, token!)))
        : [];

    const cvrResults = cvrSettled.map((settled, i) => {
      if (settled.status === 'rejected') {
        logger.error(
          `[ejendomme-by-owner] EJF CVR lookup failed for CVR ${cvrNumre[i]}:`,
          settled.reason
        );
        return null;
      }
      return settled.value;
    });

    const personResults = personSettled.map((settled, i) => {
      if (settled.status === 'rejected') {
        logger.error(
          `[ejendomme-by-owner] EJF person lookup failed for ${enhedsNumre[i]}:`,
          settled.reason
        );
        return null;
      }
      return settled.value;
    });

    /* Tjek om nogen returnerede auth-fejl */
    const harAuthFejl =
      cvrResults.some((r) => r?.authError === true) ||
      personResults.some((r) => r?.authError === true);
    if (harAuthFejl) {
      return NextResponse.json({
        ejendomme: [],
        totalBfe: 0,
        offset,
        limit,
        manglerNoegle: false,
        manglerAdgang: true,
        fejl: null,
      });
    }

    /* Saml unikke BFE-numre med tilhørende ejer-ID + ejer-andel */
    const bfeTilCvr = new Map<number, string>();
    const bfeTilEjerandel = new Map<number, string>();
    for (let i = 0; i < cvrNumre.length; i++) {
      const result = cvrResults[i];
      if (!result) continue;
      for (const bfe of result.bfeNumre) {
        if (!bfeTilCvr.has(bfe)) {
          bfeTilCvr.set(bfe, String(cvrNumre[i]).padStart(8, '0'));
        }
      }
      // Merge ejer-andel map (first owner wins when multiple CVRs queried)
      for (const [bfe, andel] of result.ejerandelByBfe) {
        if (!bfeTilEjerandel.has(bfe)) bfeTilEjerandel.set(bfe, andel);
      }
    }
    // BIZZ-264: Add person-owned BFEs (use enhedsNummer as ownerCvr placeholder)
    for (let i = 0; i < enhedsNumre.length; i++) {
      const result = personResults[i];
      if (!result) continue;
      for (const bfe of result.bfeNumre) {
        if (!bfeTilCvr.has(bfe)) {
          bfeTilCvr.set(bfe, `person-${enhedsNumre[i]}`);
        }
      }
    }

    /* ── Verificér aktivt ejerskab — markér solgte ejendomme ──
     * BIZZ-455: EJF flexibleCurrent returnerer historiske ejerskaber. For hvert BFE
     * tjekker vi om den seneste ejerpost stadig matcher CVR. Hvis en nyere post med
     * en anden ejer findes, markerer vi ejendommen som solgt (aktiv=false) men
     * beholder den i listen så UI'et kan vise fold-ud med tidligere ejendomme. */
    const aktivByBfe = new Map<number, boolean>();
    const solgtDatoByBfe = new Map<number, string | null>();
    if (cvrNumre.length > 0) {
      const queriedCvrSet = new Set(cvrNumre);
      const bfeList = [...bfeTilCvr.keys()];
      const VERIFY_BATCH = 20;
      for (let i = 0; i < bfeList.length; i += VERIFY_BATCH) {
        const chunk = bfeList.slice(i, i + VERIFY_BATCH);
        await Promise.allSettled(
          chunk.map(async (bfe) => {
            const ownerCvr = bfeTilCvr.get(bfe);
            if (!ownerCvr || ownerCvr.startsWith('person-')) {
              aktivByBfe.set(bfe, true);
              return;
            }
            const cvrNum = parseInt(ownerCvr, 10);
            const vt = new Date().toISOString();
            const query = `{ EJFCustom_EjerskabBegraenset(first: 10, virkningstid: "${vt}", where: { bestemtFastEjendomBFENr: { eq: ${bfe} } }) { nodes { ejendeVirksomhedCVRNr virkningFra } } }`;
            const res = await fetch(proxyUrl(EJF_GQL_ENDPOINT), {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
                ...proxyHeaders(),
              },
              body: JSON.stringify({ query }),
              signal: AbortSignal.timeout(proxyTimeout()),
            });
            if (!res.ok) {
              aktivByBfe.set(bfe, true); // default to active on error
              return;
            }
            const data = (await res.json()) as GqlResult<{
              ejendeVirksomhedCVRNr: number | null;
              virkningFra: string | null;
            }>;
            const nodes = Object.values(data.data ?? {})[0]?.nodes ?? [];
            if (nodes.length === 0) {
              aktivByBfe.set(bfe, true);
              return;
            }
            const newestDate = Math.max(
              ...nodes.map((n) => new Date(n.virkningFra ?? 0).getTime())
            );
            // BIZZ-463: Among ALL nodes at newest date, pick one whose CVR was in
            // our queried list (= actual current owner for this concern). If the
            // current bfeTilCvr mapping points to a different (historical) owner,
            // reassign to the correct current owner.
            const newestNodes = nodes.filter(
              (n) => new Date(n.virkningFra ?? 0).getTime() === newestDate
            );
            const currentOwnerInList = newestNodes.find(
              (n) => n.ejendeVirksomhedCVRNr != null && queriedCvrSet.has(n.ejendeVirksomhedCVRNr)
            );
            if (currentOwnerInList?.ejendeVirksomhedCVRNr) {
              // Reassign bfeTilCvr to the actual current owner
              const actualCvr = currentOwnerInList.ejendeVirksomhedCVRNr;
              bfeTilCvr.set(bfe, String(actualCvr).padStart(8, '0'));
              aktivByBfe.set(bfe, true);
            } else {
              // No queried CVR is the current owner → property was sold externally
              aktivByBfe.set(bfe, false);
              const ourLastDate = nodes
                .filter((n) => n.ejendeVirksomhedCVRNr === cvrNum)
                .map((n) => new Date(n.virkningFra ?? 0).getTime())
                .reduce((a, b) => Math.max(a, b), 0);
              const soldDate = nodes
                .filter((n) => new Date(n.virkningFra ?? 0).getTime() > ourLastDate)
                .map((n) => new Date(n.virkningFra ?? 0).getTime())
                .reduce((a, b) => Math.min(a || Infinity, b), Infinity);
              solgtDatoByBfe.set(
                bfe,
                soldDate && soldDate !== Infinity ? new Date(soldDate).toISOString() : null
              );
            }
          })
        );
      }
    }

    const alleBfe = [...bfeTilCvr.keys()];
    const totalBfe = alleBfe.length;

    if (totalBfe === 0) {
      return NextResponse.json({
        ejendomme: [],
        totalBfe: 0,
        offset,
        limit,
        manglerNoegle: false,
        manglerAdgang: false,
        fejl: null,
      });
    }

    /* Sortér: aktive først, så solgte — for konsistent paginering */
    alleBfe.sort((a, b) => {
      const aktivA = aktivByBfe.get(a) ?? true;
      const aktivB = aktivByBfe.get(b) ?? true;
      if (aktivA !== aktivB) return aktivA ? -1 : 1;
      return a - b;
    });

    /* Afgræns batch baseret på offset + limit */
    const begransetBfe = alleBfe.slice(offset, offset + limit);

    /* ── Trin 2: Hent adressedata for hvert BFE (begrænset parallelisme) ── */
    const adresseData = await pMap(begransetBfe, DAWA_CONCURRENCY, hentDawaBfeData);

    /* ── Trin 3: Saml resultater ── */
    const ejendomme: EjendomSummary[] = begransetBfe.map((bfe, idx) => ({
      bfeNummer: bfe,
      ownerCvr: bfeTilCvr.get(bfe) ?? '',
      ...adresseData[idx],
      ejerandel: bfeTilEjerandel.get(bfe) ?? null,
      aktiv: aktivByBfe.get(bfe) ?? true,
      solgtDato: solgtDatoByBfe.get(bfe) ?? null,
    }));

    /* Sortér: adresser først, derefter BFE-numre */
    ejendomme.sort((a, b) => {
      if (a.adresse && !b.adresse) return -1;
      if (!a.adresse && b.adresse) return 1;
      if (a.adresse && b.adresse) return a.adresse.localeCompare(b.adresse, 'da');
      return a.bfeNummer - b.bfeNummer;
    });

    // BIZZ-521 follow-up: kortere cache når nogen adresser mangler, så
    // midlertidigt tomme VP-resultater ikke holder i 30 min på CDN'en.
    // Fuld cache kun når alle ejendomme har adresse — da er data stabile.
    const anyMissingAddress = ejendomme.some((e) => !e.adresse);
    const cacheHeader = anyMissingAddress
      ? 'public, s-maxage=60, stale-while-revalidate=30'
      : 'public, s-maxage=1800, stale-while-revalidate=300';

    return NextResponse.json(
      {
        ejendomme,
        totalBfe,
        offset,
        limit,
        manglerNoegle: false,
        manglerAdgang: false,
        fejl: null,
      },
      {
        headers: { 'Cache-Control': cacheHeader },
      }
    );
  } catch (err) {
    logger.error('[ejendomme-by-owner] Fejl:', err instanceof Error ? err.message : err);
    const body =
      process.env.NODE_ENV === 'development'
        ? {
            ejendomme: [],
            totalBfe: 0,
            offset,
            limit,
            manglerNoegle: false,
            manglerAdgang: false,
            fejl: 'Intern serverfejl',
            dev_detail: err instanceof Error ? err.message : 'Ukendt fejl',
          }
        : {
            ejendomme: [],
            totalBfe: 0,
            offset,
            limit,
            manglerNoegle: false,
            manglerAdgang: false,
            fejl: 'Intern serverfejl',
          };
    return NextResponse.json(body);
  }
}
