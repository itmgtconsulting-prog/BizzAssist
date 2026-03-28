/**
 * GET /api/adresse/lookup?id=UUID
 *
 * Server-side proxy for DAR adresse-opslag.
 * Nødvendig fordi DAR kræver API-nøgle (server-side env var).
 *
 * @param request - Next.js request med ?id=adresse-UUID
 * @returns DawaAdresse objekt eller null
 */

import { NextRequest, NextResponse } from 'next/server';
import { darHentAdresse } from '@/app/lib/dar';

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id') ?? '';

  if (!id) {
    return NextResponse.json(null, { status: 400 });
  }

  try {
    const adresse = await darHentAdresse(id);
    return NextResponse.json(adresse, {
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200' },
    });
  } catch (err) {
    console.error('[adresse/lookup] Fejl:', err);
    return NextResponse.json(null, { status: 200 });
  }
}
