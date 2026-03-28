/**
 * GET /api/adresse/jordstykke?lng=...&lat=...
 *
 * Server-side proxy for DAR jordstykke-opslag (koordinatbaseret).
 * Bruger DAWA fallback internt, indtil MAT GraphQL er implementeret.
 *
 * @param request - Next.js request med ?lng=longitude&lat=latitude
 * @returns DawaJordstykke objekt eller null
 */

import { NextRequest, NextResponse } from 'next/server';
import { darHentJordstykke } from '@/app/lib/dar';

export async function GET(request: NextRequest) {
  const lng = parseFloat(request.nextUrl.searchParams.get('lng') ?? '');
  const lat = parseFloat(request.nextUrl.searchParams.get('lat') ?? '');

  if (isNaN(lng) || isNaN(lat)) {
    return NextResponse.json(null, { status: 400 });
  }

  try {
    const jordstykke = await darHentJordstykke(lng, lat);
    return NextResponse.json(jordstykke, {
      headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' },
    });
  } catch (err) {
    console.error('[adresse/jordstykke] Fejl:', err);
    return NextResponse.json(null, { status: 200 });
  }
}
