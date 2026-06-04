/**
 * DaekningsMap — Mapbox polygon map for coverage analysis.
 *
 * BIZZ-1995: Shows matrikel polygons colored red/yellow/green based on coverage.
 * Loaded via next/dynamic with ssr:false.
 *
 * @param results - Array of matrikel results with status + geometry
 */

'use client';

import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

/** GeoJSON geometry (Polygon or MultiPolygon from DAWA) */
type GeoJsonGeometry = GeoJSON.Polygon | GeoJSON.MultiPolygon;

interface MatrikelWithStatus {
  matrikelnr: string;
  ejerlavskode: number;
  ejerlav: string;
  totalEnheder: number;
  kundeAntal: number;
  daekningPct: number;
  koordinat: { lat: number; lng: number } | null;
  geometry: GeoJsonGeometry | null;
  adresserLabel: string;
  ejerforening?: string | null;
  status: 'red' | 'yellow' | 'green';
}

interface Props {
  results: MatrikelWithStatus[];
}

const STATUS_COLORS: Record<string, string> = {
  red: '#ef4444',
  yellow: '#f59e0b',
  green: '#10b981',
};

const STATUS_FILL_OPACITY: Record<string, number> = {
  red: 0.45,
  yellow: 0.35,
  green: 0.3,
};

/**
 * DaekningsMap — renders Mapbox with colored matrikel polygons.
 *
 * @param props.results - Classified matrikel results with geometry
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

    // Find center from first result with coordinates
    const firstWithCoords = results.find((r) => r.koordinat);
    if (!firstWithCoords?.koordinat) return;

    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: [firstWithCoords.koordinat.lng, firstWithCoords.koordinat.lat],
      zoom: 15,
    });
    mapRef.current = map;

    map.on('load', () => {
      // Build GeoJSON FeatureCollection from results with geometry
      const features = results
        .filter((r) => r.geometry)
        .map((r) => ({
          type: 'Feature' as const,
          properties: {
            matrikelnr: r.matrikelnr,
            status: r.status,
            daekningPct: r.daekningPct,
            kundeAntal: r.kundeAntal,
            totalEnheder: r.totalEnheder,
            adresserLabel: r.adresserLabel,
            ejerforening: r.ejerforening || '',
            color: STATUS_COLORS[r.status],
            fillOpacity: STATUS_FILL_OPACITY[r.status],
          },
          geometry: r.geometry!,
        }));

      const geojson = {
        type: 'FeatureCollection' as const,
        features,
      };

      // Add source
      map.addSource('matrikler', {
        type: 'geojson',
        data: geojson,
      });

      // Fill layer — colored polygons
      map.addLayer({
        id: 'matrikler-fill',
        type: 'fill',
        source: 'matrikler',
        paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': ['get', 'fillOpacity'],
        },
      });

      // Outline layer
      map.addLayer({
        id: 'matrikler-outline',
        type: 'line',
        source: 'matrikler',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 2,
          'line-opacity': 0.8,
        },
      });

      // Click popup
      map.on('click', 'matrikler-fill', (e) => {
        if (!e.features?.length) return;
        const props = e.features[0].properties!;
        const color = props.color as string;

        new mapboxgl.Popup({ offset: 10 })
          .setLngLat(e.lngLat)
          .setHTML(
            `<div style="font-family: system-ui; font-size: 12px; max-width: 220px;">
              <strong style="font-size: 13px;">Matrikel ${props.matrikelnr}</strong><br/>
              <span style="color: #666;">${props.adresserLabel}</span><br/>
              ${props.ejerforening ? `<span style="color: #999; font-size: 11px;">${props.ejerforening}</span><br/>` : ''}
              <div style="margin-top: 6px; padding-top: 6px; border-top: 1px solid #eee;">
                <strong style="color: ${color};">${Math.round(props.daekningPct)}% dækning</strong>
                <span style="color: #666;"> (${props.kundeAntal}/${props.totalEnheder})</span>
              </div>
            </div>`
          )
          .addTo(map);
      });

      // Cursor pointer on hover
      map.on('mouseenter', 'matrikler-fill', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'matrikler-fill', () => {
        map.getCanvas().style.cursor = '';
      });

      // Fit bounds to all polygons
      if (features.length > 0) {
        const bounds = new mapboxgl.LngLatBounds();
        for (const r of results) {
          if (r.koordinat) {
            bounds.extend([r.koordinat.lng, r.koordinat.lat]);
          }
        }
        map.fitBounds(bounds, { padding: 60, maxZoom: 17 });
      }
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [results]);

  return <div ref={mapContainer} className="w-full h-full" />;
}
