/**
 * DaekningsMap — Mapbox polygon map for coverage analysis.
 *
 * BIZZ-1995: Shows matrikel polygons colored red/yellow/green based on coverage.
 * Loaded via next/dynamic with ssr:false.
 *
 * @param results - Array of matrikel results with status + geometry
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';

/** Map style options — matches PropertyMap pattern */
type MapStyle = 'dark' | 'satellite';
const STYLES: Record<MapStyle, string> = {
  dark: 'mapbox://styles/mapbox/dark-v11',
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
};

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
  status: 'red' | 'yellow' | 'green' | 'grey';
}

interface Props {
  results: MatrikelWithStatus[];
}

const STATUS_COLORS: Record<string, string> = {
  grey: '#64748b',
  red: '#ef4444',
  yellow: '#f59e0b',
  green: '#10b981',
};

const STATUS_FILL_OPACITY: Record<string, number> = {
  grey: 0.2,
  red: 0.5,
  yellow: 0.45,
  green: 0.4,
};

const STATUS_LINE_WIDTH: Record<string, number> = {
  grey: 1,
  red: 2.5,
  yellow: 2,
  green: 2,
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
  const [mapStyle, setMapStyle] = useState<MapStyle>('dark');

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
      style: STYLES[mapStyle],
      center: [firstWithCoords.koordinat.lng, firstWithCoords.koordinat.lat],
      zoom: 15,
    });
    mapRef.current = map;

    // Navigation controls — matches PropertyMap pattern (bottom-right)
    map.addControl(new mapboxgl.NavigationControl({ showCompass: true }), 'bottom-right');
    map.addControl(new mapboxgl.FullscreenControl(), 'bottom-right');

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
            lineWidth: STATUS_LINE_WIDTH[r.status],
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

      // Render in z-order: red (bottom) → yellow → green (top)
      // This ensures small green polygons aren't hidden under large red ones
      const layerOrder: Array<'grey' | 'red' | 'yellow' | 'green'> = [
        'grey',
        'red',
        'yellow',
        'green',
      ];
      for (const status of layerOrder) {
        map.addLayer({
          id: `matrikler-fill-${status}`,
          type: 'fill',
          source: 'matrikler',
          filter: ['==', ['get', 'status'], status],
          paint: {
            'fill-color': ['get', 'color'],
            'fill-opacity': ['get', 'fillOpacity'],
          },
        });
        map.addLayer({
          id: `matrikler-outline-${status}`,
          type: 'line',
          source: 'matrikler',
          filter: ['==', ['get', 'status'], status],
          paint: {
            'line-color': ['get', 'color'],
            'line-width': ['get', 'lineWidth'],
            'line-opacity': 0.9,
          },
        });
      }

      // Click popup — listen on all fill layers
      const fillLayers = [
        'matrikler-fill-grey',
        'matrikler-fill-red',
        'matrikler-fill-yellow',
        'matrikler-fill-green',
      ];
      const handleClick = (
        e: mapboxgl.MapMouseEvent & { features?: mapboxgl.GeoJSONFeature[] }
      ) => {
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
      };
      for (const layer of fillLayers) {
        map.on('click', layer, handleClick);
      }

      // Cursor pointer on hover
      for (const layer of fillLayers) {
        map.on('mouseenter', layer, () => {
          map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', layer, () => {
          map.getCanvas().style.cursor = '';
        });
      }

      // Matrikelskel — add thin white boundary lines for ALL matrikler in the GeoJSON
      // (our colored fill already shows the shapes, this adds a crisp white outline)
      map.addLayer({
        id: 'matrikler-boundary',
        type: 'line',
        source: 'matrikler',
        paint: {
          'line-color': '#ffffff',
          'line-width': 0.5,
          'line-opacity': 0.4,
        },
        minzoom: 15,
      });

      // Matrikel labels — show matrikelnr at center of each polygon
      map.addLayer({
        id: 'matrikler-labels',
        type: 'symbol',
        source: 'matrikler',
        minzoom: 16,
        layout: {
          'text-field': ['get', 'matrikelnr'],
          'text-size': 10,
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#000000',
          'text-halo-width': 1,
        },
      });

      // Husnumre — Mapbox streets-v8 vector source
      if (!map.getSource('streets-v8-housenum')) {
        map.addSource('streets-v8-housenum', {
          type: 'vector',
          url: 'mapbox://mapbox.mapbox-streets-v8',
        });
      }
      map.addLayer({
        id: 'housenum-overlay',
        type: 'symbol',
        source: 'streets-v8-housenum',
        'source-layer': 'housenum_label',
        minzoom: 16,
        layout: {
          'text-field': ['get', 'house_num'],
          'text-size': 12,
          'text-allow-overlap': false,
          'text-ignore-placement': false,
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#000000',
          'text-halo-width': 1.5,
        },
      });

      // Fit bounds to all polygon geometries (not point coordinates)
      if (features.length > 0) {
        const bounds = new mapboxgl.LngLatBounds();
        for (const feat of features) {
          const geo = feat.geometry;
          // Extract all coordinates from Polygon or MultiPolygon
          const rings =
            geo.type === 'MultiPolygon'
              ? (geo.coordinates as number[][][][]).flat()
              : (geo.coordinates as number[][][]);
          for (const ring of rings) {
            for (const coord of ring) {
              bounds.extend(coord as [number, number]);
            }
          }
        }
        map.fitBounds(bounds, { padding: 40, maxZoom: 17 });
      }
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [results, mapStyle]);

  return (
    <div className="relative w-full h-full">
      <div ref={mapContainer} className="w-full h-full" />
      {/* Style toggle — top-right, matches PropertyMap pattern */}
      <div className="absolute top-3 right-3 z-10 flex bg-[#1e293b]/90 border border-white/10 rounded-lg overflow-hidden backdrop-blur-sm">
        {(['dark', 'satellite'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setMapStyle(s)}
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${
              mapStyle === s ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            {s === 'dark' ? 'Kort' : 'Satellit'}
          </button>
        ))}
      </div>
    </div>
  );
}
