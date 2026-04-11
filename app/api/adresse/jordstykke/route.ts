/**
 * GET /api/adresse/jordstykke?lng=...&lat=...
 * GET /api/adresse/jordstykke?bfe=...
 *
 * Server-side proxy for DAR jordstykke-opslag.
 * Understøtter koordinatbaseret opslag og BFE-nummer opslag.
 *
 * @param request - Next.js request med ?lng=longitude&lat=latitude ELLER ?bfe=BFEnummer
 * @returns DawaJordstykke objekt eller null
 */

import { NextRequest, NextResponse } from 'next/server';
import { darHentJordstykke } from '@/app/lib/dar';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';

export async function GET(request: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const bfe = request.nextUrl.searchParams.get('bfe');

  // BFE-baseret opslag — returnerer jordstykke + første adgangsadresse-UUID
  if (bfe) {
    // Validate BFE is a positive integer to prevent SSRF via query param injection
    if (!/^\d{1,10}$/.test(bfe)) {
      return NextResponse.json(null, { status: 400 });
    }
    try {
      const jsRes = await fetch(
        `https://api.dataforsyningen.dk/jordstykker?bfenummer=${encodeURIComponent(bfe)}`,
        {
          signal: AbortSignal.timeout(5000),
        }
      );
      if (!jsRes.ok) return NextResponse.json(null, { status: 200 });
      const jsData = await jsRes.json();
      if (!Array.isArray(jsData) || jsData.length === 0)
        return NextResponse.json(null, { status: 200 });

      const js = jsData[0];

      // Find en adgangsadresse via ejerlav+matrikelnr (hurtigere end BFE-baseret adressequery)
      let adgangsadresseId: string | null = null;
      const ek = js.ejerlav?.kode;
      const mn = js.matrikelnr;
      if (ek && mn) {
        const adgRes = await fetch(
          `https://api.dataforsyningen.dk/adgangsadresser?ejerlavkode=${ek}&matrikelnr=${encodeURIComponent(mn)}&struktur=mini&per_side=1`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (adgRes.ok) {
          const adgData = await adgRes.json();
          if (Array.isArray(adgData) && adgData.length > 0) {
            adgangsadresseId = adgData[0].id ?? null;
          }
        }
      }

      return NextResponse.json(
        { ...js, adgangsadresseId },
        {
          headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' },
        }
      );
    } catch {
      return NextResponse.json(null, { status: 200 });
    }
  }

  // Koordinatbaseret opslag
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
    logger.error('[adresse/jordstykke] Fejl:', err);
    return NextResponse.json(null, { status: 200 });
  }
}
