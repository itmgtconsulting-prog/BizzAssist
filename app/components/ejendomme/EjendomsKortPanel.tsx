/**
 * EjendomsKortPanel — højre side-panel med Mapbox-kort over en ejendomsliste.
 *
 * BIZZ-2089: Fælles komponent til virksomheds- og personsider, der viser de
 * tilknyttede ejendomme som markers på et kort. Geokodning sker client-side
 * via app/lib/ejendomsKortGeokod (DAWA + /api/bfe-addresses med LRU-cache).
 *
 * UX-mønster: samme overlay-panel som "Medier & links" i
 * VirksomhedDetaljeClient — fixed højre panel på desktop, fuldskærm på mobil.
 *
 * Markers: ≤50 ejendomme → individuelle markers med popup (adresse + link til
 * /dashboard/ejendomme/{dawaId}); >50 → Mapbox GL clustering via GeoJSON
 * Source/Layer (klik på cluster zoomer ind, klik på punkt åbner popup).
 *
 * Skal loades via next/dynamic med ssr: false (Mapbox kræver browser).
 *
 * @param items - Ejendomsliste fra værts-siden (bfe/adresse/dawaId/label)
 * @param lang - UI-sprog ('da' | 'en')
 * @param onClose - Kaldes når brugeren lukker panelet
 */

'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import Map, {
  Marker,
  Popup,
  NavigationControl,
  Source,
  Layer,
  type MapRef,
} from 'react-map-gl/mapbox';
import type { GeoJSONSource, MapMouseEvent } from 'mapbox-gl';
import { MapPin, X, ExternalLink, Loader2 } from 'lucide-react';
import { translations } from '@/app/lib/translations';
import { geokodKortItems, type KortItem, type KortMarker } from '@/app/lib/ejendomsKortGeokod';

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';
/** Over denne grænse skiftes til Mapbox GL clustering (BIZZ-2089 acceptkrav) */
const CLUSTER_THRESHOLD = 50;

interface Props {
  /** Ejendomme der skal vises på kortet */
  items: KortItem[];
  /** UI-sprog */
  lang: 'da' | 'en';
  /** Luk-callback fra værts-siden */
  onClose: () => void;
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

export default function EjendomsKortPanel({ items, lang, onClose }: Props) {
  const t = translations[lang].ejendomsKort;
  const mapRef = useRef<MapRef>(null);
  const [markers, setMarkers] = useState<KortMarker[] | null>(null);
  const [valgt, setValgt] = useState<KortMarker | null>(null);

  // Geokod items når panelet åbnes — geokodKortItems dedup'er og cacher selv
  useEffect(() => {
    let aktiv = true;
    setMarkers(null);
    geokodKortItems(items).then((res) => {
      if (aktiv) setMarkers(res);
    });
    return () => {
      aktiv = false;
    };
  }, [items]);

  // Luk på Escape (panelet er en dialog)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  /** Center/zoom ud fra de geokodede markers */
  const initialViewState = useMemo(() => {
    if (!markers || markers.length === 0) return { longitude: 11.5, latitude: 55.9, zoom: 6 };
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

  // fitBounds når geokodning lander EFTER kortet er mountet (async opslag)
  useEffect(() => {
    if (!markers || markers.length === 0 || !mapRef.current) return;
    const coords = markers.map((m) => [m.lng, m.lat] as [number, number]);
    const [[minLng, minLat], [maxLng, maxLat]] = computeBounds(coords);
    mapRef.current.fitBounds(
      [
        [minLng - 0.01, minLat - 0.01],
        [maxLng + 0.01, maxLat + 0.01],
      ],
      { padding: 48, maxZoom: 15, duration: 600 }
    );
  }, [markers]);

  const brugClustering = (markers?.length ?? 0) > CLUSTER_THRESHOLD;

  /** GeoJSON FeatureCollection til cluster-source (kun >50 markers) */
  const clusterGeojson = useMemo(() => {
    if (!brugClustering || !markers) return null;
    return {
      type: 'FeatureCollection' as const,
      features: markers.map((m, i) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [m.lng, m.lat] },
        properties: { idx: i },
      })),
    };
  }, [brugClustering, markers]);

  /** Klik i cluster-mode: cluster → zoom ind; punkt → åbn popup */
  const onMapClick = useCallback(
    (e: MapMouseEvent) => {
      const map = mapRef.current;
      if (!map || !brugClustering || !markers) return;
      const features = map.queryRenderedFeatures(e.point, {
        layers: ['ejendom-clusters', 'ejendom-points'],
      });
      const feature = features[0];
      if (!feature) return;
      if (feature.properties?.cluster_id !== undefined) {
        const clusterId = feature.properties.cluster_id as number;
        const source = map.getSource('ejendomme') as GeoJSONSource | undefined;
        source?.getClusterExpansionZoom(clusterId, (err, zoom) => {
          if (err || zoom == null) return;
          const [lng, lat] = (feature.geometry as GeoJSON.Point).coordinates;
          map.easeTo({ center: [lng, lat], zoom, duration: 500 });
        });
      } else if (typeof feature.properties?.idx === 'number') {
        setValgt(markers[feature.properties.idx] ?? null);
      }
    },
    [brugClustering, markers]
  );

