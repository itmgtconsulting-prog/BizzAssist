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
import type { LineLayerSpecification, FillLayerSpecification } from 'mapbox-gl';
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

/**
 * BIZZ-2142: Logger WebGL/render-fejl fra Mapbox uden PII.
 *
 * Edge/Safari kan fejle WebGL-context-oprettelse (sort canvas). Vi logger en
 * generisk besked til konsollen så fejlen kan diagnosticeres uden at lække
 * koordinater, adresser eller andre persondata til loggen.
 *
 * @param e - Mapbox error-event (kan indeholde et Error-objekt)
 */
function logMapWebglError(e: { error?: Error } | unknown): void {
  const msg =
    e && typeof e === 'object' && 'error' in e && (e as { error?: Error }).error
      ? (e as { error: Error }).error.message
      : 'ukendt render-fejl';

  console.warn('[ForsikringMap] WebGL/render-fejl:', msg);
}

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
  /** BIZZ-2145: BBR bygningsdata */
  bbr?: {
    bebygget_areal: number | null;
    antal_etager: number | null;
    opfoerelsesaar: number | null;
    anvendelse: string | null;
  } | null;
  /** BIZZ-2145: Police bygningsdata */
  policeBygninger?: Array<{
    navn: string | null;
    anvendelse: string | null;
    bebygget_areal_m2: number | null;
    antal_etager: number | null;
    opfoert_aar: number | null;
  }> | null;
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

/** GeoJSON matrikel-grænser: fyld-lag (transparent blåt) */
const matrikelFillStyle: FillLayerSpecification = {
  id: 'forsikring-matrikel-fill',
  type: 'fill',
  source: 'forsikring-matrikel',
  paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.08 },
};

