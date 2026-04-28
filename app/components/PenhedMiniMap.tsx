/**
 * PenhedMiniMap — Letvægtskort der viser P-enhed lokationer.
 *
 * BIZZ-1029: Bruges på virksomhedsdetaljesiden til at vise alle fysiske
 * lokationer (produktionsenheder) for en virksomhed.
 *
 * Loaded via next/dynamic med ssr: false (Mapbox kræver browser).
 *
 * @param markers - Array af P-enhed lokationer med pno, lat, lng, navn og isMain flag
 */

'use client';

import React, { useMemo, useRef } from 'react';
import Map, { Marker, NavigationControl, type MapRef } from 'react-map-gl/mapbox';
import { Factory } from 'lucide-react';

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';

export interface PenhedMarker {
  pno: number;
  lat: number;
  lng: number;
  name: string;
  isMain: boolean;
}

interface Props {
  markers: PenhedMarker[];
}

/**
 * Beregner bounding box for et sæt koordinater.
 *
 * @param coords - Array af [lng, lat] par
 * @returns Bounds som [[minLng, minLat], [maxLng, maxLat]]
 */
function computeBounds(coords: [number, number][]): [[number, number], [number, number]] {
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of coords) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

export default function PenhedMiniMap({ markers }: Props) {
  const mapRef = useRef<MapRef>(null);

  /** Center + zoom baseret på markers */
  const initialViewState = useMemo(() => {
    if (markers.length === 0) return { longitude: 12.0, latitude: 55.7, zoom: 6 };
    if (markers.length === 1) {
      return { longitude: markers[0].lng, latitude: markers[0].lat, zoom: 14 };
    }
    const coords = markers.map((m) => [m.lng, m.lat] as [number, number]);
    const [[minLng, minLat], [maxLng, maxLat]] = computeBounds(coords);
    return {
      longitude: (minLng + maxLng) / 2,
      latitude: (minLat + maxLat) / 2,
      zoom: 10,
      bounds: [
        [minLng - 0.01, minLat - 0.01],
        [maxLng + 0.01, maxLat + 0.01],
      ] as [[number, number], [number, number]],
    };
  }, [markers]);

  if (!MAPBOX_TOKEN || markers.length === 0) return null;

  return (
    <div className="w-full h-[280px] rounded-lg overflow-hidden border border-slate-700/40">
      <Map
        ref={mapRef}
        mapboxAccessToken={MAPBOX_TOKEN}
        initialViewState={initialViewState}
        mapStyle="mapbox://styles/mapbox/navigation-night-v1"
        style={{ width: '100%', height: '100%' }}
        cooperativeGestures
        attributionControl={false}
      >
        <NavigationControl position="top-right" showCompass={false} />
        {markers.map((m) => (
          <Marker key={m.pno} longitude={m.lng} latitude={m.lat} anchor="center">
            <button
              className={`flex items-center justify-center w-7 h-7 rounded-full border-2 shadow-lg transition-transform hover:scale-110 ${
                m.isMain
                  ? 'bg-cyan-500 border-cyan-300 text-white'
                  : 'bg-slate-600 border-slate-400 text-slate-200'
              }`}
              title={`${m.name} (P-nr: ${m.pno})`}
              aria-label={`${m.name} (P-nr: ${m.pno})`}
            >
              <Factory size={14} />
            </button>
          </Marker>
        ))}
      </Map>
    </div>
  );
}
