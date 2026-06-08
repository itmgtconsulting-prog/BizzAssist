/**
 * KommuneKort — Interaktivt Mapbox-kort med 98 klikbare kommuner.
 *
 * BIZZ-2033: Farvekodning pr. m²-pris (grøn→gul→rød).
 * Klik toggle kommune til/fra. Tooltip med navn+pris+antal.
 * Lazy-loaded via next/dynamic med ssr: false.
 *
 * @module app/dashboard/analyse/boligpris/KommuneKort
 */

'use client';

import { useEffect, useRef, useMemo, useState } from 'react';
import mapboxgl from 'mapbox-gl';

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';

/** Kommune-data fra API. */
interface KommuneData {
  kommune_kode: number;
  antal_handler: number;
  avg_pris: number;
  avg_m2_pris: number;
}

/** Kommunenavn-lookup. */
const KOMMUNE_NAVNE: Record<string, string> = {};

interface Props {
  /** Kommune-breakdown fra /api/analyse/boligpris */
  kommuneBreakdown: KommuneData[];
  /** Aktuelt valgte kommuner (toggle) */
  selectedKommuner: Set<number>;
  /** Callback når kommune klikkes */
  onToggleKommune: (kode: number) => void;
}

/** Interpoler farve baseret på m²-pris (grøn=lav → gul → rød=høj). */
function priceColor(m2Pris: number, minP: number, maxP: number): string {
  if (maxP <= minP) return '#22c55e';
  const t = Math.min(1, Math.max(0, (m2Pris - minP) / (maxP - minP)));
  // Grøn (0) → Gul (0.5) → Rød (1)
  const r = t < 0.5 ? Math.round(255 * (t * 2)) : 255;
  const g = t < 0.5 ? 255 : Math.round(255 * (1 - (t - 0.5) * 2));
  return `rgb(${r},${g},60)`;
}

/** Formatér tal til dansk format. */
function fmtDkk(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)} mio.`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}t`;
  return v.toLocaleString('da-DK');
}

/**
 * KommuneKort — Mapbox GL choropleth kort med kommunedata.
 */