/** GeoJSON matrikel-grænser: kant-lag (synlig linje) */
const matrikelLineStyle: LineLayerSpecification = {
  id: 'forsikring-matrikel-line',
  type: 'line',
  source: 'forsikring-matrikel',
  paint: { 'line-color': '#60a5fa', 'line-width': 1.5, 'line-opacity': 0.6 },
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
  // Standard husnummer: "47A," eller "123A,"
  const m = adresse.match(/\b(\d+[A-Za-z]?)\s*[,-]/);
  if (m) return m[1];
  // Matrikel-reference: "65bi Helsingør" → "65bi"
  const mat = adresse.match(/^(\d+\w+)\s/);
  return mat ? mat[1] : null;
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
      <span className="flex items-center gap-1 text-red-400 text-xs">
        <ShieldX size={12} />
        {marker.gapCritical} {da ? 'kritiske' : 'critical'}
      </span>
    );
  }
  if (marker.gapWarning > 0) {
    return (
      <span className="flex items-center gap-1 text-amber-400 text-xs">
        <ShieldAlert size={12} />
        {marker.gapWarning} {da ? 'advarsler' : 'warnings'}
      </span>
    );
  }
  if (!marker.isInsured) {
    return (
      <span className="flex items-center gap-1 text-red-400 text-xs">
        <ShieldX size={12} />
        {da ? 'Uforsikret' : 'Uninsured'}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-emerald-400 text-xs">
      <Shield size={12} />
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
  /** Matrikel bbox URL — opdateres dynamisk ved zoom ≥ 15 */
  const [matrikelUrl, setMatrikelUrl] = useState<string | null>(null);

  /** Opdater matrikelgrænser baseret på kortets aktuelle viewport (zoom ≥ 15) */
  const updateMatrikelForViewport = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const zoom = map.getZoom();
    if (zoom < 15) {
      setMatrikelUrl(null); // Skjul matrikel ved lavt zoom
      return;
    }
    const bounds = map.getBounds();
    if (!bounds) return;
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    setMatrikelUrl(`/api/matrikel/bbox?w=${sw.lng}&s=${sw.lat}&e=${ne.lng}&n=${ne.lat}`);
  }, []);

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

  /** Beregn bounding box og kør fitBounds */
  const fitToMarkers = useCallback(() => {
    if (!mapRef.current || markers.length === 0) return;
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
    if (minLat <= maxLat && minLng <= maxLng) {
      mapRef.current.fitBounds(
        [
          [minLng, minLat],
          [maxLng, maxLat],
        ],
        { padding: 50, maxZoom: 14, duration: 500 }
      );
    }
  }, [markers]);

  /** Auto-fitBounds når markers ændres */
  useEffect(() => {
    fitToMarkers();
  }, [fitToMarkers]);

  /** Filtrerede markører */
  const visibleMarkers = markers.filter((m) => {
    if (m.type === 'ejendom' && !showEjendomme) return false;
    if (m.type === 'virksomhed' && !showVirksomheder) return false;
    return true;
  });

  // BIZZ-2149: Ejerlejligheder med samme adresse (fx "Stjernegade 24A" = BFE
  // 244640 + 244655) har identiske koordinater og stables til én klikbar pin.
  // Vi spreder pins med samme koordinat let radialt, så hver distinkt ejendom
  // får sin egen klikbare markør (rå koordinater bevares til fitBounds ovenfor).
  // Bemærk: identifikatoren `Map` er react-map-gl-komponenten her, så vi bruger
  // et almindeligt objekt som koordinat→markører-opslag.
  const coordGroups: Record<string, ForsikringMarker[]> = {};
  for (const m of visibleMarkers) {
    const key = `${m.lat.toFixed(5)},${m.lng.toFixed(5)}`;
    if (coordGroups[key]) coordGroups[key].push(m);
    else coordGroups[key] = [m];
  }
  /**
   * Beregn vise-koordinat for en markør — spreder overlappende pins i en cirkel.
   *
   * @param m - Markøren der skal placeres
   * @returns Forskudt {lat, lng} hvis koordinatet deles, ellers den rå position
   */
  const displayPos = (m: ForsikringMarker): { lat: number; lng: number } => {
    const key = `${m.lat.toFixed(5)},${m.lng.toFixed(5)}`;
    const grp = coordGroups[key];
    if (!grp || grp.length < 2) return { lat: m.lat, lng: m.lng };
    const i = grp.indexOf(m);
    const radius = 0.00012; // ~13 m radial spredning
    const angle = (2 * Math.PI * i) / grp.length;
    return {
      lat: m.lat + radius * Math.cos(angle),
      lng: m.lng + (radius * Math.sin(angle)) / Math.cos((m.lat * Math.PI) / 180),
    };
  };

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
        maxZoom={20}
        style={{ width: '100%', height: '100%' }}
        // BIZZ-2142: Edge renderer kortet som sort flade (kun pins synlige) pga.
        // WebGL-context/compositing-forskelle. preserveDrawingBuffer beholder
        // canvas-bufferen mellem frames, antialias:false sænker GPU-kravet, og
        // failIfMajorPerformanceCaveat:false tillader software-rendering-fallback
        // på integrerede Intel-GPU'er — sammen løser de sort-canvas i Edge/Safari.
        preserveDrawingBuffer
        antialias={false}
        failIfMajorPerformanceCaveat={false}
        onError={(e) => logMapWebglError(e)}
        onClick={() => setPopupMarker(null)}
        onLoad={() => fitToMarkers()}
        onMoveEnd={() => updateMatrikelForViewport()}
      >
        <NavigationControl position="top-right" showCompass={false} />

        {/* BIZZ-2131: Matrikelgrænser (GeoJSON fra /api/matrikel/bbox) */}
        {matrikelUrl && (
          <Source id="forsikring-matrikel" type="geojson" data={matrikelUrl}>
            <Layer {...matrikelFillStyle} />
            <Layer {...matrikelLineStyle} />
          </Source>
        )}

        {visibleMarkers.map((m) => {
          const husnr = extractHusnr(m.adresse);
          const pos = displayPos(m);
          return (
            <Marker
              key={m.id}
              latitude={pos.lat}
              longitude={pos.lng}
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

      {/* Popup overlay — over legenden i bunden. BIZZ-2142: backdrop-blur fjernet —
          Edge har compositing-bugs med backdrop-filter over WebGL-canvas (sort kort). */}
      {popupMarker && (
        <div className="absolute bottom-12 left-3 right-3 bg-slate-900/95 border border-slate-700/60 rounded-lg p-3 z-10">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-white text-sm font-semibold truncate">{popupMarker.label}</p>
              {popupMarker.adresse && (
                <p className="text-slate-400 text-xs truncate mt-0.5">{popupMarker.adresse}</p>
              )}
              <div className="mt-1.5">
                <StatusBadge marker={popupMarker} da={da} />
              </div>
              {popupMarker.gapCritical + popupMarker.gapWarning > 0 && (
                <p className="text-slate-400 text-xs mt-1">
                  {popupMarker.gapCritical + popupMarker.gapWarning}{' '}
                  {da ? 'forsikringshuller' : 'gaps'}
                </p>
              )}
              {/* BIZZ-2145: BBR vs Police bygningsdata */}
              {(popupMarker.bbr || popupMarker.policeBygninger) && (
                <div className="mt-2 border-t border-slate-700/50 pt-1.5 space-y-1">
                  {popupMarker.bbr && (
                    <div className="text-xs">
                      <span className="text-blue-400 font-medium">BBR:</span>
                      <span className="text-slate-300 ml-1">
                        {popupMarker.bbr.bebygget_areal
                          ? `${popupMarker.bbr.bebygget_areal} m²`
                          : ''}
                        {popupMarker.bbr.antal_etager
                          ? ` · ${popupMarker.bbr.antal_etager} et.`
                          : ''}
                        {popupMarker.bbr.opfoerelsesaar
                          ? ` · ${popupMarker.bbr.opfoerelsesaar}`
                          : ''}
                      </span>
                    </div>
                  )}
                  {popupMarker.policeBygninger?.map((b, i) => (
                    <div key={i} className="text-xs">
                      <span className="text-emerald-400 font-medium">
                        {da ? 'Police' : 'Policy'}:
                      </span>
                      <span className="text-slate-300 ml-1">
                        {b.bebygget_areal_m2 ? `${b.bebygget_areal_m2} m²` : ''}
                        {b.antal_etager ? ` · ${b.antal_etager} et.` : ''}
                        {b.opfoert_aar ? ` · ${b.opfoert_aar}` : ''}
                        {b.anvendelse ? ` · ${b.anvendelse}` : ''}
                      </span>
                    </div>
                  ))}
                  {/* Advarsel ved areal-afvigelse > 15% */}
                  {popupMarker.bbr?.bebygget_areal &&
                    popupMarker.policeBygninger?.[0]?.bebygget_areal_m2 &&
                    (() => {
                      const bbrAreal = popupMarker.bbr!.bebygget_areal!;
                      const polAreal = popupMarker.policeBygninger![0].bebygget_areal_m2!;
                      const pct = (Math.abs(bbrAreal - polAreal) / bbrAreal) * 100;
                      if (pct > 15)
                        return (
                          <div className="text-xs text-amber-400 font-medium">
                            ⚠ {da ? 'Areal-afvigelse' : 'Area mismatch'}: BBR {bbrAreal}m² vs Police{' '}
                            {polAreal}m² ({pct.toFixed(0)}%)
                          </div>
                        );
                      return null;
                    })()}
                </div>
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
      </div>

      {/* Legende + filtre */}
      <div className="absolute bottom-3 left-3 right-3 bg-slate-900/95 border border-slate-700/60 rounded-lg px-3 py-2 z-10">
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
