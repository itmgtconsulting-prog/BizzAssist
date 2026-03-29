/**
 * DEBUG — /api/debug-env
 * Temporary endpoint to verify environment variables are loaded on Vercel.
 * Returns key lengths (never values) for troubleshooting.
 * DELETE THIS FILE after debugging.
 */

import { NextResponse } from 'next/server';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';

export async function GET() {
  const keys = [
    'DATAFORDELER_API_KEY',
    'DATAFORDELER_OAUTH_CLIENT_ID',
    'DATAFORDELER_OAUTH_CLIENT_SECRET',
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'BIZZASSIST_CLAUDE_KEY',
    'NEXT_PUBLIC_APP_URL',
    'NEXT_PUBLIC_MAPBOX_TOKEN',
  ];

  const result: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k];
    result[k] = v ? `SET (${v.length} chars, starts=${v.slice(0, 4)}…)` : 'NOT SET';
  }

  // Quick test: try fetching DAR
  let darTest = 'not tested';
  const apiKey = process.env.DATAFORDELER_API_KEY;
  if (apiKey) {
    try {
      const url = proxyUrl(
        `https://graphql.datafordeler.dk/DAR/v1?apiKey=${encodeURIComponent(apiKey)}`
      );
      const ts = new Date().toISOString();
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...proxyHeaders() },
        body: JSON.stringify({
          query: `{ DAR_Husnummer(first: 1, virkningstid: "${ts}", registreringstid: "${ts}", where: { adgangsadressebetegnelse: { startsWith: "Vesterbrogade 1" } }) { nodes { id_lokalId adgangsadressebetegnelse } } }`,
        }),
        signal: AbortSignal.timeout(proxyTimeout()),
      });
      const text = await res.text();
      darTest = `HTTP ${res.status}: ${text.slice(0, 300)}`;
    } catch (err) {
      darTest = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return NextResponse.json({ env: result, darTest });
}
