'use client';

/**
 * Interaktiv ejendomskort-komponent.
 *
 * Bruger Mapbox GL via react-map-gl som basekort med toggle
 * mellem street-view og satellite/luftfoto.
 *
 * Kortforsyningen WFS-lag (Geodatastyrelsen) viser de officielle
 * matrikelgrænser ovenpå Mapbox baselaget.
 *
 * Kræver:
 *   NEXT_PUBLIC_MAPBOX_TOKEN  — fra mapbox.com (pk.ey...)
 *   NEXT_PUBLIC_KORTFORSYNINGEN_USER  — tjenestebrugernavn fra datafordeler.dk
 *   NEXT_PUBLIC_KORTFORSYNINGEN_PASS  — tjenestebrugeradgangskode
 */

import { useState, useCallback, useRef } from 'react';
import Map, { Marker, Source, Layer, NavigationControl, type MapRef } from 'react-map-gl/mapbox';
import type { FillLayerSpecification, LineLayerSpecification } from 'mapbox-gl';
import { Satellite, Map as MapIcon, Maximize2, Minimize2 } from 'lucide-react';
import 'mapbox-gl/dist/mapbox-gl.css';

/** Mapbox styles */
const STYLES = {
  dark: 'mapbox://styles/mapbox/dark-v11',
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
} as const;

type MapStyle = keyof typeof STYLES;

/**
 * WFS-kilde URL til Kortforsyningens matrikellag.
 * Returnerer GeoJSON-grænser for matrikler i et givent bbox.
 *
 * @param user - Tjenestebrugernavn fra datafordeler.dk
 * @param pass - Tjenestebrugeradgangskode
 * @param lng - Længdegrad for centerpunkt
 * @param lat - Breddegrad for centerpunkt
 */
function matrikelWfsUrl(user: string, pass: string, lng: number, lat: number): string {
  const delta = 0.003;
  const bbox = `${lng - delta},${lat - delta},${lng + delta},${lat + delta},EPSG:4326`;
  return (
    `https://services.datafordeler.dk/Matrikel/MatrikelGaeldendeDKWFS/1.0.0/WFS` +
    `?username=${user}&password=${pass}` +
    `&SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature` +
    `&TYPENAMES=mat:Jordstykke&OUTPUTFORMAT=application/json` +
    `&SRSNAME=EPSG:4326&BBOX=${bbox}`
  );
}

/** Stil for matrikel-fyld */
const matrikelFillLayer: FillLayerSpecification = {
  id: 'matrikel-fill',
  type: 'fill',
  source: 'matrikel',
  paint: {
    'fill-color': '#3b82f6',
    'fill-opacity': 0.15,
  },
};

/** Stil for matrikel-grænselinje */
const matrikelLineLayer: LineLayerSpecification = {
  id: 'matrikel-line',
  type: 'line',
  source: 'matrikel',
  paint: {
    'line-color': '#ef4444',
    'line-width': 2,
    'line-opacity': 0.9,
  },
};

interface PropertyMapProps {
  /** Breddegrad */
  lat: number;
  /** Længdegrad */
  lng: number;
  /** Adresse vist i marker-tooltip */
  adresse: string;
  /** Vis/skjul matrikellag */
  visMmatrikel?: boolean;
}

/**
 * Interaktiv Mapbox-kort til ejendomssider.
 * Viser ejendomsmarkør, luftfoto/gade toggle og matrikelgrænser.
 *
 * @param lat - Breddegrad
 * @param lng - Længdegrad
 * @param adresse - Adresse til tooltip
 * @param visMatrikel - Skal matrikellag vises
 */
export default function PropertyMap({ lat, lng, adresse, visMmatrikel = true }: PropertyMapProps) {
  const mapRef = useRef<MapRef>(null);
  const [mapStyle, setMapStyle] = useState<MapStyle>('satellite');
  const [fullscreen, setFullscreen] = useState(false);

  const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';
  const kortUser = process.env.NEXT_PUBLIC_KORTFORSYNINGEN_USER ?? '';
  const kortPass = process.env.NEXT_PUBLIC_KORTFORSYNINGEN_PASS ?? '';

  const harNoegler = mapboxToken.startsWith('pk.');
  const harKortforsyningen = kortUser.length > 0 && kortPass.length > 0;

  /** Centrer kortet på ejendomspositionen igen */
  const centerMap = useCallback(() => {
    mapRef.current?.flyTo({ center: [lng, lat], zoom: 17, duration: 800 });
  }, [lat, lng]);

  if (!harNoegler) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-slate-900 text-center px-6 gap-3">
        <MapIcon size={28} className="text-slate-500" />
        <p className="text-slate-400 text-sm font-medium">Kortvisning ikke aktiveret</p>
        <p className="text-slate-500 text-xs leading-relaxed">
          Tilføj{' '}
          <code className="bg-slate-800 px-1 rounded text-blue-300">NEXT_PUBLIC_MAPBOX_TOKEN</code>{' '}
          til <code className="bg-slate-800 px-1 rounded text-blue-300">.env.local</code> for at
          aktivere kortet.
        </p>
      </div>
    );
  }

  return (
    <div className={`relative w-full h-full ${fullscreen ? 'fixed inset-0 z-50' : ''}`}>
      <Map
        ref={mapRef}
        mapboxAccessToken={mapboxToken}
        initialViewState={{ longitude: lng, latitude: lat, zoom: 17 }}
        style={{ width: '100%', height: '100%' }}
        mapStyle={STYLES[mapStyle]}
        attributionControl={false}
      >
        <NavigationControl position="bottom-right" showCompass={false} />

        {/* Matrikellag fra Kortforsyningen */}
        {harKortforsyningen && visMmatrikel && (
          <Source id="matrikel" type="geojson" data={matrikelWfsUrl(kortUser, kortPass, lng, lat)}>
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

      {/* Style-toggle */}
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

      {/* Kortforsyningen mangler badge */}
      {!harKortforsyningen && (
        <div className="absolute bottom-3 left-3 z-10 bg-slate-900/90 border border-slate-700/50 rounded-lg px-2.5 py-1.5">
          <p className="text-slate-500 text-xs">Matrikelgrænser: Tilføj Kortforsyningen nøgler</p>
        </div>
      )}
    </div>
  );
}
