/**
 * GET /api/wms
 *
 * Server-side proxy for danske offentlige WMS tile-services.
 * Tiles hentes server-side og videresendes til klienten,
 * så browserens CORS-restriktioner ikke gælder.
 *
 * Kun whitelistede services tillades:
 *   service=plandata → geoserver.plandata.dk
 *   service=miljo    → arealinformation.miljoeportal.dk
 *
 * Alle øvrige query-parametre viderestilles direkte til WMS-serveren.
 * BBOX-parameteren indeholder den tile-specifikke bbox fra Mapbox GL JS.
 *
 * Tiles caches i 24 timer da plandata og miljødata sjældent ændres intradag.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';
import { parseQuery } from '@/app/lib/validate';

export const runtime = 'nodejs';

// ─── Query param validation ─────────────────────────────────────────────────

const wmsQuerySchema = z.object({
  service: z.enum(['plandata', 'miljo', 'miljoegis'], {
    error: 'service skal være plandata, miljo eller miljoegis',
  }),
});

/**
 * Whitelistede WMS-services med verificerede endpoints.
 * Begge er bekræftet fungerende via GetCapabilities-kald.
 *   plandata: GeoServer for Plandata.dk (lokalplaner, kommuneplan, zonekort)
 *   miljo:    Danmarks Arealinformation GeoServer (natur, beskyttelseslinjer, grundvand)
 */
const WMS_BASES = {
  plandata: 'https://geoserver.plandata.dk/geoserver/wms',
  miljo: 'https://arealeditering-dist-geo.miljoeportal.dk/geoserver/ows',
  // BIZZ-961: Miljøstyrelsen GIS — støjkort og naturbeskyttelse
  miljoegis: 'https://tilecache2-miljoegis.mim.dk/gwc/service/wms',
} as const;

/** @internal Used by Zod schema enum — kept for type documentation */
type _ServiceKey = keyof typeof WMS_BASES;

/**
 * Proxy-handler — henter én WMS-tile server-side og returnerer den til klienten.
 *
 * @param request - Next.js GET request med service + WMS-parametre
 * @returns PNG-billedet fra WMS-serveren, eller HTTP-fejl
 */
export async function GET(request: NextRequest): Promise<Response> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = parseQuery(request, wmsQuerySchema);
  if (!parsed.success) return parsed.response;
  const { service } = parsed.data;

  // Byg WMS-URL — videresend alle parametre undtagen vores 'service'-nøgle
  const wmsParams = new URLSearchParams();
  for (const [key, value] of request.nextUrl.searchParams.entries()) {
    if (key !== 'service') wmsParams.set(key, value);
  }

  const url = `${WMS_BASES[service]}?${wmsParams.toString()}`;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      headers: { Accept: 'image/png,image/*,*/*' },
    });

    if (!res.ok) {
      logger.warn(`[wms] HTTP ${res.status} fra ${service}: ${url}`);
      return new Response(null, { status: res.status });
    }

    const data = await res.arrayBuffer();
    const contentType = res.headers.get('Content-Type') ?? 'image/png';

    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=3600',
        'Access-Control-Allow-Origin': process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk',
      },
    });
  } catch (err) {
    logger.error('[wms] proxy-fejl:', err instanceof Error ? err.message : err);
    return new Response(null, { status: 502 });
  }
}
