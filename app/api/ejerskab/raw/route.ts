/**
 * GET /api/ejerskab/raw?bfeNummer=2081243
 *
 * DIAGNOSTISK endpoint til at se HELE det rå EJF GraphQL-svar for en BFE.
 * Prøver at udvide node-selectionen med alle sandsynlige person-identifikator-
 * felter, og returnerer både errors og data så vi kan se hvad der virker.
 *
 * Bruges midlertidigt til at finde et pålideligt id vi kan bruge til at binde
 * en CVR ES-person til deres ejendomme i EJF. Slettes igen når bro er etableret.
 *
 * Kræver authentication (samme RLS-scope som /api/ejerskab).
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { getSharedOAuthToken } from '@/app/lib/dfTokenCache';
import { getCertOAuthToken, isCertAuthConfigured } from '@/app/lib/dfCertAuth';

export const runtime = 'nodejs';
export const maxDuration = 30;

const EJF_GQL_URL = 'https://services.datafordeler.dk/EJF/Ejerfortegnelsen/3/REST/graphql';

function proxyUrl(url: string): string {
  const base = process.env.DF_PROXY_URL;
  return base ? `${base}${url.replace(/^https?:\/\/[^/]+/, '')}` : url;
}
function proxyHeaders(): Record<string, string> {
  const secret = process.env.DF_PROXY_SECRET;
  return secret ? { 'x-proxy-secret': secret } : {};
}

/**
 * Prøver en række mulige person-felter i EJF's GraphQL-selection og returnerer
 * første ikke-tomme resultat sammen med den query-variant der virkede.
 */
async function probeQuery(
  bfeNummer: number,
  token: string,
  selection: string
): Promise<{
  ok: boolean;
  status: number;
  errors?: unknown;
  data?: unknown;
  selection: string;
}> {
  const virkningstid = new Date().toISOString();
  const query = `{
    EJFCustom_EjerskabBegraenset(
      first: 10
      virkningstid: "${virkningstid}"
      where: { bestemtFastEjendomBFENr: { eq: ${bfeNummer} } }
    ) {
      nodes {
        ${selection}
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
      signal: AbortSignal.timeout(15000),
      cache: 'no-store',
    });
    const json = (await res.json()) as { errors?: unknown; data?: unknown };
    return {
      ok: res.ok && !json.errors,
      status: res.status,
      errors: json.errors,
      data: json.data,
      selection,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      errors: err instanceof Error ? err.message : String(err),
      selection,
    };
  }
}

export async function GET(req: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const bfeParam = req.nextUrl.searchParams.get('bfeNummer');
  const bfeNummer = bfeParam ? parseInt(bfeParam, 10) : NaN;
  if (!Number.isFinite(bfeNummer) || bfeNummer <= 0) {
    return NextResponse.json({ error: 'bfeNummer required' }, { status: 400 });
  }

  // Samme token-strategi som /api/ejerskab: shared secret først, mTLS-cert som fallback.
  let token: string | null = await getSharedOAuthToken().catch(() => null);
  let tokenSource = 'shared-secret';
  if (!token && isCertAuthConfigured()) {
    token = await getCertOAuthToken().catch(() => null);
    tokenSource = 'cert';
  }
  if (!token) {
    return NextResponse.json(
      { error: 'OAuth token unavailable', tokenSource: 'none' },
      { status: 503 }
    );
  }
  const tokenInfoHeader = { 'x-token-source': tokenSource };
  void tokenInfoHeader;

  // En række kandidat-selections vi prøver i rækkefølge for at finde ud af
  // hvilke felter EJF faktisk eksponerer på node + ejendePersonBegraenset.
  const variants = [
    {
      name: 'baseline',
      selection: `
        bestemtFastEjendomBFENr
        ejendeVirksomhedCVRNr
        ejendePersonBegraenset { navn { navn } }
        ejerforholdskode
        faktiskEjerandel_taeller
        faktiskEjerandel_naevner
        virkningFra
      `,
    },
    {
      name: 'try_ejendeEnhedsNummer',
      selection: `
        bestemtFastEjendomBFENr
        ejendeEnhedsNummer
        ejendePersonEnhedsNummer
        ejendeVirksomhedCVRNr
        ejendePersonBegraenset { navn { navn } }
      `,
    },
    {
      name: 'try_person_extended',
      selection: `
        bestemtFastEjendomBFENr
        ejendePersonBegraenset {
          navn { navn }
          enhedsNummer
          personEnhedsNummer
          cpr { cpr }
          cpr
          foedselsdato
          alderstrin
        }
      `,
    },
    {
      name: 'try_ejendePerson_nonBegraenset',
      selection: `
        bestemtFastEjendomBFENr
        ejendePerson {
          navn { navn }
          enhedsNummer
          cpr
        }
      `,
    },
    {
      name: 'introspect_node',
      selection: `
        __typename
        bestemtFastEjendomBFENr
        ejendePersonBegraenset {
          __typename
          navn { __typename navn }
        }
      `,
    },
  ];

  const results: Record<string, unknown> = {};
  for (const v of variants) {
    const r = await probeQuery(bfeNummer, token, v.selection);
    results[v.name] = r;
  }

  return NextResponse.json(
    {
      bfeNummer,
      timestamp: new Date().toISOString(),
      results,
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
}
