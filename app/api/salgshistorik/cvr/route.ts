/**
 * GET /api/salgshistorik/cvr
 *
 * Henter ejendomshandler for en virksomhed (CVR).
 *
 * Flow:
 *   1. Find alle BFE-numre ejet af CVR via EJF_Ejerskab
 *   2. Hent ejerskifter for alle BFE'er via EJF_Ejerskifte
 *   3. Hent prisdata via EJF_Handelsoplysninger
 *   4. Hent adresser via DAWA BFE-opslag
 *
 * @param request - Next.js request med ?cvr=xxxxxxxx
 * @returns { handler: CvrHandelData[], fejl, manglerNoegle, manglerAdgang }
 */

import { NextRequest, NextResponse } from 'next/server';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';
import { logger } from '@/app/lib/logger';
import { getSharedOAuthToken } from '@/app/lib/dfTokenCache';
import { resolveTenantId } from '@/lib/api/auth';

// ─── Types ───────────────────────────────────────────────────────────────────

/** En ejendomshandel knyttet til en virksomhed */
export interface CvrHandelData {
  /** BFE-nummer for ejendommen */
  bfeNummer: number;
  /** Ejendomsadresse (fra DAWA) */
  adresse: string | null;
  /** Postnummer */
  postnr: string | null;
  /** By */
  by: string | null;
  /** Kommune */
  kommune: string | null;
  /** Kontant købesum i DKK */
  kontantKoebesum: number | null;
  /** Samlet købesum */
  samletKoebesum: number | null;
  /** Dato for købsaftale (ISO 8601) */
  koebsaftaleDato: string | null;
  /** Overtagelsesdato (ISO 8601) */
  overtagelsesdato: string | null;
  /** Overdragelsesmåde (frit salg, arv, gave, etc.) */
  overdragelsesmaade: string | null;
  /** Valutakode */
  valutakode: string | null;
  /** Om virksomheden er køber eller sælger i denne handel */
  rolle: 'koeber' | 'saelger' | 'ukendt';
}

/** API-svaret */
export interface CvrSalgshistorikResponse {
  cvr: string;
  handler: CvrHandelData[];
  fejl: string | null;
  manglerNoegle: boolean;
  manglerAdgang: boolean;
}

// ─── Datafordeler EJF GraphQL ────────────────────────────────────────────────

const EJF_GQL_URL = 'https://graphql.datafordeler.dk/flexibleCurrent/v1/';
const TOKEN_URL = 'https://auth.datafordeler.dk/realms/distribution/protocol/openid-connect/token';

let _cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Henter gyldigt OAuth Bearer token fra Datafordeler.
 *
 * @returns Bearer token eller null
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
    _cachedToken = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return _cachedToken.token;
  } catch {
    return null;
  }
}

// ─── Rå typer ────────────────────────────────────────────────────────────────

interface RawEjerskab {
  bestemtFastEjendomBFENr: number | null;
  ejendeVirksomhedCVRNr: number | null;
  virkningFra: string | null;
}

interface RawEjerskifte {
  bestemtFastEjendomBFENr: number | null;
  overtagelsesdato: string | null;
  overdragelsesmaade: string | null;
  handelsoplysningerLokalId: string | null;
  status: string | null;
}

interface RawHandelsoplysning {
  id_lokalId: string;
  kontantKoebesum: number | null;
  samletKoebesum: number | null;
  koebsaftaleDato: string | null;
  valutakode: string | null;
}

interface GqlResult<T> {
  data?: Record<string, { nodes?: T[] }>;
  errors?: { message: string; extensions?: { code?: string } }[];
}

/**
 * Sender GraphQL query til EJF.
 *
 * @returns nodes + authError flag
 */
async function queryEJF<T>(
  query: string,
  entityName: string,
  token: string
): Promise<{ nodes: T[]; authError: boolean } | null> {
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
    if (res.status === 403) return { nodes: [], authError: true };
    if (!res.ok) return null;

    const json = (await res.json()) as GqlResult<T>;
    const authErr =
      json.errors?.some(
        (e) => e.extensions?.code === 'DAF-AUTH-0001' || e.message?.includes('not authorized')
      ) ?? false;
    if (authErr) return { nodes: [], authError: true };
    if (json.errors?.length && !json.data?.[entityName]) return null;

    return { nodes: json.data?.[entityName]?.nodes ?? [], authError: false };
  } catch {
    return null;
  }
}

// ─── DAWA BFE → adresse ─────────────────────────────────────────────────────

interface DawaBfeResult {
  adresse: string | null;
  postnr: string | null;
  by: string | null;
  kommune: string | null;
}

/**
 * Henter ejendomsadresse fra DAWA via BFE-nummer.
 *
 * @param bfe - BFE-nummer
 * @returns Adresse-info eller tomme felter
 */
