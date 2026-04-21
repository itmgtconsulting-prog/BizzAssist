/**
 * GET /api/ejendomsadmin?bfeNummer=X
 *
 * BIZZ-583: Henter administrator(er) for en ejendom via Datafordeler EJF
 * Custom-query EJFCustom_EjendomsadministratorBegraenset.
 *
 * Administrator er ofte en ejerforening, udlejningsadministrator eller
 * advokat — ikke nødvendigvis ejeren. Særligt relevant for ejerlejligheder
 * og erhvervsejendomme.
 *
 * Response-form:
 * {
 *   administratorer: AdministratorInfo[];
 *   fejl: string | null;
 *   manglerAdgang: boolean;
 * }
 *
 * @module api/ejendomsadmin
 */

import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';
import { resolveTenantId } from '@/lib/api/auth';
import { parseQuery } from '@/app/lib/validate';
import { logger } from '@/app/lib/logger';
import { getSharedOAuthToken } from '@/app/lib/dfTokenCache';
import { EJF_GQL_ENDPOINT } from '@/app/lib/serviceEndpoints';

const querySchema = z.object({
  bfeNummer: z.coerce.number().int().positive(),
});

// ─── Types ───────────────────────────────────────────────────────────────────

/** En administrator-record mappet til UI-venlig form */
export interface AdministratorInfo {
  /** Stabilt EJF-ID (id_lokalId) for denne administrator-relation */
  id: string;
  /** 'virksomhed' hvis CVR sat, 'person' hvis navn sat, 'ukendt' ellers */
  type: 'virksomhed' | 'person' | 'ukendt';
  /** CVR-nummer hvis virksomhedsadministrator */
  cvr: string | null;
  /** Fuldt navn hvis person-administrator (fra EJF navn.navn) */
  navn: string | null;
  /** Fødselsdato (ISO YYYY-MM-DD) hvis person */
  foedselsdato: string | null;
  /** Virkningstids-periode for administrator-rollen */
  virkningFra: string | null;
  virkningTil: string | null;
  /** 'gældende' eller 'historisk' — ifølge EJF */
  status: string | null;
}

export interface EjendomsadminResponse {
  bfeNummer: number | null;
  administratorer: AdministratorInfo[];
  fejl: string | null;
  manglerAdgang: boolean;
}

// ─── GraphQL ──────────────────────────────────────────────────────────────────

interface RawAdminNode {
  id_lokalId?: string;
  virkningFra?: string | null;
  virkningTil?: string | null;
  status?: string | null;
  virksomhedCVRNr?: number | null;
  personEllerVirksomhedLokalId?: string | null;
  personBegraenset?: {
    id?: string;
    foedselsdato?: string | null;
    navn?: { navn?: string | null } | null;
  } | null;
}

interface GqlResult {
  data?: {
    EJFCustom_EjendomsadministratorBegraenset?: { nodes?: RawAdminNode[] };
  };
  errors?: { message: string; extensions?: { code?: string } }[];
}

/** Map en rå admin-node til UI-venlig AdministratorInfo. Skipper invalide. */
function mapNodeToInfo(node: RawAdminNode): AdministratorInfo | null {
  if (!node.id_lokalId) return null;
  const cvr = node.virksomhedCVRNr ? String(node.virksomhedCVRNr) : null;
  const personNavn = node.personBegraenset?.navn?.navn ?? null;
  const foedselsdato = node.personBegraenset?.foedselsdato ?? null;
  const type: AdministratorInfo['type'] = cvr ? 'virksomhed' : personNavn ? 'person' : 'ukendt';
  return {
    id: node.id_lokalId,
    type,
    cvr,
    navn: personNavn,
    foedselsdato,
    virkningFra: node.virkningFra ?? null,
    virkningTil: node.virkningTil ?? null,
    status: node.status ?? null,
  };
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse<EjendomsadminResponse>> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited as NextResponse<EjendomsadminResponse>;

  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json(
      { bfeNummer: null, administratorer: [], fejl: 'Unauthorized', manglerAdgang: false },
      { status: 401 }
    );
  }

  const parsed = parseQuery(request, querySchema);
  if (!parsed.success) return parsed.response as NextResponse<EjendomsadminResponse>;
  const { bfeNummer } = parsed.data;

  const token = await getSharedOAuthToken().catch(() => null);
  if (!token) {
    return NextResponse.json({
      bfeNummer,
      administratorer: [],
      fejl: 'OAuth token kunne ikke hentes',
      manglerAdgang: false,
    });
  }

  const vt = new Date().toISOString();
  const query = `{
    EJFCustom_EjendomsadministratorBegraenset(
      first: 50
      virkningstid: "${vt}"
      where: { bestemtFastEjendomBFENr: { eq: ${bfeNummer} } }
    ) {
      nodes {
        id_lokalId
        virkningFra
        virkningTil
        status
        virksomhedCVRNr
        personEllerVirksomhedLokalId
        personBegraenset {
          id
          foedselsdato
          navn { navn }
        }
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
      next: { revalidate: 86_400 }, // 24t cache — admin-ændringer er sjældne
    });

    if (res.status === 403) {
      return NextResponse.json({
        bfeNummer,
        administratorer: [],
        fejl: null,
        manglerAdgang: true,
      });
    }
    if (!res.ok) {
      logger.error('[ejendomsadmin] EJF HTTP', res.status);
      return NextResponse.json({
        bfeNummer,
        administratorer: [],
        fejl: 'Ekstern API fejl',
        manglerAdgang: false,
      });
    }

    const json = (await res.json()) as GqlResult;
    if (json.errors?.length) {
      const authErr = json.errors.some(
        (e) => e.extensions?.code === 'DAF-AUTH-0001' || e.message?.includes('not authorized')
      );
      if (authErr) {
        return NextResponse.json({
          bfeNummer,
          administratorer: [],
          fejl: null,
          manglerAdgang: true,
        });
      }
      logger.warn('[ejendomsadmin] GraphQL fejl:', json.errors[0].message);
    }

    const rawNodes = json.data?.EJFCustom_EjendomsadministratorBegraenset?.nodes ?? [];
    const administratorer = rawNodes
      .map(mapNodeToInfo)
      .filter((x): x is AdministratorInfo => x !== null)
      // Sortér: gældende først, derefter efter virkningFra desc
      .sort((a, b) => {
        const aActive = a.status !== 'historisk' ? 1 : 0;
        const bActive = b.status !== 'historisk' ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        return (b.virkningFra ?? '').localeCompare(a.virkningFra ?? '');
      });

    return NextResponse.json(
      { bfeNummer, administratorer, fejl: null, manglerAdgang: false },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600',
        },
      }
    );
  } catch (err) {
    Sentry.captureException(err);
    logger.error('[ejendomsadmin] Uventet fejl:', err instanceof Error ? err.message : err);
    return NextResponse.json({
      bfeNummer,
      administratorer: [],
      fejl: 'Ekstern API fejl',
      manglerAdgang: false,
    });
  }
}
