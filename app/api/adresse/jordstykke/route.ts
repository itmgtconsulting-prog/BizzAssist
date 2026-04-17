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
import { z } from 'zod';
import { darHentJordstykke } from '@/app/lib/dar';
import { fetchDawa } from '@/app/lib/dawa';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';

/** Zod schema for BFE-baseret opslag */
const bfeQuerySchema = z.object({
  bfe: z.string().regex(/^\d{1,10}$/, 'BFE skal være et positivt heltal (max 10 cifre)'),
});

/** Zod schema for koordinatbaseret opslag */
const coordQuerySchema = z.object({
  lng: z.coerce.number(),
  lat: z.coerce.number(),
});

export async function GET(request: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const bfe = request.nextUrl.searchParams.get('bfe');

  // BFE-baseret opslag — returnerer jordstykke + første adgangsadresse-UUID
  if (bfe) {
    const bfeParsed = bfeQuerySchema.safeParse({ bfe });
    if (!bfeParsed.success) {
      return NextResponse.json(null, { status: 400 });
    }
    try {
      const jsRes = await fetchDawa(
        `https://api.dataforsyningen.dk/jordstykker?bfenummer=${encodeURIComponent(bfe)}`,
        { signal: AbortSignal.timeout(5000) },
        { caller: 'adresse.jordstykke.bfe' }
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
        const adgRes = await fetchDawa(
          `https://api.dataforsyningen.dk/adgangsadresser?ejerlavkode=${ek}&matrikelnr=${encodeURIComponent(mn)}&struktur=mini&per_side=1`,
          { signal: AbortSignal.timeout(5000) },
          { caller: 'adresse.jordstykke.ejerlav' }
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
  const coordParsed = coordQuerySchema.safeParse({
    lng: request.nextUrl.searchParams.get('lng') ?? '',
    lat: request.nextUrl.searchParams.get('lat') ?? '',
  });

  if (!coordParsed.success) {
    return NextResponse.json(null, { status: 400 });
  }
  const { lng, lat } = coordParsed.data;

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
