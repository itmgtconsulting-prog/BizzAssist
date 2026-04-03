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
import Link from 'next/link';
import Map, {
  Marker,
  Source,
  Layer,
  NavigationControl,
  type MapRef,
  type MapMouseEvent,
} from 'react-map-gl/mapbox';
import type {
  FillLayerSpecification,
  LineLayerSpecification,
  GeoJSONSourceSpecification,
} from 'mapbox-gl';
import {
  Satellite,
  Map as MapIcon,
  Maximize2,
  Minimize2,
  Loader2,
  Building2,
  ExternalLink,
} from 'lucide-react';
import 'mapbox-gl/dist/mapbox-gl.css';

/**
 * Mapbox basekort-styles.
 *
 * 'dark' (Gade) og 'bbr' bruger navigation-night-v1 — mørkt design optimeret
 * til høj kontrast: veje er lysere end omgivelserne, bygninger er markant
 * mørkere end veje, og baggrundsarealer er dybt mørke.
 * 'bbr' tilføjer BBR-bygningsmarkører ovenpå den mørke base.
 * 'satellite' bruger satellite-streets-v12 til luftfoto med vejnavne.
 */
const STYLES = {
  dark: 'mapbox://styles/mapbox/navigation-night-v1',
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
  bbr: 'mapbox://styles/mapbox/navigation-night-v1',
} as const;

type MapStyle = keyof typeof STYLES;

/** Alle matrikelparceller — usynligt fyld-lag til hover-detektion via queryRenderedFeatures */
const matrikelFillLayer: FillLayerSpecification = {
  id: 'matrikel-fill',
  type: 'fill',
  source: 'matrikel',
  paint: {
    'fill-color': '#3b82f6',
    'fill-opacity': 0,
  },
};

/** Valgt ejendoms matrikel — fremhævet blå fyld */
const selectedFillLayer: FillLayerSpecification = {
  id: 'selected-fill',
  type: 'fill',
  source: 'selected-matrikel',
  paint: {
    'fill-color': '#3b82f6',
    'fill-opacity': 0.2,
  },
};

/** Valgt ejendoms matrikel — tydeligere grænselinje */
const selectedLineLayer: LineLayerSpecification = {
  id: 'selected-line',
  type: 'line',
  source: 'selected-matrikel',
  paint: {
    'line-color': '#60a5fa',
    'line-width': 2,
    'line-opacity': 1,
  },
};

/** Hover-highlight: blå fyld — matcher kortsidens stil */
const hoverFillLayer: FillLayerSpecification = {
  id: 'hover-fill',
  type: 'fill',
  source: 'hover-matrikel',
  paint: {
    'fill-color': '#3b82f6',
    'fill-opacity': 0.3,
  },
};

/** Hover-highlight: lys blå konturlinje (matcher kortsidens stil) */
const hoverLineLayer: LineLayerSpecification = {
  id: 'hover-line',
  type: 'line',
  source: 'hover-matrikel',
  paint: {
    'line-color': '#93c5fd',
    'line-width': 2.5,
    'line-opacity': 1,
  },
};

/** Tom GeoJSON FeatureCollection brugt som fallback inden data loader */
const EMPTY_GEOJSON: GeoJSONSourceSpecification['data'] = {
  type: 'FeatureCollection',
  features: [],
};

/** Et enkelt BBR-bygningspunkt til kortvisning */
export interface BBRBygningPunkt {
  id: string;
  lng: number;
  lat: number;
  bygningsnr: number | null;
  anvendelse: string;
  opfoerelsesaar: number | null;
  samletAreal: number | null;
  antalEtager: number | null;
  status: string | null;
}

/** Statuskoder der anses som aktive bygninger */
const AKTIV_STATUS = new Set(['1', '2', '3', '6', '7']);

const STYLE_STORAGE_KEY = 'bizzassist-map-style';
const ZOOM_STORAGE_KEY = 'bizzassist-map-zoom';
const DEFAULT_ZOOM = 17;

/** Læs gemt zoom fra localStorage — fallback til DEFAULT_ZOOM */
function læsGemtZoom(): number {
  if (typeof window === 'undefined') return DEFAULT_ZOOM;
  const v = parseFloat(window.localStorage.getItem(ZOOM_STORAGE_KEY) ?? '');
  return isFinite(v) ? v : DEFAULT_ZOOM;
}

