/**
 * GET /api/skraafoto/thumb?url=<COG_URL>&token=<TOKEN>
 *
 * BIZZ-1050: Server-side thumbnail proxy for skråfotos.
 * Dataforsyningens cogtiler thumbnail-tjeneste er nedlagt —
 * denne route henter de første 512KB af COG-filen (overview level)
 * og genererer en JPEG thumbnail via Sharp.
 *
 * Caches aggressivt (30 dage) da skråfotos ikke ændrer sig.
 *
 * @param url - CDN URL til COG-fil (skraafoto-cdn.dataforsyningen.dk)
 * @param token - Dataforsyningen API token
 * @returns JPEG thumbnail (256x256)
 */

import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';

/** Max bytes at hente fra COG (overview data sidder i slutningen af filen) */
const OVERVIEW_BYTES = 1024 * 1024; // 1MB — nok til mindste overview

export async function GET(request: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = request.nextUrl;
  const url = searchParams.get('url');

  if (!url || !url.includes('skraafoto-cdn.dataforsyningen.dk')) {
    return NextResponse.json({ error: 'Ugyldig URL' }, { status: 400 });
  }

  try {
    /* Hent filstørrelse først */
    const headRes = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000),
    });
    if (!headRes.ok) {
      return NextResponse.json({ error: `CDN fejl: ${headRes.status}` }, { status: 502 });
    }

    const contentLength = parseInt(headRes.headers.get('content-length') ?? '0', 10);
    if (contentLength === 0) {
      return NextResponse.json({ error: 'Tom fil' }, { status: 502 });
    }

    /* Hent overview data fra slutningen af filen (COG overviews er typisk der) */
    const start = Math.max(0, contentLength - OVERVIEW_BYTES);
    const rangeRes = await fetch(url, {
      headers: { Range: `bytes=${start}-${contentLength - 1}` },
      signal: AbortSignal.timeout(15000),
    });

    if (!rangeRes.ok && rangeRes.status !== 206) {
      return NextResponse.json({ error: `Range fejl: ${rangeRes.status}` }, { status: 502 });
    }

    const buffer = Buffer.from(await rangeRes.arrayBuffer());

    /* Generer thumbnail via Sharp — COG overview data kan læses som rå TIFF */
    try {
      const thumbnail = await sharp(buffer, { failOn: 'none' })
        .resize(256, 256, { fit: 'cover' })
        .jpeg({ quality: 75 })
        .toBuffer();

      return new NextResponse(new Uint8Array(thumbnail), {
        headers: {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'public, max-age=2592000, s-maxage=2592000',
        },
      });
    } catch {
      /* Sharp kan ikke parse partial TIFF — prøv fuld range (kun for små filer) */
      if (contentLength < 5 * 1024 * 1024) {
        const fullRes = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (fullRes.ok) {
          const fullBuf = Buffer.from(await fullRes.arrayBuffer());
          const thumbnail = await sharp(fullBuf, { failOn: 'none' })
            .resize(256, 256, { fit: 'cover' })
            .jpeg({ quality: 75 })
            .toBuffer();

          return new NextResponse(new Uint8Array(thumbnail), {
            headers: {
              'Content-Type': 'image/jpeg',
              'Cache-Control': 'public, max-age=2592000, s-maxage=2592000',
            },
          });
        }
      }

      /* Fallback: 1x1 transparent pixel */
      logger.warn(`[skraafoto/thumb] Sharp fejl for ${url.slice(0, 80)}`);
      return NextResponse.json({ error: 'Thumbnail generering fejlede' }, { status: 502 });
    }
  } catch (err) {
    logger.error('[skraafoto/thumb] Fejl:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 502 });
  }
}
