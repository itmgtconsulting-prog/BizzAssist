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

  const safeNavn = navn.replace(/"/g, '\\"');
  const safeFd = fd.replace(/"/g, '\\"');
  const safeId = id.replace(/"/g, '\\"');

  // Test flere filter-syntaxer
  const variants: Array<{ name: string; where: string }> = [
    {
      name: 'nested_navn_only',
      where: `{ ejendePersonBegraenset: { navn: { navn: { eq: "${safeNavn}" } } } }`,
    },
    {
      name: 'nested_foedselsdato_only',
      where: `{ ejendePersonBegraenset: { foedselsdato: { eq: "${safeFd}" } } }`,
    },
    {
      name: 'nested_id_only',
      where: `{ ejendePersonBegraenset: { id: { eq: "${safeId}" } } }`,
    },
    {
      name: 'flat_ejendePersonBegraensetId',
      where: `{ ejendePersonBegraensetId: { eq: "${safeId}" } }`,
    },
    {
      name: 'flat_ejendePersonNavn',
      where: `{ ejendePersonNavn: { eq: "${safeNavn}" } }`,
    },
    {
      name: 'flat_ejendePersonFoedselsdato',
      where: `{ ejendePersonFoedselsdato: { eq: "${safeFd}" } }`,
    },
    {
      name: 'nested_and_navn_fd',
      where: `{ and: [
        { ejendePersonBegraenset: { navn: { navn: { eq: "${safeNavn}" } } } }
        { ejendePersonBegraenset: { foedselsdato: { eq: "${safeFd}" } } }
      ] }`,
    },
  ];

  const results: Record<string, unknown> = {};
  for (const v of variants) {
    results[v.name] = await runQuery(token, v.where);
  }

  return NextResponse.json(
    { probeInputs: { navn, foedselsdato: fd, id }, results },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
}
