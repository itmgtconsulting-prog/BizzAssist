'use client';

/**
 * Interaktiv ejendomskort-komponent.
 *
 * Bruger Mapbox GL via react-map-gl som basekort med toggle
 * mellem gadekort (navigation-night-v1) og luftfoto (satellite-streets-v12).
 *
 * Matrikelgrænser hentes fra DAWA / Dataforsyningen — gratis uden API-nøgle:
 *   https://api.dataforsyningen.dk/jordstykker?x={lng}&y={lat}&srid=4326&format=geojson
 *
 * Kræver kun:
 *   NEXT_PUBLIC_MAPBOX_TOKEN  — fra mapbox.com (pk.ey...)
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import Map, { Marker, Source, Layer, NavigationControl, type MapRef } from 'react-map-gl/mapbox';
import type {
  FillLayerSpecification,
  LineLayerSpecification,
  GeoJSONSourceSpecification,
} from 'mapbox-gl';
import { Satellite, Map as MapIcon, Maximize2, Minimize2, Layers } from 'lucide-react';
import 'mapbox-gl/dist/mapbox-gl.css';

/**
 * Mapbox basekort-styles.
 *
 * 'dark' bruger navigation-night-v1 i stedet for dark-v11:
 * navigation-night-v1 er professionelt designet til mørke miljøer med
 * klar kontrast på bygninger, veje og baggrund — ingen custom overrides nødvendige.
 */
const STYLES = {
  dark: 'mapbox://styles/mapbox/navigation-night-v1',
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
} as const;

type MapStyle = keyof typeof STYLES;

/** Stil for matrikellag — gennemsigtig blå fyld */
const matrikelFillLayer: FillLayerSpecification = {
  id: 'matrikel-fill',
  type: 'fill',
  source: 'matrikel',
  paint: {
    'fill-color': '#3b82f6',
    'fill-opacity': 0.15,
  },
};

/** Stil for matrikellag — rød grænselinje */
const matrikelLineLayer: LineLayerSpecification = {
  id: 'matrikel-line',
  type: 'line',
  source: 'matrikel',
  paint: {
    'line-color': '#ef4444',
    'line-width': 2.5,
    'line-opacity': 0.95,
  },
};

/** Tom GeoJSON FeatureCollection brugt som fallback inden data loader */
const EMPTY_GEOJSON: GeoJSONSourceSpecification['data'] = {
  type: 'FeatureCollection',
  features: [],
};

interface PropertyMapProps {
  /** Breddegrad for ejendommen */
  lat: number;
  /** Længdegrad for ejendommen */
  lng: number;
  /** Adresse vist i markør-tooltip */
  adresse: string;
  /** Vis matrikelgrænselag — default true */
  visMatrikel?: boolean;
}

/** In-memory cache så samme koordinat ikke hentes to gange i samme session */
const matrikelCache: Record<string, GeoJSONSourceSpecification['data']> = {};

/**
 * Henter matrikelgrænse som GeoJSON fra DAWA (gratis, ingen token).
 * Resultatet caches i hukommelsen for sessionen.
 * Returnerer null hvis kaldet fejler.
 *
 * @param lng - Længdegrad
 * @param lat - Breddegrad
 */
async function hentMatrikelGeojson(
  lng: number,
  lat: number
): Promise<GeoJSONSourceSpecification['data'] | null> {
  const cacheKey = `${lng.toFixed(5)},${lat.toFixed(5)}`;
  if (cacheKey in matrikelCache) return matrikelCache[cacheKey];

  try {
    const url = `https://api.dataforsyningen.dk/jordstykker?x=${lng}&y=${lat}&srid=4326&format=geojson`;
    const res = await fetch(url, { next: { revalidate: 86400 } } as RequestInit);
    if (!res.ok) return null;
    const json = await res.json();
    // DAWA returnerer et array — pak ind i FeatureCollection
    const data: GeoJSONSourceSpecification['data'] = Array.isArray(json)
      ? { type: 'FeatureCollection', features: json }
      : (json as GeoJSONSourceSpecification['data']);
    matrikelCache[cacheKey] = data;
    return data;
  } catch {
    return null;
  }
}

/**
 * Interaktiv Mapbox-kort til ejendomssider.
 *
 * Viser ejendomsmarkør, luftfoto/gade toggle og officielle matrikelgrænser
 * fra DAWA (Dataforsyningen) — uden API-nøgle.
 *
 * @param lat - Breddegrad
 * @param lng - Længdegrad
 * @param adresse - Adresse til markør-label
 * @param visMatrikel - Skal matrikellag vises (default: true)
 */
