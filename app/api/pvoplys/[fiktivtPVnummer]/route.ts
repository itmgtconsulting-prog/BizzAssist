/**
 * GET /api/pvoplys/[fiktivtPVnummer]
 *
 * Henter detaljer for en EJF_PersonVirksomhedsoplys-part (dødsbo, fond,
 * udenlandsk selskab, administrator m.fl.) og en liste af ejendomme parten
 * ejer. Analog til /api/cvr-public (selskab) og /api/owner-details (person)
 * men for parter uden CVR/CPR.
 *
 * BIZZ-483: Ny detaljeside for fiktivtPVnummer. Bygger videre på BIZZ-482
 * hvor EjerData blev udvidet med ejertype='pvoplys' + fiktivtPVnummer.
 *
 * Datafordeler endpoint: https://graphql.datafordeler.dk/flexibleCurrent/v1/
 *
 * Flow:
 *   1. Hent OAuth-token (delt cache med øvrige EJF-routes)
 *   2. Parallel:
 *      a. EJF_PersonVirksomhedsoplys(fiktivtPVnummer=X) → part-detaljer
 *      b. EJFCustom_EjerskabBegraenset filtered by fiktivtPVnummer via
 *         oplysningerEjesAfEjerskab-relationen → reverse-lookup af ejendomme
 *   3. Defensive fallback — hvis schemaet afviser felter returneres best-
 *      effort data så siden aldrig er helt tom
 *
 * GDPR: EJF_PersonVirksomhedsoplys indeholder IKKE CPR. Navne kan være
 * personnavne (fx "Boet efter Jens Jensen") — logges ikke i Sentry.
 *
 * @param request - Next.js request
 * @param params  - { fiktivtPVnummer: string }
 * @returns { part, ejendomme, fejl, manglerNoegle, manglerAdgang }
 */

import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';
import { logger } from '@/app/lib/logger';
import { getSharedOAuthToken } from '@/app/lib/dfTokenCache';
import { resolveTenantId } from '@/lib/api/auth';
import { EJF_GQL_ENDPOINT } from '@/app/lib/serviceEndpoints';

export const runtime = 'nodejs';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Detaljer for en PV-part (dødsbo, fond, udenlandsk ejer m.m.) */
export interface PVOplysPart {
  /** Persistent identifikator (fiktivtPVnummer) */
  fiktivtPVnummer: string;
  /** Partens navn (fx "Boet efter X" eller udenlandsk selskabsnavn) */
  navn: string | null;
  /** Status fra EJF (fx "Aktiv", "Afsluttet") */
  status: string | null;
  /** Landekode ISO 3166-1 numerisk — sat for udenlandske parter */
  landekode: string | null;
  /** Samlet udlandsadresse (adresselinje 1-10) */
  udlandsadresse: string | null;
  /** DAR-adresse lokalId — sat for danske parter */
  adresseLokalId: string | null;
  /** Kommune-kode — sat for danske parter (fx "0101" for København) */
  kommunekode: string | null;
  /** ISO 8601 — hvornår parten blev virksom */
  virkningFra: string | null;
  /** ISO 8601 — hvornår parten ophørte. null = stadig aktiv */
  virkningTil: string | null;
}

/** Én ejendom i PV-partens portefølje */
export interface PVOplysEjendom {
  bfeNummer: number;
  ejerandel: string | null;
  /** virkningFra for ejerskabet */
  virkningFra: string | null;
}

/** API-svaret fra denne route */
export interface PVOplysResponse {
  /** Part-detaljer eller null hvis ikke fundet */
  part: PVOplysPart | null;
  /** Ejendomme parten ejer (eller har ejet) */
  ejendomme: PVOplysEjendom[];
  fejl: string | null;
  manglerNoegle: boolean;
  manglerAdgang: boolean;
}

// ─── GraphQL helpers ─────────────────────────────────────────────────────────

interface GqlResult<T> {
  data?: Record<string, { nodes?: T[] }>;
  errors?: { message: string; extensions?: { code?: string } }[];
}

/**
 * Rå node fra EJF_PersonVirksomhedsoplys.
 * Alle felter optional — defensive fallback hvis Datafordeler schema mangler.
 */
interface RawPVOplys {
  fiktivtPVnummer?: string | null;
  navn?: string | null;
  status?: string | null;
  landeKodeNumerisk?: string | null;
  adresselinje1?: string | null;
  adresselinje2?: string | null;
  adresselinje3?: string | null;
  adresselinje4?: string | null;
  adresselinje5?: string | null;
  adresseLokalId?: string | null;
  kommuneinddelingKommunekode?: string | null;
  virkningFra?: string | null;
  virkningTil?: string | null;
}

/**
 * Sender GraphQL query til EJF med en given Bearer token og entity-navn.
 *
 * @returns { nodes, authError } eller null ved netværk/parse-fejl
 */
async function queryEJF<T>(
  query: string,
  entityName: string,
  token: string
): Promise<{ nodes: T[]; authError: boolean } | null> {
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

    if ((json.errors?.length ?? 0) > 0 && !json.data?.[entityName]) {
      logger.warn(`[pvoplys] ${entityName} schema fejl:`, json.errors?.[0]?.message);
      return null;
    }

    return { nodes: json.data?.[entityName]?.nodes ?? [], authError: false };
  } catch (err) {
    logger.error('[pvoplys] queryEJF netværksfejl:', err);
    return null;
  }
}

