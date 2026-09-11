/**
 * measure — shared geodesic measurement helpers for the Opmåling feature.
 *
 * Single source of truth for distance/area math so the interactive map tool
 * (BIZZ-2285) and the AI chat tools (BIZZ-2286/2287) compute identically.
 * All functions are pure and side-effect free.
 *
 * Coordinate convention: [longitude, latitude] (GeoJSON / Mapbox order), in
 * decimal degrees (WGS84). Calculations are geodesic (great-circle / spherical)
 * via @turf — fugleflugt, not road distance.
 *
 * @module app/lib/geo/measure
 */

import distance from '@turf/distance';
import area from '@turf/area';
import { polygon } from '@turf/helpers';

/** A [longitude, latitude] coordinate pair in decimal degrees (WGS84). */
export type LngLat = [number, number];

/**
 * Total geodesic length of a polyline in metres.
 *
 * Sums the great-circle distance between each consecutive coordinate pair.
 * Returns 0 for fewer than two points.
 *
 * @param coords - Ordered [lng, lat] vertices of the line
 * @returns Total length in metres
 */
export function lineDistanceMeters(coords: LngLat[]): number {
  if (!Array.isArray(coords) || coords.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    // @turf/distance returns kilometres by default; convert to metres.
    total += distance(coords[i - 1], coords[i], { units: 'kilometers' }) * 1000;
  }
  return total;
}

/**
 * Geodesic area of a closed polygon ring in square metres.
 *
 * The ring is auto-closed if the first and last vertices differ. Returns 0 for
 * fewer than three distinct vertices.
 *
 * @param ring - [lng, lat] vertices of the polygon's outer ring
 * @returns Area in square metres
 */
export function polygonAreaM2(ring: LngLat[]): number {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  const closed: LngLat[] = [...ring];
  const first = closed[0];
  const last = closed[closed.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    closed.push([first[0], first[1]]);
  }
  return area(polygon([closed]));
}

/**
 * Formats a distance in metres for Danish display: whole metres below 1 km,
 * otherwise kilometres with two decimals.
 *
 * @param m - Distance in metres
 * @returns e.g. "742 m" or "1,57 km"
 */
export function formatDistance(m: number): string {
  if (!Number.isFinite(m) || m < 0) return '0 m';
  if (m < 1000) return `${Math.round(m)} m`;
  const km = m / 1000;
  return `${km.toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} km`;
}

/**
 * Formats an area in square metres for Danish display: whole m² below 1 ha
 * (10 000 m²), otherwise hectares with two decimals.
 *
 * @param m2 - Area in square metres
 * @returns e.g. "8.450 m²" or "3,21 ha"
 */
export function formatArea(m2: number): string {
  if (!Number.isFinite(m2) || m2 < 0) return '0 m²';
  if (m2 < 10000) return `${Math.round(m2).toLocaleString('da-DK')} m²`;
  const ha = m2 / 10000;
  return `${ha.toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ha`;
}