export default function PropertyMap({ lat, lng, adresse, visMatrikel = true }: PropertyMapProps) {
  const mapRef = useRef<MapRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [mapStyle, setMapStyle] = useState<MapStyle>('satellite');
  const [fullscreen, setFullscreen] = useState(false);
  const [matrikelData, setMatrikelData] =
    useState<GeoJSONSourceSpecification['data']>(EMPTY_GEOJSON);

  const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';
  const harToken = mapboxToken.startsWith('pk.');

  /** Hent matrikeldata fra DAWA — setState kun i async callback */
  useEffect(() => {
    if (!visMatrikel) return;
    hentMatrikelGeojson(lng, lat).then((data) => {
      if (data) setMatrikelData(data);
    });
  }, [lng, lat, visMatrikel]);

  /**
   * ResizeObserver på container-elementet — kalder map.resize() når bredden ændres
   * (f.eks. ved drag af adskillelseslinien). Mapbox GL opdaterer ikke canvas-størrelsen
   * automatisk ved CSS-ændringer, kun ved window resize-events.
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      mapRef.current?.resize();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  /** Centrer kortet på ejendommen igen */
  const centerMap = useCallback(() => {
    mapRef.current?.flyTo({ center: [lng, lat], zoom: 17, duration: 800 });
  }, [lat, lng]);

  /** Vis fallback UI hvis Mapbox-token mangler */
  if (!harToken) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-slate-900 text-center px-6 gap-3">
        <MapIcon size={28} className="text-slate-500" />
        <p className="text-slate-400 text-sm font-medium">Kortvisning ikke aktiveret</p>
        <p className="text-slate-500 text-xs leading-relaxed">
          Tilføj{' '}
          <code className="bg-slate-800 px-1 rounded text-blue-300">NEXT_PUBLIC_MAPBOX_TOKEN</code>{' '}
          til <code className="bg-slate-800 px-1 rounded text-blue-300">.env.local</code>
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full ${fullscreen ? 'fixed inset-0 z-50' : ''}`}
    >
      <Map
        ref={mapRef}
        mapboxAccessToken={mapboxToken}
        initialViewState={{ longitude: lng, latitude: lat, zoom: 17 }}
        style={{ width: '100%', height: '100%' }}
        mapStyle={STYLES[mapStyle]}
        attributionControl={false}
      >
        <NavigationControl position="bottom-right" showCompass={false} />

        {/* Matrikellag fra DAWA — gratis, ingen token */}
        {visMatrikel && (
          <Source id="matrikel" type="geojson" data={matrikelData}>
            <Layer {...matrikelFillLayer} />
            <Layer {...matrikelLineLayer} />
          </Source>
        )}

        {/* Ejendomsmarkør */}
        <Marker longitude={lng} latitude={lat} anchor="bottom">
          <div className="flex flex-col items-center cursor-pointer" onClick={centerMap}>
            <div className="bg-blue-600 text-white text-xs px-2 py-1 rounded-lg shadow-lg font-medium whitespace-nowrap mb-1">
              {adresse.split(',')[0]}
            </div>
            <div className="w-3 h-3 bg-blue-600 rounded-full border-2 border-white shadow-lg" />
          </div>
        </Marker>
      </Map>

      {/* Gadekort / Luftfoto toggle */}
      <div className="absolute top-3 left-3 flex gap-1.5 z-10">
        <button
          onClick={() => setMapStyle('dark')}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium shadow-lg transition-all ${
            mapStyle === 'dark'
              ? 'bg-blue-600 text-white'
              : 'bg-slate-900/90 text-slate-300 hover:bg-slate-800 border border-slate-700'
          }`}
        >
          <MapIcon size={12} />
          Gade
        </button>
        <button
          onClick={() => setMapStyle('satellite')}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium shadow-lg transition-all ${
            mapStyle === 'satellite'
              ? 'bg-blue-600 text-white'
              : 'bg-slate-900/90 text-slate-300 hover:bg-slate-800 border border-slate-700'
          }`}
        >
          <Satellite size={12} />
          Luftfoto
        </button>
      </div>

      {/* Fullscreen toggle */}
      <button
        onClick={() => setFullscreen((f) => !f)}
        className="absolute top-3 right-3 z-10 p-1.5 bg-slate-900/90 hover:bg-slate-800 border border-slate-700 rounded-lg text-slate-300 shadow-lg transition-all"
      >
        {fullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
      </button>

      {/* Matrikellag badge */}
      {visMatrikel && (
        <div className="absolute bottom-3 left-3 z-10 flex items-center gap-1.5 bg-slate-900/90 border border-slate-700/50 rounded-lg px-2.5 py-1.5">
          <Layers size={11} className="text-green-400" />
          <p className="text-slate-400 text-xs">Matrikelgrænser</p>
        </div>
      )}
    </div>
  );
}