interface PropertyMapProps {
  /** Breddegrad for ejendommen */
  lat: number;
  /** Længdegrad for ejendommen */
  lng: number;
  /** Adresse vist i markør-tooltip */
  adresse: string;
  /** Vis matrikelgrænselag — default true */
  visMatrikel?: boolean;
  /**
   * Kaldes med DAWA adgangsadresse-UUID når brugeren klikker på kortet.
   * Forælderkomponenten bruger dette til at navigere til den klikkede ejendom.
   */
  onAdresseValgt?: (id: string) => void;
  /**
   * BBR-bygningspunkter til visning på kortet i BBR-tilstand.
   * Hentes server-side fra Datafordeler WFS.
   */
  bygningPunkter?: BBRBygningPunkt[];
  /**
   * Valgfrit href til "Åbn på fuldt kort"-knap inde i kortet (z-30).
   * Erstatter det tidligere overlejrede Link i forælderkomponenten (z-20),
   * som konkurrerede med lag-knappernes z-index og blokerede klik.
   */
  fullMapHref?: string;
}

/** In-memory cache — gemmer { all, selected } per koordinat */
const matrikelCache: Record<
  string,
  { all: GeoJSONSourceSpecification['data']; selected: GeoJSONSourceSpecification['data'] }
> = {};

/**
 * Ray-casting point-in-polygon test.
 * Returnerer true hvis punktet (px, py) ligger inde i ringen (ring af [lng, lat] par).
 *
 * @param px - Punktets x (længdegrad)
 * @param py - Punktets y (breddegrad)
 * @param ring - Polygon-ring som array af [lng, lat] koordinatpar
 */
