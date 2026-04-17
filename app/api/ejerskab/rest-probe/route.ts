/**
 * GET /api/ejerskab/rest-probe
 *
 * Probe Datafordeler REST-endpoints for EJF Custom-tjenester. Confluence-siden
 * nævner specifikt at man kan foretage "EJF Custom Ejerskabbegrænset kaldet"
 * — måske er det en REST-operation vi ikke har udnyttet via GraphQL.
 *
 * Tester også alternative GraphQL-tjenester vi ikke har prøvet.
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { getSharedOAuthToken } from '@/app/lib/dfTokenCache';
import { proxyUrl, proxyHeaders } from '@/app/lib/dfProxy';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET(_req: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const fdatoShort = '110772';
  const navn = 'Jakob Juul Rasmussen';
  const ejfId = '68595ce7-59fb-4387-8a5b-1962685ef309';

  const token = await getSharedOAuthToken().catch(() => null);
  if (!token) return NextResponse.json({ error: 'no token' }, { status: 503 });

  async function rest(url: string) {
    try {
      const r = await fetch(proxyUrl(url), {
        headers: { Authorization: `Bearer ${token}`, ...proxyHeaders() },
        signal: AbortSignal.timeout(15000),
      });
      const text = await r.text();
      return { status: r.status, bodyPreview: text.slice(0, 800) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function gql(q: string) {
    const r = await fetch(proxyUrl('https://graphql.datafordeler.dk/flexibleCurrent/v1/'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...proxyHeaders(),
      },
      body: JSON.stringify({ query: q }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await r.text();
    return { status: r.status, bodyPreview: text.slice(0, 800) };
  }

  const results: Record<string, unknown> = {};

  // ─── REST ENDPOINTS ─────────────────────────────────────────────────────
  const restUrls = [
    // EJFCustom REST common patterns
    `https://services.datafordeler.dk/EJFCustom/EjerskabBegraenset/1/rest/hentEjerskabBegraenset?navn=${encodeURIComponent(navn)}&foedselsdato=${fdatoShort}`,
    `https://services.datafordeler.dk/EJFCustom/EjerskabBegraenset/1/rest/soegEjerskab?navn=${encodeURIComponent(navn)}&foedselsdato=${fdatoShort}`,
    `https://services.datafordeler.dk/EJFCustom/EjerskabBegraenset/1/rest/ejerskab?ejendePersonBegraensetId=${ejfId}`,
    `https://services.datafordeler.dk/EJFCustom/EjerskabBegraenset/1/REST/ejerskab?ejendePersonBegraensetId=${ejfId}`,
    // EJF standard REST for EjerskabBegraenset
    `https://services.datafordeler.dk/EJF/EjerskabBegraenset/1/rest/ejerskab?ejendePersonBegraensetId=${ejfId}`,
    `https://services.datafordeler.dk/EJF/Ejerfortegnelsen/1/rest/ejerskab?personId=${ejfId}`,
  ];

  for (const url of restUrls) {
    const label = url.replace('https://services.datafordeler.dk/', '').slice(0, 80);
    results[`REST_${label}`] = { url, ...(await rest(url)) };
  }

  // ─── GRAPHQL: andre tjenester vi ikke har testet ─────────────────────────
  const gqlQueries = [
    // Ikke-begrænsede varianter
    {
      label: 'EJF_Ejerskab',
      q: `{ EJF_Ejerskab(first: 1, virkningstid: "${new Date().toISOString()}") { nodes { __typename } } }`,
    },
    {
      label: 'EJFCustom_Ejerskab',
      q: `{ EJFCustom_Ejerskab(first: 1, virkningstid: "${new Date().toISOString()}") { nodes { __typename } } }`,
    },
    {
      label: 'EJF_EjerskabUdvidet',
      q: `{ EJF_EjerskabUdvidet(first: 1, virkningstid: "${new Date().toISOString()}") { nodes { __typename } } }`,
    },
    {
      label: 'EJF_EjerskabBegraensetUdvidet',
      q: `{ EJF_EjerskabBegraensetUdvidet(first: 1, virkningstid: "${new Date().toISOString()}") { nodes { __typename } } }`,
    },
    // Muligvis med by-person-variant
    {
      label: 'EJF_PersonBegraenset',
      q: `{ EJF_PersonBegraenset(first: 1, virkningstid: "${new Date().toISOString()}") { nodes { __typename } } }`,
    },
    {
      label: 'EJFCustom_PersonBegraenset',
      q: `{ EJFCustom_PersonBegraenset(first: 1, virkningstid: "${new Date().toISOString()}") { nodes { __typename } } }`,
    },
    // Prøv på v2/v3 endpoint hvis det findes
    // (separat fetch — kan ikke wrappes i gql-helperen ovenfor da den hard-coder /v1/)
  ];
  for (const { label, q } of gqlQueries) {
    results[`GQL_${label}`] = await gql(q);
  }

  // ─── Forskellige flexibleCurrent endpoint-versioner ──────────────────────
  const endpointVersions = [
    'https://graphql.datafordeler.dk/flexibleCurrent/v2/',
    'https://graphql.datafordeler.dk/flexibleCurrent/v3/',
    'https://graphql.datafordeler.dk/custom/v1/',
    'https://graphql.datafordeler.dk/EJFCustom/v1/',
  ];
  for (const ep of endpointVersions) {
    try {
      const r = await fetch(proxyUrl(ep), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...proxyHeaders(),
        },
        body: JSON.stringify({ query: '{ __typename }' }),
        signal: AbortSignal.timeout(10000),
      });
      const text = await r.text();
      results[`EP_${ep.slice(32)}`] = { status: r.status, bodyPreview: text.slice(0, 400) };
    } catch (err) {
      results[`EP_${ep.slice(32)}`] = { error: String(err) };
    }
  }

  return NextResponse.json(
    { inputs: { navn, fdatoShort, ejfId }, results },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
}
