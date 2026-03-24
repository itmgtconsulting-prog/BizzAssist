/**
 * GET /api/vurdering
 *
 * Henter ejendomsvurdering (offentlig ejendomsværdi + grundværdi) fra
 * Datafordeler VUR GraphQL v2.
 *
 * Flow:
 *   1. Hent OAuth Bearer token via client_credentials (BizzAssist-Dev2 Shared Secret)
 *   2. Forespørg VUR_BFEKrydsreference for at finde vurdering-IDs for BFEnummeret
 *   3. Forespørg VUR_Ejendomsvurdering for alle fundne IDs
 *   4. Returner den nyeste vurdering (højeste aar)
 *
 * Authentication: OAuth 2.0 client_credentials (DATAFORDELER_OAUTH_CLIENT_ID + SECRET)
 * Token endpoint: https://auth.datafordeler.dk/realms/distribution/protocol/openid-connect/token
 *
 * @param request - Next.js request med ?bfeNummer=xxx
 * @returns { vurdering: VurderingData | null, fejl: string | null }
 */

import { NextRequest, NextResponse } from 'next/server';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Ejendomsvurderingsdata returneret til klienten */
export interface VurderingData {
  bfeNummer: number;
  /** Offentlig ejendomsværdi i DKK */
  ejendomsvaerdi: number | null;
  /** Grundværdi i DKK */
  grundvaerdi: number | null;
  /** Vurderingsår */
  aar: number | null;
  /** Bebyggelsesprocent (0–100) */
  bebyggelsesprocent: number | null;
  /** Vurderet areal i m² */
  vurderetAreal: number | null;
  /** Benyttelses-kode */
  benyttelseskode: string | null;
}

/** API-svaret fra denne route */
export interface VurderingResponse {
  vurdering: VurderingData | null;
  fejl: string | null;
  manglerNoegle: boolean;
}

// ─── Rå typer fra VUR GraphQL ─────────────────────────────────────────────

interface RawVURBFEKrydsreference {
  fkEjendomsvurderingID: number;
}

interface RawVURVurdering {
  id: number;
  aar: number | null;
  /** NB: feltnavn i VUR-schema er ejendomvaerdiBeloeb (uden 's') */
  ejendomvaerdiBeloeb: number | null;
  grundvaerdiBeloeb: number | null;
  vurderetAreal: number | null;
  benyttelseKode: string | null;
}

// ─── OAuth token cache (modul-niveau, lever i serverprocessens levetid) ────

const VUR_GQL_URL = 'https://graphql.datafordeler.dk/VUR/v2';
const TOKEN_URL = 'https://auth.datafordeler.dk/realms/distribution/protocol/openid-connect/token';

let _cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Henter et gyldigt OAuth Bearer token fra Datafordeler.
 * Cacher tokenet i serverprocessen — fornyar automatisk 60 sek. inden udløb.
 *
 * @returns Bearer token som streng, eller null hvis auth-miljøvariabler mangler
 */
