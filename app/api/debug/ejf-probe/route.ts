/**
 * TEMP debug endpoint — probes EJF full-service access via our existing
 * OAuth credentials. Returns a matrix of which GraphQL endpoints +
 * Fildownload URL patterns are reachable.
 *
 * Auth: CRON_SECRET bearer token (reuse existing cron auth).
 * Remove this file once BIZZ-534 Mode A is wired up.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSharedOAuthToken } from '@/app/lib/dfTokenCache';
import { proxyUrl, proxyHeaders } from '@/app/lib/dfProxy';
import { EJF_GQL_ENDPOINT } from '@/app/lib/serviceEndpoints';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 30;

const VT = new Date().toISOString();
// 4 Custom-tjenester tildelt jf. support 2026-04-19. Prøv begge navngivnings-
// varianter — "EJFCustom_X" (som vi bruger for EjerskabBegraenset i dag) og
// "CustomX" (som support nævner). GraphQL-navnet afgør hvilket af dem virker.
const EJF_GQL_PROBES = [
  // Varianter af EjerskabBegraenset
  {
    name: 'EJFCustom_EjerskabBegraenset',
    query: `{ EJFCustom_EjerskabBegraenset(first: 1, virkningstid: "${VT}") { nodes { bestemtFastEjendomBFENr } } }`,
  },
  {
    name: 'CustomEjerskabBegraenset',
    query: `{ CustomEjerskabBegraenset(first: 1, virkningstid: "${VT}") { nodes { bestemtFastEjendomBFENr } } }`,
  },
  // Ejendomsadministrator
  {
    name: 'EJFCustom_EjendomsadministratorBegraenset',
    query: `{ EJFCustom_EjendomsadministratorBegraenset(first: 1, virkningstid: "${VT}") { nodes { id_lokalId status } } }`,
  },
  {
    name: 'CustomEjendomsadministratorBegraenset',
    query: `{ CustomEjendomsadministratorBegraenset(first: 1, virkningstid: "${VT}") { nodes { id_lokalId status } } }`,
  },
  // PersonEllerVirksomhedsadmini
  {
    name: 'EJFCustom_PersonEllerVirksomhedsadminiBegraenset',
    query: `{ EJFCustom_PersonEllerVirksomhedsadminiBegraenset(first: 1, virkningstid: "${VT}") { nodes { id_lokalId status } } }`,
  },
  {
    name: 'CustomPersonEllerVirksomhedsadminiBegraenset',
    query: `{ CustomPersonEllerVirksomhedsadminiBegraenset(first: 1, virkningstid: "${VT}") { nodes { id_lokalId status } } }`,
  },
  // PersonSimpel — flere navne-varianter
  {
    name: 'EJFCustom_PersonSimpelBegraenset',
    query: `{ EJFCustom_PersonSimpelBegraenset(first: 1, virkningstid: "${VT}") { nodes { id_lokalId } } }`,
  },
  {
    name: 'EJFCustom_SimpelPerson',
    query: `{ EJFCustom_SimpelPerson(first: 1, virkningstid: "${VT}") { nodes { id_lokalId } } }`,
  },
  {
    name: 'EJFCustom_PersonSimpleBegraenset',
    query: `{ EJFCustom_PersonSimpleBegraenset(first: 1, virkningstid: "${VT}") { nodes { id_lokalId } } }`,
  },
  {
    name: 'EJFCustom_Person',
    query: `{ EJFCustom_Person(first: 1, virkningstid: "${VT}") { nodes { id_lokalId } } }`,
  },
  {
    name: 'EJFCustom_PersonBasisBegraenset',
    query: `{ EJFCustom_PersonBasisBegraenset(first: 1, virkningstid: "${VT}") { nodes { id_lokalId } } }`,
  },
  {
    name: 'EJFCustom_PersonEjerskabBegraenset',
    query: `{ EJFCustom_PersonEjerskabBegraenset(first: 1, virkningstid: "${VT}") { nodes { id_lokalId } } }`,
  },
  // Inspect fields on confirmed services to understand schema
  {
    name: 'EjerskabBegraenset — rig felt-probe',
    query: `{ EJFCustom_EjerskabBegraenset(first: 1, virkningstid: "${VT}") { nodes {
      bestemtFastEjendomBFENr
      ejerforholdskode
      faktiskEjerandel_taeller
      faktiskEjerandel_naevner
      virkningFra
      virkningTil
      status
      ejendePersonBegraenset { id navn { navn } foedselsdato }
      ejendeVirksomhedCVRNr_20_Virksomhed_CVRNummer_ref { CVRNummer }
    } } }`,
  },
  {
    name: 'EjendomsadministratorBegraenset — rig felt-probe',
    query: `{ EJFCustom_EjendomsadministratorBegraenset(first: 1, virkningstid: "${VT}") { nodes {
      id_lokalId status virkningFra virkningTil
    } } }`,
  },
  {
    name: 'PersonEllerVirksomhedsadmini — rig felt-probe',
    query: `{ EJFCustom_PersonEllerVirksomhedsadminiBegraenset(first: 1, virkningstid: "${VT}") { nodes {
      id_lokalId status virkningFra virkningTil
    } } }`,
  },
  // BIZZ-583: Schema-probing for ejendomsadministrator (introspection blocked
  // by HC0046, so we guess fields by analogy to EjerskabBegraenset and see
  // which ones the server accepts).
  {
    name: 'Admin — bestemtFastEjendomBFENr field',
    query: `{ EJFCustom_EjendomsadministratorBegraenset(first: 1, virkningstid: "${VT}") { nodes {
      id_lokalId bestemtFastEjendomBFENr
    } } }`,
  },
  {
    name: 'Admin — relation naming guess A (administratorPersonEllerVirksomhedsadmini)',
    query: `{ EJFCustom_EjendomsadministratorBegraenset(first: 1, virkningstid: "${VT}") { nodes {
      id_lokalId administratorPersonEllerVirksomhedsadmini
    } } }`,
  },
  {
    name: 'Admin — relation naming guess B (ejendomsadministratorAdmini)',
    query: `{ EJFCustom_EjendomsadministratorBegraenset(first: 1, virkningstid: "${VT}") { nodes {
      id_lokalId ejendomsadministratorAdmini
    } } }`,
  },
  {
    name: 'Admin — relation naming guess C (personEllerVirksomhedsadmini)',
    query: `{ EJFCustom_EjendomsadministratorBegraenset(first: 1, virkningstid: "${VT}") { nodes {
      id_lokalId personEllerVirksomhedsadmini
    } } }`,
  },
  {
    name: 'Admin — datatype guess CVRNr + navn',
    query: `{ EJFCustom_EjendomsadministratorBegraenset(first: 1, virkningstid: "${VT}") { nodes {
      id_lokalId administratorCVRNr administratorNavn administratorPersonBegraenset { navn { navn } }
    } } }`,
  },
  {
    name: 'PersonEllerVirksomhedsadmini — navn felt',
    query: `{ EJFCustom_PersonEllerVirksomhedsadminiBegraenset(first: 1, virkningstid: "${VT}") { nodes {
      id_lokalId navn CVRNr virksomhedsnavn cprNummer
    } } }`,
  },
  {
    name: 'PersonEllerVirksomhedsadmini — adresse felter',
    query: `{ EJFCustom_PersonEllerVirksomhedsadminiBegraenset(first: 1, virkningstid: "${VT}") { nodes {
      id_lokalId adresselinje1 adresselinje2 postnr by
    } } }`,
  },
  // Entitetsbaserede — forventes at fejle (support siger vi ikke har adgang)
  {
    name: 'EJF_Ejerskab (entity — forventer fejl)',
    query: `{ EJF_Ejerskab(first: 1, virkningstid: "${VT}") { nodes { id_lokalId status } } }`,
  },
  // Jakobs eksempel-query med id_lokalId filter — prøv om specifik id-opslag virker
  // selvom "first:1" listing gav DAF-AUTH-0001
  {
    name: 'EJF_PersonVirksomhedsoplys (id_lokalId filter)',
    query: `query EJF_PersonEllerVirksomhedsoplysning { EJF_PersonVirksomhedsoplys(virkningstid: "${VT}", where: { id_lokalId: { eq: "00000000-0000-0000-0000-000000000000" } }) { nodes { id_namespace id_lokalId navn fiktivtPVnummer adresselinje1 } } }`,
  },
  // Custom-variant af samme query-shape
  {
    name: 'CustomPersonSimpelBegraenset (med id filter, rolle-navn direkte)',
    query: `{ CustomPersonSimpelBegraenset(virkningstid: "${VT}", where: { id_lokalId: { eq: "00000000-0000-0000-0000-000000000000" } }) { nodes { id_lokalId navn } } }`,
  },
  {
    name: 'EJFCustom_PersonSimpelBegraenset (med id filter)',
    query: `{ EJFCustom_PersonSimpelBegraenset(virkningstid: "${VT}", where: { id_lokalId: { eq: "00000000-0000-0000-0000-000000000000" } }) { nodes { id_lokalId navn } } }`,
  },
  // Introspection — list alle tilgængelige query-fields
  {
    name: '__schema.Query fields (introspection)',
    query: `{ __type(name: "Query") { fields { name } } }`,
  },
];

const FIL_URL_PATTERNS = [
  'https://services.datafordeler.dk/EJERFORTEGNELSEN/Ejerfortegnelsen/1/fil/',
  'https://services.datafordeler.dk/EJERFORTEGNELSEN/Ejerfortegnelsen_v2/1/fil/',
  'https://services.datafordeler.dk/EJERFORTEGNELSEN/EjerfortegnelsenTotaludtraekFladPraedefineret/1/fil/',
  'https://services.datafordeler.dk/EJERFORTEGNELSEN/Ejerfortegnelsen_Totaludtraek_Flad_Praedefineret_JSON/1/fil/',
  'https://filudtraek.datafordeler.dk/EJERFORTEGNELSEN/',
  // REST-service varianter for CustomPersonSimpelBegraenset
  'https://services.datafordeler.dk/EJERFORTEGNELSEN/CustomPersonSimpelBegraenset/1/rest/',
  'https://services.datafordeler.dk/EJERFORTEGNELSEN/CustomPersonSimpelBegraenset/1/rest/PersonSimpelBegraenset',
  'https://services.datafordeler.dk/EJERFORTEGNELSEN/Ejerfortegnelsen_v2/1/rest/CustomPersonSimpelBegraenset',
];

// Try flexibleHistory endpoint alongside flexibleCurrent
const FLEXIBLE_HISTORY_URL = 'https://graphql.datafordeler.dk/flexibleHistory/v1/';

/**
 * Verify the caller passed the correct CRON_SECRET via Bearer header.
 */
