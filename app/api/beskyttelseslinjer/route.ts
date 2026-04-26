/**
 * GET /api/beskyttelseslinjer?lat=X&lng=Y
 *
 * BIZZ-961: Punkt-lookup af beskyttelseslinjer fra Miljøportalen.
 * Kalder arealinfo WFS med koordinat-filter.
 *
 * @param lat - Breddegrad (WGS84)
 * @param lng - Længdegrad (WGS84)
 * @returns { strandbeskyttelse: bool, skovbyggelinje: bool, ... }
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

const WFS_BASE = 'https://arealeditering-dist-geo.miljoeportal.dk/geoserver/ows';

/**
 * Tjek om et punkt ligger inden for et WFS-lag.
 *
 * @param layer - WFS lag-navn
 * @param lat - Breddegrad
 * @param lng - Længdegrad
 * @returns true hvis punkt er inden for laget
 */
async function checkLayer(layer: string, lat: number, lng: number): Promise<boolean> {
  try {
    const url =
      `${WFS_BASE}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature` +
      `&TYPENAMES=${encodeURIComponent(layer)}&COUNT=1&OUTPUTFORMAT=application/json` +
      `&CQL_FILTER=${encodeURIComponent(`INTERSECTS(the_geom, POINT(${lng} ${lat}))`)}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return false;

    const data = await res.json();
    return (data.features ?? []).length > 0;
  } catch (err) {
    logger.warn(
      `[beskyttelseslinjer] WFS fejl for ${layer}:`,
      err instanceof Error ? err.message : err
    );
    return false;
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

  const [strand, skov, fortidsminde, kirke] = await Promise.all([
    checkLayer('dai:soe_bes_linjer', lat, lng),
    checkLayer('dai:skovbyggelinjer', lat, lng),
    checkLayer('dai:bes_sten_jorddiger_2022', lat, lng),
    checkLayer('dai:kirkebyggelinjer', lat, lng),
  ]);

  return NextResponse.json(
    {
      strandbeskyttelse: strand,
      skovbyggelinje: skov,
      fortidsmindebeskyttelse: fortidsminde,
      kirkebyggelinje: kirke,
    },
    { headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' } }
  );
}