async function getOAuthToken(): Promise<string | null> {
  if (_cachedToken && Date.now() < _cachedToken.expiresAt - 60_000) {
    return _cachedToken.token;
  }

  const clientId = process.env.DATAFORDELER_OAUTH_CLIENT_ID;
  const clientSecret = process.env.DATAFORDELER_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${encodeURIComponent(clientSecret)}`,
      signal: AbortSignal.timeout(8000),
      // Aldrig cache token-requests
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

/**
 * Sender en GraphQL-forespørgsel til Datafordeler VUR/v2 med Bearer token.
 *
 * @param query - GraphQL query string (inline, uden variabler)
 * @param token - OAuth Bearer token
 * @returns Parsed JSON svar eller null ved fejl
 */
async function fetchVURGraphQL(
  query: string,
  token: string
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(VUR_GQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables: {} }),
      signal: AbortSignal.timeout(8000),
      next: { revalidate: 86400 }, // 24 timer — vurderinger ændres sjældent
    });
    if (!res.ok) return null;

    const json = (await res.json()) as {
      data?: Record<string, unknown>;
      errors?: unknown[];
    };
    if (json.errors?.length) return null;
    return json.data ?? null;
  } catch {
    return null;
  }
}

// ─── Route handler ───────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse<VurderingResponse>> {
  const clientId = process.env.DATAFORDELER_OAUTH_CLIENT_ID;
  const clientSecret = process.env.DATAFORDELER_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return NextResponse.json({ vurdering: null, fejl: null, manglerNoegle: true }, { status: 200 });
  }

  const { searchParams } = request.nextUrl;
  const bfeNummerStr = searchParams.get('bfeNummer');

  if (!bfeNummerStr || !/^\d+$/.test(bfeNummerStr)) {
    return NextResponse.json(
      { vurdering: null, fejl: 'Ugyldigt eller manglende bfeNummer', manglerNoegle: false },
      { status: 400 }
    );
  }

  const bfeNummer = parseInt(bfeNummerStr, 10);

  // Hent OAuth token
  const token = await getOAuthToken();
  if (!token) {
    return NextResponse.json(
      {
        vurdering: null,
        fejl: 'OAuth token kunne ikke hentes — tjek DATAFORDELER_OAUTH_CLIENT_ID og _SECRET',
        manglerNoegle: false,
      },
      { status: 200 }
    );
  }

  try {
    // Trin 1: Find vurderings-IDs via BFEKrydsreference
    const xrefQuery = `{
      VUR_BFEKrydsreference(first: 20, where: { BFEnummer: { eq: ${bfeNummer} } }) {
        nodes { fkEjendomsvurderingID }
      }
    }`;
    const xrefData = await fetchVURGraphQL(xrefQuery, token);

    const xrefNodes = (
      xrefData?.['VUR_BFEKrydsreference'] as { nodes: RawVURBFEKrydsreference[] } | undefined
    )?.nodes;

    if (!xrefNodes?.length) {
      return NextResponse.json(
        {
          vurdering: null,
          fejl: 'Ingen vurderingsdata fundet for dette BFEnummer',
          manglerNoegle: false,
        },
        { status: 200 }
      );
    }

    // Trin 2: Hent alle vurderinger for de fundne IDs
    const ids = xrefNodes.map((n) => n.fkEjendomsvurderingID);
    const inClause = ids.join(', ');

    const vurQuery = `{
      VUR_Ejendomsvurdering(
        first: ${ids.length},
        where: { id: { in: [${inClause}] } }
      ) {
        nodes {
          id
          aar
          ejendomvaerdiBeloeb
          grundvaerdiBeloeb
          vurderetAreal
          benyttelseKode
        }
      }
    }`;
    const vurData = await fetchVURGraphQL(vurQuery, token);

    const vurNodes = (
      vurData?.['VUR_Ejendomsvurdering'] as { nodes: RawVURVurdering[] } | undefined
    )?.nodes;

    if (!vurNodes?.length) {
      return NextResponse.json(
        {
          vurdering: null,
          fejl: 'Ingen vurderingsdata fundet for dette BFEnummer',
          manglerNoegle: false,
        },
        { status: 200 }
      );
    }

    // Returner den nyeste vurdering (højeste aar)
    const newest = vurNodes.reduce<RawVURVurdering>(
      (best, curr) => ((curr.aar ?? 0) > (best.aar ?? 0) ? curr : best),
      vurNodes[0]
    );

    const vurdering: VurderingData = {
      bfeNummer,
      ejendomsvaerdi: newest.ejendomvaerdiBeloeb ?? null,
      grundvaerdi: newest.grundvaerdiBeloeb ?? null,
      aar: newest.aar ?? null,
      bebyggelsesprocent: null,
      vurderetAreal: newest.vurderetAreal ?? null,
      benyttelseskode: newest.benyttelseKode ?? null,
    };

    return NextResponse.json(
      { vurdering, fejl: null, manglerNoegle: false },
      {
        status: 200,
        headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' },
      }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ukendt fejl';
    return NextResponse.json(
      { vurdering: null, fejl: `Fejl: ${msg}`, manglerNoegle: false },
      { status: 200 }
    );
  }
}
