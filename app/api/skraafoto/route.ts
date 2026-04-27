/**
 * GET /api/skraafoto — skråfotos fra Dataforsyningen.
 *
 * BIZZ-964: Henter skråfotos (oblique aerial photos) for en given koordinat.
 * Returnerer thumbnail- og fuldstørrelseslinks i 4 retninger (nord/syd/øst/vest).
 *
 * @param lat - Breddegrad (WGS84)
 * @param lng - Længdegrad (WGS84)
 * @returns { fotos: SkraafotoRetning[] }
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { logger } from '@/app/lib/logger';

/** Én retnings skråfoto med thumbnail og fuldstørrelsesbillede */
export interface SkraafotoRetning {
  /** Retning: north | south | east | west */
  direction: string;
  /** Thumbnail URL (ca. 256px) */
  thumbnail: string;
  /** Fuld opløsning URL (COG) */
  fullsize: string;
  /** Fotoårstal (f.eks. 2023) */
  year: number | null;
}

/** API response */
export interface SkraafotoResponse {
  fotos: SkraafotoRetning[];
  fejl: string | null;
}

/** Tilladte retninger (ekskluderer nadir = lodret) */
const WANTED_DIRECTIONS = new Set(['north', 'south', 'east', 'west']);

/** Dataforsyningen skråfoto API v1.0 */
const SKRAAFOTO_BASE = 'https://api.dataforsyningen.dk/skraafoto_api/v1.0';

export async function GET(request: NextRequest): Promise<NextResponse<SkraafotoResponse>> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' } as unknown as SkraafotoResponse, {
      status: 401,
    });
  }

  const token = process.env.DATAFORSYNINGEN_TOKEN;
  if (!token) {
    return NextResponse.json({ fotos: [], fejl: 'Manglende API-nøgle' });
  }

  const { searchParams } = request.nextUrl;
  const lat = parseFloat(searchParams.get('lat') ?? '');
  const lng = parseFloat(searchParams.get('lng') ?? '');

  if (isNaN(lat) || isNaN(lng)) {
    return NextResponse.json(
      { fotos: [], fejl: 'lat og lng parametre er påkrævet' },
      { status: 400 }
    );
  }

  // Bbox: lille bounding box rundt om koordinaten (~100m)
  const delta = 0.001;
  const bbox = `${lng - delta},${lat - delta},${lng + delta},${lat + delta}`;

  try {
    // Hent fra nyeste samling (skraafotos2023, fallback til 2021)
    const collections = ['skraafotos2023', 'skraafotos2021'];
    let fotos: SkraafotoRetning[] = [];

    for (const collection of collections) {
      const url = `${SKRAAFOTO_BASE}/search?token=${encodeURIComponent(token)}&crs=http://www.opengis.net/def/crs/OGC/1.3/CRS84&limit=20&collections=${collection}&bbox=${bbox}`;

      const res = await fetch(url, {
        signal: AbortSignal.timeout(10000),
        next: { revalidate: 86400 },
      });

      if (!res.ok) {
        logger.warn(`[skraafoto] ${collection}: HTTP ${res.status}`);
        continue;
      }

      const data = (await res.json()) as {
        features?: Array<{
          properties?: { direction?: string; datetime?: string };
          assets?: {
            thumbnail?: { href?: string };
            data?: { href?: string };
          };
        }>;
      };

      const features = data.features ?? [];

      // Vælg det nærmeste foto per retning (første hit per direction)
      const seen = new Set<string>();
      for (const feat of features) {
        const dir = feat.properties?.direction;
        if (!dir || !WANTED_DIRECTIONS.has(dir) || seen.has(dir)) continue;
        seen.add(dir);

        const thumb = feat.assets?.thumbnail?.href;
        const full = feat.assets?.data?.href;
        if (!thumb || !full) continue;

        // Udtræk årstal fra datetime (f.eks. "2023-04-15T10:30:00Z")
        const yearMatch = feat.properties?.datetime?.match(/^(\d{4})/);
        const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

        fotos.push({ direction: dir, thumbnail: thumb, fullsize: full, year });
      }

      // Hvis vi fandt mindst 2 retninger, brug denne samling
      if (fotos.length >= 2) break;
      fotos = []; // prøv næste samling
    }

    // Sortér: north → east → south → west
    const dirOrder: Record<string, number> = { north: 0, east: 1, south: 2, west: 3 };
    fotos.sort((a, b) => (dirOrder[a.direction] ?? 9) - (dirOrder[b.direction] ?? 9));

    return NextResponse.json(
      { fotos, fejl: null },
      {
        headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' },
      }
    );
  } catch (err) {
    logger.error('[skraafoto] Fejl:', err instanceof Error ? err.message : err);
    return NextResponse.json({ fotos: [], fejl: 'Ekstern API fejl' });
  }
}