  /** Indhold til marker-popup: adresse + evt. label + link til ejendomssiden */
  const popupIndhold = (m: KortMarker) => (
    <div className="text-xs text-slate-200 max-w-[220px]">
      {m.label && m.label !== m.adresse && (
        <p className="font-semibold text-white mb-0.5">{m.label}</p>
      )}
      <p className="text-slate-300">{m.adresse}</p>
      {m.dawaId && (
        <Link
          href={`/dashboard/ejendomme/${m.dawaId}`}
          className="inline-flex items-center gap-1 mt-1.5 text-cyan-400 hover:text-cyan-300 font-medium"
        >
          {t.openProperty}
          <ExternalLink size={11} />
        </Link>
      )}
    </div>
  );

  // Portal til document.body: værts-siderne har transformerede/overflow-
  // ancestors der ellers fanger fixed-elementet i en lavere stacking context
  // (global topbar tegnede hen over panel-headeren). Komponenten loades med
  // ssr:false, så document findes altid her.
  return createPortal(
    <>
      {/* Dark theme på Mapbox-popup (default er hvid baggrund) */}
      <style>{`
        .ejendomskort-popup .mapboxgl-popup-content {
          background: #0f172a;
          color: #e2e8f0;
          padding: 10px 14px;
          border-radius: 8px;
          border: 1px solid #334155;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.6);
        }
        .ejendomskort-popup .mapboxgl-popup-tip {
          border-top-color: #0f172a;
          border-bottom-color: #0f172a;
        }
      `}</style>
      {/* Backdrop (kun desktop — mobil-panelet er fuldskærm) */}
      <div
        className="hidden sm:block fixed inset-0 z-40 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ejendomskort-titel"
        className="fixed inset-0 sm:inset-y-0 sm:left-auto sm:right-0 z-50 w-full sm:w-[520px] flex flex-col bg-slate-950 sm:border-l sm:border-slate-700/50 shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-slate-900 border-b border-slate-700/50 shrink-0">
          <div className="flex items-center gap-2">
            <MapPin size={16} className="text-cyan-400" />
            <h2 id="ejendomskort-titel" className="text-sm font-semibold text-white">
              {t.title}
            </h2>
            {markers && markers.length > 0 && (
              <span className="text-xs text-slate-400">
                {markers.length} {t.placed}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label={t.close}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Kort / loading / empty */}
        <div className="flex-1 relative min-h-0">
          {markers === null ? (
            <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-slate-400">
              <Loader2 size={16} className="animate-spin" />
              {t.loading}
            </div>
          ) : markers.length === 0 || !MAPBOX_TOKEN ? (
            <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-slate-400">
              {t.empty}
            </div>
          ) : (
            <Map
              ref={mapRef}
              mapboxAccessToken={MAPBOX_TOKEN}
              initialViewState={initialViewState}
              mapStyle="mapbox://styles/mapbox/navigation-night-v1"
              style={{ width: '100%', height: '100%' }}
              attributionControl={false}
              onClick={onMapClick}
              interactiveLayerIds={
                brugClustering ? ['ejendom-clusters', 'ejendom-points'] : undefined
              }
            >
              <NavigationControl position="top-right" showCompass={false} />

              {brugClustering && clusterGeojson ? (
                <Source
                  id="ejendomme"
                  type="geojson"
                  data={clusterGeojson}
                  cluster
                  clusterMaxZoom={14}
                  clusterRadius={45}
                >
                  <Layer
                    id="ejendom-clusters"
                    type="circle"
                    filter={['has', 'point_count']}
                    paint={{
                      'circle-color': '#0891b2',
                      'circle-stroke-color': '#67e8f9',
                      'circle-stroke-width': 2,
                      'circle-radius': ['step', ['get', 'point_count'], 14, 25, 18, 100, 24],
                    }}
                  />
                  <Layer
                    id="ejendom-cluster-count"
                    type="symbol"
                    filter={['has', 'point_count']}
                    layout={{
                      'text-field': ['get', 'point_count_abbreviated'],
                      'text-size': 12,
                    }}
                    paint={{ 'text-color': '#ffffff' }}
                  />
                  <Layer
                    id="ejendom-points"
                    type="circle"
                    filter={['!', ['has', 'point_count']]}
                    paint={{
                      'circle-color': '#06b6d4',
                      'circle-stroke-color': '#a5f3fc',
                      'circle-stroke-width': 2,
                      'circle-radius': 7,
                    }}
                  />
                </Source>
              ) : (
                markers.map((m) => (
                  <Marker
                    key={`${m.lng},${m.lat},${m.bfe ?? m.dawaId ?? m.adresse}`}
                    longitude={m.lng}
                    latitude={m.lat}
                    anchor="center"
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setValgt(m);
                      }}
                      aria-label={m.label ?? m.adresse}
                      className="flex items-center justify-center w-7 h-7 rounded-full bg-cyan-500 border-2 border-cyan-300 text-white shadow-lg transition-transform hover:scale-110"
                    >
                      <MapPin size={14} />
                    </button>
                  </Marker>
                ))
              )}

              {valgt && (
                <Popup
                  longitude={valgt.lng}
                  latitude={valgt.lat}
                  anchor="bottom"
                  offset={16}
                  onClose={() => setValgt(null)}
                  closeButton={false}
                  className="ejendomskort-popup"
                >
                  {popupIndhold(valgt)}
                </Popup>
              )}
            </Map>
          )}
        </div>
      </div>
    </>,
    document.body
  );
}