async function hentAdresseFraBfe(bfe: number): Promise<DawaBfeResult> {
  const empty: DawaBfeResult = { adresse: null, postnr: null, by: null, kommune: null };
  try {
    const res = await fetch(`https://api.dataforsyningen.dk/bfe/${bfe}`, {
      signal: AbortSignal.timeout(5000),
      next: { revalidate: 86400 },
    });
    if (!res.ok) return empty;
    const json = await res.json();

    /* DAWA BFE response har jordstykke[].ejerlav + husnumre (beliggenhedsadresse) */
    const beliggenhed = json?.beliggenhedsadresse;
    if (beliggenhed) {
      return {
        adresse: beliggenhed.vejnavn
          ? `${beliggenhed.vejnavn} ${beliggenhed.husnr ?? ''}`.trim()
          : null,
        postnr: beliggenhed.postnr ?? null,
        by: beliggenhed.postnrnavn ?? null,
        kommune: beliggenhed.kommunenavn ?? null,
      };
    }

    /* Fallback: jordstykker → ejerlav */
    const js = json?.jordstykker?.[0];
    if (js?.ejerlav?.navn) {
      return {
        adresse: js.ejerlav.navn,
        postnr: null,
        by: null,
        kommune: js.kommune?.navn ?? null,
      };
    }

    return empty;
  } catch {
    return empty;
  }
}

