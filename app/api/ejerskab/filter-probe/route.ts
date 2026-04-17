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

async function _runQuery(token: string, whereClause: string) {
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

  async function gql(q: string) {
    const r = await fetch(proxyUrl(EJF_GQL_URL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...proxyHeaders(),
      },
      body: JSON.stringify({ query: q }),
      signal: AbortSignal.timeout(15000),
    });
    return r.text();
  }

  // 1. Root Query-type: hvilke top-level operations findes der?
  const rootQuery = await gql(`{
    __type(name: "Query") {
      fields { name args { name type { name kind } } }
    }
  }`);

  // 2. Alle typer der starter med EJFCustom
  const typesList = await gql(`{
    __schema {
      types {
        name
        kind
      }
    }
  }`);

  // 3. Filter-input for vores brugte type — prøv også navn-varianter
  const filterTypes = [
    'EJFCustom_EjerskabBegraensetFilterInput',
    'EjfCustom_EjerskabBegraensetFilterInput',
    'EJFCustom_EjerskabBegraenset_FilterInput',
    'EJFCustomEjerskabBegraensetFilterInput',
  ];
  const filterIntrospections: Record<string, string> = {};
  for (const n of filterTypes) {
    const q = `{ __type(name: "${n}") { name inputFields { name type { name kind ofType { name kind } } } } }`;
    filterIntrospections[n] = await gql(q);
  }

  const introspect = rootQuery;

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

  // Probe for andre top-level queries der matcher EJFCustom-mønstret.
  // Uden introspection prøver vi simpelthen kendte mønstre og ser hvilke
  // der returnerer data vs field-does-not-exist fejl.
  async function _tryRootQuery(name: string, args: string): Promise<unknown> {
    const q = `{ ${name}(${args}) { nodes { __typename } } }`;
    return { query: q, response: await gql(q) };
  }

  const virkningstid = new Date().toISOString();
  const rootTests: Record<string, unknown> = {};
  const candidateQueries = [
    `EJFCustom_EjerskabBegraenset(first: 1, virkningstid: "${virkningstid}", where: { bestemtFastEjendomBFENr: { eq: 2081243 } })`,
    `EJFCustom_PersonEjerskab(first: 1, virkningstid: "${virkningstid}")`,
    `EJFCustom_EjerskabByPerson(first: 1, virkningstid: "${virkningstid}")`,
    `EJFCustom_EjerskabPerson(first: 1, virkningstid: "${virkningstid}")`,
    `EJF_EjerskabByPerson(first: 1, virkningstid: "${virkningstid}")`,
    `EJF_EjerskabBegraenset(first: 1, virkningstid: "${virkningstid}")`,
    `EJF_PersonVirksomhedsoplys(first: 1, virkningstid: "${virkningstid}", where: { navn: { eq: "${navn.replace(/"/g, '\\"')}" } })`,
    `EJFCustom_EjerskabBegraensetByPerson(first: 1, virkningstid: "${virkningstid}")`,
    `EJF_Handelsoplysninger(first: 1, virkningstid: "${virkningstid}")`,
  ];
  for (const q of candidateQueries) {
    const queryStr = `{ ${q} { nodes { __typename } } }`;
    const resp = await gql(queryStr);
    const match = q.match(/^(\w+)/);
    const key = match ? match[1] : q.slice(0, 30);
    rootTests[key] = {
      query: queryStr.slice(0, 200),
      response: resp.slice(0, 500),
    };
  }

  // Prøv filter på eksisterende Ejerskab med alle kendte felter samtidig
  // for at se om vi kan ramme noget der returnerer Jakobs BFE'er
  const filterFieldProbes: Record<string, string> = {};
  const candidateFields = [
    'ejendeEnhedsNummer',
    'ejendePersonId',
    'ejendePersonBegraensetId_lokalId',
    'ejendePersonLokalId',
    'oplysningerEjesAfEjerskabId_lokalId',
    'id_lokalId',
    'ejetAfEnhedsNummer',
    'ejerEnhedsNummer',
  ];
  for (const f of candidateFields) {
    const q = `{ EJFCustom_EjerskabBegraenset(first: 1, virkningstid: "${virkningstid}", where: { ${f}: { eq: "test" } }) { nodes { bestemtFastEjendomBFENr } } }`;
    filterFieldProbes[f] = (await gql(q)).slice(0, 400);
  }

  const results = { rootTests, filterFieldProbes };

  return NextResponse.json(
    {
      probeInputs: { navn, foedselsdato: fd, id },
      rootQueryFields: introspect.slice(0, 6000),
      allTypesSnippet: typesList.slice(0, 8000),
      filterIntrospections,
      altIntrospections,
      results,
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
}