export default function KommuneKort({
  kommuneBreakdown,
  selectedKommuner,
  onToggleKommune,
}: Props): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Beregn min/max m²-pris for farveskala
  const m2Prices = kommuneBreakdown.filter((k) => k.avg_m2_pris > 0).map((k) => k.avg_m2_pris);
  const minP = Math.min(...m2Prices, 0);
  const maxP = Math.max(...m2Prices, 1);

  // Byg lookup: kommune_kode → data (memoiseret)
  const dataMap = useMemo(() => {
    const m = new Map<number, KommuneData>();
    for (const k of kommuneBreakdown) m.set(k.kommune_kode, k);
    return m;
  }, [kommuneBreakdown]);

  /** Initialiser Mapbox */
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: [10.5, 56.0],
      zoom: 6.2,
      minZoom: 5,
      maxZoom: 10,
      attributionControl: false,
    });

    map.on('load', async () => {
      // Hent GeoJSON
      try {
        const res = await fetch('/geo/kommuner.geojson');
        const geojson = await res.json();

        // Gem kommunenavne
        for (const f of geojson.features) {
          KOMMUNE_NAVNE[f.properties.kode] = f.properties.navn;
        }

        map.addSource('kommuner', { type: 'geojson', data: geojson });

        // Fill layer — farvekodning
        map.addLayer({
          id: 'kommune-fill',
          type: 'fill',
          source: 'kommuner',
          paint: {
            'fill-color': [
              'case',
              // Default transparent for kommuner uden data
              ['==', ['get', 'kode'], ''],
              'rgba(100,116,139,0.1)',
              'rgba(100,116,139,0.15)',
            ],
            'fill-opacity': 0.7,
          },
        });

        // Outline layer
        map.addLayer({
          id: 'kommune-outline',
          type: 'line',
          source: 'kommuner',
          paint: {
            'line-color': 'rgba(148,163,184,0.3)',
            'line-width': 0.5,
          },
        });

        setLoaded(true);
      } catch (err) {
        console.error('[KommuneKort] GeoJSON load fejl:', err);
      }
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  /** Opdater farver når data ændres */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;

    // Byg match-expression for fill-color baseret på kommune_kode → farve
    const matchExpr: (string | string[])[] = ['match', ['get', 'kode']];
    for (const k of kommuneBreakdown) {
      if (k.avg_m2_pris > 0) {
        const kodeStr = String(k.kommune_kode).padStart(4, '0');
        (matchExpr as unknown[]).push(kodeStr, priceColor(k.avg_m2_pris, minP, maxP));
      }
    }
    (matchExpr as unknown[]).push('rgba(100,116,139,0.15)'); // default

    try {
      map.setPaintProperty('kommune-fill', 'fill-color', matchExpr as mapboxgl.Expression);
    } catch {
      // Layer not ready yet
    }
  }, [kommuneBreakdown, loaded, minP, maxP]);

  /** Opdater outline for selected kommuner */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;

    const selectedKodes = Array.from(selectedKommuner).map((k) => String(k).padStart(4, '0'));

    try {
      if (selectedKodes.length > 0) {
        map.setPaintProperty('kommune-outline', 'line-color', [
          'case',
          ['in', ['get', 'kode'], ['literal', selectedKodes]],
          '#3b82f6',
          'rgba(148,163,184,0.3)',
        ] as mapboxgl.Expression);
        map.setPaintProperty('kommune-outline', 'line-width', [
          'case',
          ['in', ['get', 'kode'], ['literal', selectedKodes]],
          2.5,
          0.5,
        ] as mapboxgl.Expression);
      } else {
        map.setPaintProperty('kommune-outline', 'line-color', 'rgba(148,163,184,0.3)');
        map.setPaintProperty('kommune-outline', 'line-width', 0.5);
      }
    } catch {
      // Layer not ready
    }
  }, [selectedKommuner, loaded]);

  /** Klik-handler */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;

    const handleClick = (e: mapboxgl.MapMouseEvent) => {
      const features = map.queryRenderedFeatures(e.point, { layers: ['kommune-fill'] });
      if (features.length > 0) {
        const kode = Number(features[0].properties?.kode);
        if (kode > 0) onToggleKommune(kode);
      }
    };

    map.on('click', 'kommune-fill', handleClick);
    map.on('mouseenter', 'kommune-fill', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'kommune-fill', () => {
      map.getCanvas().style.cursor = '';
    });

    return () => {
      map.off('click', 'kommune-fill', handleClick);
    };
  }, [loaded, onToggleKommune]);

  /** Tooltip */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;

    const popup = new mapboxgl.Popup({
      closeButton: false,
      closeOnClick: false,
      className: 'kommune-tooltip',
    });

    const handleMove = (e: mapboxgl.MapMouseEvent) => {
      const features = map.queryRenderedFeatures(e.point, { layers: ['kommune-fill'] });
      if (features.length > 0) {
        const props = features[0].properties;
        const kode = Number(props?.kode);
        const navn =
          props?.navn ?? KOMMUNE_NAVNE[String(kode).padStart(4, '0')] ?? `Kommune ${kode}`;
        const d = dataMap.get(kode);
        const html = d
          ? `<strong>${navn}</strong><br/>m²-pris: ${d.avg_m2_pris.toLocaleString('da-DK')} kr<br/>Handler: ${d.antal_handler.toLocaleString('da-DK')}<br/>Gns. pris: ${fmtDkk(d.avg_pris)} kr`
          : `<strong>${navn}</strong><br/>Ingen data`;
        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
      } else {
        popup.remove();
      }
    };

    map.on('mousemove', 'kommune-fill', handleMove);
    map.on('mouseleave', 'kommune-fill', () => popup.remove());

    return () => {
      popup.remove();
    };
  }, [loaded, dataMap]);

  return (
    <div className="w-full h-full overflow-hidden" style={{ minHeight: 400 }}>
      <div ref={containerRef} className="w-full h-full" />
      {/* Farveskala legend */}
      <div className="absolute bottom-3 left-3 bg-slate-900/80 backdrop-blur-sm rounded-lg px-3 py-2 text-xs text-slate-300">
        <div className="flex items-center gap-2 mb-1">
          <span>m²-pris</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded-sm" style={{ background: '#22c55e' }} />
          <span>{minP > 0 ? `${Math.round(minP / 1000)}k` : '0'}</span>
          <div
            className="w-12 h-2 rounded-sm"
            style={{
              background: 'linear-gradient(to right, #22c55e, #eab308, #ef4444)',
            }}
          />
          <div className="w-3 h-3 rounded-sm" style={{ background: '#ef4444' }} />
          <span>{maxP > 0 ? `${Math.round(maxP / 1000)}k` : '–'}</span>
        </div>
      </div>
    </div>
  );
}
