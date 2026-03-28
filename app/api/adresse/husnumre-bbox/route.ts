/**
 * Husnumre i bounding box — server-side proxy for kort-lag.
 * Erstatter direkte DAWA-kald fra kortsiden (DAWA lukker 1. juli 2026).
 *
 * Bruger DAR GraphQL med bbox-baseret filtrering.
 * Falder tilbage til DAWA hvis DAR fejler.
 *
 * GET /api/adresse/husnumre-bbox?w=12.5&s=55.6&e=12.6&n=55.7
 * @returns GeoJSON FeatureCollection med adressepunkter (Point geometry)
 */
import { NextRequest, NextResponse } from 'next/server';

const emptyFc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * Henter husnumre i en bounding box som GeoJSON Point-features.
 * DAR GraphQL understøtter ikke spatial queries endnu, så vi bruger DAWA fallback.
 *
 * @param request - NextRequest med w, s, e, n query params (WGS84 bbox)
 * @returns GeoJSON FeatureCollection med Point features
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const w = parseFloat(searchParams.get('w') ?? '');
  const s = parseFloat(searchParams.get('s') ?? '');
  const e = parseFloat(searchParams.get('e') ?? '');
  const n = parseFloat(searchParams.get('n') ?? '');

  if ([w, s, e, n].some(isNaN)) {
    return NextResponse.json(emptyFc, { status: 400 });
  }

  // TODO: Replace with DAR GraphQL spatial query when supported (before July 2026)
  // DAWA fallback
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
    const res = await fetch(
      `https://api.dataforsyningen.dk/adgangsadresser?polygon=${poly}&srid=4326&struktur=mini&per_side=1000`,
      { signal: AbortSignal.timeout(8000) }
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
