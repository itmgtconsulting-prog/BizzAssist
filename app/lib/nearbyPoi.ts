/**
 * Nearby POI lookup via OpenStreetMap Overpass API.
 *
 * BIZZ-1181: Henter nærområde-data (skoler, transport, indkøb, grønne
 * områder) for en given koordinat. Bruges af boligannonce-generator til
 * at berige beliggenhedsbeskrivelsen.
 *
 * Rate-limit: Overpass API er gratis men har rate-limits (~1 req/s).
 * Bruger AbortSignal.timeout for at undgå at blokere annonce-generering.
 *
 * @module app/lib/nearbyPoi
 */

import { logger } from '@/app/lib/logger';

const OVERPASS_API = 'https://overpass-api.de/api/interpreter';

/** POI-kategori */
export type PoiCategory = 'school' | 'transport' | 'shopping' | 'park';

/** Et nærliggende POI */
export interface NearbyPoi {
  /** POI-navn */
  name: string;
  /** Kategori */
  category: PoiCategory;
  /** Afstand i meter (beregnet fra center-punkt) */
  distanceMeters: number;
}

/** Resultat af nærområde-lookup */
export interface NearbyPoiResult {
  schools: NearbyPoi[];
  transport: NearbyPoi[];
  shopping: NearbyPoi[];
  parks: NearbyPoi[];
}

/** Overpass element shape */
interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/**
 * Beregn afstand mellem to koordinater (Haversine).
 *
 * @param lat1 - Latitude 1
 * @param lon1 - Longitude 1
 * @param lat2 - Latitude 2
 * @param lon2 - Longitude 2
 * @returns Afstand i meter
 */
function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Hent nærliggende POI'er via Overpass API.
 *
 * @param lat - Latitude for center-punkt
 * @param lon - Longitude for center-punkt
 * @param radiusMeters - Søgeradius i meter (default 1500)
 * @returns Kategoriserede POI'er sorteret efter afstand
 */
export async function fetchNearbyPois(
  lat: number,
  lon: number,
  radiusMeters = 1500
): Promise<NearbyPoiResult> {
  const result: NearbyPoiResult = { schools: [], transport: [], shopping: [], parks: [] };

  // Overpass QL query — henter skoler, stationer, butikker og parker i radius
  const query = `
    [out:json][timeout:10];
    (
      node["amenity"="school"](around:${radiusMeters},${lat},${lon});
      way["amenity"="school"](around:${radiusMeters},${lat},${lon});
      node["public_transport"="station"](around:${radiusMeters},${lat},${lon});
      node["railway"="station"](around:${radiusMeters},${lat},${lon});
      node["highway"="bus_stop"](around:${radiusMeters},${lat},${lon});
      node["shop"="supermarket"](around:${radiusMeters},${lat},${lon});
      node["shop"="convenience"](around:${radiusMeters},${lat},${lon});
      way["leisure"="park"](around:${radiusMeters},${lat},${lon});
      relation["leisure"="park"](around:${radiusMeters},${lat},${lon});
    );
    out center tags;
  `;

  try {
    const res = await fetch(OVERPASS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(12000),
    });

    if (!res.ok) {
      logger.warn(`[nearbyPoi] Overpass API error: HTTP ${res.status}`);
      return result;
    }

    const data = (await res.json()) as { elements?: OverpassElement[] };
    const elements = data.elements ?? [];

    for (const el of elements) {
      const elLat = el.lat ?? el.center?.lat;
      const elLon = el.lon ?? el.center?.lon;
      if (!elLat || !elLon) continue;

      const name = el.tags?.name;
      if (!name) continue;

      const dist = Math.round(haversineDistance(lat, lon, elLat, elLon));

      const tags = el.tags ?? {};
      if (tags.amenity === 'school') {
        result.schools.push({ name, category: 'school', distanceMeters: dist });
      } else if (tags.public_transport === 'station' || tags.railway === 'station') {
        result.transport.push({ name, category: 'transport', distanceMeters: dist });
      } else if (tags.highway === 'bus_stop') {
        result.transport.push({ name, category: 'transport', distanceMeters: dist });
      } else if (tags.shop) {
        result.shopping.push({ name, category: 'shopping', distanceMeters: dist });
      } else if (tags.leisure === 'park') {
        result.parks.push({ name, category: 'park', distanceMeters: dist });
      }
    }

    // Sort by distance and limit
    result.schools.sort((a, b) => a.distanceMeters - b.distanceMeters).splice(3);
    result.transport.sort((a, b) => a.distanceMeters - b.distanceMeters).splice(5);
    result.shopping.sort((a, b) => a.distanceMeters - b.distanceMeters).splice(3);
    result.parks.sort((a, b) => a.distanceMeters - b.distanceMeters).splice(3);

    return result;
  } catch (err) {
    logger.warn('[nearbyPoi] Fetch failed:', err instanceof Error ? err.message : String(err));
    return result;
  }
}

/**
 * Formatér POI-data til prompt-kontekst tekst.
 *
 * @param pois - Kategoriserede POI'er
 * @returns Formateret tekst til Claude prompt
 */
export function formatPoisForPrompt(pois: NearbyPoiResult): string {
  const sections: string[] = [];

  if (pois.schools.length > 0) {
    sections.push(
      'Skoler: ' + pois.schools.map((s) => `${s.name} (${s.distanceMeters}m)`).join(', ')
    );
  }
  if (pois.transport.length > 0) {
    sections.push(
      'Transport: ' + pois.transport.map((t) => `${t.name} (${t.distanceMeters}m)`).join(', ')
    );
  }
  if (pois.shopping.length > 0) {
    sections.push(
      'Indkøb: ' + pois.shopping.map((s) => `${s.name} (${s.distanceMeters}m)`).join(', ')
    );
  }
  if (pois.parks.length > 0) {
    sections.push(
      'Grønne områder: ' + pois.parks.map((p) => `${p.name} (${p.distanceMeters}m)`).join(', ')
    );
  }

  if (sections.length === 0) return '';
  return `NÆROMRÅDE (inden for 1,5 km):\n${sections.join('\n')}`;
}
