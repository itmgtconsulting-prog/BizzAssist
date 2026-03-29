/**
 * Matrikel-polygoner for en bounding box — server-side proxy.
 * Erstatter direkte DAWA-kald fra kortsiden (DAWA lukker 1. juli 2026).
 *
 * Bruger Datafordeler MAT WFS med bbox-filter.
 * Falder tilbage til DAWA hvis MAT WFS fejler.
 *
 * GET /api/matrikel/bbox?w=12.5&s=55.6&e=12.6&n=55.7
 * @returns GeoJSON FeatureCollection med matrikel polygoner
 */
import { NextRequest, NextResponse } from 'next/server';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';

/**
 * Henter matrikelpolygoner for en bounding box via Datafordeler MAT WFS.
 * Falder tilbage til DAWA GeoJSON hvis MAT WFS fejler.
 *
 * @param request - NextRequest med w, s, e, n query params (WGS84 bbox)
 * @returns GeoJSON FeatureCollection
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const w = parseFloat(searchParams.get('w') ?? '');
  const s = parseFloat(searchParams.get('s') ?? '');
  const e = parseFloat(searchParams.get('e') ?? '');
  const n = parseFloat(searchParams.get('n') ?? '');

  if ([w, s, e, n].some(isNaN)) {
    return NextResponse.json({ type: 'FeatureCollection', features: [] }, { status: 400 });
  }

  const apiKey = process.env.DATAFORDELER_API_KEY;
  const emptyFc = { type: 'FeatureCollection', features: [] };

  // Forsøg Datafordeler MAT WFS
  if (apiKey) {
    try {
      const bbox = `${s},${w},${n},${e},urn:ogc:def:crs:EPSG::4326`;
      const url =
        `https://services.datafordeler.dk/Matrikel/MatGaeld662/1/WFS` +
        `?service=WFS&version=2.0.0&request=GetFeature` +
        `&typeName=mat:Jordstykke_Gaeldende` +
        `&srsName=EPSG:4326` +
        `&bbox=${bbox}` +
        `&outputFormat=json` +
        `&count=1000` +
        `&apiKey=${encodeURIComponent(apiKey)}`;

      const res = await fetch(proxyUrl(url), {
        headers: { ...proxyHeaders() },
        signal: AbortSignal.timeout(proxyTimeout()),
      });
      if (res.ok) {
        const json = await res.json();
        if (json?.type === 'FeatureCollection') {
          return NextResponse.json(json);
        }
      }
    } catch {
      // Fall through to DAWA
    }
  }

  // DAWA fallback (virker til 1. juli 2026)
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
    const url = `https://api.dataforsyningen.dk/jordstykker?polygon=${poly}&srid=4326&format=geojson&per_side=1000`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return NextResponse.json(emptyFc);
    const json = await res.json();
    if (Array.isArray(json)) {
      return NextResponse.json({ type: 'FeatureCollection', features: json });
    }
    if (json?.type === 'FeatureCollection') {
      return NextResponse.json(json);
    }
    return NextResponse.json(emptyFc);
  } catch {
    return NextResponse.json(emptyFc, { status: 502 });
  }
}
