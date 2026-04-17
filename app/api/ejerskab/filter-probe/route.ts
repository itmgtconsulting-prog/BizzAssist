/**
 * GET /api/ejerskab/filter-probe?navn=Jakob+Juul+Rasmussen&foedselsdato=1972-07-11
 *
 * Diagnostisk endpoint der tester forskellige EJF GraphQL-filter-varianter
 * på personer, så vi kan finde ud af hvilken syntax der faktisk returnerer
 * personens ejendomme. EJF accepterer visse filter-syntaxer uden at fejle,
 * men returnerer 0 matches selv når data findes — vi skal finde rette format.
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { getSharedOAuthToken } from '@/app/lib/dfTokenCache';
import { proxyUrl, proxyHeaders } from '@/app/lib/dfProxy';

export const runtime = 'nodejs';
export const maxDuration = 30;

const EJF_GQL_URL = 'https://graphql.datafordeler.dk/flexibleCurrent/v1/';

async function runQuery(token: string, whereClause: string) {
  const virkningstid = new Date().toISOString();
  const query = `{
    EJFCustom_EjerskabBegraenset(
      first: 50
      virkningstid: "${virkningstid}"
      where: ${whereClause}
    ) {
      nodes {
        bestemtFastEjendomBFENr
        status
        ejendePersonBegraenset { id navn { navn } foedselsdato }
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
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* ignore */
    }
    return {
      status: res.status,
      parsed,
      rawSnippet: text.slice(0, 500),
    };
  } catch (err) {
    return { status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function GET(req: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const navn = req.nextUrl.searchParams.get('navn') ?? 'Jakob Juul Rasmussen';
  const fd = req.nextUrl.searchParams.get('foedselsdato') ?? '1972-07-11';
  const id = req.nextUrl.searchParams.get('id') ?? '68595ce7-59fb-4387-8a5b-1962685ef309';

  const token = await getSharedOAuthToken().catch(() => null);
  if (!token) return NextResponse.json({ error: 'OAuth token unavailable' }, { status: 503 });

  const _safeNavn = navn.replace(/"/g, '\\"');
  const _safeFd = fd.replace(/"/g, '\\"');
  const _safeId = id.replace(/"/g, '\\"');

  // Først: introspect filter-input-typen for at finde valide felter.
  const introspectQuery = `{
    __type(name: "EJFCustom_EjerskabBegraensetFilterInput") {
      name
      inputFields {
        name
        type {
          name
          kind
          ofType { name kind }
        }
      }
    }
  }`;
  const introspectRes = await fetch(proxyUrl(EJF_GQL_URL), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...proxyHeaders(),
    },
    body: JSON.stringify({ query: introspectQuery }),
    signal: AbortSignal.timeout(15000),
  });
  const introspect = await introspectRes.text();

  // Prøv også alternative typenavne
  const alternativeNames = [
    'EJFCustom_EjerskabBegraensetFilter',
    'EjfCustom_EjerskabBegraensetFilter',
    'EjfCustomEjerskabBegraensetFilterInput',
  ];
  const altIntrospections: Record<string, unknown> = {};
  for (const n of alternativeNames) {
    const q = `{ __type(name: "${n}") { name kind inputFields { name type { name kind } } } }`;
    const r = await fetch(proxyUrl(EJF_GQL_URL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...proxyHeaders(),
      },
      body: JSON.stringify({ query: q }),
      signal: AbortSignal.timeout(10000),
    });
    altIntrospections[n] = await r.text();
  }

  // Test flere filter-syntaxer (baseline som sanity-check)
  const variants: Array<{ name: string; where: string }> = [
    { name: 'bfe_direct', where: `{ bestemtFastEjendomBFENr: { eq: 2081243 } }` },
    {
      name: 'ejendePersonEnhedsNummer_68_prefix',
      where: `{ ejendePersonEnhedsNummer: { eq: 68595 } }`,
    },
  ];
  const results: Record<string, unknown> = {};
  for (const v of variants) {
    results[v.name] = await runQuery(token, v.where);
  }

  return NextResponse.json(
    {
      probeInputs: { navn, foedselsdato: fd, id },
      introspection: introspect.slice(0, 4000),
      altIntrospections,
      results,
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
}