function punktIRing(px: number, py: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0],
      yi = ring[i][1];
    const xj = ring[j][0],
      yj = ring[j][1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Finder den GeoJSON-feature (matrikelparcel) der indeholder punktet (lng, lat).
 * Bruger ray-casting mod ydre ring af hver Polygon/MultiPolygon.
 *
 * @param fc - FeatureCollection fra matrikel-API
 * @param lng - Ejendomspunktets længdegrad
 * @param lat - Ejendomspunktets breddegrad
 * @returns FeatureCollection med kun den matchende feature, eller alle hvis ingen match
 */
function filtrerTilEjendom(
  fc: {
    type: string;
    features: {
      type: string;
      geometry: { type: string; coordinates: number[][][] | number[][][][] };
      properties: Record<string, unknown>;
    }[];
  },
  lng: number,
  lat: number
): GeoJSONSourceSpecification['data'] {
  const match = fc.features.find((f) => {
    if (f.geometry.type === 'Polygon') {
      return punktIRing(lng, lat, f.geometry.coordinates[0] as number[][]);
    }
    if (f.geometry.type === 'MultiPolygon') {
      return (f.geometry.coordinates as number[][][][]).some((poly) =>
        punktIRing(lng, lat, poly[0])
      );
    }
    return false;
  });
  // Returnér kun den matchende parcel — eller hele FC som fallback
  return match
    ? ({ type: 'FeatureCollection', features: [match] } as GeoJSONSourceSpecification['data'])
    : (fc as GeoJSONSourceSpecification['data']);
}

/**
 * Henter alle matrikelparceller i et bbox-vindue rundt om punktet.
 * Returnerer { all, selected } — alle parceller + den ene der indeholder punktet.
 *
 * @param lng - Længdegrad
 * @param lat - Breddegrad
 */
async function hentMatrikelGeojson(
  lng: number,
  lat: number
): Promise<{
  all: GeoJSONSourceSpecification['data'];
  selected: GeoJSONSourceSpecification['data'];
} | null> {
  const cacheKey = `${lng.toFixed(5)},${lat.toFixed(5)}`;
  if (cacheKey in matrikelCache) return matrikelCache[cacheKey];

  try {
    const delta = 0.001;
    const url = `/api/matrikel/bbox?w=${lng - delta}&s=${lat - delta}&e=${lng + delta}&n=${lat + delta}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fc: any =
      json?.type === 'FeatureCollection'
        ? json
        : Array.isArray(json)
          ? { type: 'FeatureCollection', features: json }
          : json;
    const all = fc as GeoJSONSourceSpecification['data'];
    const selected = filtrerTilEjendom(fc, lng, lat);
    const result = { all, selected };
    matrikelCache[cacheKey] = result;
    return result;
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
export default function PropertyMap({
  lat,
  lng,
  adresse,
  visMatrikel = true,
  onAdresseValgt,
  bygningPunkter,
  fullMapHref,
}: PropertyMapProps) {
  const mapRef = useRef<MapRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  /**
   * Korttype initialiseres fra localStorage så den bevares på tværs af navigationer.
   * Sikrer at brugeren forbliver i f.eks. BBR-tilstand når de klikker til ny ejendom.
   */
  const [mapStyle, setMapStyleState] = useState<MapStyle>(() => {
    if (typeof window === 'undefined') return 'satellite';
    const saved = window.localStorage.getItem(STYLE_STORAGE_KEY) as MapStyle | null;
    return saved && saved in STYLES ? saved : 'satellite';
  });
  const setMapStyle = (style: MapStyle) => {
    setMapStyleState(style);
    window.localStorage.setItem(STYLE_STORAGE_KEY, style);
  };
  const [fullscreen, setFullscreen] = useState(false);
  /** Den BBR-bygning hvis hover-tooltip vises — null = ingen */
  const [aktivBygning, setAktivBygning] = useState<BBRBygningPunkt | null>(null);
  /**
   * Pixel-position for det aktive bygnings-tooltip.
   * Beregnes via map.project() når en bygning hover-aktiveres, så tooltippet
   * kan renderes i container-laget (z-50) oven over alle Marker-noder.
   */
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
  /**
   * Gemmer brugerens aktuelle zoom-niveau — initialiseres fra localStorage
   * så zoom bevares på tværs af navigationer (komponent remountes ved ny rute).
   * Opdateres via onZoomEnd og persisteres til localStorage samtidig.
   */
  const zoomRef = useRef<number>(læsGemtZoom());
  const [matrikelData, setMatrikelData] =
    useState<GeoJSONSourceSpecification['data']>(EMPTY_GEOJSON);
  /** GeoJSON for kun den valgte ejendoms matrikelparcel — fremhævet stil */
  const [selectedMatrikelData, setSelectedMatrikelData] =
    useState<GeoJSONSourceSpecification['data']>(EMPTY_GEOJSON);
  /** True mens DAWA reverse geocode-kald kører efter korteklik */
  const [søgerAdresse, setSøgerAdresse] = useState(false);
  /** GeoJSON for den matrikel musen svæver over — vises som gult highlight-lag */
  const [hoverData, setHoverData] = useState<GeoJSONSourceSpecification['data']>(EMPTY_GEOJSON);
  /** Debounce-timer ref til hover-kald — forhindrer for mange API-kald */
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';
  const harToken = mapboxToken.startsWith('pk.');

  /** Hent matrikeldata — alle parceller + fremhæv ejendommens egen parcel */
  useEffect(() => {
    if (!visMatrikel) return;
    hentMatrikelGeojson(lng, lat).then((result) => {
      if (result) {
        setMatrikelData(result.all);
        setSelectedMatrikelData(result.selected);
      }
    });
  }, [lng, lat, visMatrikel]);

  /**
   * Flyver til ny ejendom ved lat/lng-ændring med default zoom 17.
   * Resetter zoom ved ejendomsskift så man altid starter tæt på bygningen.
   * Luk også bygnings-tooltip så gammel markør ikke hænger over ny ejendom.
   */
  useEffect(() => {
    setAktivBygning(null);
    zoomRef.current = DEFAULT_ZOOM;
    mapRef.current?.flyTo({ center: [lng, lat], zoom: DEFAULT_ZOOM, duration: 800 });
  }, [lat, lng]);

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

  /**
   * Håndterer klik på kortet.
   * Kalder DAWA reverse geocode for at finde nærmeste adgangsadresse ved
   * de klikkede koordinater, og videregiver UUID til onAdresseValgt-callback.
   *
   * @param e - Mapbox korteklik-event med lngLat koordinater
   */
  const handleKlik = useCallback(
    async (e: MapMouseEvent) => {
      if (!onAdresseValgt || søgerAdresse) return;
      const { lng: x, lat: y } = e.lngLat;
      setSøgerAdresse(true);
      try {
        // Server-side proxy — undgår direkte DAWA-kald (DAWA lukker 1. juli 2026)
        const res = await fetch(`/api/adresse/reverse?lng=${x}&lat=${y}`, {
          signal: AbortSignal.timeout(6000),
        });
        if (!res.ok) return;
        const data: { id?: string | null } = await res.json();
        if (data?.id) onAdresseValgt(data.id);
      } catch {
        /* ignorer netværksfejl */
      } finally {
        setSøgerAdresse(false);
      }
    },
    [onAdresseValgt, søgerAdresse]
  );

  /**
   * Håndterer musebevægelse over kortet.
   * Bruger queryRenderedFeatures mod matrikel-fill laget for at finde den
   * specifikke matrikelparcel under cursoren — matcher kortsidens tilgang.
   * Falder tilbage til bbox-fetch hvis matrikel-fill laget ikke eksisterer endnu.
   */
  const handleMouseMove = useCallback(
    (e: MapMouseEvent) => {
      if (!onAdresseValgt) return;
      const map = mapRef.current?.getMap();
      if (!map) return;

      // Forsøg at finde matrikelparcel under cursoren via allerede-rendererede features
      if (map.getLayer('matrikel-fill')) {
        const features = map.queryRenderedFeatures(e.point, { layers: ['matrikel-fill'] });
        if (features.length > 0) {
          setHoverData({
            type: 'FeatureCollection',
            features: [features[0].toJSON()],
          } as GeoJSONSourceSpecification['data']);
        } else {
          setHoverData(EMPTY_GEOJSON);
        }
        return;
      }

      // Fallback: hent via API (bruges kun hvis matrikel-fill ikke er tilgængeligt)
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      hoverTimer.current = setTimeout(async () => {
        const { lng: x, lat: y } = e.lngLat;
        const result = await hentMatrikelGeojson(x, y);
        setHoverData(result?.selected ?? EMPTY_GEOJSON);
      }, 80);
    },
    [onAdresseValgt]
  );

  /** Ryd hover-highlight når musen forlader kortet */
  const handleMouseLeave = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setHoverData(EMPTY_GEOJSON);
  }, []);

  /**
   * Tilpasser navigation-night-v1 stilen ved hvert stilload.
   * Skjuler route/traffic/congestion overlay-lag (grønne/gule linjer på veje)
   * og sætter vej- og baggrundsfarver til mørk grå/blågrå.
   *
   * VIGTIGT: isStyleLoaded()-checket er bevidst udeladt — ved style.load-event
   * er stilen klar, og checket kan returnere false pga. interne Mapbox _changed-flag.
   * Registreres som permanent style.load-listener i handleMapLoad (ikke useEffect)
   * for at undgå race-condition hvor listener ankommer efter eventet fyrer.
   */
  const anvendStilOverrides = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;

    // Kun tilpas navigation-night-v1 (dark/bbr) — satellite-streets behøver ingen overrides
    const currentStyle = map.getStyle()?.name?.toLowerCase() ?? '';
    if (!currentStyle.includes('navigation') && !currentStyle.includes('night')) return;

    const layers = map.getStyle()?.layers;
    if (!layers) return;
    for (const layer of layers) {
      const id = layer.id.toLowerCase();
      // Skjul route/traffic/congestion-lag (inkl. grønne congestion-linjer)
      if (
        id.startsWith('navigation-route') ||
        id.startsWith('navigation-traffic') ||
        id.includes('congestion') ||
        id.includes('waypoint') ||
        id.includes('origin') ||
        id.includes('destination')
      ) {
        try {
          map.setLayoutProperty(layer.id, 'visibility', 'none');
        } catch {
          /* ignore */
        }
      }
      // Sæt vejfarver til mørk grå
      if (
        id.includes('road') ||
        id.includes('street') ||
        id.includes('motorway') ||
        id.includes('highway')
      ) {
        if (layer.type === 'line')
          try {
            map.setPaintProperty(layer.id, 'line-color', '#6b7280');
          } catch {
            /* ignore */
          }
        if (layer.type === 'fill')
          try {
            map.setPaintProperty(layer.id, 'fill-color', '#6b7280');
          } catch {
            /* ignore */
          }
      }
      // Mørk baggrund
      if ((layer.id === 'background' || layer.id === 'land') && layer.type === 'background')
        try {
          map.setPaintProperty(layer.id, 'background-color', '#28303f');
        } catch {
          /* ignore */
        }
      if (layer.id === 'land' && layer.type === 'fill')
        try {
          map.setPaintProperty(layer.id, 'fill-color', '#28303f');
        } catch {
          /* ignore */
        }
    }
  }, []);

  /**
   * Registrerer style.load-listener PERMANENT ved initial map load.
   * Dette undgår race-condition hvor useEffect-baseret registrering
   * ankommer for sent — Mapbox fyrer style.load under render-cyklussen,
   * men useEffect kører EFTER render.
   */
  const handleMapLoad = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    // Anvend overrides på den allerede indlæste startsstil
    anvendStilOverrides();
    // Lyt permanent — style.load fyrer ved hvert fremtidigt stilskift
    map.on('style.load', anvendStilOverrides);
  }, [anvendStilOverrides]);

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
      {/* Skjul Mapbox-logo og attribution */}
      <style>{`.mapboxgl-ctrl-logo,.mapboxgl-ctrl-attrib{display:none!important}`}</style>
      <Map
        ref={mapRef}
        mapboxAccessToken={mapboxToken}
        initialViewState={{ longitude: lng, latitude: lat, zoom: DEFAULT_ZOOM }}
        style={{ width: '100%', height: '100%' }}
        mapStyle={STYLES[mapStyle]}
        attributionControl={false}
        onLoad={handleMapLoad}
        onClick={onAdresseValgt ? handleKlik : undefined}
        onMouseMove={onAdresseValgt ? handleMouseMove : undefined}
        onMouseLeave={onAdresseValgt ? handleMouseLeave : undefined}
        cursor={onAdresseValgt ? (søgerAdresse ? 'wait' : 'crosshair') : 'grab'}
        onZoomEnd={(e) => {
          zoomRef.current = e.viewState.zoom;
          window.localStorage.setItem(ZOOM_STORAGE_KEY, String(e.viewState.zoom));
        }}
      >
        <NavigationControl position="bottom-right" showCompass={false} />

        {/* Alle matrikelparceller — usynligt fyld-lag til hover/klik-detektion */}
        {visMatrikel && (
          <Source id="matrikel" type="geojson" data={matrikelData}>
            <Layer {...matrikelFillLayer} />
          </Source>
        )}

        {/* Valgt ejendoms matrikelparcel — fremhævet */}
        {visMatrikel && (
          <Source id="selected-matrikel" type="geojson" data={selectedMatrikelData}>
            <Layer {...selectedFillLayer} />
            <Layer {...selectedLineLayer} />
          </Source>
        )}

        {/* Hover-highlight — matrikelgrænse ved museover */}
        {onAdresseValgt && (
          <Source id="hover-matrikel" type="geojson" data={hoverData}>
            <Layer {...hoverFillLayer} />
            <Layer {...hoverLineLayer} />
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

        {/* BBR-bygningsmarkører — kun synlige i BBR-tilstand */}
        {mapStyle === 'bbr' &&
          bygningPunkter?.map((b, bIdx) => {
            const aktiv = AKTIV_STATUS.has(b.status ?? '');
            const erHover = aktivBygning?.id === b.id;
            return (
              <Marker key={`${b.id}-${bIdx}`} longitude={b.lng} latitude={b.lat} anchor="center">
                {/* Kun cirklen i Marker — tooltip løftes til container-lag */}
                <div
                  onMouseEnter={() => {
                    setAktivBygning(b);
                    const px = mapRef.current?.project({ lng: b.lng, lat: b.lat });
                    if (px) setTooltipPos({ x: px.x, y: px.y });
                  }}
                  onMouseLeave={() => {
                    setAktivBygning(null);
                    setTooltipPos(null);
                  }}
                  aria-label={`Byg${b.bygningsnr ?? '?'} — ${b.anvendelse}`}
                  className={`w-5 h-5 rounded-full border-2 shadow-lg cursor-pointer transition-all ${
                    aktiv
                      ? erHover
                        ? 'bg-emerald-400 border-emerald-200 scale-125'
                        : 'bg-emerald-500/90 border-emerald-300 hover:scale-125'
                      : erHover
                        ? 'bg-slate-500 border-slate-300 scale-110'
                        : 'bg-slate-600/80 border-slate-400 hover:scale-110'
                  }`}
                />
              </Marker>
            );
          })}
      </Map>

      {/* Luftfoto / Gade / BBR toggle — BBR yderst til venstre, Luftfoto yderst til højre */}
      {/* z-30 sikrer at knapperne er over alle overlejringer i forælderkomponenten (z-20) */}
      <div className="absolute top-3 left-3 flex gap-1.5 z-30">
        {bygningPunkter && bygningPunkter.length > 0 && (
          <button
            onClick={() => {
              setMapStyle('bbr');
              setAktivBygning(null);
            }}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium shadow-lg transition-all ${
              mapStyle === 'bbr'
                ? 'bg-emerald-600 text-white'
                : 'bg-slate-900/90 text-slate-300 hover:bg-slate-800 border border-slate-700'
            }`}
          >
            <Building2 size={12} />
            BBR
            <span
              className={`ml-0.5 rounded-full px-1 py-0 text-[10px] font-bold ${mapStyle === 'bbr' ? 'bg-emerald-500 text-white' : 'bg-slate-700 text-slate-300'}`}
            >
              {bygningPunkter.length}
            </span>
          </button>
        )}
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

      {/* Øverst til højre: "Fuldt kort"-link (hvis angivet) + fullscreen toggle */}
      {/* z-30 matcher lag-knapperne — ingen konflikt med forælderkomponentens z-indeks */}
      <div className="absolute top-3 right-3 z-30 flex items-center gap-1.5">
        {fullMapHref && (
          <Link
            href={fullMapHref}
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-900/90 hover:bg-slate-800 border border-slate-700 rounded-lg text-slate-300 text-xs font-medium shadow-lg transition-all"
            title="Åbn på fuldt kort"
          >
            <ExternalLink size={12} />
            <span className="hidden sm:inline">Fuldt kort</span>
          </Link>
        )}
        <button
          onClick={() => setFullscreen((f) => !f)}
          className="p-1.5 bg-slate-900/90 hover:bg-slate-800 border border-slate-700 rounded-lg text-slate-300 shadow-lg transition-all"
        >
          {fullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      </div>

      {/* Loading-overlay ved korteklik */}
      {søgerAdresse && (
        <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
          <div className="flex items-center gap-2 bg-slate-900/90 border border-slate-700/60 rounded-xl px-3 py-2 shadow-lg">
            <Loader2 size={13} className="text-blue-400 animate-spin" />
            <span className="text-slate-300 text-xs">Henter ejendom…</span>
          </div>
        </div>
      )}

      {/*
       * BBR hover-tooltip — renderes i container-laget (z-50) så den altid
       * er over alle Marker-noder uanset DOM-rækkefølge.
       * Positioneres via map.project() pixel-koordinater fra onMouseEnter.
       */}
      {aktivBygning &&
        tooltipPos &&
        (() => {
          const aktiv = AKTIV_STATUS.has(aktivBygning.status ?? '');
          return (
            <div
              className="absolute z-50 w-56 bg-slate-900 border border-slate-700/60 rounded-xl shadow-2xl p-3 text-xs pointer-events-none"
              style={{
                left: tooltipPos.x,
                top: tooltipPos.y,
                transform: 'translate(-50%, calc(-100% - 14px))',
              }}
            >
              <p className="text-emerald-400 font-bold text-[11px] mb-0.5">
                Byg{aktivBygning.bygningsnr ?? '?'}
              </p>
              <p className="text-white font-semibold mb-1.5 leading-tight">
                {aktivBygning.anvendelse}
              </p>
              <div className="space-y-0.5 text-slate-300">
                {aktivBygning.opfoerelsesaar && (
                  <p>
                    Opført: <span className="text-white">{aktivBygning.opfoerelsesaar}</span>
                  </p>
                )}
                {aktivBygning.samletAreal && (
                  <p>
                    Areal: <span className="text-white">{aktivBygning.samletAreal} m²</span>
                  </p>
                )}
                {aktivBygning.antalEtager && (
                  <p>
                    Etager: <span className="text-white">{aktivBygning.antalEtager}</span>
                  </p>
                )}
                <p>
                  Status:{' '}
                  <span className={aktiv ? 'text-emerald-400' : 'text-slate-400'}>
                    {aktiv ? 'Aktiv' : 'Nedrevet/andet'}
                  </span>
                </p>
              </div>
              {/* Pil ned mod markøren */}
              <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-slate-700/60" />
            </div>
          );
        })()}
    </div>
  );
}