function verifyAuth(req: NextRequest): boolean {
  const header = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${process.env.CRON_SECRET ?? ''}`;
  if (!process.env.CRON_SECRET) return false;
  return safeCompare(header, expected);
}

/**
 * Fetches a URL and returns minimal metadata (status, content-type, snippet).
 */
async function probeUrl(url: string, auth: string | null): Promise<Record<string, unknown>> {
  try {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...proxyHeaders(),
    };
    if (auth) headers['Authorization'] = auth;
    const res = await fetch(proxyUrl(url), {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    const contentType = res.headers.get('content-type') ?? '';
    const contentLength = res.headers.get('content-length') ?? null;
    const contentDisposition = res.headers.get('content-disposition') ?? null;
    let snippet = '';
    if (
      contentType.includes('json') ||
      contentType.includes('text') ||
      contentType.includes('xml')
    ) {
      const text = await res.text();
      snippet = text.slice(0, 400);
    }
    return {
      status: res.status,
      contentType,
      contentLength,
      contentDisposition,
      snippet,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Runs a GraphQL probe and returns whether the query succeeded or what error
 * was returned (DAF-AUTH-0001 = permission denied for that specific service).
 */
async function probeGraphQL(
  name: string,
  query: string,
  token: string
): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(proxyUrl(EJF_GQL_ENDPOINT), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...proxyHeaders(),
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(10_000),
    });
    const httpStatus = res.status;
    const json = (await res.json().catch(() => null)) as {
      data?: Record<string, { nodes: unknown[] }>;
      errors?: Array<{ message: string; extensions?: { code: string } }>;
    } | null;
    if (!json) return { httpStatus, error: 'non-json-response' };
    if (json.errors?.length) {
      return {
        httpStatus,
        ok: false,
        errors: json.errors.map((e) => ({
          message: e.message,
          code: e.extensions?.code,
        })),
      };
    }
    if (httpStatus >= 400) {
      return { httpStatus, ok: false, body: JSON.stringify(json).slice(0, 300) };
    }
    // Special-case: introspection response has nested fields[] array
    if (json.data && '__type' in json.data) {
      const fields = (json.data as { __type?: { fields?: Array<{ name: string }> } }).__type
        ?.fields;
      const ejfFields =
        fields
          ?.map((f) => f.name)
          .filter((n) => /ejf|person|ejerskab|ejendom|admin/i.test(n))
          .sort() ?? [];
      return { httpStatus, ok: true, ejfFields };
    }
    const firstKey = Object.keys(json.data ?? {})[0];
    const count = firstKey ? (json.data?.[firstKey]?.nodes?.length ?? 0) : 0;
    return { httpStatus, ok: true, firstKey, nodeCount: count };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * GET /api/debug/ejf-probe
 * Requires Authorization: Bearer $CRON_SECRET.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!verifyAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const token = await getSharedOAuthToken();
  if (!token) {
    return NextResponse.json(
      { error: 'OAuth token unavailable — check DATAFORDELER_OAUTH_CLIENT_ID/_SECRET' },
      { status: 500 }
    );
  }

  // Run all probes in parallel
  const graphqlResults: Record<string, unknown> = {};
  await Promise.all(
    EJF_GQL_PROBES.map(async (p) => {
      graphqlResults[p.name] = await probeGraphQL(p.name, p.query, token);
    })
  );

  const filResults: Record<string, unknown> = {};
  await Promise.all(
    FIL_URL_PATTERNS.map(async (u) => {
      filResults[u] = await probeUrl(u, `Bearer ${token}`);
    })
  );

  // Also probe flexibleHistory endpoint for PersonSimpelBegraenset
  const historyResults: Record<string, unknown> = {};
  for (const fieldName of [
    'EJFCustom_PersonSimpelBegraenset',
    'CustomPersonSimpelBegraenset',
    'EJFCustom_EjerskabBegraenset',
  ]) {
    try {
      const res = await fetch(proxyUrl(FLEXIBLE_HISTORY_URL), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...proxyHeaders(),
        },
        body: JSON.stringify({
          query: `{ ${fieldName}(first: 1, virkningstid: "${VT}") { nodes { id_lokalId } } }`,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const json = (await res.json().catch(() => null)) as {
        errors?: Array<{ message: string; extensions?: { code: string } }>;
      } | null;
      historyResults[`flexibleHistory/${fieldName}`] = {
        httpStatus: res.status,
        errors: json?.errors?.map((e) => ({ message: e.message, code: e.extensions?.code })),
      };
    } catch (err) {
      historyResults[`flexibleHistory/${fieldName}`] = {
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  logger.log('[debug/ejf-probe] completed');
  return NextResponse.json({
    tokenPreview: `${token.slice(0, 12)}…${token.slice(-4)}`,
    tokenLength: token.length,
    graphql: graphqlResults,
    fildownload: filResults,
    flexibleHistory: historyResults,
  });
}
