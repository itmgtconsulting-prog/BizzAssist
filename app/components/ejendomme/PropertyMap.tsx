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
  Layers,
  X,
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
  /** Ejerforholdskode (byg066) — "50"=andelsboligforening, "60"=almen bolig */
  ejerforholdskode: string | null;
}

/** Statuskoder der anses som aktive bygninger */
const AKTIV_STATUS = new Set(['1', '2', '3', '6', '7']);

const STYLE_STORAGE_KEY = 'bizzassist-map-style';
const ZOOM_STORAGE_KEY = 'bizzassist-map-zoom';
const DEFAULT_ZOOM = 17;

// ─── Overlay-lag ──────────────────────────────────────────────────────────────

/** Nøgler for PropertyMap's toggle-bare overlay-lag */
type OverlayNøgle = 'matrikel' | 'lokalplaner' | 'zonekort' | 'kommuneplan' | 'jordforurening';

/**
 * Bygger en WMS tile-URL via server-side proxy (/api/wms).
 * Proxyen henter tiles server-side og videresender dem til browseren,
 * hvilket løser CORS-problemer med de danske offentlige WMS-servere.
 *
 * @param service - 'plandata' eller 'miljo' (whitelistet i /api/wms)
 * @param layers  - Kommasepareret WMS LAYERS-parameter
 */
function buildWmsUrl(service: 'plandata' | 'miljo', layers: string): string {
  return (
    `/api/wms?service=${service}` +
    `&SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap` +
    `&LAYERS=${encodeURIComponent(layers)}` +
    `&STYLES=&FORMAT=image%2Fpng&TRANSPARENT=true` +
    `&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}&SRS=EPSG:3857`
  );
}

/** WMS overlay-lag tilgængelige i PropertyMap's lag-panel */
const OVERLAY_WMS = [
  {
    id: 'lokalplaner' as OverlayNøgle,
    navn: 'Lokalplaner',
    url: buildWmsUrl('plandata', 'pdk:theme_pdk_lokalplan_vedtaget'),
    opacity: 0.8,
    farveClass: 'bg-violet-600 border-violet-600',
  },
  {
    id: 'zonekort' as OverlayNøgle,
    navn: 'Zonekort',
    url: buildWmsUrl('plandata', 'pdk:theme_pdk_zonekort_samlet_v'),
    opacity: 0.7,
    farveClass: 'bg-amber-600 border-amber-600',
  },
  {
    id: 'kommuneplan' as OverlayNøgle,
    navn: 'Kommuneplan',
    url: buildWmsUrl('plandata', 'pdk:theme_pdk_kommuneplanramme_vedtaget_v'),
    opacity: 0.8,
    farveClass: 'bg-emerald-600 border-emerald-600',
  },
  {
    id: 'jordforurening' as OverlayNøgle,
    navn: 'Jordforurening',
    url: buildWmsUrl('miljo', 'dai:Jordforurening'),
    opacity: 0.7,
    farveClass: 'bg-rose-600 border-rose-600',
  },
] as const;