// ─── Route handler ───────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse<CvrSalgshistorikResponse>> {
  const auth = await resolveTenantId();
  if (!auth)
    return NextResponse.json({ error: 'Unauthorized' } as unknown as CvrSalgshistorikResponse, {
      status: 401,
    });
  const clientId = process.env.DATAFORDELER_OAUTH_CLIENT_ID;
  const clientSecret = process.env.DATAFORDELER_OAUTH_CLIENT_SECRET;

  const { searchParams } = request.nextUrl;
  const cvr = searchParams.get('cvr') ?? '';

  if (!cvr || !/^\d{8}$/.test(cvr)) {
    return NextResponse.json(
      { cvr, handler: [], fejl: 'Ugyldigt CVR-nummer', manglerNoegle: false, manglerAdgang: false },
      { status: 400 }
    );
  }

  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { cvr, handler: [], fejl: null, manglerNoegle: true, manglerAdgang: false },
      { status: 200 }
    );
  }

  const token = await getSharedOAuthToken();
  if (!token) {
    return NextResponse.json(
      { cvr, handler: [], fejl: 'OAuth token fejl', manglerNoegle: false, manglerAdgang: false },
      { status: 200 }
    );
  }

  try {
    // ── Trin 1: Find alle BFE-numre ejet af CVR (nuværende + historiske) ──
    const ejerskabQuery = `{
      EJFCustom_EjerskabBegraenset(
        first: 500
        where: {
          ejendeVirksomhedCVRNr: { eq: ${parseInt(cvr, 10)} }
        }
      ) {
        nodes {
          bestemtFastEjendomBFENr
          ejendeVirksomhedCVRNr
          virkningFra
        }
      }
    }`;

    const ejerskabResult = await queryEJF<RawEjerskab>(
      ejerskabQuery,
      'EJFCustom_EjerskabBegraenset',
      token
    );
    if (ejerskabResult?.authError) {
      return NextResponse.json(
        { cvr, handler: [], fejl: null, manglerNoegle: false, manglerAdgang: true },
        { status: 200 }
      );
    }
    if (!ejerskabResult) {
      return NextResponse.json(
        {
          cvr,
          handler: [],
          fejl: 'EJF_Ejerskab query fejlede',
          manglerNoegle: false,
          manglerAdgang: false,
        },
        { status: 200 }
      );
    }

    const bfeNrSet = new Set<number>();
    for (const e of ejerskabResult.nodes) {
      if (e.bestemtFastEjendomBFENr != null) bfeNrSet.add(e.bestemtFastEjendomBFENr);
    }

    if (bfeNrSet.size === 0) {
      return NextResponse.json(
        { cvr, handler: [], fejl: null, manglerNoegle: false, manglerAdgang: false },
        {
          status: 200,
          headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
        }
      );
    }

    const bfeList = [...bfeNrSet];

    // ── Trin 2: Hent ejerskifter for alle BFE'er ──
    const bfeFilter = bfeList.map((b) => b.toString()).join(', ');
    const ejerskifteQuery = `{
      EJF_Ejerskifte(
        first: 1000
        where: {
          bestemtFastEjendomBFENr: { in: [${bfeFilter}] }
        }
      ) {
        nodes {
          bestemtFastEjendomBFENr
          overtagelsesdato
          overdragelsesmaade
          handelsoplysningerLokalId
          status
        }
      }
    }`;

    const ejerskifteResult = await queryEJF<RawEjerskifte>(
      ejerskifteQuery,
      'EJF_Ejerskifte',
      token
    );
    if (ejerskifteResult?.authError) {
      return NextResponse.json(
        { cvr, handler: [], fejl: null, manglerNoegle: false, manglerAdgang: true },
        { status: 200 }
      );
    }

    const ejerskifter = ejerskifteResult?.nodes ?? [];

    // ── Trin 3: Hent handelsoplysninger ──
    const handelsIds = [
      ...new Set(
        ejerskifter
          .map((e) => e.handelsoplysningerLokalId)
          .filter((id): id is string => id != null && id.length > 0)
      ),
    ];

    const handelsMap = new Map<string, RawHandelsoplysning>();
    if (handelsIds.length > 0) {
      const idsStr = handelsIds.map((id) => `"${id}"`).join(', ');
      const handelsQuery = `{
        EJF_Handelsoplysninger(
          first: 1000
          where: { id_lokalId: { in: [${idsStr}] } }
        ) {
          nodes {
            id_lokalId
            kontantKoebesum
            samletKoebesum
            koebsaftaleDato
            valutakode
          }
        }
      }`;

      const handelsResult = await queryEJF<RawHandelsoplysning>(
        handelsQuery,
        'EJF_Handelsoplysninger',
        token
      );
      if (handelsResult?.nodes) {
        for (const h of handelsResult.nodes) handelsMap.set(h.id_lokalId, h);
      }
    }

    // ── Trin 4: Hent adresser for alle BFE'er (parallel) ──
    const adresseMap = new Map<number, DawaBfeResult>();
    const adressePromises = bfeList.map(async (bfe) => {
      const adr = await hentAdresseFraBfe(bfe);
      adresseMap.set(bfe, adr);
    });
    await Promise.allSettled(adressePromises);

    // ── Trin 5: Byg ejerskab-set for CVR (hvornår CVR ejede hver BFE) ──
    const cvrEjerskabMap = new Map<number, string | null>();
    for (const e of ejerskabResult.nodes) {
      if (e.bestemtFastEjendomBFENr != null) {
        cvrEjerskabMap.set(e.bestemtFastEjendomBFENr, e.virkningFra);
      }
    }

    // ── Sammenkobl data ──
    const handler = ejerskifter
      .map((e): CvrHandelData | null => {
        const bfe = e.bestemtFastEjendomBFENr;
        if (bfe == null) return null;

        const h = e.handelsoplysningerLokalId
          ? handelsMap.get(e.handelsoplysningerLokalId)
          : undefined;
        const adr = adresseMap.get(bfe);
        const _dato = h?.koebsaftaleDato ?? e.overtagelsesdato ?? '';

        /* Bestem rolle: Hvis overtagelsesdato ≈ ejerskab virkningFra → CVR er køber */
        const ejerskabStart = cvrEjerskabMap.get(bfe);
        let rolle: 'koeber' | 'saelger' | 'ukendt' = 'ukendt';
        if (ejerskabStart && e.overtagelsesdato) {
          const ejerskabDate = ejerskabStart.slice(0, 10);
          const handelDate = e.overtagelsesdato.slice(0, 10);
          if (ejerskabDate === handelDate) {
            rolle = 'koeber';
          } else if (ejerskabDate < handelDate) {
            rolle = 'saelger';
          } else {
            rolle = 'koeber';
          }
        }

        return {
          bfeNummer: bfe,
          adresse: adr?.adresse ?? null,
          postnr: adr?.postnr ?? null,
          by: adr?.by ?? null,
          kommune: adr?.kommune ?? null,
          kontantKoebesum: h?.kontantKoebesum ?? null,
          samletKoebesum: h?.samletKoebesum ?? null,
          koebsaftaleDato: h?.koebsaftaleDato ?? null,
          overtagelsesdato: e.overtagelsesdato ?? null,
          overdragelsesmaade: e.overdragelsesmaade ?? null,
          valutakode: h?.valutakode ?? 'DKK',
          rolle,
        } satisfies CvrHandelData;
      })
      .filter(
        (h): h is CvrHandelData =>
          h !== null &&
          (h.kontantKoebesum != null || h.samletKoebesum != null || h.overtagelsesdato != null)
      )
      .sort((a, b) => {
        const da = a.koebsaftaleDato ?? a.overtagelsesdato ?? '';
        const db = b.koebsaftaleDato ?? b.overtagelsesdato ?? '';
        return db.localeCompare(da); // nyeste først
      });

    logger.log(
      `[salgshistorik/cvr] CVR ${cvr}: ${bfeList.length} BFE'er, ${handler.length} handler`
    );

    return NextResponse.json(
      { cvr, handler, fejl: null, manglerNoegle: false, manglerAdgang: false },
      {
        status: 200,
        headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
      }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ukendt fejl';
    return NextResponse.json(
      {
        cvr,
        handler: [],
        fejl: `Netværksfejl: ${msg}`,
        manglerNoegle: false,
        manglerAdgang: false,
      },
      { status: 200 }
    );
  }
}
