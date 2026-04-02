/**
 * GET /api/ejerskab
 *
 * Henter ejeroplysninger (Ejerfortegnelsen) fra Datafordeler EJF GraphQL v1.
 *
 * Endpoint: https://graphql.datafordeler.dk/EJF/v1
 * Kræver: Dataadgang-tilladelse til EJF fra Geodatastyrelsen (ansøgning på datafordeler.dk)
 *
 * Flow:
 *   1. Hent OAuth Bearer token via client_credentials (BizzAssist-Dev2 Shared Secret)
 *   2. Forespørg EJF_Ejerskab med virkningstid=nu og bestemtFastEjendomBFENr filter
 *   3. For virksomhedsejere returneres CVR-nummer
 *   4. For personejere returneres kun ejeroplysningerLokalId (CPR kræver ekstra tilladelse)
 *
 * NB: Returnerer manglerAdgang: true hvis 403 fra Datafordeler (Dataadgang ikke godkendt endnu).
 *
 * @param request - Next.js request med ?bfeNummer=xxx
 * @returns { ejere: EjerData[], fejl: string | null, manglerNoegle: boolean, manglerAdgang: boolean }
 */

import { NextRequest, NextResponse } from 'next/server';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';
import { getCertOAuthToken, isCertAuthConfigured } from '@/app/lib/dfCertAuth';

// ─── Types ───────────────────────────────────────────────────────────────────

/** En enkelt ejer fra Ejerfortegnelsen */
export interface EjerData {
  /** CVR-nummer hvis selskabsejer — ellers null */
  cvr: string | null;
  /** Ejerandel som brøk: taeller/naevner (f.eks. 1/1 = 100%) */
  ejerandel_taeller: number | null;
  ejerandel_naevner: number | null;
  /** Ejerskab-type kode fra EJF */
  ejerforholdskode: string | null;
  /** "selskab" | "person" | "ukendt" */
  ejertype: 'selskab' | 'person' | 'ukendt';
  /** ISO 8601 dato for hvornår ejerskab trådte i kraft */
  virkningFra: string | null;
}

/** API-svaret fra denne route */
export interface EjerskabResponse {
  bfeNummer: number | null;
  ejere: EjerData[];
  fejl: string | null;
  manglerNoegle: boolean;
  /** true hvis Datafordeler returnerer 403 — Dataadgang-ansøgning mangler */
  manglerAdgang: boolean;
}

// ─── Datafordeler EJF GraphQL ────────────────────────────────────────────────

const EJF_GQL_URL = 'https://graphql.datafordeler.dk/EJF/v1';
const TOKEN_URL = 'https://auth.datafordeler.dk/realms/distribution/protocol/openid-connect/token';

/** OAuth token cache — deles med vurdering/route.ts i serverprocessen */
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

interface RawEJFEjerskab {
  bestemtFastEjendomBFENr: number | null;
  ejendeVirksomhedCVRNr: number | null;
  ejendePersonPersonNr: string | null;
  ejerforholdskode: string | null;
  faktiskEjerandel_taeller: number | null;
  faktiskEjerandel_naevner: number | null;
  status: string | null;
  virkningFra: string | null;
}

// ─── Hjælpefunktioner ─────────────────────────────────────────────────────────

/**
 * Bestemmer ejertype ud fra ejerforholdskode-streng (f.eks. fra Datafordeler).
 * Bruges som fallback når CVR/CPR-felter ikke kan afgøre typen.
 *
 * @param kode - Ejerforholdskode fra Datafordeler (f.eks. "10", "20", "S", "P")
 * @returns "selskab" | "person" | "ukendt"
 */
export function parseEjertype(kode?: string): 'selskab' | 'person' | 'ukendt' {
  if (!kode) return 'ukendt';
  const k = kode.toUpperCase().trim();
  // Numeriske koder: 10–19 = person, 20–39 = selskab/virksomhed
  const num = parseInt(k, 10);
  if (!isNaN(num)) {
    if (num >= 10 && num < 20) return 'person';
    if (num >= 20 && num < 40) return 'selskab';
  }
  // Bogstavskoder
  if (k === 'S' || k === 'SELSKAB' || k === 'K') return 'selskab';
  if (k === 'P' || k === 'PERSON' || k === 'F') return 'person';
  return 'ukendt';
}

/**
 * Bestemmer ejertype fra en rå EJF_Ejerskab node.
 * Bruger CVR/CPR-tilstedeværelse som primær indikator,
 * ejerforholdskode som fallback.
 *
 * @param raw - Rå EJF_Ejerskab node fra GraphQL
 * @returns "selskab" | "person" | "ukendt"
 */
function parseEjertypeFraNode(raw: RawEJFEjerskab): 'selskab' | 'person' | 'ukendt' {
  if (raw.ejendeVirksomhedCVRNr != null) return 'selskab';
  if (raw.ejendePersonPersonNr != null) return 'person';
  return parseEjertype(raw.ejerforholdskode ?? undefined);
}

// ─── EJF GraphQL query helper ───────────────────────────────────────────────

type EJFQueryResult =
  | { ok: true; nodes: RawEJFEjerskab[] }
  | { ok: false; manglerAdgang: boolean; fejl: string | null };

/**
 * Sender EJF GraphQL forespørgsel med et givet Bearer token.
 *
 * @param bfeNummer - BFE-nummer at slå op
 * @param token - OAuth Bearer token
 * @returns Parsed result eller fejl-info
 */
