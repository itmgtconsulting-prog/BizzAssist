/**
 * GET /api/adresse/autocomplete?q=...
 *
 * Server-side proxy for DAR autocomplete.
 * Nødvendig fordi DAR kræver API-nøgle (server-side env var),
 * mens autocomplete bruges fra client-side komponenter.
 *
 * @param request - Next.js request med ?q=søgestreng
 * @returns Array af DawaAutocompleteResult (DAR-kompatibelt format)
 */

import { NextRequest, NextResponse } from 'next/server';
import { darAutocomplete } from '@/app/lib/dar';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';

export async function GET(request: NextRequest) {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const q = request.nextUrl.searchParams.get('q') ?? '';

  if (q.trim().length < 2) {
    return NextResponse.json([]);
  }

  try {
    const results = await darAutocomplete(q);
    return NextResponse.json(results, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
    });
  } catch (err) {
    console.error('[adresse/autocomplete] Fejl:', err);
    return NextResponse.json([], { status: 200 });
  }
}
