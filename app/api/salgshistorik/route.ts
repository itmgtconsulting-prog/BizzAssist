/**
 * GET /api/salgshistorik
 *
 * Henter historiske salgsoplysninger fra Datafordeler EJF GraphQL v1.
 * Bruger samme OAuth-flow som /api/ejerskab.
 *
 * Endpoint: https://graphql.datafordeler.dk/EJF/v1
 *
 * Schema (verificeret via EJF.graphql 2026-03-27):
 *   Trin 1: EJF_Ejerskifte  → filtrér på bestemtFastEjendomBFENr → hent handelsoplysningerLokalId
 *   Trin 2: EJF_Handelsoplysninger → filtrér på id_lokalId ∈ [ids] → hent prisdata
 *
 * @param request - Next.js request med ?bfeNummer=xxx
 * @returns { handler: HandelData[], fejl, manglerNoegle, manglerAdgang }
 */

import { NextRequest, NextResponse } from 'next/server';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';

// ─── Types ───────────────────────────────────────────────────────────────────

/** En enkelt historisk handel fra Ejerfortegnelsen */
export interface HandelData {
  /** Kontant købesum i DKK */
  kontantKoebesum: number | null;
  /** Samlet købesum (inkl. løsøre etc.) */
  samletKoebesum: number | null;
  /** Løsøreværdi */
  loesoeresum: number | null;
  /** Entreprisesum */
  entreprisesum: number | null;
  /** Dato for købsaftale (ISO 8601) */
  koebsaftaleDato: string | null;
  /** Overtagelsesdato fra ejerskifte (ISO 8601) */
  overtagelsesdato: string | null;
  /** Overdragelsesmåde (frit salg, arv, gave, tvangsauktion, etc.) */
  overdragelsesmaade: string | null;
  /** Valutakode (typisk DKK) */
  valutakode: string | null;
}

/** API-svaret fra denne route */
export interface SalgshistorikResponse {
  bfeNummer: number | null;
  handler: HandelData[];
  fejl: string | null;
  manglerNoegle: boolean;
  manglerAdgang: boolean;
}

// ─── Datafordeler EJF GraphQL ────────────────────────────────────────────────

const EJF_GQL_URL = 'https://graphql.datafordeler.dk/EJF/v1';
const TOKEN_URL = 'https://auth.datafordeler.dk/realms/distribution/protocol/openid-connect/token';

/** OAuth token cache */
let _cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Henter et gyldigt OAuth Bearer token fra Datafordeler.
 * Cacher tokenet i serverprocessen — fornyer automatisk 60 sek. inden udløb.
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

// ─── Rå typer fra EJF GraphQL schema ────────────────────────────────────────

/** EJF_Ejerskifte — kobler BFE til handelsoplysning */
interface RawEjerskifte {
  bestemtFastEjendomBFENr: number | null;
  overtagelsesdato: string | null;
  overdragelsesmaade: string | null;
  handelsoplysningerLokalId: string | null;
  status: string | null;
}

/** EJF_Handelsoplysninger — prisdata for en handel */
interface RawHandelsoplysning {
  id_lokalId: string;
  kontantKoebesum: number | null;
  samletKoebesum: number | null;
  loesoeresum: number | null;
  entreprisesum: number | null;
  koebsaftaleDato: string | null;
  valutakode: string | null;
  status: string | null;
}

// ─── GraphQL helpers ─────────────────────────────────────────────────────────

interface GqlResult<T> {
  data?: Record<string, { nodes?: T[] }>;
  errors?: { message: string; extensions?: { code?: string } }[];
}