// ─── Route handler ───────────────────────────────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ fiktivtPVnummer: string }> }
): Promise<NextResponse<PVOplysResponse>> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited as NextResponse<PVOplysResponse>;

  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json(
      {
        part: null,
        ejendomme: [],
        fejl: 'Unauthorized',
        manglerNoegle: false,
        manglerAdgang: false,
      },
      { status: 401 }
    );
  }

  const { fiktivtPVnummer } = await params;

  // Sanity-check: fiktivtPVnummer er typisk en streng af tal/bogstaver.
  // Tillader kun alfanumerisk + bindestreg for at undgå GraphQL-injection.
  if (!/^[A-Za-z0-9-]{1,64}$/.test(fiktivtPVnummer)) {
    return NextResponse.json(
      {
        part: null,
        ejendomme: [],
        fejl: 'Ugyldigt fiktivtPVnummer',
        manglerNoegle: false,
        manglerAdgang: false,
      },
      { status: 400 }
    );
  }

  const hasSharedSecret = !!(
    process.env.DATAFORDELER_OAUTH_CLIENT_ID && process.env.DATAFORDELER_OAUTH_CLIENT_SECRET
  );
  if (!hasSharedSecret) {
    return NextResponse.json(
      { part: null, ejendomme: [], fejl: null, manglerNoegle: true, manglerAdgang: false },
      { status: 200 }
    );
  }

  const token = await getSharedOAuthToken();
  if (!token) {
    return NextResponse.json(
      {
        part: null,
        ejendomme: [],
        fejl: 'OAuth token kunne ikke hentes',
        manglerNoegle: false,
        manglerAdgang: false,
      },
      { status: 200 }
    );
  }

  // ── Parallel: part-detaljer + reverse-lookup af ejendomme ──
  // Hvis Datafordeler-schemaet ikke understøtter reverse-lookup via
  // oplysningerEjesAfEjerskab-relationen falder vi tilbage til kun
  // part-detaljerne. Bedre at vise part uden ejendomme end tom side.
  const partQuery = `{
    EJF_PersonVirksomhedsoplys(
      first: 1
      where: { fiktivtPVnummer: { eq: "${fiktivtPVnummer}" } }
    ) {
      nodes {
        fiktivtPVnummer
        navn
        status
        landeKodeNumerisk
        adresselinje1
        adresselinje2
        adresselinje3
        adresselinje4
        adresselinje5
        adresseLokalId
        kommuneinddelingKommunekode
        virkningFra
        virkningTil
      }
    }
  }`;

  const ejendommeQuery = `{
    EJFCustom_EjerskabBegraenset(
      first: 200
      where: {
        oplysningerEjesAfEjerskab: { fiktivtPVnummer: { eq: "${fiktivtPVnummer}" } }
      }
    ) {
      nodes {
        bestemtFastEjendomBFENr
        faktiskEjerandel_taeller
        faktiskEjerandel_naevner
        virkningFra
      }
    }
  }`;

  try {
    const [partResult, ejendommeResult] = await Promise.all([
      queryEJF<RawPVOplys>(partQuery, 'EJF_PersonVirksomhedsoplys', token),
      queryEJF<{
        bestemtFastEjendomBFENr: number | null;
        faktiskEjerandel_taeller: number | null;
        faktiskEjerandel_naevner: number | null;
        virkningFra: string | null;
      }>(ejendommeQuery, 'EJFCustom_EjerskabBegraenset', token),
    ]);

    // Auth-fejl på mindst én query = manglerAdgang for hele siden
    if (partResult?.authError || ejendommeResult?.authError) {
      return NextResponse.json(
        { part: null, ejendomme: [], fejl: null, manglerNoegle: false, manglerAdgang: true },
        { status: 200 }
      );
    }

    const rawPart = partResult?.nodes?.[0] ?? null;
    const adresseLinjer = rawPart
      ? [
          rawPart.adresselinje1,
          rawPart.adresselinje2,
          rawPart.adresselinje3,
          rawPart.adresselinje4,
          rawPart.adresselinje5,
        ]
          .map((l) => (typeof l === 'string' ? l.trim() : ''))
          .filter((l) => l.length > 0)
      : [];

    const part: PVOplysPart | null = rawPart
      ? {
          fiktivtPVnummer: rawPart.fiktivtPVnummer ?? fiktivtPVnummer,
          navn: rawPart.navn ?? null,
          status: rawPart.status ?? null,
          landekode: rawPart.landeKodeNumerisk ?? null,
          udlandsadresse: adresseLinjer.length > 0 ? adresseLinjer.join(', ') : null,
          adresseLokalId: rawPart.adresseLokalId ?? null,
          kommunekode: rawPart.kommuneinddelingKommunekode ?? null,
          virkningFra: rawPart.virkningFra ?? null,
          virkningTil: rawPart.virkningTil ?? null,
        }
      : null;

    const ejendomme: PVOplysEjendom[] = (ejendommeResult?.nodes ?? [])
      .filter((n) => n.bestemtFastEjendomBFENr != null)
      .map((n) => {
        const t = n.faktiskEjerandel_taeller;
        const nav = n.faktiskEjerandel_naevner;
        const pct = t != null && nav != null && nav > 0 ? `${Math.round((t / nav) * 100)}%` : null;
        return {
          bfeNummer: n.bestemtFastEjendomBFENr as number,
          ejerandel: pct,
          virkningFra: n.virkningFra ?? null,
        };
      });

    return NextResponse.json(
      { part, ejendomme, fejl: null, manglerNoegle: false, manglerAdgang: false },
      {
        status: 200,
        headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
      }
    );
  } catch (err) {
    Sentry.captureException(err);
    logger.error('[pvoplys] Fejl:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      {
        part: null,
        ejendomme: [],
        fejl: 'Ekstern API fejl',
        manglerNoegle: false,
        manglerAdgang: false,
      },
      { status: 200 }
    );
  }
}
