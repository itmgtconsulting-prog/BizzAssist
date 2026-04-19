/**
 * TEMP DEBUG: GET /api/debug/bbr
 *
 * Returns diagnostic info about the BBR GraphQL connection from Vercel's side.
 * Used to troubleshoot why BBR returns null even though DATAFORDELER_API_KEY is set.
 *
 * Remove when BBR is fixed.
 */

import { NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET() {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const DF_API_KEY = process.env.DATAFORDELER_API_KEY ?? '';
  const DF_PROXY_URL = process.env.DF_PROXY_URL ?? '';

  const result: Record<string, unknown> = {
    hasApiKey: !!DF_API_KEY,
    apiKeyLength: DF_API_KEY.length,
    apiKeyPrefix: DF_API_KEY.slice(0, 4),
    hasProxy: !!DF_PROXY_URL,
    proxyUrl: DF_PROXY_URL ? `${DF_PROXY_URL.slice(0, 30)}...` : null,
  };

  if (!DF_API_KEY) {
    return NextResponse.json(result);
  }

  // Test FULL BYGNING_QUERY (same as app) with new BIZZ-487 fields
  const now = new Date().toISOString();
  const query = `{
    BBR_Bygning(first: 100, virkningstid: "${now}", where: { husnummer: { eq: "0a3f507c-b879-32b8-e044-0003ba298018" } }) {
      nodes {
        id_lokalId
        byg026Opfoerelsesaar
        byg027OmTilbygningsaar
        byg038SamletBygningsareal
        byg039BygningensSamledeBoligAreal
        byg040BygningensSamledeErhvervsAreal
        byg041BebyggetAreal
        byg024AntalLejlighederMedKoekken
        byg025AntalLejlighederUdenKoekken
        byg054AntalEtager
        byg033Tagdaekningsmateriale
        byg032YdervaeggensMateriale
        byg056Varmeinstallation
        byg057Opvarmningsmiddel
        byg058SupplerendeVarme
        byg030Vandforsyning
        byg031Afloebsforhold
        byg021BygningensAnvendelse
        byg070Fredning
        byg071BevaringsvaerdighedReference
        byg077KaelderAreal
        byg078TagetageAreal
        byg094Revisionsdato
        status
        husnummer
      }
    }
  }`;

  const directUrl = `https://graphql.datafordeler.dk/BBR/v2?apiKey=${DF_API_KEY}`;
  const url = proxyUrl(directUrl);
  result.finalUrlPrefix = url.slice(0, 60) + '...';

  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...proxyHeaders() },
      body: JSON.stringify({ query, variables: {} }),
      signal: AbortSignal.timeout(proxyTimeout()),
    });
    result.status = res.status;
    result.elapsedMs = Date.now() - start;
    const text = await res.text();
    result.bodyLength = text.length;
    result.bodyPreview = text.slice(0, 500);
    try {
      const json = JSON.parse(text);
      result.hasData = !!json.data;
      result.hasNodes = !!json.data?.BBR_Bygning?.nodes?.length;
      if (json.errors) result.graphqlErrors = json.errors.slice(0, 3);
    } catch {
      result.parseError = true;
    }
  } catch (err) {
    result.fetchError = err instanceof Error ? err.message : String(err);
    result.elapsedMs = Date.now() - start;
  }

  return NextResponse.json(result);
}
