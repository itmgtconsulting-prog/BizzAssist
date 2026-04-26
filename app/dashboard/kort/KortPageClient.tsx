'use client';

/**
 * Fuld-side interaktivt kort — /dashboard/kort
 *
 * Viser et Mapbox-baseret kortvisning der fylder hele indholdssektionen.
 *
 * Funktioner:
 *   - Adressesøgning med DAWA autocomplete
 *   - Gadekort (navigation-night-v1) og Luftfoto (satellite-streets-v12)
 *   - Matrikel-lag fra DAWA — vises ved zoom ≥ 13
 *   - Husnummer-lag fra DAWA — vises ved zoom ≥ 15
 *   - Hover-highlight på matrikler
 *   - Klik på matrikel → popup med ejerlav, grundareal, zone + "Åbn ejendom"
 *   - Zoom-badge i realtid
 *
 * Arkitektur: GeoJSON-sources og -layers tilføjes direkte via Mapbox GL JS API
 * (imperativt) fremfor via react-map-gl <Source>/<Layer> — dette undgår
 * lifecycle-problemer ved stil-ændringer og style.load timing.
 */

import { useState, useCallback, useRef, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Map, {
  Marker,
  NavigationControl,
  GeolocateControl,
  type MapRef,
  type MapMouseEvent,
} from 'react-map-gl/mapbox';
import type { GeoJSONSource } from 'mapbox-gl';
import {
  Search,
  Satellite,
  Map as MapIcon,
  MapPin,
  ArrowRight,
  Loader2,
  X,
  Navigation,
  Layers,
  Building2,
} from 'lucide-react';

import { useRouter } from 'next/navigation';
import { type DawaAutocompleteResult, type DawaAdresse } from '@/app/lib/dawa';
import { useLanguage } from '@/app/context/LanguageContext';
import { type VirksomhedMarkør, type CVRBboxResponse } from '@/app/api/cvr/bbox/route';
import { logger } from '@/app/lib/logger';

// ─── Konstanter ───────────────────────────────────────────────────────────────

const STYLES = {
  dark: 'mapbox://styles/mapbox/navigation-night-v1',
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
} as const;
type KortStyle = keyof typeof STYLES;

const DEFAULT_CENTER = { lng: 11.5, lat: 56.2 };
const DEFAULT_ZOOM = 6.5;
const MIN_ZOOM_MATRIKEL = 15;
const MIN_ZOOM_HUSNR = 15;

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

// ─── Typer ────────────────────────────────────────────────────────────────────

/** Kortets viewport-tilstand — opdateres på onMoveEnd og bruges til at trigge data-fetch */
interface ViewportState {
  zoom: number;
  w: number;
  s: number;
  e: number;
  n: number;
}

interface MatrikelPopup {
  x: number;
  y: number;
  titel: string;
  matrikelnr: string;
  grundareal: number | null;
  zone: string | null;
  adresse: string | null;
  dawaId: string | null;
}

// ─── API-hjælpere ─────────────────────────────────────────────────────────────

// TODO(BIZZ-92): Migrate fetchMatrikelBbox to DAR when DAR supports spatial polygon queries (before July 2026)
/**
 * Henter matrikel polygoner fra DAWA for en bounding box via polygon-parameter.
 * VIGTIGT: DAWA's bbox-parameter kræver UTM32-koordinater som standard — bboxsrid=4326
 * ignoreres. I stedet bruges polygon=[[[w,s],[e,s],[e,n],[w,n],[w,s]]] som accepterer
 * WGS84-koordinater direkte og filtrerer korrekt.
 * srid=4326 → output i WGS84.
 *
 * @param w - Vest-koordinat (lng, WGS84)
 * @param s - Syd-koordinat (lat, WGS84)
 * @param e - Øst-koordinat (lng, WGS84)
 * @param n - Nord-koordinat (lat, WGS84)
 * @returns GeoJSON FeatureCollection med matrikel polygoner
 */
async function fetchMatrikelBbox(
  w: number,
  s: number,
  e: number,
  n: number,
  abortSignal?: AbortSignal
): Promise<GeoJSON.FeatureCollection> {
  try {
    // polygon-parameteren accepterer WGS84 direkte — bbox+bboxsrid=4326 virker ikke
    // Server-side proxy — undgår direkte DAWA-kald (DAWA lukker 1. juli 2026)
    const url = `/api/matrikel/bbox?w=${w}&s=${s}&e=${e}&n=${n}`;
    logger.log('[matrikel] henter:', url);
    // Kombiner ekstern AbortSignal med timeout — den der affyres først vinder
    const timeoutSignal = AbortSignal.timeout(25000);
    const signal = abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal;
    const res = await fetch(url, { signal });
    if (!res.ok) {
      logger.warn('[matrikel] HTTP', res.status, await res.text());
      return EMPTY_FC;
    }
    const json = (await res.json()) as
      | { type?: string; features?: GeoJSON.Feature[] }
      | GeoJSON.Feature[];
    // DAWA kan returnere både FeatureCollection og bare et array
    if (Array.isArray(json)) {
      logger.log(`[matrikel] array med ${json.length} features`);
      return { type: 'FeatureCollection', features: json };
    }
    if (json?.type === 'FeatureCollection' && Array.isArray(json.features)) {
      logger.log(`[matrikel] FeatureCollection med ${json.features.length} features`);
      return json as GeoJSON.FeatureCollection;
    }
    logger.warn('[matrikel] uventet svar-format:', JSON.stringify(json).slice(0, 200));
    return EMPTY_FC;
  } catch (err) {
    logger.error('[matrikel] fejl:', err);
    return EMPTY_FC;
  }
}

// TODO(BIZZ-92): Migrate fetchHusnumre to DAR when DAR supports spatial polygon queries (before July 2026)
/**
 * Henter adresse-punkter fra DAWA for en bounding box til husnummer-lag.
 * Bruger polygon-parameteren med WGS84-koordinater (bbox+bboxsrid=4326 virker ikke).
 * Bruger struktur=mini (hurtig) og bygger Point-features fra x/y felterne.
 *
 * @param w - Vest-koordinat (lng, WGS84)
 * @param s - Syd-koordinat (lat, WGS84)
 * @param e - Øst-koordinat (lng, WGS84)
 * @param n - Nord-koordinat (lat, WGS84)
 * @returns GeoJSON FeatureCollection med adressepunkter
 */
async function fetchHusnumre(
  w: number,
  s: number,
  e: number,
  n: number,
  abortSignal?: AbortSignal
): Promise<GeoJSON.FeatureCollection> {
  try {
    // Server-side proxy — undgår direkte DAWA-kald (DAWA lukker 1. juli 2026)
    const timeoutSignal = AbortSignal.timeout(10000);
    const signal = abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal;
    const res = await fetch(`/api/adresse/husnumre-bbox?w=${w}&s=${s}&e=${e}&n=${n}`, {
      signal,
    });
    if (!res.ok) return EMPTY_FC;
    const json = (await res.json()) as GeoJSON.FeatureCollection;
    return json?.type === 'FeatureCollection' ? json : EMPTY_FC;
  } catch {
    return EMPTY_FC;
  }
}

/** Et BBR-bygningspunkt med ejendomstype fra /api/bbr/bbox */
interface BBRTypePunkt {
  id: string;
  lng: number;
  lat: number;
  ejerforholdskode: string | null;
}

/**
 * Henter BBR bygningspunkter med ejerforholdskode for en bounding box.
 * Bruges til at vise andelsbolig (AB) og almen bolig (AL) badges på kortet.
 * Returnerer tomt array ved fejl eller zoom < 15.
 *
 * @param w - Vest-koordinat (lng, WGS84)
 * @param s - Syd-koordinat (lat, WGS84)
 * @param e - Øst-koordinat (lng, WGS84)
 * @param n - Nord-koordinat (lat, WGS84)
 * @returns Array af BBRTypePunkt
 */
async function fetchBBRType(w: number, s: number, e: number, n: number): Promise<BBRTypePunkt[]> {
  try {
    const res = await fetch(`/api/bbr/bbox?w=${w}&s=${s}&e=${e}&n=${n}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as BBRTypePunkt[];
    return Array.isArray(json) ? json : [];
  } catch {
    return [];
  }
}

/**
 * Henter aktive virksomheder med kendte koordinater inden for `radius` km
 * fra et centralt punkt via /api/cvr/bbox.
 * Returnerer tomt array ved fejl eller manglende CVR-adgang.
 *
 * @param lat    - Breddegrad for søgecentrum (WGS84)
 * @param lng    - Længdegrad for søgecentrum (WGS84)
 * @param radius - Søgeradius i kilometer
 * @returns Array af VirksomhedMarkør
 */
async function fetchVirksomheder(
  lat: number,
  lng: number,
  radius: number
): Promise<VirksomhedMarkør[]> {
  try {
    const url = `/api/cvr/bbox?lat=${lat}&lng=${lng}&radius=${radius}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = (await res.json()) as CVRBboxResponse;
    return data.virksomheder ?? [];
  } catch {
    return [];
  }
}

// TODO(BIZZ-92): Migrate reverseGeocode to DAR when DAR supports reverse geocoding (before July 2026)
/**
 * Reverse geocoder — finder nærmeste DAWA adresse for koordinat.
 *
 * @param lng - Længdegrad
 * @param lat - Breddegrad
 * @returns Adressestreng + DAWA-id, eller null
 */
async function reverseGeocode(
  lng: number,
  lat: number
): Promise<{ adresse: string; id: string | null } | null> {
  try {
    // Server-side proxy — undgår direkte DAWA-kald (DAWA lukker 1. juli 2026)
    const res = await fetch(`/api/adresse/reverse?lng=${lng}&lat=${lat}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as { adresse: string | null; id: string | null };
    return d.adresse ? { adresse: d.adresse, id: d.id } : null;
  } catch {
    return null;
  }
}

// ─── Lag-panel ───────────────────────────────────────────────────────────────

/**
 * Alle toggleable lag-nøgler.
 * Kun lag med verificerede, gratis WMS-endpoints er inkluderet.
 * Bekræftet via GetCapabilities 2026-03-27:
 *   plandata → geoserver.plandata.dk/geoserver/wms
 *   miljo    → arealeditering-dist-geo.miljoeportal.dk/geoserver/ows
 */
type LagNøgle =
  | 'ortofoto'
  | 'matrikel'
  | 'husnumre'
  | 'bbr_type'
  | 'virksomheder'
  | 'lokalplaner'
  | 'kommuneplan'
  | 'zonekort'
  | 'byggefelt'
  | 'kloakopland'
  | 'detailhandel'
  | 'natura2000'
  | 'skovbyggelinje'
  | 'fredninger'
  | 'natur_reservat'
  | 'ramsar'
  | 'aabeskyttelse'
  | 'soebeskyttelse'
  | 'kirkeomgivelser'
  | 'jorddiger'
  | 'bev_vandloeb'
  | 'bev_landskaber'
  | 'kulturhistorie'
  | 'bnbo'
  | 'raastof'
  | 'indsatsplaner'
  | 'omr_klassificering'
  | 'jordforurening'
  | 'stoej_vej'
  | 'stoej_tog';

/** Synlighedstilstand for alle lag */
type LagSynlighed = Record<LagNøgle, boolean>;

const LAG_START: LagSynlighed = {
  ortofoto: false,
  matrikel: true,
  husnumre: true,
  bbr_type: true,
  virksomheder: false,
  lokalplaner: false,
  kommuneplan: false,
  zonekort: false,
  byggefelt: false,
  kloakopland: false,
  detailhandel: false,
  natura2000: false,
  skovbyggelinje: false,
  fredninger: false,
  natur_reservat: false,
  ramsar: false,
  aabeskyttelse: false,
  soebeskyttelse: false,
  kirkeomgivelser: false,
  jorddiger: false,
  bev_vandloeb: false,
  bev_landskaber: false,
  kulturhistorie: false,
  bnbo: false,
  raastof: false,
  indsatsplaner: false,
  omr_klassificering: false,
  jordforurening: false,
  stoej_vej: false,
  stoej_tog: false,
};

/** WMS-lag definition — kilde, URL og standard opacity */
interface WmsLagDef {
  id: LagNøgle;
  wmsUrl: string;
  opacity: number;
}

/**
 * Bygger en WMS tile-URL der går igennem vores server-side proxy (/api/wms).
 * Proxyen henter tiles server-side og videresender dem til browseren,
 * hvilket løser CORS-problemer med de danske offentlige WMS-servere.
 *
 * @param service - 'plandata' eller 'miljo' (whitelistet i /api/wms)
 * @param layers  - Kommasepareret WMS LAYERS-parameter
 */
function wmsUrl(service: 'plandata' | 'miljo' | 'miljoegis', layers: string): string {
  return (
    `/api/wms?service=${service}` +
    `&SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap` +
    `&LAYERS=${encodeURIComponent(layers)}` +
    `&STYLES=&FORMAT=image%2Fpng&TRANSPARENT=true` +
    `&SRS=EPSG%3A3857&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}`
  );
}

/**
 * GeoDanmark Ortofoto (luftfoto) — frie data, ingen API-nøgle påkrævet.
 * WMS tile-URL i EPSG:3857 (Web Mercator) med {bbox-epsg-3857} placeholder
 * som Mapbox GL erstatter automatisk ved tile-requests.
 */
const ORTOFOTO_WMS_URL =
  'https://api.dataforsyningen.dk/orto_foraar_webmercator?' +
  'service=WMS&version=1.1.1&request=GetMap' +
  '&layers=orto_foraar_webmercator&styles=' +
  '&srs=EPSG:3857&format=image/jpeg&transparent=false' +
  '&width=256&height=256&bbox={bbox-epsg-3857}';

/**
 * WMS-lag med bekræftede lagnavn fra GetCapabilities 2026-03-27.
 * Alle hentes via /api/wms proxy (løser CORS).
 *
 * plandata → geoserver.plandata.dk/geoserver/wms  (namespace: pdk:)
 * miljo    → arealeditering-dist-geo.miljoeportal.dk/geoserver/ows (namespace: dai:)
 */
const WMS_LAG: WmsLagDef[] = [
  // ── Planer & Regulering (Plandata) ──
  {
    id: 'lokalplaner',
    wmsUrl: wmsUrl('plandata', 'pdk:theme_pdk_lokalplan_vedtaget'),
    opacity: 0.8,
  },
  {
    id: 'kommuneplan',
    wmsUrl: wmsUrl('plandata', 'pdk:theme_pdk_kommuneplanramme_vedtaget_v'),
    opacity: 0.8,
  },
  { id: 'zonekort', wmsUrl: wmsUrl('plandata', 'pdk:theme_pdk_zonekort_samlet_v'), opacity: 0.7 },
  {
    id: 'byggefelt',
    wmsUrl: wmsUrl('plandata', 'pdk:theme_pdk_byggefelt_vedtaget'),
    opacity: 0.75,
  },
  {
    id: 'kloakopland',
    wmsUrl: wmsUrl('plandata', 'pdk:theme_pdk_kloakopland_vedtaget_v'),
    opacity: 0.65,
  },
  {
    id: 'detailhandel',
    wmsUrl: wmsUrl('plandata', 'pdk:theme_pdk_detailhandel_vedtaget'),
    opacity: 0.7,
  },
  // ── Bevaringsværdi (Plandata) ──
  {
    id: 'bev_landskaber',
    wmsUrl: wmsUrl('plandata', 'pdk:theme_pdk_bevaringsvaerdigelandskaber_vedtaget'),
    opacity: 0.7,
  },
  {
    id: 'kulturhistorie',
    wmsUrl: wmsUrl('plandata', 'pdk:theme_pdk_kulturhistoriskbevaringsvaerdi_vedtaget'),
    opacity: 0.7,
  },
  // ── Natur & Miljø (Miljøportal) ──
  {
    id: 'natura2000',
    wmsUrl: wmsUrl('miljo', 'dai:bes_naturtyper,dai:habitat_omr,dai:fugle_bes_omr'),
    opacity: 0.7,
  },
  { id: 'skovbyggelinje', wmsUrl: wmsUrl('miljo', 'dai:skovbyggelinjer'), opacity: 0.85 },
  { id: 'fredninger', wmsUrl: wmsUrl('miljo', 'dai:fredede_omr'), opacity: 0.7 },
  { id: 'natur_reservat', wmsUrl: wmsUrl('miljo', 'dai:natur_vildt_reservat'), opacity: 0.7 },
  { id: 'ramsar', wmsUrl: wmsUrl('miljo', 'dai:ramsar_omr'), opacity: 0.7 },
  // ── Beskyttelseslinjer (Miljøportal) ──
  { id: 'aabeskyttelse', wmsUrl: wmsUrl('miljo', 'dai:aa_bes_linjer'), opacity: 0.85 },
  { id: 'soebeskyttelse', wmsUrl: wmsUrl('miljo', 'dai:soe_bes_linjer'), opacity: 0.85 },
  { id: 'kirkeomgivelser', wmsUrl: wmsUrl('miljo', 'dai:kirkebyggelinjer'), opacity: 0.8 },
  { id: 'jorddiger', wmsUrl: wmsUrl('miljo', 'dai:bes_sten_jorddiger_2022'), opacity: 0.85 },
  { id: 'bev_vandloeb', wmsUrl: wmsUrl('miljo', 'dai:bes_vandloeb'), opacity: 0.8 },
  // ── Grundvand & Ressourcer (Miljøportal) ──
  { id: 'bnbo', wmsUrl: wmsUrl('miljo', 'dai:status_bnbo'), opacity: 0.7 },
  { id: 'raastof', wmsUrl: wmsUrl('miljo', 'dai:raastofomr'), opacity: 0.65 },
  { id: 'indsatsplaner', wmsUrl: wmsUrl('miljo', 'dai:indsatsplaner'), opacity: 0.65 },
  { id: 'omr_klassificering', wmsUrl: wmsUrl('miljo', 'dai:omr_klassificering'), opacity: 0.6 },
  // ── Jordforurening (Miljøportal) ──
  { id: 'jordforurening', wmsUrl: wmsUrl('miljo', 'dai:Jordforurening'), opacity: 0.7 },
  // ── BIZZ-961: Støjkort (Miljøstyrelsen GIS) ──
  {
    id: 'stoej_vej',
    wmsUrl: wmsUrl('miljoegis', 'theme-dk_noise2022_vej_1_5m'),
    opacity: 0.65,
  },
  {
    id: 'stoej_tog',
    wmsUrl: wmsUrl('miljoegis', 'theme-dk_noise2022_jernbane_1_5m'),
    opacity: 0.65,
  },
];

/** Farveaccenter til gruppeoverskrifter */
type LagFarve = 'blue' | 'amber' | 'emerald' | 'violet' | 'rose' | 'orange';

/** Visuel gruppering af lag til panel-UI */
const LAG_GRUPPER: Array<{
  navn: string;
  farve: LagFarve;
  lag: Array<{ id: LagNøgle; navn: string }>;
}> = [
  {
    navn: 'Baggrundskort',
    farve: 'blue',
    lag: [{ id: 'ortofoto', navn: 'Ortofoto (luftfoto)' }],
  },
  {
    navn: 'Ejendomsdata',
    farve: 'blue',
    lag: [
      { id: 'matrikel', navn: 'Matrikelgrænser' },
      { id: 'husnumre', navn: 'Husnumre' },
      { id: 'bbr_type', navn: 'Ejendomstype (EL/AB) zoom 15+' },
      { id: 'virksomheder', navn: 'Virksomheder (CVR)' },
    ],
  },
  {
    navn: 'Planer & Regulering',
    farve: 'amber',
    lag: [
      { id: 'lokalplaner', navn: 'Lokalplaner' },
      { id: 'kommuneplan', navn: 'Kommuneplanrammer' },
      { id: 'zonekort', navn: 'Zonekort' },
      { id: 'byggefelt', navn: 'Byggefelt' },
      { id: 'kloakopland', navn: 'Kloakopland' },
      { id: 'detailhandel', navn: 'Detailhandel' },
    ],
  },
  {
    navn: 'Bevaringsværdi',
    farve: 'orange',
    lag: [
      { id: 'bev_landskaber', navn: 'Bevaringsværdige landskaber' },
      { id: 'kulturhistorie', navn: 'Kulturhistorisk bevaringsværdi' },
    ],
  },
  {
    navn: 'Natur & Miljø',
    farve: 'emerald',
    lag: [
      { id: 'natura2000', navn: 'Natura 2000 & §3 natur' },
      { id: 'skovbyggelinje', navn: 'Skovbyggelinje' },
      { id: 'fredninger', navn: 'Fredede arealer' },
      { id: 'natur_reservat', navn: 'Natur- og vildtreservat' },
      { id: 'ramsar', navn: 'Ramsar-områder' },
      { id: 'jordforurening', navn: 'Jordforurening' },
    ],
  },
  {
    navn: 'Beskyttelseslinjer',
    farve: 'violet',
    lag: [
      { id: 'aabeskyttelse', navn: 'Åbeskyttelseslinje' },
      { id: 'soebeskyttelse', navn: 'Søbeskyttelseslinje' },
      { id: 'kirkeomgivelser', navn: 'Kirkeomgivelser' },
      { id: 'jorddiger', navn: 'Sten- og jorddiger' },
      { id: 'bev_vandloeb', navn: 'Beskyttede vandløb' },
    ],
  },
  {
    navn: 'Grundvand & Ressourcer',
    farve: 'rose',
    lag: [
      { id: 'bnbo', navn: 'BNBO — boringsnær beskyttelse' },
      { id: 'raastof', navn: 'Råstofområder' },
      { id: 'indsatsplaner', navn: 'Indsatsplaner' },
      { id: 'omr_klassificering', navn: 'Områdeklassificering' },
    ],
  },
  {
    navn: 'Støj & Klimarisiko',
    farve: 'orange',
    lag: [
      { id: 'stoej_vej', navn: 'Vejstøj (Lden dB)' },
      { id: 'stoej_tog', navn: 'Jernbanestøj (Lden dB)' },
    ],
  },
];

// ─── Lag-signaturforklaringer ─────────────────────────────────────────────────

/** Én indgang i en signaturforklaring — farve + label. */
interface LegendEntry {
  color: string;
  label: string;
}

/**
 * Konfiguration af signaturforklaringer for de kortlag der bruger
 * distinkte farver til at skelne kategorier.
 *
 * Farveværdierne matcher de officielle WMS-stilarter fra
 * Plandata.dk og Miljøportalen (verificeret via GetMap-requests).
 */
const LAYER_LEGENDS: Partial<Record<LagNøgle, { title: string; entries: LegendEntry[] }>> = {
  bbr_type: {
    title: 'Ejendomstype',
    entries: [
      { color: '#059669', label: 'AB — Andelsbolig' },
      { color: '#4f46e5', label: 'AL — Almen bolig' },
    ],
  },
  zonekort: {
    title: 'Zonekort',
    entries: [
      { color: '#e74c3c', label: 'Byzone' },
      { color: '#f1c40f', label: 'Landzone' },
      { color: '#3498db', label: 'Sommerhusområde' },
    ],
  },
  kloakopland: {
    title: 'Kloakopland',
    entries: [
      { color: '#8B4513', label: 'Fælleskloak' },
      { color: '#2ecc71', label: 'Separatkloak' },
      { color: '#e74c3c', label: 'Spildevandskloak' },
    ],
  },
  omr_klassificering: {
    title: 'Områdeklassificering',
    entries: [{ color: '#e67e22', label: 'Klassificeret område' }],
  },
  bev_landskaber: {
    title: 'Bevaringsværdige landskaber',
    entries: [{ color: '#d4a017', label: 'Bevaringsværdigt landskab' }],
  },
  kulturhistorie: {
    title: 'Kulturhistorisk bevaringsværdi',
    entries: [{ color: '#c0392b', label: 'Kulturhistorisk værdi' }],
  },
  byggefelt: {
    title: 'Byggefelt',
    entries: [{ color: '#8e44ad', label: 'Byggefelt' }],
  },
  natura2000: {
    title: 'Natura 2000',
    entries: [
      { color: '#27ae60', label: 'Habitatområde' },
      { color: '#2980b9', label: 'Fuglebeskyttelsesområde' },
      { color: '#16a085', label: '§3 naturtype' },
    ],
  },
  fredninger: {
    title: 'Fredede arealer',
    entries: [{ color: '#2ecc71', label: 'Fredet areal' }],
  },
  bnbo: {
    title: 'BNBO',
    entries: [{ color: '#3498db', label: 'Boringsnær beskyttelse' }],
  },
  raastof: {
    title: 'Råstofområder',
    entries: [
      { color: '#95a5a6', label: 'Råstofgraveområde' },
      { color: '#bdc3c7', label: 'Råstofinteresseområde' },
    ],
  },
};

/**
 * Signaturforklaring-overlay der vises i bunden af kortet.
 *
 * Renderer én kompakt boks per aktivt lag der har en signaturforklaring
 * defineret i LAYER_LEGENDS. Boksene stacker vertikalt og er
 * pointer-events-none så de ikke blokerer kort-interaktion.
 *
 * @param props.visLag - Aktuel lag-synlighedstilstand
 */
function MapLegends({ visLag }: { visLag: LagSynlighed }) {
  /** Filtrer aktive lag der har signaturforklaringer */
  const aktiveLegends = (Object.keys(LAYER_LEGENDS) as LagNøgle[]).filter(
    (id) => visLag[id] && LAYER_LEGENDS[id]
  );

  if (aktiveLegends.length === 0) return null;

  return (
    <div className="absolute bottom-20 right-4 z-10 flex flex-col gap-2 pointer-events-none max-h-[50vh] overflow-y-auto">
      {aktiveLegends.map((lagId) => {
        const legend = LAYER_LEGENDS[lagId]!;
        return (
          <div
            key={lagId}
            className="bg-slate-800/90 border border-slate-700/40 rounded-lg px-3 py-2 shadow-lg backdrop-blur-sm pointer-events-auto"
          >
            <p className="text-slate-300 text-[10px] font-semibold uppercase tracking-wider mb-1.5">
              {legend.title}
            </p>
            <div className="flex flex-col gap-1">
              {legend.entries.map((entry) => (
                <div key={entry.label} className="flex items-center gap-2">
                  <span
                    className="w-3 h-3 rounded-sm shrink-0 border border-white/10"
                    style={{ backgroundColor: entry.color }}
                  />
                  <span className="text-slate-300 text-xs leading-tight">{entry.label}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── KortInner ────────────────────────────────────────────────────────────────

/**
 * Indre kortkomponent — kræver Suspense-wrapper pga. useSearchParams.
 * Alle GeoJSON-sources og -layers styres imperativt via Mapbox GL JS API
 * for at undgå timing-problemer med react-map-gl's komponent-livscyklus.
 */
function KortInner() {
  const router = useRouter();
  const { lang } = useLanguage();
  const da = lang === 'da';
  const searchParams = useSearchParams();
  const mapRef = useRef<MapRef>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  /** Bilingual UI strings */
  const mt = {
    searchPlaceholder: da ? 'Søg adresse…' : 'Search address…',
    roadAddNumber: da ? 'Vej — tilføj husnummer' : 'Road — add house number',
    street: da ? 'Gade' : 'Street',
    aerial: da ? 'Luftfoto' : 'Aerial',
    layers: da ? 'Lag' : 'Layers',
    mapLayers: da ? 'Kortlag' : 'Map layers',
    fetching: da ? 'Henter…' : 'Loading…',
    parcels: da ? 'Matrikler' : 'Parcels',
    houseNumbers: da ? 'Husnumre' : 'House numbers',
    houseNumbersShort: da ? 'Husnr.' : 'House no.',
    fetchingAddress: da ? 'Henter adresse…' : 'Loading address…',
    parcelNo: da ? 'Matrikelnr.' : 'Parcel no.',
    cadastre: da ? 'Ejerlav' : 'Cadastre',
    landArea: da ? 'Grundareal' : 'Land area',
    propertyData: da ? 'Ejendomsdata' : 'Property data',
    companies: da ? 'Virksomheder' : 'Companies',
    openCompany: da ? 'Åbn virksomhed' : 'Open company',
    cvr: 'CVR',
    industry: da ? 'Branche' : 'Industry',
  };

  const [kortStyle, setKortStyle] = useState<KortStyle>('dark');

  /** Realtids-zoom til badges (opdateres via onMove) */
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);

  /**
   * Viewport-state opdateres på onMoveEnd / onZoomEnd.
   * useEffect lytter på denne og fetcher data — undgår stale-closure problemer.
   */
  const [viewport, setViewport] = useState<ViewportState | null>(null);

  /**
   * Debounce-timer til viewport-opdateringer — forhindrer hurtige successive
   * pan/zoom-events i at trigge parallelle data-fetches.
   * 300 ms er tilstrækkelig til at samle slut-positionen efter en pan-sekvens.
   */
  const viewportDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * AbortController til igangværende matrikel/husnr-fetch.
   * Afbrydes ved ny viewport-opdatering for at frigøre netværksressourcer.
   */
  const fetchAbortRef = useRef<AbortController | null>(null);

  // Søgefelt
  const [søgeTekst, setSøgeTekst] = useState('');
  const [forslag, setForslag] = useState<DawaAutocompleteResult[]>([]);
  const [markeret, setMarkeret] = useState(-1);
  const [søger, setSøger] = useState(false);
  const søgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Ryd søge-debounce timer ved unmount for at undgå setState på afmonteret komponent. */
  useEffect(() => {
    return () => {
      if (søgeTimer.current) clearTimeout(søgeTimer.current);
    };
  }, []);

  /** Ryd viewport-debounce og afbryd evt. igangværende fetch ved unmount. */
  useEffect(() => {
    return () => {
      if (viewportDebounceRef.current) clearTimeout(viewportDebounceRef.current);
      if (fetchAbortRef.current) fetchAbortRef.current.abort();
    };
  }, []);

  // Lag-data (React state — synkroniseres til Mapbox via useEffect)
  const [henterMatrikel, setHenterMatrikel] = useState(false);
  const [henterHusnr, setHenterHusnr] = useState(false);

  /**
   * Refs holder det seneste GeoJSON til brug i style.load-handler
   * (undgår stale closure ved style-skift).
   */
  const matrikelDataRef = useRef<GeoJSON.FeatureCollection>(EMPTY_FC);
  const hoverDataRef = useRef<GeoJSON.FeatureCollection>(EMPTY_FC);
  const husnrDataRef = useRef<GeoJSON.FeatureCollection>(EMPTY_FC);

  // Popup
  const [popup, setPopup] = useState<MatrikelPopup | null>(null);
  const [henterAdresse, setHenterAdresse] = useState(false);

  // Søgt-adresse markør
  const [søgtMarkør, setSøgtMarkør] = useState<{ lng: number; lat: number } | null>(null);

  // Lag-panel
  const [lagPanel, setLagPanel] = useState(false);
  const [visLag, setVisLag] = useState<LagSynlighed>(LAG_START);
  /** BBR ejendomstype-punkter (AB/AL) — hentes ved bbr_type toggle + zoom ≥ 15 */
  const [bbrTypePunkter, setBbrTypePunkter] = useState<BBRTypePunkt[]>([]);

  /** CVR virksomheds-markører — hentes når virksomheder-laget er aktivt */
  const [virksomhedsMarkører, setVirksomhedsMarkører] = useState<VirksomhedMarkør[]>([]);
  /** Henter-tilstand for virksomhedsmarkører — vises på toggle-knappen */
  const [henterVirksomheder, setHenterVirksomheder] = useState(false);
  /** Valgt virksomhed-popup */
  const [virksomhedPopup, setVirksomhedPopup] = useState<VirksomhedMarkør | null>(null);

  const visLagRef = useRef<LagSynlighed>(LAG_START);
  const lagPanelRef = useRef<HTMLDivElement>(null);

  /** Synkroniserer visLagRef med visLag state — bruges i style.load-handler (stale closure). */
  useEffect(() => {
    visLagRef.current = visLag;
  }, [visLag]);

  const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';
  const startEjendomId = useRef<string | null>(searchParams.get('ejendom'));

  // ── Imperativ lag-setup ─────────────────────────────────────────────────────

  /**
   * Tilføjer GeoJSON-sources og -layers direkte til Mapbox-instansen.
   * Kaldes ved map load og efter hvert style.load (ved stil-skift).
   * Idempotent — skippes hvis source/layer allerede eksisterer.
   */
  const setupLag = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;

    // ── Ortofoto raster basemap (tilføjes først så det ligger under alt andet) ──
    if (!map.getSource('ortofoto'))
      map.addSource('ortofoto', { type: 'raster', tiles: [ORTOFOTO_WMS_URL], tileSize: 256 });
    if (!map.getLayer('ortofoto-raster'))
      map.addLayer({
        id: 'ortofoto-raster',
        type: 'raster',
        source: 'ortofoto',
        layout: { visibility: visLagRef.current.ortofoto ? 'visible' : 'none' },
        paint: { 'raster-opacity': 1 },
      });

    // ── Sources ──
    if (!map.getSource('matrikel'))
      map.addSource('matrikel', { type: 'geojson', data: matrikelDataRef.current });
    if (!map.getSource('matrikel-hover'))
      map.addSource('matrikel-hover', { type: 'geojson', data: hoverDataRef.current });
    if (!map.getSource('husnumre'))
      map.addSource('husnumre', { type: 'geojson', data: husnrDataRef.current });

    // ── Matrikel fill + line ──
    if (!map.getLayer('matrikel-fill'))
      map.addLayer({
        id: 'matrikel-fill',
        type: 'fill',
        source: 'matrikel',
        paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.15 },
      });
    if (!map.getLayer('matrikel-line'))
      map.addLayer({
        id: 'matrikel-line',
        type: 'line',
        source: 'matrikel',
        paint: { 'line-color': '#60a5fa', 'line-width': 1.5, 'line-opacity': 1 },
      });

    // ── Hover highlight ──
    if (!map.getLayer('matrikel-hover-fill'))
      map.addLayer({
        id: 'matrikel-hover-fill',
        type: 'fill',
        source: 'matrikel-hover',
        paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.3 },
      });
    if (!map.getLayer('matrikel-hover-line'))
      map.addLayer({
        id: 'matrikel-hover-line',
        type: 'line',
        source: 'matrikel-hover',
        paint: { 'line-color': '#93c5fd', 'line-width': 2.5, 'line-opacity': 1 },
      });

    // ── Husnumre (symbol) ──
    if (!map.getLayer('husnr'))
      map.addLayer({
        id: 'husnr',
        type: 'symbol',
        source: 'husnumre',
        layout: {
          'text-field': ['get', 'husnr'],
          'text-size': 11,
          'text-anchor': 'center',
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': '#e2e8f0',
          'text-halo-color': '#0f172a',
          'text-halo-width': 1.5,
        },
      });

    logger.log('[lag] sources og layers tilføjet');

    // ── WMS raster lag (tilføjes initial med visibility=none — styres via visLag state) ──
    for (const wms of WMS_LAG) {
      const srcId = `wms-${wms.id}`;
      const lyrId = `wms-${wms.id}-raster`;
      if (!map.getSource(srcId))
        map.addSource(srcId, { type: 'raster', tiles: [wms.wmsUrl], tileSize: 256 });
      if (!map.getLayer(lyrId))
        map.addLayer({
          id: lyrId,
          type: 'raster',
          source: srcId,
          layout: { visibility: visLagRef.current[wms.id] ? 'visible' : 'none' },
          paint: { 'raster-opacity': wms.opacity },
        });
    }
  }, []);

  /**
   * Skubber de seneste data-refs direkte ind i Mapbox-sources via setData.
   * Bruges af style.load-handler for at genindlæse data efter stil-skift.
   */
  const synkLagData = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    (map.getSource('matrikel') as GeoJSONSource | undefined)?.setData(matrikelDataRef.current);
    (map.getSource('matrikel-hover') as GeoJSONSource | undefined)?.setData(hoverDataRef.current);
    (map.getSource('husnumre') as GeoJSONSource | undefined)?.setData(husnrDataRef.current);
    map.triggerRepaint();
  }, []);

  /**
   * Synkroniserer lag-synlighed fra visLagRef til Mapbox.
   * Kaldes fra style.load-handler efter gen-opsætning af lag.
   */
  const synkLagSynlighed = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    const v = visLagRef.current;
    const vis = (on: boolean): 'visible' | 'none' => (on ? 'visible' : 'none');
    if (map.getLayer('ortofoto-raster'))
      map.setLayoutProperty('ortofoto-raster', 'visibility', vis(v.ortofoto));
    for (const id of [
      'matrikel-fill',
      'matrikel-line',
      'matrikel-hover-fill',
      'matrikel-hover-line',
    ] as const)
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis(v.matrikel));
    if (map.getLayer('husnr')) map.setLayoutProperty('husnr', 'visibility', vis(v.husnumre));
    for (const wms of WMS_LAG) {
      const lyrId = `wms-${wms.id}-raster`;
      if (map.getLayer(lyrId)) map.setLayoutProperty(lyrId, 'visibility', vis(v[wms.id]));
    }
  }, []);

  /** Opdaterer Mapbox lag-synlighed når visLag state ændres. */
  useEffect(() => {
    synkLagSynlighed();
  }, [visLag, synkLagSynlighed]);

  // ── Stil-overrides ──────────────────────────────────────────────────────────

  /**
   * Tilpasser navigation-night-v1 stilen:
   * - Skjuler route/traffic/congestion overlay-layers (grønne/gule linjer på veje)
   * - Sætter vej-farver til mørk grå (#6b7280)
   * - Sætter baggrund/land til mørk blågrå (#28303f)
   *
   * VIGTIGT: isStyleLoaded()-checket er bevidst udeladt — ved style.load-event
   * er stilen klar, og checket kan returnere false pga. interne Mapbox _changed-flag,
   * hvilket ville forhindre overrides i at blive anvendt.
   */
  const anvendStilOverrides = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    const layers = map.getStyle()?.layers;
    if (!layers) return;
    for (const layer of layers) {
      const id = layer.id.toLowerCase();
      // Skjul alle route/traffic/congestion-lag — inkl. grønne congestion-linjer
      if (
        id.startsWith('navigation-route') ||
        id.startsWith('navigation-traffic') ||
        id.includes('congestion') ||
        id.includes('route') ||
        id.includes('traffic') ||
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

  // ── Viewport ────────────────────────────────────────────────────────────────

  /**
   * Læser viewport fra kortet og gemmer i state — bruges til at trigge data-fetch.
   * Kaldes fra onMoveEnd, onZoomEnd og handleMapLoad.
   *
   * Debounces 300 ms for at undgå at trigge et nyt fetch for hvert trin i en
   * pan/zoom-sekvens — kun den endelige position fører til et API-kald.
   * Afbryder desuden evt. igangværende fetch (AbortController) straks ved ny
   * viewport-ændring, så netværksressourcer frigøres hurtigt.
   */
  const opdaterViewport = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    const b = map.getBounds();
    if (!b) return;

    // Afbryd igangværende fetch straks — ny position er undervejs
    if (fetchAbortRef.current) {
      fetchAbortRef.current.abort();
      fetchAbortRef.current = null;
    }

    // Debounce: vent 300 ms på at pan/zoom er afsluttet
    if (viewportDebounceRef.current) clearTimeout(viewportDebounceRef.current);
    viewportDebounceRef.current = setTimeout(() => {
      const innerMap = mapRef.current?.getMap();
      if (!innerMap) return;
      const innerB = innerMap.getBounds();
      if (!innerB) return;
      setViewport({
        zoom: innerMap.getZoom(),
        w: innerB.getWest(),
        s: innerB.getSouth(),
        e: innerB.getEast(),
        n: innerB.getNorth(),
      });
    }, 300);
  }, []);

  // ── Map load ────────────────────────────────────────────────────────────────

  /**
   * Kaldes én gang når kortet er indlæst.
   * Tilføjer sources/layers imperativt og registrerer style.load-handler
   * der gen-opsætter lagene efter hvert stil-skift.
   */
  const handleMapLoad = useCallback(async () => {
    const map = mapRef.current?.getMap();
    if (!map) return;

    // Anvend stil-overrides på initial stil
    anvendStilOverrides();

    // Tilføj GeoJSON sources + layers
    setupLag();

    // Ved hvert fremtidigt stil-skift: gen-opsæt lag og synk data
    // VIGTIGT: style.load sletter ALLE custom sources/layers — derfor re-opsættes de her
    map.on('style.load', () => {
      anvendStilOverrides();
      setupLag();
      synkLagData();
      synkLagSynlighed(); // Genopretter lag-synlighed efter stil-skift
    });

    // Trigger initial viewport → data-fetch
    opdaterViewport();

    // Fly til specifik ejendom hvis URL-param sat
    if (!startEjendomId.current) return;
    const adrRes = await fetch(
      `/api/adresse/lookup?id=${encodeURIComponent(startEjendomId.current)}`
    );
    const adr: DawaAdresse | null = adrRes.ok ? await adrRes.json() : null;
    if (!adr || !mapRef.current) return;
    mapRef.current.flyTo({ center: [adr.x, adr.y], zoom: 17, duration: 1200 });
    setSøgtMarkør({ lng: adr.x, lat: adr.y });
  }, [anvendStilOverrides, setupLag, synkLagData, synkLagSynlighed, opdaterViewport]);

  // ── Data-fetch via useEffect ────────────────────────────────────────────────

  /**
   * Henter matrikel- og husnr-data når viewport ændres.
   * Rydder automatisk op (cancelled) hvis viewport ændres igen under fetch.
   * Bruger AbortController til at afbryde igangværende HTTP-kald ved ny viewport.
   */
  useEffect(() => {
    if (!viewport) return;
    if (viewport.zoom < MIN_ZOOM_MATRIKEL) {
      matrikelDataRef.current = EMPTY_FC;
      hoverDataRef.current = EMPTY_FC;
      husnrDataRef.current = EMPTY_FC;
      synkLagData();
      return;
    }

    // Afbryd evt. forrige in-flight fetch og opret ny controller
    if (fetchAbortRef.current) fetchAbortRef.current.abort();
    const abortController = new AbortController();
    fetchAbortRef.current = abortController;

    let cancelled = false;
    const { w, s, e, n, zoom: z } = viewport;

    const hent = async () => {
      setHenterMatrikel(true);
      const matrikel = await fetchMatrikelBbox(w, s, e, n, abortController.signal);
      if (!cancelled) {
        matrikelDataRef.current = matrikel;
        setHenterMatrikel(false);

        const map = mapRef.current?.getMap();

        // Sikr at source og layers eksisterer — style.load kan have slettet dem
        if (map && !map.getSource('matrikel')) setupLag();

        const src = map?.getSource('matrikel') as GeoJSONSource | undefined;
        if (src) {
          src.setData(matrikel);
          map?.triggerRepaint();
        }
      }

      if (z >= MIN_ZOOM_HUSNR) {
        if (!cancelled) setHenterHusnr(true);
        const husnr = await fetchHusnumre(w, s, e, n, abortController.signal);
        if (!cancelled) {
          husnrDataRef.current = husnr;
          setHenterHusnr(false);
          const map = mapRef.current?.getMap();
          if (map && !map.getSource('husnumre')) setupLag();
          const src = map?.getSource('husnumre') as GeoJSONSource | undefined;
          if (src) {
            src.setData(husnr);
            map?.triggerRepaint();
          }
        }
      } else {
        if (!cancelled) {
          husnrDataRef.current = EMPTY_FC;
          const map = mapRef.current?.getMap();
          (map?.getSource('husnumre') as GeoJSONSource | undefined)?.setData(EMPTY_FC);
        }
      }
    };

    hent();
    return () => {
      cancelled = true;
      abortController.abort();
      fetchAbortRef.current = null;
    };
  }, [viewport, synkLagData, setupLag]);

  /**
   * Henter BBR ejendomstype-punkter (AB/AL) når bbr_type-laget er aktivt og zoom ≥ 15.
   * Rydder automatisk op ved viewport-ændring.
   */
  useEffect(() => {
    if (!viewport || !visLag.bbr_type || viewport.zoom < 15) {
      if (!visLag.bbr_type) setBbrTypePunkter([]);
      return;
    }
    let cancelled = false;
    const { w, s, e, n } = viewport;
    fetchBBRType(w, s, e, n).then((data) => {
      if (!cancelled) setBbrTypePunkter(data);
    });
    return () => {
      cancelled = true;
    };
  }, [viewport, visLag.bbr_type]);

  /**
   * Henter CVR virksomheds-markører når virksomheder-laget er aktivt.
   * Radius beregnes ud fra zoom-niveau — jo mere zoomet ud, jo større radius.
   * Rydder listen når laget slås fra, og re-henter ved viewport-ændring.
   */
  useEffect(() => {
    if (!viewport || !visLag.virksomheder) {
      if (!visLag.virksomheder) {
        setVirksomhedsMarkører([]);
        setVirksomhedPopup(null);
      }
      return;
    }

    let cancelled = false;

    // Beregn radius ud fra zoom: zoom 10 → ~15 km, zoom 14 → ~2 km
    const radiusKm = Math.max(1, Math.min(15, Math.pow(2, 14 - viewport.zoom) * 2));
    // Kortcentrum
    const centerLat = (viewport.s + viewport.n) / 2;
    const centerLng = (viewport.w + viewport.e) / 2;

    setHenterVirksomheder(true);
    fetchVirksomheder(centerLat, centerLng, radiusKm).then((data) => {
      if (!cancelled) {
        setVirksomhedsMarkører(data);
        setHenterVirksomheder(false);
      }
    });

    return () => {
      cancelled = true;
      setHenterVirksomheder(false);
    };
  }, [viewport, visLag.virksomheder]);

  // ── Hover-data → Mapbox source (direkte) ────────────────────────────────────

  /**
   * Synkroniserer hover-data direkte til Mapbox-source.
   * Opdateres fra handleMouseMove/-Leave.
   */
  const opdaterHoverKilde = useCallback((fc: GeoJSON.FeatureCollection) => {
    hoverDataRef.current = fc;
    const map = mapRef.current?.getMap();
    (map?.getSource('matrikel-hover') as GeoJSONSource | undefined)?.setData(fc);
  }, []);

  // ── Søgefelt ────────────────────────────────────────────────────────────────

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (
        !searchRef.current?.contains(e.target as Node) &&
        !dropdownRef.current?.contains(e.target as Node)
      ) {
        setForslag([]);
        setMarkeret(-1);
      }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  /** Lukker lag-panel ved klik udenfor. */
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (lagPanel && lagPanelRef.current && !lagPanelRef.current.contains(e.target as Node))
        setLagPanel(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [lagPanel]);

  const handleSøgning = useCallback((tekst: string) => {
    setSøgeTekst(tekst);
    setMarkeret(-1);
    if (søgeTimer.current) clearTimeout(søgeTimer.current);
    if (tekst.trim().length < 2) {
      setForslag([]);
      return;
    }
    søgeTimer.current = setTimeout(async () => {
      setSøger(true);
      const acRes = await fetch(`/api/adresse/autocomplete?q=${encodeURIComponent(tekst)}`);
      setForslag(acRes.ok ? await acRes.json() : []);
      setSøger(false);
    }, 200);
  }, []);

  /**
   * Flyver kortet til det valgte søgeresultat.
   * darAutocomplete returnerer x=0, y=0 — koordinater hentes via separat opslag
   * mod /api/adresse/lookup når de mangler i autocomplete-svaret.
   */
  const vælgForslag = useCallback(
    async (r: DawaAutocompleteResult) => {
      if (r.type === 'vejnavn') {
        setSøgeTekst(r.tekst);
        setForslag([]);
        searchRef.current?.focus();
        return;
      }
      setSøgeTekst(r.tekst);
      setForslag([]);
      setMarkeret(-1);
      let lng = r.adresse.x;
      let lat = r.adresse.y;
      // BIZZ-370: darAutocomplete kan returnere x=0, y=0 (falsy) for visse
      // adresser — brug != null så 0 ikke fejlagtigt trigger fallback-opslaget.
      // BIZZ-630: MEN (0, 0) er altid et uløst DAWA-svar (ligger i Atlanterhavet
      // ved Vestafrika, ikke Danmark) — triggér fallback i det tilfælde også.
      const isNull = lng == null || lat == null;
      const isZeroZero = lng === 0 && lat === 0;
      if (isNull || isZeroZero) {
        try {
          const res = await fetch(`/api/adresse/lookup?id=${encodeURIComponent(r.adresse.id)}`);
          if (res.ok) {
            const data: { x?: number; y?: number } | null = await res.json();
            if (data?.x != null && data?.y != null && !(data.x === 0 && data.y === 0)) {
              lng = data.x;
              lat = data.y;
            }
          }
        } catch {
          /* ignorer netværksfejl */
        }
      }
      // BIZZ-630: Sanity-check koordinater er indenfor Danmarks bounding box
      // (lng 7-16°E, lat 54-58°N). Udenfor → vis toast i stedet for at flyve
      // kortet til Atlanterhavet / Europa. Rummer alle danske adresser +
      // en lille margin for Bornholm/Færøer.
      const DK_BBOX = { minLng: 7, maxLng: 16, minLat: 54, maxLat: 58 };
      const isInDenmark =
        lng != null &&
        lat != null &&
        lng >= DK_BBOX.minLng &&
        lng <= DK_BBOX.maxLng &&
        lat >= DK_BBOX.minLat &&
        lat <= DK_BBOX.maxLat;

      if (isInDenmark) {
        mapRef.current?.flyTo({ center: [lng!, lat!], zoom: 17, duration: 1000 });
        setSøgtMarkør({ lng: lng!, lat: lat! });
        setPopup(null);
      } else {
        logger.warn('[kort] ugyldige koordinater fra DAWA:', {
          id: r.adresse.id,
          lng,
          lat,
        });
        // Reset search field så brugeren kan prøve igen uden at kortet
        // står "stuck" med forkert input.
        setSøgeTekst('');
        searchRef.current?.focus();
      }
    },
    [setPopup]
  );

  const handleTastatur = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!forslag.length) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMarkeret((m) => Math.min(m + 1, forslag.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMarkeret((m) => Math.max(m - 1, -1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const i = markeret >= 0 ? markeret : 0;
        if (forslag[i]) void vælgForslag(forslag[i]);
      } else if (e.key === 'Escape') {
        setForslag([]);
        setMarkeret(-1);
      }
    },
    [forslag, markeret, vælgForslag]
  );

  // ── Kort-interaktion ────────────────────────────────────────────────────────

  /**
   * Opdaterer hover-highlightet når musen bevæger sig over kortet.
   * Bruger queryRenderedFeatures mod matrikel-fill laget.
   */
  const handleMouseMove = useCallback(
    (e: MapMouseEvent) => {
      const map = mapRef.current?.getMap();
      if (!map) return;
      const features = map.queryRenderedFeatures(e.point, { layers: ['matrikel-fill'] });
      opdaterHoverKilde(
        features.length > 0
          ? { type: 'FeatureCollection', features: [features[0] as GeoJSON.Feature] }
          : EMPTY_FC
      );
    },
    [opdaterHoverKilde]
  );

  /** Nulstiller hover-highlight når musen forlader kortet. */
  const handleMouseLeave = useCallback(() => opdaterHoverKilde(EMPTY_FC), [opdaterHoverKilde]);

  /**
   * Viser popup med matrikel-info ved klik.
   * Reverse geocoder adressen asynkront.
   */
  const handleKlik = useCallback(
    async (e: MapMouseEvent) => {
      const map = mapRef.current?.getMap();
      if (!map) return;
      const features = map.queryRenderedFeatures(e.point, { layers: ['matrikel-fill'] });
      if (features.length === 0) {
        setPopup(null);
        setSøgtMarkør(null);
        return;
      }

      const props = features[0].properties as Record<string, unknown>;
      const matrikelnr = typeof props.matrikelnr === 'string' ? props.matrikelnr : '?';
      const ejerlavNavn = typeof props.ejerlavsnavn === 'string' ? props.ejerlavsnavn : '';
      const grundareal = typeof props.registreretareal === 'number' ? props.registreretareal : null;
      const zone = typeof props.zone === 'string' ? props.zone : null;
      const titel = ejerlavNavn ? `${ejerlavNavn}, ${matrikelnr}` : matrikelnr;

      setPopup({
        x: e.point.x,
        y: e.point.y,
        titel,
        matrikelnr,
        grundareal,
        zone,
        adresse: null,
        dawaId: null,
      });
      setHenterAdresse(true);
      const geo = await reverseGeocode(e.lngLat.lng, e.lngLat.lat);
      setHenterAdresse(false);
      if (geo)
        setPopup((prev) => (prev ? { ...prev, adresse: geo.adresse, dawaId: geo.id } : null));
    },
    [setPopup]
  );

  // ── Render ──────────────────────────────────────────────────────────────────

  const matrikelAktiv = zoom >= MIN_ZOOM_MATRIKEL;
  const husnrAktiv = zoom >= MIN_ZOOM_HUSNR;

  return (
    <div className="relative w-full h-full overflow-hidden">
      <style>{`.mapboxgl-ctrl-logo,.mapboxgl-ctrl-attrib{display:none!important}`}</style>

      <Map
        ref={mapRef}
        mapboxAccessToken={mapboxToken}
        initialViewState={{
          longitude: DEFAULT_CENTER.lng,
          latitude: DEFAULT_CENTER.lat,
          zoom: DEFAULT_ZOOM,
        }}
        style={{ width: '100%', height: '100%' }}
        mapStyle={STYLES[kortStyle]}
        attributionControl={false}
        interactiveLayerIds={['matrikel-fill']}
        onLoad={handleMapLoad}
        onMove={(e) => setZoom(e.viewState.zoom)}
        onMoveEnd={opdaterViewport}
        onZoomEnd={opdaterViewport}
        onClick={handleKlik}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        cursor="crosshair"
      >
        <NavigationControl position="bottom-right" />
        <GeolocateControl position="bottom-right" trackUserLocation showUserHeading />

        {/* GeoJSON sources og layers tilføjes imperativt i handleMapLoad — ingen <Source>/<Layer> her */}

        {søgtMarkør && (
          <Marker longitude={søgtMarkør.lng} latitude={søgtMarkør.lat} anchor="bottom">
            <div className="flex flex-col items-center">
              <div className="w-4 h-4 bg-blue-500 rounded-full border-2 border-white shadow-lg ring-4 ring-blue-500/30" />
              <div className="w-0.5 h-3 bg-blue-400/60" />
            </div>
          </Marker>
        )}

        {/* BBR ejendomstype-badges — vises kun ved zoom ≥ 15 og når bbr_type-laget er aktivt */}
        {visLag.bbr_type &&
          bbrTypePunkter.map((p) => {
            const isAB = p.ejerforholdskode === '50';
            const isAL = p.ejerforholdskode === '60';
            if (!isAB && !isAL) return null;
            return (
              <Marker key={p.id} longitude={p.lng} latitude={p.lat} anchor="center">
                <span
                  className={`text-[8px] font-bold px-1.5 py-px rounded-full shadow-lg border leading-none pointer-events-none select-none ${
                    isAB
                      ? 'bg-emerald-600/90 text-white border-emerald-400'
                      : 'bg-indigo-600/90 text-white border-indigo-400'
                  }`}
                >
                  {isAB ? 'AB' : 'AL'}
                </span>
              </Marker>
            );
          })}

        {/* Virksomheds-markører — blå cirkler, klik åbner popup */}
        {visLag.virksomheder &&
          virksomhedsMarkører.map((v) => (
            <Marker
              key={v.cvr}
              longitude={v.lng}
              latitude={v.lat}
              anchor="center"
              onClick={(e) => {
                // Forhindrer map-klik-event i at propagere (lukker matrikel-popup)
                e.originalEvent.stopPropagation();
                setVirksomhedPopup((prev) => (prev?.cvr === v.cvr ? null : v));
                setPopup(null);
              }}
            >
              <button
                aria-label={`Virksomhed: ${v.navn}`}
                className="w-4 h-4 rounded-full bg-blue-600 border-2 border-white shadow-lg ring-2 ring-blue-600/40 hover:scale-125 transition-transform cursor-pointer"
              />
            </Marker>
          ))}
      </Map>

      {/* ── Søgebar ───────────────────────────────────────────────────────── */}
      {/* top-16 på mobil — undgår overlap med stil-toggle (left-4) og lag-knap (right-4) */}
      <div className="absolute top-16 sm:top-14 left-1/2 -translate-x-1/2 z-30 w-full max-w-lg px-4">
        <div className="relative">
          <div className="flex items-center gap-2 bg-[#0f172a]/95 border border-white/10 rounded-2xl shadow-2xl px-4 py-3 backdrop-blur-sm">
            {søger ? (
              <Loader2 size={16} className="text-blue-400 animate-spin shrink-0" />
            ) : (
              <Search size={16} className="text-slate-400 shrink-0" />
            )}
            <input
              ref={searchRef}
              type="text"
              value={søgeTekst}
              onChange={(e) => handleSøgning(e.target.value)}
              onKeyDown={handleTastatur}
              placeholder={mt.searchPlaceholder}
              className="flex-1 bg-transparent text-white placeholder-slate-500 text-sm outline-none"
            />
            {søgeTekst && (
              <button
                onClick={() => {
                  setSøgeTekst('');
                  setForslag([]);
                  setSøgtMarkør(null);
                }}
                className="text-slate-500 hover:text-slate-300 transition-colors"
              >
                <X size={14} />
              </button>
            )}
          </div>
          {forslag.length > 0 && (
            <div
              ref={dropdownRef}
              className="absolute top-full mt-2 w-full bg-[#0f172a]/98 border border-white/10 rounded-2xl shadow-2xl overflow-hidden backdrop-blur-sm z-50"
            >
              {forslag.map((r, i) => (
                <button
                  key={r.adresse.id}
                  onMouseDown={(ev) => {
                    ev.preventDefault();
                    vælgForslag(r);
                  }}
                  className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors border-b border-white/5 last:border-0 ${
                    i === markeret ? 'bg-blue-600/20 text-white' : 'text-slate-300 hover:bg-white/5'
                  }`}
                >
                  <div
                    className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${i === markeret ? 'bg-blue-600/30' : 'bg-white/5'}`}
                  >
                    {r.type === 'vejnavn' ? (
                      <Navigation
                        size={12}
                        className={i === markeret ? 'text-blue-400' : 'text-slate-400'}
                      />
                    ) : (
                      <MapPin
                        size={12}
                        className={i === markeret ? 'text-blue-400' : 'text-slate-400'}
                      />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{r.tekst}</p>
                    <p className="text-slate-500 text-xs">
                      {r.type === 'vejnavn'
                        ? mt.roadAddNumber
                        : `${r.adresse.postnr} ${r.adresse.postnrnavn}`}
                    </p>
                  </div>
                  <ArrowRight
                    size={12}
                    className={i === markeret ? 'text-blue-400' : 'text-slate-600'}
                  />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Kortknapper øverst — venstre + højre i fælles row, kan aldrig overlappe */}
      <div className="absolute top-4 left-4 right-4 z-20 flex items-center justify-between gap-2">
        {/* Venstre: stil-toggle */}
        <div className="flex flex-wrap gap-1.5 min-w-0">
          {(['dark', 'satellite'] as KortStyle[]).map((s) => (
            <button
              key={s}
              onClick={() => setKortStyle(s)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium shadow-lg transition-all ${
                kortStyle === s
                  ? 'bg-blue-600 text-white'
                  : 'bg-[#0f172a]/90 text-slate-300 hover:bg-slate-800 border border-white/10'
              }`}
            >
              {s === 'dark' ? <MapIcon size={13} /> : <Satellite size={13} />}
              {s === 'dark' ? mt.street : mt.aerial}
            </button>
          ))}
        </div>
        {/* Højre: Lag-knap */}
        <button
          onClick={() => setLagPanel((p) => !p)}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium shadow-lg transition-all shrink-0 ${
            lagPanel
              ? 'bg-blue-600 text-white'
              : 'bg-[#0f172a]/90 text-slate-300 hover:bg-slate-800 border border-white/10'
          }`}
        >
          <Layers size={13} />
          {mt.layers}
        </button>
      </div>

      {/* ── Lag-panel (højre side) ───────────────────────────────────────── */}
      {lagPanel && (
        <div
          ref={lagPanelRef}
          className="absolute top-14 right-4 z-30 w-56 bg-[#0d1625]/98 border border-white/10 rounded-xl shadow-2xl backdrop-blur-sm overflow-hidden"
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
            <span className="text-white text-xs font-semibold">{mt.mapLayers}</span>
            <button
              onClick={() => setLagPanel(false)}
              className="text-slate-500 hover:text-slate-300 transition-colors p-0.5 rounded hover:bg-white/5"
            >
              <X size={12} />
            </button>
          </div>
          <div className="px-2 py-1.5 max-h-[70vh] overflow-y-auto">
            {LAG_GRUPPER.map((gruppe) => (
              <div key={gruppe.navn} className="mb-0.5">
                <p
                  className={`text-[9px] font-bold uppercase tracking-widest px-1 pt-2 pb-1 ${
                    gruppe.farve === 'blue'
                      ? 'text-blue-400'
                      : gruppe.farve === 'amber'
                        ? 'text-amber-400'
                        : gruppe.farve === 'violet'
                          ? 'text-violet-400'
                          : gruppe.farve === 'rose'
                            ? 'text-rose-400'
                            : gruppe.farve === 'orange'
                              ? 'text-orange-400'
                              : 'text-emerald-400'
                  }`}
                >
                  {gruppe.navn}
                </p>
                {gruppe.lag.map((lag) => (
                  <button
                    key={lag.id}
                    onClick={() => setVisLag((prev) => ({ ...prev, [lag.id]: !prev[lag.id] }))}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg mb-px transition-colors text-left ${
                      visLag[lag.id] ? 'bg-white/5' : 'hover:bg-white/3'
                    }`}
                  >
                    <div
                      className={`w-3.5 h-3.5 rounded-sm flex items-center justify-center shrink-0 border transition-colors ${
                        visLag[lag.id]
                          ? gruppe.farve === 'blue'
                            ? 'bg-blue-600   border-blue-600'
                            : gruppe.farve === 'amber'
                              ? 'bg-amber-600  border-amber-600'
                              : gruppe.farve === 'violet'
                                ? 'bg-violet-600 border-violet-600'
                                : gruppe.farve === 'rose'
                                  ? 'bg-rose-600   border-rose-600'
                                  : gruppe.farve === 'orange'
                                    ? 'bg-orange-600 border-orange-600'
                                    : 'bg-emerald-600 border-emerald-600'
                          : 'border-white/20'
                      }`}
                    >
                      {visLag[lag.id] && (
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
                      className={`text-xs leading-tight truncate ${visLag[lag.id] ? 'text-white' : 'text-slate-400'}`}
                    >
                      {lag.navn}
                    </p>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Signaturforklaringer (bottom-right, over navigationskontroller) ─ */}
      <MapLegends visLag={visLag} />

      {/* ── Status-badges (bottom-left) ───────────────────────────────────── */}
      <div className="absolute bottom-4 left-4 z-10 flex items-center gap-2">
        <div className="flex items-center gap-1.5 bg-[#0f172a]/90 border border-white/10 rounded-lg px-2.5 py-1.5 shadow">
          <span className="text-slate-500 text-[11px]">Zoom</span>
          <span className="text-white text-xs font-semibold tabular-nums w-8 text-right">
            {zoom.toFixed(1)}
          </span>
        </div>
        <div
          className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 shadow border transition-colors ${
            matrikelAktiv ? 'bg-[#0f172a]/90 border-blue-500/30' : 'bg-[#0f172a]/70 border-white/5'
          }`}
        >
          {henterMatrikel ? (
            <Loader2 size={11} className="text-blue-400 animate-spin" />
          ) : (
            <Layers size={11} className={matrikelAktiv ? 'text-blue-400' : 'text-slate-600'} />
          )}
          <span className={`text-xs ${matrikelAktiv ? 'text-slate-300' : 'text-slate-600'}`}>
            {henterMatrikel
              ? mt.fetching
              : matrikelAktiv
                ? mt.parcels
                : `${mt.parcels} zoom ${MIN_ZOOM_MATRIKEL}+`}
          </span>
        </div>
        <div
          className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 shadow border transition-colors ${
            husnrAktiv ? 'bg-[#0f172a]/90 border-emerald-500/30' : 'bg-[#0f172a]/70 border-white/5'
          }`}
        >
          {henterHusnr ? (
            <Loader2 size={11} className="text-emerald-400 animate-spin" />
          ) : (
            <MapPin size={11} className={husnrAktiv ? 'text-emerald-400' : 'text-slate-600'} />
          )}
          <span className={`text-xs ${husnrAktiv ? 'text-slate-300' : 'text-slate-600'}`}>
            {henterHusnr
              ? mt.fetching
              : husnrAktiv
                ? mt.houseNumbers
                : `${mt.houseNumbersShort} zoom ${MIN_ZOOM_HUSNR}+`}
          </span>
        </div>
        {/* Virksomheds-badge — vises kun når laget er aktivt */}
        {visLag.virksomheder && (
          <div className="flex items-center gap-1.5 bg-[#0f172a]/90 border border-blue-500/30 rounded-lg px-2.5 py-1.5 shadow">
            {henterVirksomheder ? (
              <Loader2 size={11} className="text-blue-400 animate-spin" />
            ) : (
              <Building2 size={11} className="text-blue-400" />
            )}
            <span className="text-xs text-slate-300">
              {henterVirksomheder
                ? mt.fetching
                : `${virksomhedsMarkører.length} ${mt.companies.toLowerCase()}`}
            </span>
          </div>
        )}
      </div>

      {/* ── Ejendoms-panel (fast bund-placering) ─────────────────────────── */}
      {popup && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 z-30 w-full max-w-md px-4 pointer-events-auto">
          <div className="bg-[#0d1625]/98 border border-white/10 rounded-2xl shadow-2xl backdrop-blur-sm overflow-hidden">
            {/* Header — adresse + luk */}
            <div className="flex items-start justify-between px-5 pt-4 pb-3">
              <div className="flex-1 min-w-0 pr-3">
                {henterAdresse ? (
                  <div className="flex items-center gap-2 text-slate-400 text-sm py-1">
                    <Loader2 size={13} className="animate-spin" />
                    <span>{mt.fetchingAddress}</span>
                  </div>
                ) : (
                  <>
                    <p className="text-white text-base font-semibold leading-snug truncate">
                      {popup.adresse?.split(',')[0] ?? popup.titel}
                    </p>
                    {popup.adresse && (
                      <p className="text-slate-400 text-xs mt-0.5 truncate">
                        {popup.adresse.split(',').slice(1).join(',').trim()}
                      </p>
                    )}
                  </>
                )}
                {popup.zone && (
                  <span className="inline-block mt-2 text-[10px] font-medium text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-full px-2 py-0.5">
                    {popup.zone}
                  </span>
                )}
              </div>
              <button
                onClick={() => setPopup(null)}
                className="text-slate-500 hover:text-slate-300 transition-colors shrink-0 mt-0.5 p-1 rounded-lg hover:bg-white/5"
              >
                <X size={15} />
              </button>
            </div>

            {/* Detaljer — matrikelnr, ejerlav, grundareal */}
            <div className="px-5 pb-4 grid grid-cols-3 gap-4 border-t border-white/5 pt-3">
              <div>
                <p className="text-slate-500 text-[10px] uppercase tracking-wider mb-1">
                  {mt.parcelNo}
                </p>
                <p className="text-white text-sm font-semibold">{popup.matrikelnr}</p>
              </div>
              <div>
                <p className="text-slate-500 text-[10px] uppercase tracking-wider mb-1">
                  {mt.cadastre}
                </p>
                <p className="text-white text-sm font-semibold truncate">
                  {popup.titel.includes(',') ? popup.titel.split(',')[0].trim() : '—'}
                </p>
              </div>
              <div>
                <p className="text-slate-500 text-[10px] uppercase tracking-wider mb-1">
                  {mt.landArea}
                </p>
                <p className="text-white text-sm font-semibold">
                  {popup.grundareal != null
                    ? `${popup.grundareal.toLocaleString('da-DK')} m²`
                    : '—'}
                </p>
              </div>
            </div>

            {/* CTA — åbn ejendomsside */}
            <div className="px-4 pb-4">
              <button
                onClick={() => popup.dawaId && router.push(`/dashboard/ejendomme/${popup.dawaId}`)}
                disabled={!popup.dawaId || henterAdresse}
                className="w-full flex items-center justify-between bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl px-5 py-3 transition-colors group"
              >
                <span>{mt.propertyData}</span>
                <ArrowRight
                  size={16}
                  className="group-hover:translate-x-0.5 transition-transform"
                />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Virksomheds-popup (fast bund-placering) ─────────────────────────── */}
      {virksomhedPopup && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 z-30 w-full max-w-md px-4 pointer-events-auto">
          <div className="bg-[#0d1625]/98 border border-blue-500/20 rounded-2xl shadow-2xl backdrop-blur-sm overflow-hidden">
            {/* Header */}
            <div className="flex items-start justify-between px-5 pt-4 pb-3">
              <div className="flex items-start gap-3 flex-1 min-w-0 pr-3">
                <div className="w-9 h-9 rounded-xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center shrink-0 mt-0.5">
                  <Building2 size={16} className="text-blue-400" />
                </div>
                <div className="min-w-0">
                  <p className="text-white text-base font-semibold leading-snug truncate">
                    {virksomhedPopup.navn}
                  </p>
                  {virksomhedPopup.branche && (
                    <p className="text-slate-400 text-xs mt-0.5 truncate">
                      {virksomhedPopup.branche}
                    </p>
                  )}
                </div>
              </div>
              <button
                onClick={() => setVirksomhedPopup(null)}
                className="text-slate-500 hover:text-slate-300 transition-colors shrink-0 mt-0.5 p-1 rounded-lg hover:bg-white/5"
              >
                <X size={15} />
              </button>
            </div>

            {/* Detaljer — CVR-nummer */}
            <div className="px-5 pb-4 border-t border-white/5 pt-3">
              <div>
                <p className="text-slate-500 text-[10px] uppercase tracking-wider mb-1">{mt.cvr}</p>
                <p className="text-white text-sm font-semibold tabular-nums">
                  {virksomhedPopup.cvr.toString().padStart(8, '0')}
                </p>
              </div>
            </div>

            {/* CTA — åbn virksomhedsside */}
            <div className="px-4 pb-4">
              <button
                onClick={() => router.push(`/dashboard/companies/${virksomhedPopup.cvr}`)}
                className="w-full flex items-center justify-between bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-xl px-5 py-3 transition-colors group"
              >
                <span>{mt.openCompany}</span>
                <ArrowRight
                  size={16}
                  className="group-hover:translate-x-0.5 transition-transform"
                />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Exporteret side-komponent — wrapper KortInner i Suspense
 * pga. useSearchParams kræver en Suspense-grænse i Next.js App Router.
 */
export default function KortPageClient() {
  return (
    <Suspense fallback={<div className="w-full h-full bg-[#0f172a]" />}>
      <KortInner />
    </Suspense>
  );
}
