/**
 * GET /api/bbr/bbox?w=...&s=...&e=...&n=...
 *
 * Henter BBR bygningspunkter med ejerforholdskode for en bounding box.
 * Bruges af /dashboard/kort til at vise ejendomstype-badges (EL/AB) på kortet.
 *
 * Kræver DATAFORDELER_API_KEY i .env.local.
 * Returnerer tomt array hvis nøgle mangler eller ingen bygninger i bbox.
 *
 * @param w - Vest-koordinat (lng, WGS84)
 * @param s - Syd-koordinat (lat, WGS84)
 * @param e - Øst-koordinat (lng, WGS84)
 * @param n - Nord-koordinat (lat, WGS84)
 * @returns JSON array af { id, lng, lat, ejerforholdskode }
 */

import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';

const WFS_BASE = 'https://wfs.datafordeler.dk/BBR/BBR_WFS/1.0.0/WFS';
const DF_API_KEY = process.env.DATAFORDELER_API_KEY ?? '';

/** Et BBR-bygningspunkt med ejendomstype til kortvisning */
export interface BBRTypePunkt {
  id: string;
  lng: number;
  lat: number;
  /** Ejerforholdskode — "50"=andelsboligforening, "60"=almen bolig */
  ejerforholdskode: string | null;
  /** Bygningens anvendelse (byg021), f.eks. "Etageboligbebyggelse" */
  anvendelse: string | null;
}

/**
 * GET handler — henter BBR bygningspunkter i en bounding box fra Datafordeler WFS.
 * Returnerer kun bygninger med interessant ejerforholdskode (50 eller 60).
 *
 * @param request - NextRequest med w, s, e, n query params
 * @returns JSON array af BBRTypePunkt
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl;
  const w = parseFloat(searchParams.get('w') ?? '');
  const s = parseFloat(searchParams.get('s') ?? '');
  const e = parseFloat(searchParams.get('e') ?? '');
  const n = parseFloat(searchParams.get('n') ?? '');

  if ([w, s, e, n].some(isNaN)) {
    return NextResponse.json([], { status: 400 });
  }

  if (!DF_API_KEY) {
    return NextResponse.json([], {
      headers: { 'Cache-Control': 'public, s-maxage=60' },
    });
  }

  // Begræns bbox-størrelse for at undgå for mange bygninger
  const maxDelta = 0.05; // ~5 km — svarer til zoom 13-14
  if (Math.abs(e - w) > maxDelta * 4 || Math.abs(n - s) > maxDelta * 4) {
    return NextResponse.json([], {
      headers: { 'Cache-Control': 'public, s-maxage=60' },
    });
  }

  const cqlFilter = encodeURIComponent(
    `byg066Ejerforhold IN ('50','60') AND BBOX(geometri,${s},${w},${n},${e},'EPSG:4326')`
  );

  const url =
    `${WFS_BASE}?service=WFS&version=2.0.0&request=GetFeature` +
    `&typeName=bbr_v001:bygning_current` +
    `&outputFormat=application%2Fjson` +
    `&srsName=EPSG:4326` +
    `&count=200` +
    `&CQL_FILTER=${cqlFilter}` +
    `&apikey=${DF_API_KEY}`;

  try {
    const res = await fetch(proxyUrl(url), {
      headers: { ...proxyHeaders() },
      signal: AbortSignal.timeout(proxyTimeout()),
      next: { revalidate: 3600 },
    });

    if (!res.ok) {
      console.error(`[BBR bbox] HTTP ${res.status}`);
      return NextResponse.json([], {
        headers: { 'Cache-Control': 'public, s-maxage=60' },
      });
    }

    const json = (await res.json()) as {
      features?: Array<{
        geometry?: { coordinates?: [number, number] };
        properties?: Record<string, unknown>;
      }>;
    };

    if (!json.features) {
      return NextResponse.json([], {
        headers: { 'Cache-Control': 'public, s-maxage=3600' },
      });
    }

    const punkter: BBRTypePunkt[] = json.features
      .filter((f) => f.geometry?.coordinates)
      .map((f) => {
        const p = f.properties ?? {};
        const coords = f.geometry!.coordinates!;
        return {
          id: String(p.id_lokalId ?? ''),
          lng: coords[0],
          lat: coords[1],
          ejerforholdskode: p.byg066Ejerforhold != null ? String(p.byg066Ejerforhold) : null,
          anvendelse:
            p.byg021BygningensAnvendelse != null ? String(p.byg021BygningensAnvendelse) : null,
        };
      });

    return NextResponse.json(punkter, {
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
    });
  } catch (err) {
    Sentry.captureException(err);
    console.error('[BBR bbox] Fejl:', err instanceof Error ? err.message : String(err));
    return NextResponse.json([], {
      headers: { 'Cache-Control': 'public, s-maxage=60' },
    });
  }
}
