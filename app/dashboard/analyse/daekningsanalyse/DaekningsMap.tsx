/**
 * DaekningsMap — Mapbox heatmap for coverage analysis.
 *
 * BIZZ-1995: Shows matrikel markers colored red/yellow/green based on coverage.
 * Loaded via next/dynamic with ssr:false.
 *
 * @param results - Array of matrikel results with status classification
 */

'use client';

import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

interface MatrikelWithStatus {
  matrikelnr: string;
  ejerlavskode: number;
  ejerlav: string;
  totalEnheder: number;
  kundeAntal: number;
  daekningPct: number;
  koordinat: { lat: number; lng: number } | null;
  adresserLabel: string;
  ejerforening?: string | null;
  status: 'red' | 'yellow' | 'green';
}

interface Props {
  results: MatrikelWithStatus[];
}

const STATUS_COLORS = {
  red: '#ef4444',
  yellow: '#f59e0b',
  green: '#10b981',
} as const;

/**
 * DaekningsMap — renders Mapbox with colored markers per matrikel.
 *
 * @param props.results - Classified matrikel results
 * @returns Mapbox map container
 */
export default function DaekningsMap({ results }: Props) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);

  useEffect(() => {
    if (!mapContainer.current) return;
    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    if (!token) return;

    mapboxgl.accessToken = token;

    const markersWithCoords = results.filter((r) => r.koordinat);
    if (markersWithCoords.length === 0) return;

    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: [markersWithCoords[0].koordinat!.lng, markersWithCoords[0].koordinat!.lat],
      zoom: 15,
    });
    mapRef.current = map;

    map.on('load', () => {
      // Fit bounds to all markers
      if (markersWithCoords.length > 1) {
        const bounds = new mapboxgl.LngLatBounds();
        markersWithCoords.forEach((r) => {
          bounds.extend([r.koordinat!.lng, r.koordinat!.lat]);
        });
        map.fitBounds(bounds, { padding: 60, maxZoom: 16 });
      }

      // Add markers
      markersWithCoords.forEach((r) => {
        const color = STATUS_COLORS[r.status];

        const popup = new mapboxgl.Popup({ offset: 25 }).setHTML(`
          <div style="font-family: system-ui; font-size: 12px; max-width: 220px;">
            <strong style="font-size: 13px;">Matrikel ${r.matrikelnr}</strong><br/>
            <span style="color: #666;">${r.adresserLabel}</span><br/>
            ${r.ejerforening ? `<span style="color: #999; font-size: 11px;">${r.ejerforening}</span><br/>` : ''}
            <div style="margin-top: 6px; padding-top: 6px; border-top: 1px solid #eee;">
              <strong style="color: ${color};">${Math.round(r.daekningPct)}% dækning</strong>
              <span style="color: #666;"> (${r.kundeAntal}/${r.totalEnheder})</span>
            </div>
          </div>
        `);

        new mapboxgl.Marker({ color })
          .setLngLat([r.koordinat!.lng, r.koordinat!.lat])
          .setPopup(popup)
          .addTo(map);
      });
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [results]);

  return <div ref={mapContainer} className="w-full h-full" />;
}
