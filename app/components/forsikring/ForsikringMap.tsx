'use client';

/**
 * BIZZ-2131: Forsikrings-kort med farve-kodede markører.
 *
 * Viser ejendomme og virksomheder fra en forsikringsanalyse på et Mapbox-kort.
 * Farvekodning: grøn = fuldt forsikret, amber = advarsler, rød = kritisk/uforsikret,
 * blå = virksomhed.
 *
 * Bruges i ForsikringPageClient som sidepanel (desktop) eller fullscreen overlay (mobil).
 *
 * @module app/components/forsikring/ForsikringMap
 */

import React, { useState, useCallback, useRef, useEffect, memo } from 'react';
import Map, { Marker, Source, Layer, NavigationControl, type MapRef } from 'react-map-gl/mapbox';
import type { RasterLayerSpecification } from 'mapbox-gl';
import {
  Satellite,
  Map as MapIcon,
  Building2,
  X,
  Shield,
  ShieldAlert,
  ShieldX,
} from 'lucide-react';

/** Basekort-styles (dark + satellite) */
const STYLES = {
  dark: 'mapbox://styles/mapbox/navigation-night-v1',
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
} as const;

type MapStyle = keyof typeof STYLES;

const STYLE_STORAGE_KEY = 'bizzassist-forsikring-map-style';

/** Markør-data fra geo-endpointet */
export interface ForsikringMarker {
  id: string;
  type: 'ejendom' | 'virksomhed';
  label: string;
  lat: number;
  lng: number;
  bfe: number | null;
  cvr: string | null;
  adresse: string | null;
  isInsured: boolean;
  gapCritical: number;
  gapWarning: number;
}

interface ForsikringMapProps {
  /** Markører at plotte */
  markers: ForsikringMarker[];
  /** Callback når bruger klikker en markør — scroller til aktiv i listen */
  onMarkerClick?: (aktivId: string) => void;
  /** Aktiv-ID der skal highlightes (klikket i listen) */
  highlightedId?: string | null;
  /** Sprog (dansk/engelsk) */
  da?: boolean;
}

/**
 * WMS tile-URL via server-side proxy (undgår CORS).
 *
 * @param service - WMS-service-nøgle
 * @param layers - WMS LAYERS parameter
 * @returns Tile URL med {bbox-epsg-3857} placeholder
 */
function buildWmsUrl(service: 'plandata' | 'geodanmark', layers: string): string {
  return (
    `/api/wms?service=${service}` +
    `&SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap` +
    `&LAYERS=${encodeURIComponent(layers)}` +
    `&STYLES=&FORMAT=image%2Fpng&TRANSPARENT=true` +
    `&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}&SRS=EPSG:3857`
  );
}

/** Matrikelgrænser WMS-lag — jordstykker fra GeoDanmark */
const matrikelWmsUrl = buildWmsUrl('geodanmark', 'JORDSTYKKE');

/** Raster-lag style for matrikelgrænser */
const matrikelLayerStyle: RasterLayerSpecification = {
  id: 'forsikring-matrikel-wms',
  type: 'raster',
  source: 'forsikring-matrikel',
  paint: { 'raster-opacity': 0.5 },
};

/**
 * Beregn markør-farve baseret på forsikringsstatus.
 *
 * @param marker - Markør-data
 * @returns Tailwind farve-klasse
 */
function markerColor(marker: ForsikringMarker): string {
  if (marker.type === 'virksomhed') return 'bg-blue-500';
  if (marker.gapCritical > 0 || !marker.isInsured) return 'bg-red-500';
  if (marker.gapWarning > 0) return 'bg-amber-500';
  return 'bg-emerald-500';
}

/**
 * Uddrag husnummer fra adresse — "Gefionsvej 47A, 3000 Helsingør" → "47A".
 *
 * @param adresse - Fuld adressestreng
 * @returns Husnummer eller null
 */
function extractHusnr(adresse: string | null): string | null {
  if (!adresse) return null;
  const m = adresse.match(/\b(\d+[A-Za-z]?)\s*[,-]/);
  return m ? m[1] : null;
}

/**
 * Status-ikon til popup.
 *
 * @param marker - Markør-data
 * @returns Ikon + label
 */
