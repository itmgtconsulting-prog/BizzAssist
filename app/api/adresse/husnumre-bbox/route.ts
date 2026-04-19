/**
 * Husnumre i bounding box — server-side proxy for kort-lag.
 *
 * Flow (BIZZ-504):
 *   1. Datafordeler DAR WFS med bbox-filter (primær)
 *   2. DAWA /adgangsadresser?polygon=… (fallback indtil DAWA lukker 2026-07-01)
 *
 * Bruges af KortPageClient.tsx til at vise adresseprikker på kortet.
 *
 * GET /api/adresse/husnumre-bbox?w=12.5&s=55.6&e=12.6&n=55.7
 * @returns GeoJSON FeatureCollection med adressepunkter (Point geometry)
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveTenantId } from '@/lib/api/auth';
import { parseQuery } from '@/app/lib/validate';
import { DAWA_BASE_URL } from '@/app/lib/serviceEndpoints';
import { fetchDawa } from '@/app/lib/dawa';
import { darHusnumreBbox } from '@/app/lib/dar';
import { logger } from '@/app/lib/logger';

const emptyFc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** Zod schema for husnumre-bbox query params */
const bboxSchema = z.object({
  w: z.coerce.number(),
  s: z.coerce.number(),
  e: z.coerce.number(),
  n: z.coerce.number(),
});

/**
 * Henter husnumre i en bounding box som GeoJSON Point-features.
 *
 * BIZZ-504: Forsøger Datafordeler DAR WFS først; falder tilbage til DAWA
 * (som lukker 1. juli 2026). Fallbacken bevares som safety net indtil
 * DAR-pathen er verificeret i produktion.
 *
 * @param request - NextRequest med w, s, e, n query params (WGS84 bbox)
 * @returns GeoJSON FeatureCollection med Point features
 */
export async function GET(request: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = parseQuery(request, bboxSchema);
  if (!parsed.success) return NextResponse.json(emptyFc, { status: 400 });
  const { w, s, e, n } = parsed.data;

  // Guard: reject oversized bounding boxes — husnumre are dense and large areas
  // cause very slow responses or result sets that exceed the count cap.
  // Applies to both DAR WFS and DAWA (per_side cap).
  const lngSpan = Math.abs(e - w);
  const latSpan = Math.abs(n - s);
  if (lngSpan > 0.3 || latSpan > 0.3) {
    return NextResponse.json(
      {
        ...emptyFc,
        error: 'Bbox for stor — zoom ind for at se husnumre',
      } as unknown as GeoJSON.FeatureCollection,
      { status: 400 }
    );
  }

  // ── Primær: Datafordeler DAR WFS ────────────────────────────────────────
  const darResult = await darHusnumreBbox(w, s, e, n);
  if (darResult) {
    return NextResponse.json(darResult);
  }

  // ── Fallback: DAWA (logget som deprecated via fetchDawa) ────────────────
  logger.warn('[husnumre-bbox] DAR WFS returned null, falling back to DAWA (deadline 2026-07-01)');
  try {
    const poly = encodeURIComponent(
      JSON.stringify([
        [
          [w, s],
          [e, s],
          [e, n],
          [w, n],
          [w, s],
        ],
      ])
    );
    const res = await fetchDawa(
      `${DAWA_BASE_URL}/adgangsadresser?polygon=${poly}&srid=4326&struktur=mini&per_side=1000`,
      { signal: AbortSignal.timeout(8000) },
      { caller: 'adresse.husnumre-bbox.fallback' }
    );
    if (!res.ok) return NextResponse.json(emptyFc);
    const items = (await res.json()) as Record<string, unknown>[];
    if (!Array.isArray(items)) return NextResponse.json(emptyFc);

    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: items
        .filter((item) => typeof item.x === 'number' && typeof item.y === 'number')
        .map((item) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [item.x as number, item.y as number] },
          properties: { husnr: (item.husnr as string) ?? '' },
        })),
    };
    return NextResponse.json(fc);
  } catch {
    return NextResponse.json(emptyFc, { status: 502 });
  }
}
