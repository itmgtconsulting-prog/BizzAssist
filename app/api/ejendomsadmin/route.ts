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
 * BIZZ-1815: When the given BFE (ejerlejlighed) has no administrator, the
 * route falls back to the parent SFE and returns its administrator with
 * arvFraSfeBfe set to the parent BFE number.
 *
 * Response-form:
 * {
 *   administratorer: AdministratorInfo[];
 *   fejl: string | null;
 *   manglerAdgang: boolean;
 *   arvFraSfeBfe?: number | null;
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
import { createAdminClient } from '@/lib/supabase/admin';
import { parseQuery } from '@/app/lib/validate';
import { logger } from '@/app/lib/logger';
import { getSharedOAuthToken } from '@/app/lib/dfTokenCache';
import { EJF_GQL_ENDPOINT, DAWA_BASE_URL } from '@/app/lib/serviceEndpoints';
import { fetchDawa } from '@/app/lib/dawa';

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
  /** BIZZ-1815: BFE for parent SFE when admin is inherited from moderejendommen */
  arvFraSfeBfe?: number | null;
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

// ─── BIZZ-1815: SFE fallback ─────────────────────────────────────────────────

/**
 * Resolve the parent SFE BFE for an ejerlejlighed.
 *
 * Strategy: look up adgangsadresse_id in bbr_ejendom_status for the given BFE,
 * then use DAWA to find the jordstykke (matrikel) which yields the SFE BFE.
 * Returns null if the BFE is not an ejerlejlighed or parent cannot be found.
 *
 * @param bfeNummer - BFE number of the ejerlejlighed
 * @returns Parent SFE BFE number, or null if not resolvable
 */
async function resolveParentSfeBfe(bfeNummer: number): Promise<number | null> {
  try {
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: row } = await (admin as any)
      .from('bbr_ejendom_status')
      .select('adgangsadresse_id')
      .eq('bfe_nummer', bfeNummer)
      .maybeSingle();

    if (!row?.adgangsadresse_id) return null;

    // Resolve adgangsadresse → jordstykke → SFE BFE
    const adgRes = await fetchDawa(
      `${DAWA_BASE_URL}/adgangsadresser/${row.adgangsadresse_id}`,
      { signal: AbortSignal.timeout(5000) },
      { caller: 'ejendomsadmin.sfe-resolve' }
    );
    if (!adgRes.ok) return null;

    const adg = (await adgRes.json()) as {
      jordstykke?: { ejerlav?: { kode?: number }; matrikelnr?: string };
    };
    const ejerlav = adg?.jordstykke?.ejerlav?.kode;
    const matrikelnr = adg?.jordstykke?.matrikelnr;
    if (!ejerlav || !matrikelnr) return null;

    // Jordstykke BFE = SFE (moderejendommen)
    const jordRes = await fetchDawa(
      `${DAWA_BASE_URL}/jordstykker/${ejerlav}/${matrikelnr}`,
      { signal: AbortSignal.timeout(5000) },
      { caller: 'ejendomsadmin.sfe-jordstykke' }
    );
    if (!jordRes.ok) return null;

    const jord = (await jordRes.json()) as { bfenummer?: number };
    const sfeBfe = jord?.bfenummer ?? null;

    // Only return if the SFE BFE differs from the input (avoids infinite loop)
    return sfeBfe && sfeBfe !== bfeNummer ? sfeBfe : null;
  } catch {
    return null;
  }
}

/**
 * Query ejf_administrator cache for a given BFE and return mapped results.
 *
 * @param bfe - BFE number to query
 * @returns Array of AdministratorInfo from cache, or null if no cache hit
 */
async function queryAdminCache(bfe: number): Promise<AdministratorInfo[] | null> {
  try {
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: cached } = await (admin as any)
      .from('ejf_administrator')
      .select(
        'id_lokal_id, administrator_type, virksomhed_cvr, person_navn, virkning_fra, virkning_til, status'
      )
      .eq('bfe_nummer', bfe)
      .eq('status', 'gældende');

    if (!cached || cached.length === 0) return null;

    return (
      cached as Array<{
        id_lokal_id: string;
        administrator_type: string;
        virksomhed_cvr: string | null;
        person_navn: string | null;
        virkning_fra: string | null;
        virkning_til: string | null;
        status: string;
      }>
    ).map((row) => ({
      id: row.id_lokal_id,
      type: row.administrator_type as AdministratorInfo['type'],
      cvr: row.virksomhed_cvr,
      navn: row.person_navn,
      foedselsdato: null,
      virkningFra: row.virkning_fra,
      virkningTil: row.virkning_til,
      status: row.status,
    }));
  } catch {
    return null;
  }
}