function StatusBadge({ marker, da }: { marker: ForsikringMarker; da: boolean }) {
  if (marker.gapCritical > 0) {
    return (
      <span className="flex items-center gap-1 text-red-400 text-[10px]">
        <ShieldX size={10} />
        {marker.gapCritical} {da ? 'kritiske' : 'critical'}
      </span>
    );
  }
  if (marker.gapWarning > 0) {
    return (
      <span className="flex items-center gap-1 text-amber-400 text-[10px]">
        <ShieldAlert size={10} />
        {marker.gapWarning} {da ? 'advarsler' : 'warnings'}
      </span>
    );
  }
  if (!marker.isInsured) {
    return (
      <span className="flex items-center gap-1 text-red-400 text-[10px]">
        <ShieldX size={10} />
        {da ? 'Uforsikret' : 'Uninsured'}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-emerald-400 text-[10px]">
      <Shield size={10} />
      {da ? 'Forsikret' : 'Insured'}
    </span>
  );
}

/**
 * Forsikrings-kort med aktiv-markører og legende.
 *
 * @param props - Markører, klik-handler, sprog
 */
function ForsikringMapInner({
  markers,
  onMarkerClick,
  highlightedId,
  da = true,
}: ForsikringMapProps) {
  const mapRef = useRef<MapRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  /** ResizeObserver — trigger map.resize() når containeren ændrer størrelse (drag-divider) */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      mapRef.current?.resize();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [mapStyle, setMapStyleState] = useState<MapStyle>(() => {
    if (typeof window === 'undefined') return 'dark';
    const saved = window.localStorage.getItem(STYLE_STORAGE_KEY) as MapStyle | null;
    return saved && saved in STYLES ? saved : 'dark';
  });
  const [popupMarker, setPopupMarker] = useState<ForsikringMarker | null>(null);
  const [showEjendomme, setShowEjendomme] = useState(true);
  const [showVirksomheder, setShowVirksomheder] = useState(true);

  /** Skift kort-style og gem i localStorage */
  const setMapStyle = useCallback((style: MapStyle) => {
    setMapStyleState(style);
    window.localStorage.setItem(STYLE_STORAGE_KEY, style);
  }, []);

  /** Fly til highlighted markør når bruger klikker i listen */
  useEffect(() => {
    if (!highlightedId || !mapRef.current) return;
    const m = markers.find((x) => x.id === highlightedId);
    if (!m) return;
    mapRef.current.flyTo({ center: [m.lng, m.lat], zoom: 16, duration: 800 });
    setPopupMarker(m);
  }, [highlightedId, markers]);

  /** Auto-fitBounds til alle markører ved load */
  useEffect(() => {
    if (!mapRef.current || markers.length === 0) return;
    const map = mapRef.current;

    // Beregn bounding box
    let minLat = Infinity,
      maxLat = -Infinity,
      minLng = Infinity,
      maxLng = -Infinity;
    for (const m of markers) {
      if (m.lat < minLat) minLat = m.lat;
      if (m.lat > maxLat) maxLat = m.lat;
      if (m.lng < minLng) minLng = m.lng;
      if (m.lng > maxLng) maxLng = m.lng;
    }

    // Tilpas viewport med padding
    if (minLat <= maxLat && minLng <= maxLng) {
      map.fitBounds(
        [
          [minLng, minLat],
          [maxLng, maxLat],
        ],
        { padding: 50, maxZoom: 14, duration: 500 }
      );
    }
  }, [markers]);

  /** Filtrerede markører */
  const visibleMarkers = markers.filter((m) => {
    if (m.type === 'ejendom' && !showEjendomme) return false;
    if (m.type === 'virksomhed' && !showVirksomheder) return false;
    return true;
  });

  // Default center (Danmark) hvis ingen markører
  const defaultLat = markers[0]?.lat ?? 55.68;
  const defaultLng = markers[0]?.lng ?? 12.57;

  return (
    <div ref={containerRef} className="relative w-full h-full">
      <Map
        ref={mapRef}
        mapboxAccessToken={process.env.NEXT_PUBLIC_MAPBOX_TOKEN}
        initialViewState={{
          latitude: defaultLat,
          longitude: defaultLng,
          zoom: 7,
        }}
        mapStyle={STYLES[mapStyle]}
        style={{ width: '100%', height: '100%' }}
        onClick={() => setPopupMarker(null)}
      >
        <NavigationControl position="top-right" showCompass={false} />

        {/* BIZZ-2131: Matrikelgrænser WMS-lag */}
        <Source id="forsikring-matrikel" type="raster" tiles={[matrikelWmsUrl]} tileSize={256}>
          <Layer {...matrikelLayerStyle} />
        </Source>

        {visibleMarkers.map((m) => {
          const husnr = extractHusnr(m.adresse);
          return (
            <Marker
              key={m.id}
              latitude={m.lat}
              longitude={m.lng}
              anchor="center"
              onClick={(e) => {
                e.originalEvent.stopPropagation();
                setPopupMarker(m);
                onMarkerClick?.(m.id);
              }}
            >
              <div
                className={`${markerColor(m)} flex items-center justify-center shadow-lg cursor-pointer hover:scale-110 transition-transform ${
                  husnr
                    ? 'rounded-md px-1.5 py-0.5 border min-w-[24px]'
                    : 'w-6 h-6 rounded-full border-2'
                } ${
                  highlightedId === m.id
                    ? 'border-white ring-2 ring-white/60 scale-125 z-10'
                    : 'border-white/30'
                }`}
                title={m.label}
              >
                {husnr ? (
                  <span className="text-white text-[9px] font-bold leading-none">{husnr}</span>
                ) : m.type === 'virksomhed' ? (
                  <Building2 size={12} className="text-white" />
                ) : (
                  <span className="text-white text-[9px] font-bold">?</span>
                )}
              </div>
            </Marker>
          );
        })}
      </Map>

      {/* Popup overlay */}
      {popupMarker && (
        <div className="absolute top-3 left-3 right-3 bg-slate-900/95 backdrop-blur-sm border border-slate-700/60 rounded-lg p-3 z-10">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-white text-xs font-medium truncate">{popupMarker.label}</p>
              {popupMarker.adresse && (
                <p className="text-slate-400 text-[10px] truncate mt-0.5">{popupMarker.adresse}</p>
              )}
              <div className="mt-1.5">
                <StatusBadge marker={popupMarker} da={da} />
              </div>
              {popupMarker.gapCritical + popupMarker.gapWarning > 0 && (
                <p className="text-slate-400 text-[10px] mt-1">
                  {popupMarker.gapCritical + popupMarker.gapWarning}{' '}
                  {da ? 'forsikringshuller' : 'gaps'}
                </p>
              )}
            </div>
            <button
              onClick={() => setPopupMarker(null)}
              className="p-1 rounded hover:bg-slate-700/50 text-slate-400 hover:text-white transition-colors flex-shrink-0"
              aria-label={da ? 'Luk' : 'Close'}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {/* Style toggle */}
      <div className="absolute top-3 left-3 z-10 flex gap-1">
        {!popupMarker && (
          <>
            <button
              onClick={() => setMapStyle('dark')}
              className={`p-1.5 rounded-lg border transition-colors ${
                mapStyle === 'dark'
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-slate-800/80 border-slate-700/60 text-slate-300 hover:bg-slate-700/80'
              }`}
              aria-label={da ? 'Gadekort' : 'Street map'}
            >
              <MapIcon size={14} />
            </button>
            <button
              onClick={() => setMapStyle('satellite')}
              className={`p-1.5 rounded-lg border transition-colors ${
                mapStyle === 'satellite'
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-slate-800/80 border-slate-700/60 text-slate-300 hover:bg-slate-700/80'
              }`}
              aria-label={da ? 'Luftfoto' : 'Satellite'}
            >
              <Satellite size={14} />
            </button>
          </>
        )}
      </div>

      {/* Legende + filtre */}
      <div className="absolute bottom-3 left-3 right-3 bg-slate-900/90 backdrop-blur-sm border border-slate-700/60 rounded-lg px-3 py-2 z-10">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px]">
          <button
            onClick={() => setShowEjendomme(!showEjendomme)}
            className={`flex items-center gap-1.5 transition-opacity ${!showEjendomme ? 'opacity-40' : ''}`}
          >
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" />
            <span className="text-slate-300">{da ? 'Forsikret' : 'Insured'}</span>
          </button>
          <button
            onClick={() => setShowEjendomme(!showEjendomme)}
            className={`flex items-center gap-1.5 transition-opacity ${!showEjendomme ? 'opacity-40' : ''}`}
          >
            <span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block" />
            <span className="text-slate-300">{da ? 'Advarsler' : 'Warnings'}</span>
          </button>
          <button
            onClick={() => setShowEjendomme(!showEjendomme)}
            className={`flex items-center gap-1.5 transition-opacity ${!showEjendomme ? 'opacity-40' : ''}`}
          >
            <span className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block" />
            <span className="text-slate-300">{da ? 'Kritisk' : 'Critical'}</span>
          </button>
          <button
            onClick={() => setShowVirksomheder(!showVirksomheder)}
            className={`flex items-center gap-1.5 transition-opacity ${!showVirksomheder ? 'opacity-40' : ''}`}
          >
            <span className="w-2.5 h-2.5 rounded-full bg-blue-500 inline-block" />
            <span className="text-slate-300">{da ? 'Virksomhed' : 'Company'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/** Memoized eksport — re-render kun ved marker/props ændring */
const ForsikringMap = memo(ForsikringMapInner);
ForsikringMap.displayName = 'ForsikringMap';
export default ForsikringMap;
