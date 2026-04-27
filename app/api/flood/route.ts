/**
 * GET /api/flood?lat=55.676&lng=12.568
 *
 * BIZZ-948: Oversvømmelsesrisiko punkt-lookup via Dataforsyningen DHM WMS.
 * Henter 1x1 pixel GetMap-tiles for havvand +1m og skybrud bluespot og
 * tjekker om pixelen er farvet (i zone) eller transparent (uden for zone).
 *
 * @param lat - Breddegrad (WGS84)
 * @param lng - Længdegrad (WGS84)
 * @returns { havvand1m: boolean, skybrud: boolean, risikoNiveau: 'lav'|'medium'|'hoej' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { parseQuery } from '@/app/lib/validate';
import { resolveTenantId } from '@/lib/api/auth';
import { logger } from '@/app/lib/logger';

export const runtime = 'nodejs';

const querySchema = z.object({
  lat: z.string().regex(/^-?\d+(\.\d+)?$/),
  lng: z.string().regex(/^-?\d+(\.\d+)?$/),
});

/** Tjek om et DHM WMS-lag dækker et punkt via 1x1 pixel GetMap. */
async function isInFloodZone(
  layer: string,
  lat: number,
  lng: number,
  token: string
): Promise<boolean> {
  // Byg en lille bbox rundt om punktet (~10m)
  const d = 0.00005;
  const bbox = `${lat - d},${lng - d},${lat + d},${lng + d}`;

  const url =
    `https://api.dataforsyningen.dk/wms/dhm?service=WMS&version=1.1.1&request=GetMap` +
    `&layers=${layer}&styles=&format=image/png&transparent=true` +
    `&width=1&height=1&srs=EPSG:4326&bbox=${bbox}&token=${token}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return false;

    const buf = Buffer.from(await res.arrayBuffer());
    // PNG: 8-byte header + IHDR chunk. For 1x1 RGBA PNG, check if alpha channel > 0.
    // Minimal 1x1 transparent PNG er ~67 bytes, farvet er typisk ~70+ bytes.
    // Vi tjekker IDAT-data: transparent pixel har raw bytes 00 00 00 00 00 (filter + RGBA)
    // Simpel heuristik: PNG > 68 bytes = farvet pixel = i zone
    return buf.length > 68;
  } catch (err) {
    logger.warn('[flood] WMS lookup fejl:', err instanceof Error ? err.message : err);
    return false;
  }
}

export interface FloodRiskData {
  /** true hvis punktet er i havvand +1m oversvømmelseszone */
  havvand1m: boolean;
  /** true hvis punktet er i skybrud bluespot zone */
  skybrud: boolean;
  /** Samlet risikoniveau */
  risikoNiveau: 'lav' | 'medium' | 'hoej';
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = parseQuery(req, querySchema);
  if (!parsed.success) return parsed.response;

  const token = process.env.DATAFORSYNINGEN_TOKEN;
  if (!token) {
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 503 });
  }

  const lat = parseFloat(parsed.data.lat);
  const lng = parseFloat(parsed.data.lng);

  // Kør begge lookups parallelt
  const [havvand1m, skybrud] = await Promise.all([
    isInFloodZone('dhm_havvandpaaland', lat, lng, token),
    isInFloodZone('dhm_bluespot_ekstremregn', lat, lng, token),
  ]);

  const risikoNiveau: FloodRiskData['risikoNiveau'] =
    havvand1m && skybrud ? 'hoej' : havvand1m || skybrud ? 'medium' : 'lav';

  return NextResponse.json({ havvand1m, skybrud, risikoNiveau } satisfies FloodRiskData, {
    headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' },
  });
}
