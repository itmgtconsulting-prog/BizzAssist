/**
 * GET /api/stoej?lat=X&lng=Y
 *
 * BIZZ-961: Punkt-lookup af støjniveau fra Miljøstyrelsen GIS.
 * Kalder miljoegis WMS GetFeatureInfo for at returnere dB-niveau.
 *
 * @param lat - Breddegrad (WGS84)
 * @param lng - Længdegrad (WGS84)
 * @returns { vejstoejLdenDb: number | null, togstoejLdenDb: number | null }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { parseQuery } from '@/app/lib/validate';
import { resolveTenantId } from '@/lib/api/auth';
import { logger } from '@/app/lib/logger';

export const runtime = 'nodejs';

const querySchema = z.object({
  lat: z.coerce.number().min(54).max(58),
  lng: z.coerce.number().min(7).max(16),
});

const WMS_BASE = 'https://tilecache2-miljoegis.mim.dk/gwc/service/wms';

/**
 * Henter støjniveau via WMS GetFeatureInfo.
 *
 * @param layer - WMS lag-navn
 * @param lat - Breddegrad
 * @param lng - Længdegrad
 * @returns dB-niveau eller null
 */
async function getNoiseLevel(layer: string, lat: number, lng: number): Promise<number | null> {
  try {
    // Konverter WGS84 → EPSG:3857 (Web Mercator) for WMS query
    const x = (lng * 20037508.34) / 180;
    const y3857 = Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180);
    const yMerc = (y3857 * 20037508.34) / 180;

    // Lav en lille bbox omkring punktet (~100m)
    const delta = 50; // meter i EPSG:3857
    const bbox = `${x - delta},${yMerc - delta},${x + delta},${yMerc + delta}`;

    const url =
      `${WMS_BASE}?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetFeatureInfo` +
      `&LAYERS=${encodeURIComponent(layer)}&QUERY_LAYERS=${encodeURIComponent(layer)}` +
      `&SRS=EPSG:3857&BBOX=${bbox}&WIDTH=256&HEIGHT=256&X=128&Y=128` +
      `&INFO_FORMAT=application/json&FEATURE_COUNT=1`;

    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;

    const data = await res.json();
    const features = data.features ?? [];
    if (features.length === 0) return null;

    // Hent dB-værdi fra feature properties
    const props = features[0].properties ?? {};
    const dbValue = props.db_lden ?? props.lden ?? props.value ?? props.GRAY_INDEX ?? null;
    return typeof dbValue === 'number' ? dbValue : null;
  } catch (err) {
    logger.warn(
      `[stoej] GetFeatureInfo fejl for ${layer}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = parseQuery(req, querySchema);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Ugyldige parametre' }, { status: 400 });
  }

  const { lat, lng } = parsed.data;

  const [vejstoej, togstoej] = await Promise.all([
    getNoiseLevel('theme-dk_noise2022_vej_1_5m', lat, lng),
    getNoiseLevel('theme-dk_noise2022_jernbane_1_5m', lat, lng),
  ]);

  return NextResponse.json(
    { vejstoejLdenDb: vejstoej, togstoejLdenDb: togstoej },
    { headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' } }
  );
}