/**
 * Sender GraphQL query til EJF.
 *
 * @returns nodes + authError flag, eller null ved netværk/parsefejl
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

    // Auth-fejl kan komme som GraphQL error selv ved 200
    const authErr =
      json.errors?.some(
        (e) => e.extensions?.code === 'DAF-AUTH-0001' || e.message?.includes('not authorized')
      ) ?? false;
    if (authErr) return { nodes: [], authError: true };

    // Schema/field-fejl
    if (json.errors?.length && !json.data?.[entityName]) {
      console.warn(`[salgshistorik] ${entityName} fejl:`, json.errors[0].message);
      return null;
    }

    return {
      nodes: json.data?.[entityName]?.nodes ?? [],
      authError: false,
    };
  } catch (err) {
    console.error('[salgshistorik] queryEJF netværksfejl:', err);
    return null;
  }
}

// ─── Route handler ───────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse<SalgshistorikResponse>> {
  const clientId = process.env.DATAFORDELER_OAUTH_CLIENT_ID;
  const clientSecret = process.env.DATAFORDELER_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { bfeNummer: null, handler: [], fejl: null, manglerNoegle: true, manglerAdgang: false },
      { status: 200 }
    );
  }

  const { searchParams } = request.nextUrl;
  const bfeStr = searchParams.get('bfeNummer');

  if (!bfeStr || !/^\d+$/.test(bfeStr)) {
    return NextResponse.json(
      {
        bfeNummer: null,
        handler: [],
        fejl: 'Ugyldigt eller manglende bfeNummer',
        manglerNoegle: false,
        manglerAdgang: false,
      },
      { status: 400 }
    );
  }

  const bfeNummer = parseInt(bfeStr, 10);

  const token = await getOAuthToken();
  if (!token) {
    return NextResponse.json(
      {
        bfeNummer,
        handler: [],
        fejl: 'OAuth token kunne ikke hentes',
        manglerNoegle: false,
        manglerAdgang: false,
      },
      { status: 200 }
    );
  }

  try {
    // ── Trin 1: Hent ejerskifter for BFE → få handelsoplysningerLokalId ──
    const ejerskifteQuery = `{
      EJF_Ejerskifte(
        first: 200
        where: {
          bestemtFastEjendomBFENr: { eq: ${bfeNummer} }
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
        { bfeNummer, handler: [], fejl: null, manglerNoegle: false, manglerAdgang: true },
        { status: 200 }
      );
    }

    if (!ejerskifteResult) {
      return NextResponse.json(
        {
          bfeNummer,
          handler: [],
          fejl: 'EJF_Ejerskifte query fejlede',
          manglerNoegle: false,
          manglerAdgang: false,
        },
        { status: 200 }
      );
    }

    const ejerskifter = ejerskifteResult.nodes;

    // Saml unikke handelsoplysningerLokalIds
    const handelsIds = [
      ...new Set(
        ejerskifter
          .map((e) => e.handelsoplysningerLokalId)
          .filter((id): id is string => id != null && id.length > 0)
      ),
    ];

    // Hvis ingen handelsoplysninger → returner ejerskifter uden prisdata
    if (handelsIds.length === 0) {
      const handler: HandelData[] = ejerskifter
        .filter((e) => e.overtagelsesdato != null)
        .map((e) => ({
          kontantKoebesum: null,
          samletKoebesum: null,
          loesoeresum: null,
          entreprisesum: null,
          koebsaftaleDato: null,
          overtagelsesdato: e.overtagelsesdato,
          overdragelsesmaade: e.overdragelsesmaade ?? null,
          valutakode: null,
        }))
        .sort((a, b) => (b.overtagelsesdato ?? '').localeCompare(a.overtagelsesdato ?? ''));

      return NextResponse.json(
        { bfeNummer, handler, fejl: null, manglerNoegle: false, manglerAdgang: false },
        {
          status: 200,
          headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
        }
      );
    }

    // ── Trin 2: Hent handelsoplysninger via id_lokalId ──
    const idsStr = handelsIds.map((id) => `"${id}"`).join(', ');
    const handelsQuery = `{
      EJF_Handelsoplysninger(
        first: 200
        where: {
          id_lokalId: { in: [${idsStr}] }
        }
      ) {
        nodes {
          id_lokalId
          kontantKoebesum
          samletKoebesum
          loesoeresum
          entreprisesum
          koebsaftaleDato
          valutakode
          status
        }
      }
    }`;

    const handelsResult = await queryEJF<RawHandelsoplysning>(
      handelsQuery,
      'EJF_Handelsoplysninger',
      token
    );

    if (handelsResult?.authError) {
      return NextResponse.json(
        { bfeNummer, handler: [], fejl: null, manglerNoegle: false, manglerAdgang: true },
        { status: 200 }
      );
    }

    // Byg opslag: handelsoplysningerLokalId → prisdata
    const handelsMap = new Map<string, RawHandelsoplysning>();
    if (handelsResult?.nodes) {
      for (const h of handelsResult.nodes) {
        handelsMap.set(h.id_lokalId, h);
      }
    }

    // ── Sammenkobl ejerskifter med handelsoplysninger ──
    const handler: HandelData[] = ejerskifter
      .map((e) => {
        const h = e.handelsoplysningerLokalId
          ? handelsMap.get(e.handelsoplysningerLokalId)
          : undefined;
        return {
          kontantKoebesum: h?.kontantKoebesum ?? null,
          samletKoebesum: h?.samletKoebesum ?? null,
          loesoeresum: h?.loesoeresum ?? null,
          entreprisesum: h?.entreprisesum ?? null,
          koebsaftaleDato: h?.koebsaftaleDato ?? null,
          overtagelsesdato: e.overtagelsesdato ?? null,
          overdragelsesmaade: e.overdragelsesmaade ?? null,
          valutakode: h?.valutakode ?? null,
        };
      })
      .filter(
        (h) => h.kontantKoebesum != null || h.samletKoebesum != null || h.overtagelsesdato != null
      )
      .sort((a, b) => {
        const da = a.koebsaftaleDato ?? a.overtagelsesdato ?? '';
        const db = b.koebsaftaleDato ?? b.overtagelsesdato ?? '';
        return db.localeCompare(da); // nyeste først
      });

    console.log(
      `[salgshistorik] ${handler.length} handler fundet for BFE ${bfeNummer} (${ejerskifter.length} ejerskifter, ${handelsIds.length} handelsoplysninger)`
    );

    return NextResponse.json(
      { bfeNummer, handler, fejl: null, manglerNoegle: false, manglerAdgang: false },
      {
        status: 200,
        headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
      }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ukendt fejl';
    return NextResponse.json(
      {
        bfeNummer,
        handler: [],
        fejl: `Netværksfejl: ${msg}`,
        manglerNoegle: false,
        manglerAdgang: false,
      },
      { status: 200 }
    );
  }
}
