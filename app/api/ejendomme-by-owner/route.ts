/**
 * GET /api/ejendomme-by-owner
 *
 * Finder alle ejendomme ejet af en eller flere virksomheder (CVR-numre).
 * Bruges til at vise ejendomsportefølje på virksomheds- og ejersider.
 *
 * Flow:
 *   1. For hvert CVR: forespørg EJF_Ejerskab GraphQL med ejendeVirksomhedCVRNr filter
 *      og virkningstid=nu for at finde aktuelt ejede BFE-numre
 *   2. For hvert unikt BFE: hent adressedata via DAWA /bfe/{bfe} endpoint
 *   3. Returner beriget liste med adresse, ejendomstype og DAWA-id til detaljeside-link
 *
 * Autentificering: OAuth Shared Secret (primær) + mTLS Certifikat (fallback).
 * Kræver: DATAFORDELER_OAUTH_CLIENT_ID + DATAFORDELER_OAUTH_CLIENT_SECRET
 *
 * @param cvr - Kommasepareret liste af CVR-numre (maks. 30)
 * @returns { ejendomme: EjendomSummary[], totalBfe: number, manglerNoegle: boolean, manglerAdgang: boolean, fejl: string | null }
 */

import { NextRequest, NextResponse } from 'next/server';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';
import { getCertOAuthToken, isCertAuthConfigured } from '@/app/lib/dfCertAuth';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';

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

const EJF_GQL_URL = 'https://graphql.datafordeler.dk/flexibleCurrent/v1/';
const TOKEN_URL = 'https://auth.datafordeler.dk/realms/distribution/protocol/openid-connect/token';

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
async function getOAuthToken(): Promise<string | null> {
  if (_cachedToken && Date.now() < _cachedToken.expiresAt - 60_000) {
    return _cachedToken.token;
  }

  const clientId = process.env.DATAFORDELER_OAUTH_CLIENT_ID;
  const clientSecret = process.env.DATAFORDELER_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  try {
    const res = await fetch(proxyUrl(TOKEN_URL), {
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
): Promise<{ bfeNumre: number[]; authError: boolean } | null> {
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
      }
    }
  }`;

  try {
    const res = await fetch(proxyUrl(EJF_GQL_URL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...proxyHeaders(),
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(proxyTimeout()),
      next: { revalidate: 3600 },
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
    const res = await fetch(`https://api.dataforsyningen.dk/bfe/${bfe}`, {
      signal: AbortSignal.timeout(6000),
      next: { revalidate: 86400 },
    });
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

    /* Fallback: jordstykker → ejerlav */
    const js = json.jordstykker?.[0];
    if (js?.ejerlav?.navn) {
      return {
        adresse: js.ejerlav.navn,
        postnr: null,
        by: null,
        kommune: js.kommune?.navn ?? null,
        kommuneKode: js.kommune?.kode ?? null,
        ejendomstype: json.ejendomstype ?? null,
        dawaId: js.husnumre?.[0]?.id ?? null,
      };
    }

    return { ...empty, ejendomstype: json.ejendomstype ?? null };
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
  const promise = _hentDawaBfeDataImpl(bfe);
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

  if (!cvrParam) {
    return NextResponse.json(
      {
        ejendomme: [],
        totalBfe: 0,
        offset,
        limit,
        manglerNoegle: false,
        manglerAdgang: false,
        fejl: 'cvr parameter er påkrævet',
      },
      { status: 400 }
    );
  }

  /* Parsér og validér CVR-numre */
  const rawCvrs = cvrParam
    .split(',')
    .map((s) => s.trim().replace(/\D/g, ''))
    .filter((s) => s.length >= 7 && s.length <= 8);

  if (rawCvrs.length === 0) {
    return NextResponse.json(
      {
        ejendomme: [],
        totalBfe: 0,
        offset,
        limit,
        manglerNoegle: false,
        manglerAdgang: false,
        fejl: 'Ingen gyldige CVR-numre angivet',
      },
      { status: 400 }
    );
  }

  const cvrNumre = [...new Set(rawCvrs.map((s) => parseInt(s, 10)))].slice(0, MAX_CVR);

  /* Hent OAuth token */
  let token: string | null = null;

  if (hasSharedSecret) {
    token = await getOAuthToken();
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
    /* ── Trin 1: Find alle BFE-numre ejet af de angivne CVR-numre (parallelt) ── */
    // Use Promise.allSettled so a single failing CVR lookup doesn't abort the whole request.
    // Failed lookups are logged and skipped; fulfilled results are processed normally.
    const ejerskabSettled = await Promise.allSettled(
      cvrNumre.map((cvr) => hentBfeByCvr(cvr, token!))
    );

    const ejerskabResults = ejerskabSettled.map((settled, i) => {
      if (settled.status === 'rejected') {
        logger.error(
          `[ejendomme-by-owner] EJF CVR lookup failed for CVR ${cvrNumre[i]}:`,
          settled.reason
        );
        return null;
      }
      return settled.value;
    });

    /* Tjek om nogen returnerede auth-fejl */
    const harAuthFejl = ejerskabResults.some((r) => r?.authError === true);
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

    /* Saml unikke BFE-numre med tilhørende ejer-CVR */
    const bfeTilCvr = new Map<number, string>();
    for (let i = 0; i < cvrNumre.length; i++) {
      const result = ejerskabResults[i];
      if (!result) continue;
      for (const bfe of result.bfeNumre) {
        if (!bfeTilCvr.has(bfe)) {
          bfeTilCvr.set(bfe, String(cvrNumre[i]).padStart(8, '0'));
        }
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

    /* Sortér BFE-numre for konsistent paginering på tværs af batches */
    alleBfe.sort((a, b) => a - b);

    /* Afgræns batch baseret på offset + limit */
    const begransetBfe = alleBfe.slice(offset, offset + limit);

    /* ── Trin 2: Hent adressedata for hvert BFE (begrænset parallelisme) ── */
    const adresseData = await pMap(begransetBfe, DAWA_CONCURRENCY, hentDawaBfeData);

    /* ── Trin 3: Saml resultater ── */
    const ejendomme: EjendomSummary[] = begransetBfe.map((bfe, idx) => ({
      bfeNummer: bfe,
      ownerCvr: bfeTilCvr.get(bfe) ?? '',
      ...adresseData[idx],
    }));

    /* Sortér: adresser først, derefter BFE-numre */
    ejendomme.sort((a, b) => {
      if (a.adresse && !b.adresse) return -1;
      if (!a.adresse && b.adresse) return 1;
      if (a.adresse && b.adresse) return a.adresse.localeCompare(b.adresse, 'da');
      return a.bfeNummer - b.bfeNummer;
    });

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
        headers: { 'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=300' },
      }
    );
  } catch (err) {
    logger.error('[ejendomme-by-owner] Fejl:', err instanceof Error ? err.message : err);
    return NextResponse.json({
      ejendomme: [],
      totalBfe: 0,
      offset,
      limit,
      manglerNoegle: false,
      manglerAdgang: false,
      fejl: err instanceof Error ? err.message : 'Ukendt fejl',
    });
  }
}