/**
 * BIZZ-1815: Try to find administrator via the parent SFE when the given BFE
 * (typically an ejerlejlighed) has no direct administrator record.
 *
 * Flow:
 *   1. Resolve parent SFE BFE via DAWA jordstykke lookup
 *   2. Check ejf_administrator cache for the parent SFE
 *   3. If cache miss, query EJF GraphQL live for the parent SFE
 *
 * @param bfeNummer - The ejerlejlighed BFE with no administrator
 * @param token - OAuth token for EJF GraphQL (already obtained by caller)
 * @returns Admin results from parent SFE, or null if not found
 */
async function trySfeFallback(
  bfeNummer: number,
  token: string
): Promise<{ sfeBfe: number; administratorer: AdministratorInfo[] } | null> {
  const sfeBfe = await resolveParentSfeBfe(bfeNummer);
  if (!sfeBfe) return null;

  logger.log(`[ejendomsadmin] BIZZ-1815: BFE ${bfeNummer} → parent SFE ${sfeBfe}, trying fallback`);

  // Try cache first for parent SFE
  const cached = await queryAdminCache(sfeBfe);
  if (cached && cached.length > 0) {
    logger.log(
      `[ejendomsadmin] BIZZ-1815: Cache hit for parent SFE ${sfeBfe}: ${cached.length} admins`
    );
    return { sfeBfe, administratorer: cached };
  }

  // Live EJF GraphQL for parent SFE
  try {
    const vt = new Date().toISOString();
    const sfeQuery = `{
      EJFCustom_EjendomsadministratorBegraenset(
        first: 50
        virkningstid: "${vt}"
        where: { bestemtFastEjendomBFENr: { eq: ${sfeBfe} } }
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

    const res = await fetch(proxyUrl(EJF_GQL_ENDPOINT), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...proxyHeaders(),
      },
      body: JSON.stringify({ query: sfeQuery }),
      signal: AbortSignal.timeout(proxyTimeout()),
      next: { revalidate: 86_400 },
    });

    if (!res.ok) return null;

    const json = (await res.json()) as GqlResult;
    const rawNodes = json.data?.EJFCustom_EjendomsadministratorBegraenset?.nodes ?? [];
    const administratorer = rawNodes
      .map(mapNodeToInfo)
      .filter((x): x is AdministratorInfo => x !== null)
      .sort((a, b) => {
        const aActive = a.status !== 'historisk' ? 1 : 0;
        const bActive = b.status !== 'historisk' ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        return (b.virkningFra ?? '').localeCompare(a.virkningFra ?? '');
      });

    if (administratorer.length > 0) {
      logger.log(
        `[ejendomsadmin] BIZZ-1815: Live EJF hit for parent SFE ${sfeBfe}: ${administratorer.length} admins`
      );
      return { sfeBfe, administratorer };
    }
  } catch {
    /* SFE fallback is best-effort — non-fatal */
  }

  return null;
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

  // BIZZ-1659: Cache-first fra ejf_administrator-tabel (backfilled data)
  const cachedAdmins = await queryAdminCache(bfeNummer);
  if (cachedAdmins && cachedAdmins.length > 0) {
    logger.log(`[ejendomsadmin] Cache hit: ${cachedAdmins.length} admins for BFE ${bfeNummer}`);
    return NextResponse.json(
      { bfeNummer, administratorer: cachedAdmins, fejl: null, manglerAdgang: false },
      { headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' } }
    );
  }

  const token = await getSharedOAuthToken().catch(() => null);
  if (!token) {
    // BIZZ-1815: Even without OAuth, try parent SFE from cache
    const sfeBfe = await resolveParentSfeBfe(bfeNummer);
    if (sfeBfe) {
      const sfeCached = await queryAdminCache(sfeBfe);
      if (sfeCached && sfeCached.length > 0) {
        logger.log(`[ejendomsadmin] BIZZ-1815: No OAuth but cache hit for parent SFE ${sfeBfe}`);
        return NextResponse.json(
          {
            bfeNummer,
            administratorer: sfeCached,
            fejl: null,
            manglerAdgang: false,
            arvFraSfeBfe: sfeBfe,
          },
          { headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' } }
        );
      }
    }
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

    // BIZZ-1815: When no admin found for this BFE, check if it is an
    // ejerlejlighed and try the parent SFE instead. The administrator
    // (ejerforening) is typically registered on the SFE, not the unit.
    if (administratorer.length === 0) {
      const sfeFallback = await trySfeFallback(bfeNummer, token);
      if (sfeFallback) {
        return NextResponse.json(
          {
            bfeNummer,
            administratorer: sfeFallback.administratorer,
            fejl: null,
            manglerAdgang: false,
            arvFraSfeBfe: sfeFallback.sfeBfe,
          },
          {
            headers: {
              'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600',
            },
          }
        );
      }
    }

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