/** Standard synlighedstilstand — matrikel til, WMS fra */
const OVERLAY_START: Record<OverlayNøgle, boolean> = {
  matrikel: true,
  lokalplaner: false,
  zonekort: false,
  kommuneplan: false,
  jordforurening: false,
};

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
  /**
   * True hvis ejendommen er en ejerlejlighed (ejerlejlighedBfe !== null).
   * Bruges til at vise "EL"-badge på bygningsmarkørerne i BBR-tilstand.
   */
  erEjerlejlighed?: boolean;
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
  erEjerlejlighed,
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

  /**
   * Styrer om EL/AB ejendomstype-badges vises på bygningsmarkørerne.
   * Initialiseres til true — vises som standard, brugeren kan deaktivere via lag-panelet.
   * Vises i ALLE tre kortstile (BBR, gade, satellit).
   */
  const [visEjendomsBadges, setVisEjendomsBadges] = useState(true);

  /**
   * Styrer om husnumre vises på kortet.
   * Ref bruges til at sætte initial synlighed i aktiverHusnumre uden stale closure.
   */
  const visHusnumreRef = useRef(true);
  const [visHusnumre, setVisHusnumreState] = useState(true);
  /** Opdaterer visHusnumre state + ref atomisk */
  const setVisHusnumre = (v: boolean) => {
    setVisHusnumreState(v);
    visHusnumreRef.current = v;
  };

  /** Åben/lukket tilstand for lag-panelet */
  const [lagPanel, setLagPanel] = useState(false);
  /**
   * Synlighedstilstand for overlay-lag (matrikel + WMS).
   * Initialiseres med matrikel-prop'en — brugeren kan togge via lag-panelet.
   */
  const [visOverlay, setVisOverlay] = useState<Record<OverlayNøgle, boolean>>({
    ...OVERLAY_START,
    matrikel: visMatrikel,
  });
  /** Ref til visOverlay — undgår stale closure i style.load-handler */
  const visOverlayRef = useRef<Record<OverlayNøgle, boolean>>({
    ...OVERLAY_START,
    matrikel: visMatrikel,
  });
  /** Ref til lag-panel-containeren — bruges til klik-udenfor detektion */
  const lagPanelRef = useRef<HTMLDivElement>(null);

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
   * Opsætter WMS raster-lag imperativt via Mapbox GL API.
   * Idempotent — skippes hvis source/layer allerede eksisterer.
   * Læser initial synlighed fra visOverlayRef (undgår stale closure ved style.load).
   */
  const opsætWmsLag = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    for (const wms of OVERLAY_WMS) {
      const srcId = `prop-wms-${wms.id}`;
      const lyrId = `prop-wms-${wms.id}-raster`;
      if (!map.getSource(srcId))
        map.addSource(srcId, { type: 'raster', tiles: [wms.url], tileSize: 256 });
      if (!map.getLayer(lyrId)) {
        // Indsæt WMS raster-lag UNDER housenum-label så husnumre altid vises øverst.
        // På navigation-night-v1 (dark/bbr) eksisterer housenum-label i stilen —
        // addLayer med beforeId placerer det nye lag under dette symbol-lag.
        // På satellite-streets-v12 eksisterer housenum-label ikke, så beforeId er undefined
        // og laget tilføjes øverst (housenum-overlay tilføjes derefter via aktiverHusnumre).
        const beforeId = map.getLayer('housenum-label') ? 'housenum-label' : undefined;
        map.addLayer(
          {
            id: lyrId,
            type: 'raster',
            source: srcId,
            layout: { visibility: visOverlayRef.current[wms.id] ? 'visible' : 'none' },
            paint: { 'raster-opacity': wms.opacity },
          },
          beforeId
        );
      }
    }
  }, []);

  /**
   * Synkroniserer WMS lag-synlighed fra visOverlayRef til Mapbox.
   * Kaldes fra useEffect når visOverlay state ændres.
   */
  const synkWmsLagSynlighed = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    const v = visOverlayRef.current;
    const vis = (on: boolean): 'visible' | 'none' => (on ? 'visible' : 'none');
    for (const wms of OVERLAY_WMS) {
      const lyrId = `prop-wms-${wms.id}-raster`;
      if (map.getLayer(lyrId)) map.setLayoutProperty(lyrId, 'visibility', vis(v[wms.id]));
    }
  }, []);

  /** Synkroniserer visOverlayRef med visOverlay state — bruges i style.load-handler */
  useEffect(() => {
    visOverlayRef.current = visOverlay;
  }, [visOverlay]);

  /** Synkroniserer WMS lag-synlighed til Mapbox ved state-ændring */
  useEffect(() => {
    synkWmsLagSynlighed();
  }, [visOverlay, synkWmsLagSynlighed]);

  /** Lukker lag-panelet ved klik udenfor */
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (lagPanel && lagPanelRef.current && !lagPanelRef.current.contains(e.target as Node))
        setLagPanel(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [lagPanel]);

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
   * Opsætter også WMS overlay-lag og re-registrerer dem ved stil-skift.
   */
  /**
   * Aktiverer husnumre på kortet.
   *
   * Navigation-night-v1 (dark/bbr) har et built-in 'housenum-label' lag der blot
   * skal gøres synligt. Satellite-streets-v12 mangler dette lag, så vi tilføjer
   * en manuel streets-v8 vector source og et symbol-lag med hvide husnumre med
   * sort halo — synligt oven på luftfoto ved zoom ≥ 17.
   *
   * Kaldes både ved initial load og ved hvert stilskift.
   */
  const aktiverHusnumre = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    const vis = visHusnumreRef.current ? 'visible' : 'none';

    if (map.getLayer('housenum-label')) {
      // Built-in lag i navigation-night-v1 — anvend synlighedstilstand fra ref
      try {
        map.setLayoutProperty('housenum-label', 'visibility', vis);
        map.setFilter('housenum-label', ['>=', ['zoom'], 17]);
      } catch {
        /* ignorer */
      }
      return;
    }

    // Satellite-stilen har ikke housenum-label — tilføj streets-v8 overlay
    const SRC = 'streets-v8-housenum';
    const LYR = 'housenum-overlay';
    if (!map.getSource(SRC)) {
      map.addSource(SRC, {
        type: 'vector',
        url: 'mapbox://mapbox.mapbox-streets-v8',
      });
    }
    if (!map.getLayer(LYR)) {
      map.addLayer({
        id: LYR,
        type: 'symbol',
        source: SRC,
        'source-layer': 'housenum_label',
        minzoom: 17,
        layout: {
          'text-field': ['get', 'house_num'],
          'text-size': 12,
          visibility: vis,
          'text-allow-overlap': false,
          'text-ignore-placement': false,
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#000000',
          'text-halo-width': 1.5,
        },
      });
    } else {
      // Lag eksisterer allerede — synkronisér synlighed
      try {
        map.setLayoutProperty(LYR, 'visibility', vis);
      } catch {
        /* ignorer */
      }
    }
  }, []);

  const handleMapLoad = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    // Anvend overrides og opsæt lag på den allerede indlæste startsstil
    anvendStilOverrides();
    opsætWmsLag();
    aktiverHusnumre();
    // Lyt permanent — style.load fyrer ved hvert fremtidigt stilskift
    map.on('style.load', () => {
      anvendStilOverrides();
      opsætWmsLag();
      aktiverHusnumre();
    });
  }, [anvendStilOverrides, opsætWmsLag, aktiverHusnumre]);

  /**
   * Synkroniserer husnumre-synlighed til Mapbox ved toggle.
   * Håndterer begge lag: built-in housenum-label (dark/bbr) og custom housenum-overlay (satellite).
   */
  const sætHusnumreSynlighed = useCallback((on: boolean) => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    const vis = on ? 'visible' : 'none';
    if (map.getLayer('housenum-label'))
      try {
        map.setLayoutProperty('housenum-label', 'visibility', vis);
      } catch {
        /* ignorer */
      }
    if (map.getLayer('housenum-overlay'))
      try {
        map.setLayoutProperty('housenum-overlay', 'visibility', vis);
      } catch {
        /* ignorer */
      }
  }, []);

  /** Synkroniserer husnumre-synlighed til Mapbox ved state-ændring */
  useEffect(() => {
    sætHusnumreSynlighed(visHusnumre);
  }, [visHusnumre, sætHusnumreSynlighed]);

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
        {visOverlay.matrikel && (
          <Source id="matrikel" type="geojson" data={matrikelData}>
            <Layer {...matrikelFillLayer} />
          </Source>
        )}

        {/* Valgt ejendoms matrikelparcel — fremhævet */}
        {visOverlay.matrikel && (
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

        {/* BBR-bygningsmarkører — cirkler kun i BBR-tilstand, badges i ALLE tre kortstile */}
        {bygningPunkter?.map((b, bIdx) => {
          const aktiv = AKTIV_STATUS.has(b.status ?? '');
          const erHover = aktivBygning?.id === b.id;
          const visCirkel = mapStyle === 'bbr';
          const badgeEL = visEjendomsBadges && erEjerlejlighed;
          const badgeAB = visEjendomsBadges && !erEjerlejlighed && b.ejerforholdskode === '50';
          const badgeAL = visEjendomsBadges && !erEjerlejlighed && b.ejerforholdskode === '60';
          // I ikke-BBR tilstand: marker kun vises hvis der er et aktivt badge
          if (!visCirkel && !badgeEL && !badgeAB && !badgeAL) return null;
          return (
            <Marker key={`${b.id}-${bIdx}`} longitude={b.lng} latitude={b.lat} anchor="center">
              {/* Wrapper til at positionere badge relativt til cirklen */}
              <div className="relative">
                {/* Bygningscirkel — kun i BBR-tilstand */}
                {visCirkel && (
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
                )}
                {/* EL/AB/AL ejendomstype-badge — vises i alle tre kortstile når togget er aktivt */}
                {badgeEL && (
                  <span
                    className={`${visCirkel ? 'absolute -top-2 -right-2.5' : ''} bg-blue-600 text-white text-[7px] font-bold px-1 py-px rounded-full shadow-sm border border-blue-300 leading-none pointer-events-none select-none`}
                  >
                    EL
                  </span>
                )}
                {badgeAB && (
                  <span
                    className={`${visCirkel ? 'absolute -top-2 -right-2.5' : ''} bg-emerald-600 text-white text-[7px] font-bold px-1 py-px rounded-full shadow-sm border border-emerald-300 leading-none pointer-events-none select-none`}
                  >
                    AB
                  </span>
                )}
                {badgeAL && (
                  <span
                    className={`${visCirkel ? 'absolute -top-2 -right-2.5' : ''} bg-indigo-600 text-white text-[7px] font-bold px-1 py-px rounded-full shadow-sm border border-indigo-300 leading-none pointer-events-none select-none`}
                  >
                    AL
                  </span>
                )}
              </div>
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

      {/* Øverst til højre: Lag-knap + "Fuldt kort"-link (hvis angivet) + fullscreen toggle */}
      {/* z-30 matcher lag-knapperne — ingen konflikt med forælderkomponentens z-indeks */}
      <div ref={lagPanelRef} className="absolute top-3 right-3 z-30 flex items-center gap-1.5">
        {/* Lag-knap */}
        <button
          onClick={() => setLagPanel((p) => !p)}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium shadow-lg transition-all ${
            lagPanel || Object.entries(visOverlay).some(([k, v]) => k !== 'matrikel' && v)
              ? 'bg-blue-600 text-white'
              : 'bg-slate-900/90 text-slate-300 hover:bg-slate-800 border border-slate-700'
          }`}
          title="Kortlag"
        >
          <Layers size={12} />
          Lag
        </button>

        {/* Lag-panel dropdown */}
        {lagPanel && (
          <div className="absolute top-9 right-0 w-52 max-w-[calc(100vw-1.5rem)] bg-slate-900/98 border border-white/10 rounded-xl shadow-2xl backdrop-blur-sm overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
              <span className="text-white text-xs font-semibold">Kortlag</span>
              <button
                onClick={() => setLagPanel(false)}
                className="text-slate-500 hover:text-slate-300 transition-colors p-0.5 rounded hover:bg-white/5"
              >
                <X size={12} />
              </button>
            </div>
            <div className="px-2 py-1.5 max-h-[60vh] overflow-y-auto touch-pan-y overscroll-contain">
              {/* BBR Bygninger */}
              <p className="text-[9px] font-bold uppercase tracking-widest px-1 pt-1.5 pb-1 text-emerald-400">
                Bygninger
              </p>
              <button
                onClick={() => {
                  if (mapStyle === 'bbr') {
                    setMapStyle('satellite');
                    setAktivBygning(null);
                  } else {
                    setMapStyle('bbr');
                    setAktivBygning(null);
                  }
                }}
                disabled={!bygningPunkter || bygningPunkter.length === 0}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg mb-px transition-colors text-left ${
                  mapStyle === 'bbr' ? 'bg-white/5' : 'hover:bg-white/[0.03]'
                } disabled:opacity-40 disabled:cursor-not-allowed`}
              >
                <div
                  className={`w-3.5 h-3.5 rounded-sm flex items-center justify-center shrink-0 border transition-colors ${
                    mapStyle === 'bbr' ? 'bg-emerald-600 border-emerald-600' : 'border-white/20'
                  }`}
                >
                  {mapStyle === 'bbr' && (
                    <svg width="8" height="6" viewBox="0 0 10 8" fill="none">
                      <path
                        d="M1 4L3.5 6.5L9 1"
                        stroke="white"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </div>
                <p
                  className={`text-xs leading-tight truncate ${mapStyle === 'bbr' ? 'text-white' : 'text-slate-400'}`}
                >
                  BBR Bygninger
                  {(!bygningPunkter || bygningPunkter.length === 0) && (
                    <span className="ml-1 text-[10px] text-slate-600">— ingen data</span>
                  )}
                </p>
                {bygningPunkter && bygningPunkter.length > 0 && (
                  <span className="ml-auto text-[10px] bg-slate-700 text-slate-300 rounded-full px-1.5 py-0.5 font-bold shrink-0">
                    {bygningPunkter.length}
                  </span>
                )}
              </button>

              {/* Ejendomstype-badges — EL / AB / AL */}
              <button
                onClick={() => setVisEjendomsBadges((p) => !p)}
                disabled={(!bygningPunkter || bygningPunkter.length === 0) && !erEjerlejlighed}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg mb-px transition-colors text-left ${
                  visEjendomsBadges ? 'bg-white/5' : 'hover:bg-white/[0.03]'
                } disabled:opacity-40 disabled:cursor-not-allowed`}
              >
                <div
                  className={`w-3.5 h-3.5 rounded-sm flex items-center justify-center shrink-0 border transition-colors ${
                    visEjendomsBadges ? 'bg-blue-600 border-blue-600' : 'border-white/20'
                  }`}
                >
                  {visEjendomsBadges && (
                    <svg width="8" height="6" viewBox="0 0 10 8" fill="none">
                      <path
                        d="M1 4L3.5 6.5L9 1"
                        stroke="white"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </div>
                <p
                  className={`text-xs leading-tight truncate ${visEjendomsBadges ? 'text-white' : 'text-slate-400'}`}
                >
                  Ejerlejlighed/Andel
                </p>
                {/* Forhåndsvisning af badges der vil blive vist */}
                <div className="ml-auto flex gap-0.5 shrink-0">
                  {erEjerlejlighed && (
                    <span className="text-[8px] bg-blue-600/30 text-blue-400 border border-blue-500/30 rounded px-1 font-bold leading-none py-0.5">
                      EL
                    </span>
                  )}
                  {!erEjerlejlighed && bygningPunkter?.some((b) => b.ejerforholdskode === '50') && (
                    <span className="text-[8px] bg-emerald-600/30 text-emerald-400 border border-emerald-500/30 rounded px-1 font-bold leading-none py-0.5">
                      AB
                    </span>
                  )}
                  {bygningPunkter?.some((b) => b.ejerforholdskode === '60') && (
                    <span className="text-[8px] bg-indigo-600/30 text-indigo-400 border border-indigo-500/30 rounded px-1 font-bold leading-none py-0.5">
                      AL
                    </span>
                  )}
                </div>
              </button>

              {/* Basiskort-lag */}
              <p className="text-[9px] font-bold uppercase tracking-widest px-1 pt-2 pb-1 text-blue-400">
                Basiskort
              </p>
              {/* Husnumre toggle — vises i alle tre kortstile */}
              <button
                onClick={() => setVisHusnumre(!visHusnumre)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg mb-px transition-colors text-left ${
                  visHusnumre ? 'bg-white/5' : 'hover:bg-white/[0.03]'
                }`}
              >
                <div
                  className={`w-3.5 h-3.5 rounded-sm flex items-center justify-center shrink-0 border transition-colors ${
                    visHusnumre ? 'bg-blue-600 border-blue-600' : 'border-white/20'
                  }`}
                >
                  {visHusnumre && (
                    <svg width="8" height="6" viewBox="0 0 10 8" fill="none">
                      <path
                        d="M1 4L3.5 6.5L9 1"
                        stroke="white"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </div>
                <p
                  className={`text-xs leading-tight truncate ${visHusnumre ? 'text-white' : 'text-slate-400'}`}
                >
                  Husnumre
                </p>
              </button>
              {visMatrikel && (
                <button
                  onClick={() => setVisOverlay((prev) => ({ ...prev, matrikel: !prev.matrikel }))}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg mb-px transition-colors text-left ${
                    visOverlay.matrikel ? 'bg-white/5' : 'hover:bg-white/[0.03]'
                  }`}
                >
                  <div
                    className={`w-3.5 h-3.5 rounded-sm flex items-center justify-center shrink-0 border transition-colors ${
                      visOverlay.matrikel ? 'bg-blue-600 border-blue-600' : 'border-white/20'
                    }`}
                  >
                    {visOverlay.matrikel && (
                      <svg width="8" height="6" viewBox="0 0 10 8" fill="none">
                        <path
                          d="M1 4L3.5 6.5L9 1"
                          stroke="white"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </div>
                  <p
                    className={`text-xs leading-tight truncate ${visOverlay.matrikel ? 'text-white' : 'text-slate-400'}`}
                  >
                    Matrikel
                  </p>
                </button>
              )}

              {/* WMS overlay-lag */}
              <p className="text-[9px] font-bold uppercase tracking-widest px-1 pt-2 pb-1 text-violet-400">
                Plandata
              </p>
              {OVERLAY_WMS.filter((w) =>
                ['lokalplaner', 'zonekort', 'kommuneplan'].includes(w.id)
              ).map((wms) => (
                <button
                  key={wms.id}
                  onClick={() => setVisOverlay((prev) => ({ ...prev, [wms.id]: !prev[wms.id] }))}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg mb-px transition-colors text-left ${
                    visOverlay[wms.id] ? 'bg-white/5' : 'hover:bg-white/[0.03]'
                  }`}
                >
                  <div
                    className={`w-3.5 h-3.5 rounded-sm flex items-center justify-center shrink-0 border transition-colors ${
                      visOverlay[wms.id] ? wms.farveClass : 'border-white/20'
                    }`}
                  >
                    {visOverlay[wms.id] && (
                      <svg width="8" height="6" viewBox="0 0 10 8" fill="none">
                        <path
                          d="M1 4L3.5 6.5L9 1"
                          stroke="white"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </div>
                  <p
                    className={`text-xs leading-tight truncate ${visOverlay[wms.id] ? 'text-white' : 'text-slate-400'}`}
                  >
                    {wms.navn}
                  </p>
                </button>
              ))}

              <p className="text-[9px] font-bold uppercase tracking-widest px-1 pt-2 pb-1 text-rose-400">
                Miljø
              </p>
              {OVERLAY_WMS.filter((w) => w.id === 'jordforurening').map((wms) => (
                <button
                  key={wms.id}
                  onClick={() => setVisOverlay((prev) => ({ ...prev, [wms.id]: !prev[wms.id] }))}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg mb-px transition-colors text-left ${
                    visOverlay[wms.id] ? 'bg-white/5' : 'hover:bg-white/[0.03]'
                  }`}
                >
                  <div
                    className={`w-3.5 h-3.5 rounded-sm flex items-center justify-center shrink-0 border transition-colors ${
                      visOverlay[wms.id] ? wms.farveClass : 'border-white/20'
                    }`}
                  >
                    {visOverlay[wms.id] && (
                      <svg width="8" height="6" viewBox="0 0 10 8" fill="none">
                        <path
                          d="M1 4L3.5 6.5L9 1"
                          stroke="white"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </div>
                  <p
                    className={`text-xs leading-tight truncate ${visOverlay[wms.id] ? 'text-white' : 'text-slate-400'}`}
                  >
                    {wms.navn}
                  </p>
                </button>
              ))}
            </div>
          </div>
        )}

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
