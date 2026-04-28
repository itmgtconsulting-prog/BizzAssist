/**
 * GET /api/skraafoto/thumb?url=<COG_URL>
 *
 * BIZZ-1050: Server-side thumbnail proxy for skråfotos.
 * Henter fuld COG-fil fra CDN og genererer JPEG thumbnail via Sharp.
 *
 * COG-filer er 40-60MB men Sharp resizer dem til 256px på ~800ms.
 * Resultatet caches aggressivt (30 dage) da skråfotos ikke ændrer sig.
 *
 * @param url - CDN URL til COG-fil (skraafoto-cdn.dataforsyningen.dk)
 * @returns JPEG thumbnail (256x256)
 */

import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';

export async function GET(request: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = request.nextUrl.searchParams.get('url');

  if (!url || !url.includes('skraafoto-cdn.dataforsyningen.dk')) {
    return NextResponse.json({ error: 'Ugyldig URL' }, { status: 400 });
  }

  try {
    /* Hent fuld COG-fil fra CDN (40-60MB, ingen token nødvendig) */
    const res = await fetch(url, {
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      return NextResponse.json({ error: `CDN fejl: ${res.status}` }, { status: 502 });
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    /* Generer thumbnail via Sharp (~800ms for 60MB COG) */
    const thumbnail = await sharp(buffer, { failOn: 'none', limitInputPixels: false })
      .resize(256, 256, { fit: 'cover' })
      .jpeg({ quality: 75 })
      .toBuffer();

    return new NextResponse(new Uint8Array(thumbnail), {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=2592000, s-maxage=2592000',
      },
    });
  } catch (err) {
    logger.error('[skraafoto/thumb] Fejl:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Thumbnail generering fejlede' }, { status: 502 });
  }
}