async function queryEJF(bfeNummer: number, token: string): Promise<EJFQueryResult> {
  const virkningstid = new Date().toISOString();

  const query = `{
    EJF_Ejerskab(
      first: 500
      virkningstid: "${virkningstid}"
      where: {
        bestemtFastEjendomBFENr: { eq: ${bfeNummer} }
      }
    ) {
      nodes {
        bestemtFastEjendomBFENr
        ejendeVirksomhedCVRNr
        ejendePersonPersonNr
        ejerforholdskode
        faktiskEjerandel_taeller
        faktiskEjerandel_naevner
        status
        virkningFra
      }
    }
  }`;

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

  if (res.status === 403) {
    return { ok: false, manglerAdgang: true, fejl: null };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return {
      ok: false,
      manglerAdgang: false,
      fejl: `Datafordeler EJF svarede ${res.status}: ${text.slice(0, 200)}`,
    };
  }

  const json = (await res.json()) as {
    data?: { EJF_Ejerskab?: { nodes: RawEJFEjerskab[] } };
    errors?: { message: string; extensions?: { code?: string } }[];
  };

  const authError = json.errors?.find((e) => e.extensions?.code === 'DAF-AUTH-0001');
  if (authError) {
    return { ok: false, manglerAdgang: true, fejl: null };
  }

  return { ok: true, nodes: json.data?.EJF_Ejerskab?.nodes ?? [] };
}

// ─── Route handler ───────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse<EjerskabResponse>> {
  const hasSharedSecret = !!(
    process.env.DATAFORDELER_OAUTH_CLIENT_ID && process.env.DATAFORDELER_OAUTH_CLIENT_SECRET
  );
  const hasCert = isCertAuthConfigured();

  if (!hasSharedSecret && !hasCert) {
    return NextResponse.json(
      { bfeNummer: null, ejere: [], fejl: null, manglerNoegle: true, manglerAdgang: false },
      { status: 200 }
    );
  }

  const { searchParams } = request.nextUrl;
  const bfeNummerStr = searchParams.get('bfeNummer');

  if (!bfeNummerStr || !/^\d+$/.test(bfeNummerStr)) {
    return NextResponse.json(
      {
        bfeNummer: null,
        ejere: [],
        fejl: 'Ugyldigt eller manglende bfeNummer',
        manglerNoegle: false,
        manglerAdgang: false,
      },
      { status: 400 }
    );
  }

  const bfeNummer = parseInt(bfeNummerStr, 10);

  // ── Forsøg 1: OAuth Shared Secret ──
  let result: EJFQueryResult | null = null;

  if (hasSharedSecret) {
    const token = await getOAuthToken();
    if (token) {
      try {
        result = await queryEJF(bfeNummer, token);
        if (result.ok) {
          console.log('[ejerskab] Shared Secret: OK —', result.nodes.length, 'ejere');
        } else if (result.manglerAdgang) {
          console.warn('[ejerskab] Shared Secret: 403/manglerAdgang — forsøger certifikat...');
        }
      } catch (err) {
        console.error('[ejerskab] Shared Secret fejl:', err instanceof Error ? err.message : err);
      }
    }
  }

  // ── Forsøg 2: OAuth Certifikat (mTLS) — hvis Shared Secret mangler adgang ──
  if ((!result || (!result.ok && result.manglerAdgang)) && hasCert) {
    console.log('[ejerskab] Forsøger OAuth Certifikat (mTLS)...');
    const certToken = await getCertOAuthToken();
    if (certToken) {
      try {
        const certResult = await queryEJF(bfeNummer, certToken);
        if (certResult.ok) {
          console.log('[ejerskab] Certifikat: OK —', certResult.nodes.length, 'ejere');
        } else {
          console.warn(
            '[ejerskab] Certifikat:',
            certResult.manglerAdgang ? '403/manglerAdgang' : certResult.fejl
          );
        }
        result = certResult;
      } catch (err) {
        console.error('[ejerskab] Certifikat fejl:', err instanceof Error ? err.message : err);
      }
    } else {
      console.error('[ejerskab] Certifikat: Kunne ikke hente OAuth token via mTLS');
    }
  }

  // ── Ingen token overhovedet ──
  if (!result) {
    return NextResponse.json(
      {
        bfeNummer,
        ejere: [],
        fejl: 'Hverken OAuth Shared Secret eller Certifikat kunne autentificere',
        manglerNoegle: false,
        manglerAdgang: false,
      },
      { status: 200 }
    );
  }

  // ── Fejl-result ──
  if (!result.ok) {
    return NextResponse.json(
      {
        bfeNummer,
        ejere: [],
        fejl: result.fejl,
        manglerNoegle: false,
        manglerAdgang: result.manglerAdgang,
      },
      { status: 200 }
    );
  }

  // ── Succes ──
  const nodes = result.nodes;

  if (!nodes.length) {
    return NextResponse.json(
      { bfeNummer, ejere: [], fejl: null, manglerNoegle: false, manglerAdgang: false },
      { status: 200 }
    );
  }

  const ejere: EjerData[] = nodes.map((n) => ({
    cvr: n.ejendeVirksomhedCVRNr != null ? String(n.ejendeVirksomhedCVRNr) : null,
    ejerandel_taeller: n.faktiskEjerandel_taeller ?? null,
    ejerandel_naevner: n.faktiskEjerandel_naevner ?? null,
    ejerforholdskode: n.ejerforholdskode ?? null,
    ejertype: parseEjertypeFraNode(n),
    virkningFra: n.virkningFra ?? null,
  }));

  return NextResponse.json(
    { bfeNummer, ejere, fejl: null, manglerNoegle: false, manglerAdgang: false },
    {
      status: 200,
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
    }
  );
}
