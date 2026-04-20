'use client';

/**
 * Ejendomsdetaljeside — Resights-niveau detalje.
 * Viser fuld information om en ejendom fordelt på 6 tabs:
 * Overblik, BBR, Ejerforhold, Tinglysning, Økonomi, Dokumenter.
 *
 * BizzAssist forbedringer over Resights:
 * - Inline AI-analyse direkte på siden
 * - Interaktiv prishistorik-graf via Recharts
 * - Krydslinks til virksomhedssider for selskabsejere
 * - Mørkt tema optimeret til professionelle brugere
 * - SVG-baseret ejerstrukturtræ
 */

import { useState, use, useEffect, useRef, useCallback, useMemo, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  Download,
  Bell,
  X,
  MapPin,
  Building2,
  Home,
  ChevronDown,
  ChevronRight,
  TrendingUp,
  FileText,
  Users,
  Landmark,
  BarChart3,
  Briefcase,
  Phone,
  Mail,
  Map as MapIcon,
  CheckCircle,
  XCircle,
  Info,
  Zap,
  Clock,
} from 'lucide-react';
/** Recharts — single dynamic import keeps recharts in one chunk */
const EjendomPrisChart = dynamic(() => import('./EjendomPrisChart'), { ssr: false });

/** PropertyMap — dynamisk importeret pga. Mapbox GL (browser-only) */
const PropertyMap = dynamic(() => import('@/app/components/ejendomme/PropertyMap'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-64 bg-slate-800/50 rounded-xl animate-pulse flex items-center justify-center">
      <span className="text-slate-500 text-sm">Indlæser kort...</span>
    </div>
  ),
});
import {
  getEjendomById,
  formatDKK,
  formatDato,
  type EjerstrukturNode,
} from '@/app/lib/mock/ejendomme';
import { erDawaId, type DawaAdresse, type DawaJordstykke } from '@/app/lib/dawa';
import { formatBenyttelseOgByggeaar } from '@/app/lib/benyttelseskoder';
import { tekniskAnlaegTekst, tekniskAnlaegKategori } from '@/app/lib/bbrTekniskAnlaegKoder';
import type { EjendomApiResponse, LiveBBRBygning } from '@/app/api/ejendom/[id]/route';
import type { CVRVirksomhed, CVRResponse } from '@/app/api/cvr/route';
import type { VurderingData, VurderingResponse } from '@/app/api/vurdering/route';
import type { EjerData, EjerskabResponse } from '@/app/api/ejerskab/route';
import type { PlandataItem, PlandataResponse } from '@/app/api/plandata/route';
import type { EnergimaerkeItem, EnergimaerkeResponse } from '@/app/api/energimaerke/route';
import type { JordParcelItem, JordResponse } from '@/app/api/jord/route';
import type { HandelData, SalgshistorikResponse } from '@/app/api/salgshistorik/route';
import type { TLEjer, TLHaeftelse } from '@/app/api/tinglysning/summarisk/route';
import type {
  ForelobigVurdering,
  ForelobigVurderingResponse,
} from '@/app/api/vurdering-forelobig/route';
import type { MatrikelEjendom, MatrikelResponse } from '@/app/api/matrikel/route';
import type {
  MatrikelHistorikEvent,
  MatrikelHistorikResponse,
} from '@/app/api/matrikel/historik/route';
import { gemRecentEjendom } from '@/app/lib/recentEjendomme';
import { recordRecentVisit } from '@/app/lib/recordRecentVisit';
import { erTracked, toggleTrackEjendom, fetchErTracked } from '@/app/lib/trackedEjendomme';
import FoelgTooltip from '@/app/components/FoelgTooltip';
import SektionLoader from '@/app/components/SektionLoader';
import TabLoadingSpinner from '@/app/components/TabLoadingSpinner';
import { useLanguage } from '@/app/context/LanguageContext';
import { useSetAIPageContext } from '@/app/context/AIPageContext';
import dynamic from 'next/dynamic';
import type { DiagramGraph } from '@/app/components/diagrams/DiagramData';
import { logger } from '@/app/lib/logger';
import TinglysningTab from './TinglysningTab';

const DiagramForce = dynamic(() => import('@/app/components/diagrams/DiagramForce'), {
  ssr: false,
  loading: () => <div className="w-full h-96 bg-slate-800/50 rounded-xl animate-pulse" />,
});

type Tab =
  | 'overblik'
  | 'bbr'
  | 'ejerforhold'
  | 'tinglysning'
  | 'oekonomi'
  | 'skatter'
  | 'dokumenter';

/** Bygger tab-liste med oversatte labels */
function buildTabs(da: boolean): { id: Tab; label: string; ikon: React.ReactNode }[] {
  return [
    { id: 'overblik', label: da ? 'Oversigt' : 'Overview', ikon: <Building2 size={12} /> },
    { id: 'bbr', label: 'BBR', ikon: <FileText size={12} /> },
    { id: 'ejerforhold', label: da ? 'Ejerskab' : 'Ownership', ikon: <Users size={12} /> },
    { id: 'oekonomi', label: da ? 'Økonomi' : 'Financials', ikon: <BarChart3 size={12} /> },
    { id: 'skatter', label: da ? 'SKAT' : 'Tax', ikon: <Landmark size={12} /> },
    {
      id: 'tinglysning',
      label: da ? 'Tinglysning' : 'Land Registry',
      ikon: <Landmark size={12} />,
    },
    { id: 'dokumenter', label: da ? 'Dokumenter' : 'Documents', ikon: <FileText size={12} /> },
  ];
}

/** Miljøindikator statusfarve */
const miljoStatusColor: Record<string, string> = {
  aktiv: 'border-blue-500/30 bg-blue-500/5',
  advarsel: 'border-orange-500/30 bg-orange-500/5',
  inaktiv: 'border-slate-700/50 bg-slate-800/20',
};

/**
 * Lille datakort til overblik-sektionen.
 * @param label - Kortets label
 * @param value - Kortets primære værdi
 * @param sub - Valgfri undertekst
 */
function DataKort({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-slate-900/50 border border-slate-700/40 rounded-xl p-2">
      <p className="text-slate-400 text-xs leading-none mb-0.5">{label}</p>
      <p className="text-white font-semibold text-sm leading-tight">{value}</p>
      {sub && <p className="text-slate-500 text-xs mt-0.5">{sub}</p>}
    </div>
  );
}

/**
 * Sektionstitel med valgfri download-knap.
 * @param title - Titeltekst
 * @param onDownload - Valgfri download-handler
 */
function SectionTitle({ title, onDownload }: { title: string; onDownload?: () => void }) {
  return (
    <div className="flex items-center justify-between mb-1.5">
      <h3 className="text-white font-semibold text-sm">{title}</h3>
      {onDownload && (
        <button
          onClick={onDownload}
          className="text-slate-600 hover:text-slate-300 transition-colors"
        >
          <Download size={14} />
        </button>
      )}
    </div>
  );
}

/**
 * SVG-baseret ejerstruktur-træ i horisontalt layout.
 * Noder vises fra venstre (personer) mod højre (ejendom).
 *
 * @param noder - Array af EjerstrukturNode der bygger træet
 */
function _EjerstrukturTrae({ noder }: { noder: EjerstrukturNode[] }) {
  // Opbyg kolonner: ingen forælder = kolonne 0, dybde stiger mod højre
  const getDepth = (node: EjerstrukturNode, depth = 0): number => {
    if (!node.foraeldreId) return depth;
    const parent = noder.find((n) => n.id === node.foraeldreId);
    return parent ? getDepth(parent, depth + 1) : depth;
  };

  const maxDepth = Math.max(...noder.map((n) => getDepth(n)));

  // Grupper noder per dybde (kolonner) — bruger Record i stedet for Map for ES2017-kompatibilitet
  const byDepth: Record<number, EjerstrukturNode[]> = {};
  noder.forEach((n) => {
    const d = maxDepth - getDepth(n);
    if (!byDepth[d]) byDepth[d] = [];
    byDepth[d].push(n);
  });

  const COL_W = 160;
  const ROW_H = 80;
  const NODE_W = 140;
  const NODE_H = 54;
  const COLS = maxDepth + 1;

  const totalW = COLS * COL_W + 20;
  const depthValues: EjerstrukturNode[][] = Object.values(byDepth);
  const maxRows = Math.max(...depthValues.map((a: EjerstrukturNode[]) => a.length));
  const totalH = Math.max(maxRows * ROW_H + 20, 160);

  // Beregn x/y per node
  const nodePos: Record<string, { x: number; y: number }> = {};
  Object.entries(byDepth).forEach(([colStr, nodesInCol]: [string, EjerstrukturNode[]]) => {
    const col = Number(colStr);
    const colX = col * COL_W + 10;
    nodesInCol.forEach((node: EjerstrukturNode, rowIdx: number) => {
      const colH = nodesInCol.length * ROW_H;
      const startY = (totalH - colH) / 2;
      nodePos[node.id] = {
        x: colX,
        y: startY + rowIdx * ROW_H,
      };
    });
  });

  /** Farver pr. nodetype */
  const nodeColor: Record<EjerstrukturNode['type'], string> = {
    person: '#ef4444',
    selskab: '#2563eb',
    ejendom: '#475569',
  };

  return (
    <div className="overflow-x-auto">
      <svg width={totalW} height={totalH} className="block">
        {/* Linjer */}
        {noder
          .filter((n) => n.foraeldreId)
          .map((n) => {
            const from = nodePos[n.foraeldreId!];
            const to = nodePos[n.id];
            if (!from || !to) return null;
            const x1 = from.x + NODE_W;
            const y1 = from.y + NODE_H / 2;
            const x2 = to.x;
            const y2 = to.y + NODE_H / 2;
            const mx = (x1 + x2) / 2;
            return (
              <g key={`line-${n.id}`}>
                <path
                  d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke="#334155"
                  strokeWidth={1.5}
                />
                {n.andel !== undefined && (
                  <text
                    x={mx}
                    y={(y1 + y2) / 2 - 5}
                    fill="#64748b"
                    fontSize={10}
                    textAnchor="middle"
                  >
                    {n.andel}%
                  </text>
                )}
              </g>
            );
          })}

        {/* Noder */}
        {noder.map((node) => {
          const pos = nodePos[node.id];
          if (!pos) return null;
          const color = nodeColor[node.type];
          const isEjendom = node.type === 'ejendom';

          return (
            <g key={node.id} transform={`translate(${pos.x}, ${pos.y})`}>
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={isEjendom ? 6 : 8}
                fill={`${color}18`}
                stroke={color}
                strokeWidth={1}
              />
              {/* Ikoncirkel */}
              <circle cx={20} cy={NODE_H / 2} r={12} fill={`${color}30`} />
              <text x={20} y={NODE_H / 2 + 5} textAnchor="middle" fontSize={12} fill={color}>
                {node.type === 'person' ? '👤' : node.type === 'selskab' ? '🏢' : '🏠'}
              </text>

              {/* Navn */}
              <text x={38} y={NODE_H / 2 - 6} fontSize={10} fontWeight="600" fill="#f1f5f9">
                {node.navn.length > 18 ? node.navn.slice(0, 16) + '…' : node.navn}
              </text>
              {/* Titel */}
              <text x={38} y={NODE_H / 2 + 8} fontSize={9} fill="#64748b">
                {node.titel ?? ''}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/**
 * Ejendomsdetaljeside med tabs og kortvisning.
 * @param params - URL params med ejendoms-id (Promise i React 19)
 * @param prefetched - Optional server-side prefetched DAWA + BBR data (eliminerer klient-side waterfall)
 */
export default function EjendomDetaljeClient({
  params,
  prefetched,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[]>>;
  prefetched?: import('./page').PrefetchedPropertyData;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { lang } = useLanguage();
  const da = lang === 'da';
  /** Sæt AI-kontekst når ejendomsdata er tilgængeligt — AI'en kan bruge ID'erne direkte */
  const setAICtx = useSetAIPageContext();
  const tabs = buildTabs(da);

  /** Lokalt oversættelsesobjekt — alle brugervendte strenge på siden */
  const t = {
    // Navigation
    back: da ? 'Ejendomme' : 'Properties',
    backToProperties: da ? 'Tilbage til ejendomme' : 'Back to properties',
    // Header
    report: da ? 'Rapport' : 'Report',
    generating: da ? 'Genererer…' : 'Generating…',
    following: da ? 'Følger' : 'Following',
    follow: da ? 'Følg' : 'Follow',
    fullMap: da ? 'Fuldt kort' : 'Full map',
    openFullMap: da ? 'Åbn på fuldt kort' : 'Open full map',
    // Loading states
    loadingAddress: da ? 'Henter adressedata…' : 'Loading address data…',
    loadingMap: da ? 'Henter kort…' : 'Loading map…',
    addressNotFound: da ? 'Adresse ikke fundet' : 'Address not found',
    addressNotFoundDesc: da
      ? 'Adressen kunne ikke hentes fra DAWA.'
      : 'The address could not be retrieved from DAWA.',
    propertyNotFound: da ? 'Ejendom ikke fundet' : 'Property not found',
    propertyNotFoundDesc: da
      ? 'BFE-nummeret findes ikke i systemet.'
      : 'The BFE number does not exist in the system.',
    // Overblik — Matrikel
    cadastre: da ? 'matrikel' : 'cadastre',
    builtUp: da ? 'bebygget' : 'built-up',
    plotArea: da ? 'Grundareal' : 'Plot area',
    cadastreNr: da ? 'Matrikelnr.' : 'Cadastre no.',
    ejerlav: da ? 'Ejerlav' : 'Land registry district',
    municipality: da ? 'Kommune' : 'Municipality',
    buildingCoverage: da ? 'Bebyggelsesprocent' : 'Building coverage',
    // Overblik — Vurdering
    propertyValuation: da ? 'Ejendomsvurdering' : 'Property valuation',
    propertyValue: da ? 'Ejendomsværdi' : 'Property value',
    landValue: da ? 'Grundværdi' : 'Land value',
    assessedArea: da ? 'Vurderet areal' : 'Assessed area',
    groundTax: da ? 'Grundskyld' : 'Land tax',
    estGroundTax: da ? 'Est. grundskyld' : 'Est. land tax',
    notAssessed: da ? 'Fastsættes ikke' : 'Not assessed',
    taxable: da ? 'Afgiftspligtig' : 'Taxable',
    perYear: da ? '/ år' : '/ year',
    awaitingBBR: da ? 'Afventer BBR-data…' : 'Awaiting BBR data…',
    bfeNotFound: da ? 'BFEnummer ikke fundet' : 'BFE number not found',
    noValuationData: da ? 'Ingen vurderingsdata' : 'No valuation data',
    preliminary: da ? 'FORELØBIG' : 'PRELIMINARY',
    newSystem: da ? 'NY' : 'NEW',
    // Overblik — Bygninger
    buildings: da ? 'bygninger' : 'buildings',
    buildingArea: da ? 'Bygningsareal' : 'Building area',
    residentialArea: da ? 'Beboelsesareal' : 'Residential area',
    commercialArea: da ? 'Erhvervsareal' : 'Commercial area',
    basement: da ? 'Kælder' : 'Basement',
    // Overblik — Enheder
    units: da ? 'enheder' : 'units',
    residentialUnits: da ? 'Beboelsesenheder' : 'Residential units',
    commercialUnits: da ? 'Erhvervsenheder' : 'Commercial units',
    totalUnitArea: da ? 'Samlet enhedsareal' : 'Total unit area',
    // Lejligheder (ejerlejligheder i ejendom)
    apartments: da ? 'Lejligheder' : 'Apartments',
    loadingApartments: da ? 'Henter lejlighedsdata…' : 'Loading apartment data…',
    apartmentAddress: da ? 'Adresse' : 'Address',
    apartmentDescription: da ? 'Type' : 'Type',
    apartmentOwner: da ? 'Ejer' : 'Owner',
    apartmentArea: da ? 'Areal' : 'Area',
    apartmentPrice: da ? 'Købspris' : 'Purchase price',
    apartmentDate: da ? 'Købsdato' : 'Purchase date',
    noApartments: da ? 'Ingen ejerlejligheder fundet.' : 'No condominiums found.',
    // CVR
    companiesAtAddress: da ? 'Virksomheder på adressen' : 'Companies at address',
    cvrAccessRequired: da
      ? 'CVR-opslag kræver gratis adgang til Erhvervsstyrelsens CVR OpenData.'
      : 'CVR lookup requires free access to the Danish Business Authority CVR OpenData.',
    restartDevServer: da ? 'Genstart dev-serveren bagefter.' : 'Restart the dev server afterwards.',
    loadingCVR: da ? 'Henter CVR-data…' : 'Loading CVR data…',
    active: da ? 'aktive' : 'active',
    ceased: da ? 'ophørte' : 'ceased',
    company: da ? 'Virksomhed' : 'Company',
    industry: da ? 'Industri' : 'Industry',
    period: da ? 'Periode' : 'Period',
    employees: da ? 'Ansatte' : 'Employees',
    lessThan1Month: da ? 'Under 1 md.' : 'Less than 1 mo.',
    monthsToNow: da ? 'md. til nu' : 'mo. to date',
    yearsToNow: da ? 'år til nu' : 'yr. to date',
    noCVRFound: da
      ? 'Ingen CVR-registrerede virksomheder fundet på denne adresse.'
      : 'No CVR-registered companies found at this address.',
    historical: da ? 'historiske' : 'historical',
    showHistorical: da ? 'Vis historiske' : 'Show historical',
    hideHistorical: da ? 'Skjul historiske' : 'Hide historical',
    // BBR
    bbrUnavailable: da ? 'BBR-data utilgængelig' : 'BBR data unavailable',
    openDatafordeler: da ? 'Åbn datafordeler.dk →' : 'Open datafordeler.dk →',
    information: da ? 'Information' : 'Information',
    noActiveBuildings: da ? 'Ingen aktive bygninger tilgængelige' : 'No active buildings available',
    nr: da ? 'Nr.' : 'No.',
    usage: da ? 'Anvendelse' : 'Usage',
    builtYear: da ? 'Opf. år' : 'Built',
    builtArea: da ? 'Bebygget' : 'Built area',
    totalArea: da ? 'Samlet' : 'Total',
    geodata: da ? 'Geodata' : 'Geodata',
    status: da ? 'Status' : 'Status',
    erected: da ? 'Opført' : 'Erected',
    projected: da ? 'Projekteret' : 'Projected',
    underConstruction: da ? 'Under opførelse' : 'Under construction',
    temporary: da ? 'Midlertidig' : 'Temporary',
    condemned: da ? 'Kondemneret' : 'Condemned',
    // BBR detaljer
    outerWall: da ? 'Ydervæg' : 'Outer wall',
    roofMaterial: da ? 'Tagmateriale' : 'Roof material',
    heatingInstallation: da ? 'Varmeinstallation' : 'Heating installation',
    heatingForm: da ? 'Opvarmningsform' : 'Heating type',
    supplementaryHeat: da ? 'Supplerende varme' : 'Supplementary heat',
    waterSupply: da ? 'Vandforsyning' : 'Water supply',
    drainage: da ? 'Afløb' : 'Drainage',
    floors: da ? 'Etager' : 'Floors',
    residentialAreaLabel: da ? 'Boligareal' : 'Residential area',
    commercialAreaLabel: da ? 'Erhvervsareal' : 'Commercial area',
    commercialUnitsLabel: da ? 'Erhvervsenheder' : 'Commercial units',
    renovationYear: da ? 'Ombygningsår' : 'Renovation year',
    preservation: da ? 'Fredning' : 'Preservation',
    conservationValue: da ? 'Bevaringsværdighed' : 'Conservation value',
    // Enheder
    totalUnits: da ? 'Enheder i alt' : 'Total units',
    totalAreaLabel: da ? 'Samlet areal' : 'Total area',
    noUnitsAvailable: da ? 'Ingen enheder tilgængelige' : 'No units available',
    bldg: da ? 'Byg.' : 'Bldg.',
    area: da ? 'Areal' : 'Area',
    rooms: da ? 'Værelser' : 'Rooms',
    address: da ? 'Adresse' : 'Address',
    floor: da ? 'Etage' : 'Floor',
    door: da ? 'Dør' : 'Door',
    housingType: da ? 'Boligtype' : 'Housing type',
    energySupply: da ? 'Energiforsyning' : 'Energy supply',
    // BBR — ingen data
    bbrDataUnavailable: da ? 'BBR-data utilgængelig' : 'BBR data unavailable',
    bbrSubscriptionRequired: da
      ? 'BBR-data kræver et aktivt abonnement på BBRPublic-tjenesten på datafordeler.dk.'
      : 'BBR data requires an active subscription to the BBRPublic service on datafordeler.dk.',
    // Matrikel
    cadastreInfo: da ? 'Matrikeloplysninger' : 'Cadastre information',
    loadingCadastre: da ? 'Henter matrikeldata…' : 'Loading cadastre data…',
    agriculturalNote: da ? 'Landbrugsnotering' : 'Agricultural note',
    condominiums: da ? 'Ejerlejligheder' : 'Condominiums',
    dividedIntoCondominiums: da ? 'Opdelt i ejerlejligheder' : 'Divided into condominiums',
    commonLot: da ? 'Fælleslod' : 'Common lot',
    yes: da ? 'Ja' : 'Yes',
    separatedRoad: da ? 'Udskilt vej' : 'Separated road',
    parcels: da ? 'Jordstykker' : 'Parcels',
    noCadastreData: da ? 'Ingen matrikeldata fundet' : 'No cadastre data found',
    protectedForest: da ? 'Fredskov' : 'Protected forest',
    coastalProtection: da ? 'Strandbeskyttelse' : 'Coastal protection',
    duneProtection: da ? 'Klitfredning' : 'Dune protection',
    groundRent: da ? 'Jordrente' : 'Ground rent',
    road: da ? 'Vej' : 'Road',
    // Ejerforhold
    ownerRegistry: da ? 'Ejerfortegnelse · Datafordeler' : 'Owner Registry · Datafordeler',
    loadingOwners: da ? 'Henter ejerdata…' : 'Loading owner data…',
    bfeUnavailable: da ? 'BFEnummer ikke tilgængeligt' : 'BFE number unavailable',
    bbrMissing: da
      ? 'BBR-data mangler — DATAFORDELER_API_KEY er sandsynligvis ikke sat i .env.local'
      : 'BBR data missing — DATAFORDELER_API_KEY is likely not set in .env.local',
    bbrRelationFailed: da
      ? 'BBR ejendomsrelation mislykkedes — tjenesten er muligvis ikke aktiveret'
      : 'BBR property relation query failed — the service may not be activated',
    noRelationFound: da
      ? 'Ingen ejendomsrelation fundet for denne adresse'
      : 'No property relation found for this address',
    checkThreePoints: da
      ? 'Tjek disse 3 punkter på datafordeler.dk:'
      : 'Check these 3 points on datafordeler.dk:',
    bbrPublicActivated: da
      ? 'BBRPublic — aktiveret i Datafordeler-bruger'
      : 'BBRPublic — activated in Datafordeler user',
    propertyLocationAddress: da
      ? 'EjendomsBeliggenhedsAdresse — aktiveret under Ejerfortegnelse'
      : 'PropertyLocationAddress — activated under Owner Registry',
    propertyValuationActivated: da
      ? 'Ejendomsvurdering — aktiveret under HentEjendomsvurdering'
      : 'Property valuation — activated under HentEjendomsvurdering',
    goToDatafordeler: da
      ? 'Gå til datafordeler.dk → Ejendomme →'
      : 'Go to datafordeler.dk → Properties →',
    accessMissing: da
      ? 'Dataadgang mangler — Ejerfortegnelse (EJF)'
      : 'Data access missing — Owner Registry (EJF)',
    oauthValid: da
      ? 'OAuth-token er gyldigt, men adgang til EJF kræver en godkendt Dataadgang-ansøgning hos Geodatastyrelsen.'
      : 'OAuth token is valid, but access to EJF requires an approved Data Access application from the Geodatastyrelsen.',
    applyAccess: da
      ? 'Ansøg om adgang til EJF på datafordeler.dk →'
      : 'Apply for access to EJF on datafordeler.dk →',
    companyType: da ? 'Selskab' : 'Company',
    personType: da ? 'Person' : 'Person',
    privatePerson: da ? 'Privat person' : 'Private person',
    ownerSince: da ? 'Ejer siden' : 'Owner since',
    share: da ? 'Andel' : 'Share',
    noOwnerDataFound: da
      ? 'Ingen ejerdata fundet via Datafordeler'
      : 'No owner data found via Datafordeler',
    // Tinglysning
    landRegistry: da ? 'Tinglysning' : 'Land Registry',
    landRegistryDesc: da
      ? 'Historiske adkomster og skøder kræver adgang til Tinglysning.dk REST API (backlog).'
      : 'Historical deeds and titles require access to the Tinglysning.dk REST API (backlog).',
    landRegistryFullDesc: da
      ? 'Hæftelser, pantegæld og servitutter hentes via Tinglysning.dk. Kræver abonnement på tingbogsattest-tjenesten.'
      : 'Encumbrances, mortgages and easements are fetched via Tinglysning.dk. Requires subscription to the land register service.',
    // Økonomi
    loadingValuation: da ? 'Henter vurderingsdata…' : 'Loading valuation data…',
    valuationHistory: da ? 'Vurderingshistorik' : 'Valuation history',
    yearCol: da ? 'Aar' : 'Year',
    propertyValueCol: da ? 'Ejendomsvaerdi' : 'Property value',
    landValueCol: da ? 'Grundvaerdi' : 'Land value',
    plotAreaCol: da ? 'Grundareal' : 'Plot area',
    bfeRequired: da
      ? '{da ? "Ejendomsvurdering kræver BFEnummer fra BBR Ejendomsrelation." : "Property valuation requires BFE number from BBR property relation."}'
      : 'Property valuation requires BFE number from BBR Property Relation.',
    noValuationFound: da ? 'Ingen vurderingsdata fundet' : 'No valuation data found',
    // Salgshistorik
    salesHistory: da ? 'Salgshistorik' : 'Sales history',
    loadingSalesHistory: da ? 'Henter salgshistorik…' : 'Loading sales history…',
    accessAwaitingApproval: da ? 'Adgang afventer godkendelse' : 'Access awaiting approval',
    salesHistoryEJF: da
      ? 'Salgshistorik kræver EJF-adgang fra Geodatastyrelsen via datafordeler.dk.'
      : 'Sales history requires EJF access from Geodatastyrelsen via datafordeler.dk.',
    date: da ? 'Dato' : 'Date',
    type: da ? 'Type' : 'Type',
    purchasePrice: da ? 'Købesum' : 'Purchase price',
    cashPrice: da ? 'Kontant' : 'Cash',
    noTransactions: da
      ? 'Ingen handler registreret for denne ejendom'
      : 'No transactions recorded for this property',
    buyerName: da ? 'Køber' : 'Buyer',
    deedType: da ? 'Adkomst' : 'Deed type',
    registrationDate: da ? 'Tinglyst' : 'Registered',
    registrationFee: da ? 'Tinglysningsafgift' : 'Registration fee',
    loesoereSum: da ? 'Løsøre' : 'Movables',
    entrepriseSum: da ? 'Entreprise' : 'Construction',
    overtagelsesdato: da ? 'Overtagelse' : 'Possession',
    mortgages: da ? 'Hæftelser & Pantebreve' : 'Mortgages & Charges',
    noMortgages: da ? 'Ingen hæftelser tinglyst' : 'No mortgages registered',
    principalAmount: da ? 'Hovedstol' : 'Principal',
    interestRate: da ? 'Rente' : 'Interest',
    loanType: da ? 'Låntype' : 'Loan type',
    totalDebt: da ? 'Samlet pantegæld' : 'Total mortgage debt',
    loanToValue: da ? 'Belåningsgrad' : 'Loan-to-value',
    loadingTinglysning: da ? 'Henter tinglysningsdata…' : 'Loading land registry data…',
    // Udbudshistorik
    listingHistory: da ? 'Udbudshistorik' : 'Listing history',
    listingPricesAndStatus: da ? 'Udbudspriser og status' : 'Listing prices and status',
    listingHistoryDesc: da
      ? 'Udbudshistorik med prisændringer og handelstyper kræver markedsdata-integration (backlog).'
      : 'Listing history with price changes and deal types requires market data integration (backlog).',
    noListingHistory: da ? 'Ingen udbudshistorik registreret' : 'No listing history recorded',
    // Lignende handler
    comparableSales: da ? 'Lignende handler' : 'Comparable sales',
    comparableSalesInArea: da
      ? 'Sammenlignelige handler i området'
      : 'Comparable sales in the area',
    comparableSalesDesc: da
      ? 'Kvadratmeterpriser og handler for lignende ejendomme kræver markedsdata-integration (backlog).'
      : 'Square metre prices and sales for comparable properties require market data integration (backlog).',
    // SKAT
    propertyTaxes: da ? 'Ejendomsskatter' : 'Property taxes',
    noTaxData: da ? 'Ingen skattedata tilgængelig' : 'No tax data available',
    currentTaxation: da ? 'Nuværende beskatning' : 'Current taxation',
    groundTaxToMunicipality: da ? 'Grundskyld til kommunen' : 'Land tax to municipality',
    propertyValueTax: da ? 'Ejendomsværdiskat' : 'Property value tax',
    propertyValueTaxExempt: da ? 'Ejendomsværdiskat (fritaget)' : 'Property value tax (exempt)',
    totalTax: da ? 'Totale skat' : 'Total tax',
    taxBreakdownKoloni: da
      ? '(kun grundskyld — fritaget for ejendomsværdiskat)'
      : '(land tax only — property value tax exempt)',
    taxBreakdownNormal: da ? '(grundskyld + ejendomsværdiskat)' : '(land tax + property value tax)',
    koloniTooltip: da
      ? 'Kolonihavehuse ikke må bruges til helårsbeboelse og er derfor undtaget ejendomsværdiskat jf. kolonihavelovens § 2.'
      : 'Allotment houses may not be used for year-round habitation and are therefore exempt from property value tax per the Allotment Act § 2.',
    // Dokumenter
    documents: da ? 'Dokumenter' : 'Documents',
    loading: da ? 'Henter…' : 'Loading…',
    selectDocsToDownload: da
      ? 'Vælg dokumenter med checkboks for at downloade'
      : 'Select documents with checkbox to download',
    downloadSelected: da ? 'Download valgte' : 'Download selected',
    yearLabel: da ? 'År' : 'Year',
    document: da ? 'Dokument' : 'Document',
    statusLabel: da ? 'Status' : 'Status',
    docLabel: da ? 'Dok.' : 'Doc.',
    bbrNotice: da ? 'BBR-meddelelse' : 'BBR notice',
    soilContamination: da ? 'Jordforureningsattest' : 'Soil contamination certificate',
    notMapped: da ? 'Ikke kortlagt' : 'Not mapped',
    error: da ? 'Fejl' : 'Error',
    cadastreMap: da ? 'Matrikelkort' : 'Cadastre map',
    protectedBuilding: da ? 'Fredet bygning' : 'Protected building',
    protected: da ? 'Fredet' : 'Protected',
    plans: da ? 'Planer' : 'Plans',
    noPlansFound: da ? 'Ingen planer fundet for denne adresse' : 'No plans found for this address',
    generalUsage: da ? 'Generel anvendelse' : 'General usage',
    subAreaNo: da ? 'Delområdenummer' : 'Sub-area number',
    maxBuildingCoverage: da ? 'Maks. bebyggelsesprocent' : 'Max. building coverage',
    maxFloors: da ? 'Maks. antal etager' : 'Max. floors',
    maxBuildingHeight: da ? 'Maks. bygningshøjde' : 'Max. building height',
    minPlotSubdivision: da
      ? 'Min. grundstørrelse ved udstykning'
      : 'Min. plot size for subdivision',
    proposalDate: da ? 'Forslagsdato' : 'Proposal date',
    approvalDate: da ? 'Vedtagelsesdato' : 'Approval date',
    effectiveDate: da ? 'Dato trådt i kraft' : 'Effective date',
    startDate: da ? 'Startdato' : 'Start date',
    endDate: da ? 'Slutdato' : 'End date',
    noAdditionalDetails: da
      ? 'Ingen yderligere detaljer tilgængelige'
      : 'No additional details available',
    // Energi
    energyReports: da ? 'Energimærkerapporter' : 'Energy label reports',
    noEnergyLabels: da
      ? 'Ingen energimærker registreret for denne ejendom'
      : 'No energy labels registered for this property',
    classLabel: da ? 'Klasse' : 'Class',
    validFrom: da ? 'Gyldig fra' : 'Valid from',
    validTo: da ? 'Gyldig til' : 'Valid to',
    reportLabel: da ? 'Rapport' : 'Report',
    buildingLabel: da ? 'Bygning' : 'Building',
    buildingsLabel: da ? 'bygninger' : 'buildings',
    // Jordforurening detaljer
    mappingStatus: da ? 'Kortlægningsstatus' : 'Mapping status',
    nuance: da ? 'Nuancering' : 'Nuance',
    locationRef: da ? 'Lokationsreference' : 'Location reference',
    location: da ? 'Lokation' : 'Location',
    otherLocations: da ? 'Øvrige lokationer' : 'Other locations',
    reevalDate: da ? 'Genvurderingsdato' : 'Re-evaluation date',
    lastModified: da ? 'Senest ændret' : 'Last modified',
    cadastreLabel: da ? 'Matrikel' : 'Cadastre',
    region: da ? 'Region' : 'Region',
    municipalityCode: da ? 'Kommunekode' : 'Municipality code',
    housingStatement: da ? 'Boligudtalelse' : 'Housing statement',
    // Mock-specifikke
    landPlots: da ? 'Jordstykker' : 'Land plots',
    cadastres: da ? 'Matrikler' : 'Cadastres',
    atticUsed: da ? 'Udnyttet tagetage' : 'Attic used',
    unit: da ? 'enhed' : 'unit',
    building: da ? 'bygning' : 'building',
    owners: da ? 'Ejere' : 'Owners',
    latestTransaction: da ? 'Seneste handel' : 'Latest transaction',
    pricePerSqm: da ? 'Pris/m²' : 'Price/m²',
    annualTax: da ? 'Årlig' : 'Annual',
    latestValuation: da ? 'Seneste vurdering' : 'Latest valuation',
    totalTaxLabel: da ? 'Skat i alt' : 'Total tax',
    environmentalIndicators: da ? 'Miljøindikatorer' : 'Environmental indicators',
    companies: da ? 'virksomheder' : 'companies',
    // Mock — Ejerforhold
    owner: da ? 'Ejer' : 'Owner',
    primaryContact: da ? 'Primær kontakt' : 'Primary contact',
    adBlocked: da ? 'Reklamebeskyttet' : 'Ad-protected',
    acquisitionDate: da ? 'Overtagelsesdato' : 'Acquisition date',
    ownerType: da ? 'Ejertype' : 'Owner type',
    branchName: da ? 'Branchenavn' : 'Industry',
    phone: da ? 'Telefon' : 'Phone',
    email: da ? 'E-mail' : 'Email',
    signingRule: da ? 'Tegningsregel' : 'Signing rule',
    ownershipStructure: da ? 'Ejerstruktur' : 'Ownership structure',
    keyFigures: da ? 'Nøgletal' : 'Key figures',
    incomeStatement: da ? 'Resultatopgørelse' : 'Income statement',
    profitBeforeTax: da ? 'Resultat før skat' : 'Profit before tax',
    result: da ? 'Resultat' : 'Result',
    currentOwners: da ? 'Nuværende ejere' : 'Current owners',
    privatPerson: da ? 'Privatperson' : 'Private person',
    acquired: da ? 'Erhvervet' : 'Acquired',
    ownershipShare: da ? 'ejerandel' : 'ownership share',
    // Mock — Tinglysning
    landRegisterCert: da ? 'Tingbogsattest' : 'Land register certificate',
    titleHolder: da ? 'Adkomsthaver' : 'Title holder',
    historicalTitles: da ? 'Historiske adkomster' : 'Historical titles',
    encumbrances: da ? 'Hæftelser' : 'Encumbrances',
    priority: da ? 'Prioritet' : 'Priority',
    creditor: da ? 'Kreditor' : 'Creditor',
    debtor: da ? 'Debitor' : 'Debtor',
    principal: da ? 'Hovedstol' : 'Principal',
    amount: da ? 'Beløb' : 'Amount',
    // Mock — Økonomi
    priceHistory: da ? 'Prishistorik' : 'Price history',
    buyer: da ? 'Køber' : 'Buyer',
    priceChange: da ? 'Prisændring' : 'Price change',
    price: da ? 'Pris' : 'Price',
    // Mock — Dokumenter
    standardDocs: da ? 'Stamdokumenter' : 'Standard documents',
    name: da ? 'Navn' : 'Name',
    servitutNote: da
      ? 'Servitutter: Ejendommen har ingen elektroniske servitutdokumenter at downloade...'
      : 'Easements: The property has no electronic easement documents to download...',
    // Rapport download fejl
    reportDownloadFailed: da ? 'Rapport-download fejlede' : 'Report download failed',
    unknownError: da ? 'Ukendt fejl' : 'Unknown error',
    unknownAddress: da ? 'Ukendt adresse' : 'Unknown address',
    zipDownloadFailed: da ? 'ZIP-download fejlede' : 'ZIP download failed',
    noDirectPdfLinks: da
      ? 'De valgte dokumenter har ingen direkte PDF-links der kan downloades.'
      : 'The selected documents have no direct PDF links that can be downloaded.',
    zipDownloaded: da
      ? 'ZIP-filen er hentet, men følgende dokumenter kunne ikke inkluderes (ikke en gyldig PDF):'
      : 'The ZIP file has been downloaded, but the following documents could not be included (not a valid PDF):',
    tryOpenInBrowser: da
      ? 'Prøv at åbne dem direkte i browseren.'
      : 'Try opening them directly in the browser.',
    // Ejerforhold koder
    ownerRelation10: da ? 'Privatpersoner eller I/S' : 'Private persons or partnership',
    ownerRelation20: da ? 'A/S, ApS eller P/S' : 'Corp., Ltd., or partnership',
    ownerRelation30: da
      ? 'Forening, legat eller selvejende inst.'
      : 'Association, trust or self-governing inst.',
    ownerRelation40: da ? 'Offentlig myndighed' : 'Public authority',
    ownerRelation41: da ? 'Staten' : 'The State',
    ownerRelation50: da ? 'Andelsboligforening' : 'Housing cooperative',
    ownerRelation60: da ? 'Almennyttigt boligselskab' : 'Public housing association',
    ownerRelation70: da ? 'Fond' : 'Foundation',
    ownerRelation80: da ? 'Andet' : 'Other',
    // Slots- og kulturstyrelsen
    slotsOgKultur: da ? 'Slots- og Kulturstyrelsen' : 'Agency for Culture and Palaces',
  };

  const [aktivTab, setAktivTab] = useState<Tab>('overblik');
  const [valgteDoc, setValgteDoc] = useState<Set<string>>(new Set());

  /**
   * JS-baseret xl-breakpoint detektion (≥1280px).
   * Erstatter Tailwind `hidden xl:flex` som Turbopack ikke genererer korrekt
   * ved client-side navigation (FOUC i dev-mode).
   */
  const [visKort, setVisKort] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 900px)');
    setVisKort(mq.matches);
    const handler = (e: MediaQueryListEvent) => setVisKort(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  /**
   * Styrer om mobil-kortoverlay er åbent.
   * Kun relevant på skærme under 900px hvor det normale kortpanel er skjult.
   */
  const [mobilKortAaben, setMobilKortAaben] = useState(false);

  /**
   * Styrer om kortpanelet er synligt på desktop.
   * Brugeren kan toggle panelet via "Kort"-knappen i headeren.
   * Har ingen effekt på mobil (mobilKortAaben styrer overlay der).
   */
  const [kortPanelÅben, setKortPanelÅben] = useState(true);

  /**
   * Kortpanel-bredde i px — kan trækkes af brugeren via adskillelseslinien.
   * Standard 380 px, min 200 px, max 900 px.
   */
  const [kortBredde, setKortBredde] = useState(380);

  /**
   * True mens brugeren trækker adskillelseslinien.
   * Aktiverer globale mousemove/mouseup-handlers via useEffect.
   */
  const [trækker, setTrækker] = useState(false);

  /**
   * Gemmer startpunktet for en drag-operation.
   * Bruger ref i stedet for state for at undgå re-renders under drag.
   */
  const trækStart = useRef<{ x: number; bredde: number } | null>(null);

  /**
   * Globale drag-handlers — kun aktive mens trækker === true.
   * Beregner ny kortbredde som startBredde + (startX − currentX),
   * dvs. bevægelse mod venstre øger kortbredden og omvendt.
   */
  useEffect(() => {
    if (!trækker) return;
    function onMove(e: MouseEvent) {
      if (!trækStart.current) return;
      const delta = trækStart.current.x - e.clientX;
      const nyBredde = Math.min(900, Math.max(200, trækStart.current.bredde + delta));
      setKortBredde(nyBredde);
    }
    function onUp() {
      setTrækker(false);
      trækStart.current = null;
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [trækker]);

  // DAWA-tilstand — kun aktiv når id er et DAWA UUID
  // Hvis server-side prefetch leverede data, brug det som initial state
  const [dawaAdresse, setDawaAdresse] = useState<DawaAdresse | null>(
    prefetched?.dawaAdresse ?? null
  );
  const [dawaJordstykke, setDawaJordstykke] = useState<DawaJordstykke | null>(null);
  // true = loader, false = fejl, null = idle/done
  const [dawaStatus, setDawaStatus] = useState<'loader' | 'fejl' | 'ok' | 'idle'>(
    prefetched?.dawaAdresse ? 'ok' : 'idle'
  );

  /** BBR data fra server-side API-route — null = ikke hentet / ikke tilgængeligt */
  const [bbrData, setBbrData] = useState<EjendomApiResponse | null>(prefetched?.bbrData ?? null);
  /** True mens BBR-data hentes */
  const [bbrLoader, setBbrLoader] = useState(false);

  /** Tinglysningsdata — tinglyst areal, fordelingstal, ejerlejlighedsnr */
  const [tinglysningData, setTinglysningData] = useState<{
    tinglystAreal: number | null;
    ejerlejlighedNr: number | null;
    fordelingstal: { taeller: number; naevner: number } | null;
  } | null>(null);

  /** ESR-nummer (kommuneNummer-ejendomsnummer) fra Tinglysning */
  const [esrNummer, setEsrNummer] = useState<string | null>(null);

  /** Tinglysning adkomster (ejerskifter) — bruges til at berige salgshistorik med købernavne */
  const [tlEjere, setTlEjere] = useState<TLEjer[]>([]);
  /** Tinglysning hæftelser — pantebreve og lån tinglyst på ejendommen */
  const [tlHaeftelser, setTlHaeftelser] = useState<TLHaeftelse[]>([]);
  /** True mens tinglysning summarisk data hentes */
  const [tlSumLoader, setTlSumLoader] = useState(false);
  /** True når tinglysningsdata er fra test-fallback BFE (ikke den rigtige ejendom) */
  const [tlTestFallback, setTlTestFallback] = useState(false);

  /** CVR-virksomheder registreret på adressen */
  const [cvrVirksomheder, setCvrVirksomheder] = useState<CVRVirksomhed[] | null>(null);
  /** BIZZ-473: True when CVR fetch has completed (success or error). Used to prevent
   * flicker where the section appears briefly then disappears if no companies found. */
  const [cvrFetchComplete, setCvrFetchComplete] = useState(false);
  /** True hvis CVR_ES_USER/PASS mangler i .env.local */
  const [cvrTokenMangler, setCvrTokenMangler] = useState(false);
  /** True hvis CVR ElasticSearch API er utilgængeligt (timeout/nedbrud) */
  const [cvrApiDown, setCvrApiDown] = useState(false);
  /** Vis ophørte virksomheder i CVR-sektionen */
  const [visOphoerte, setVisOphoerte] = useState(false);

  /** Ejerlejligheder i ejendommen (null = ikke hentet, [] = ingen fundet) */
  const [lejligheder, setLejligheder] = useState<
    import('@/app/api/ejerlejligheder/route').Ejerlejlighed[] | null
  >(null);
  /** True mens lejlighedsdata hentes */
  const [lejlighederLoader, setLejlighederLoader] = useState(false);

  /** Ejendomsvurderingsdata fra Datafordeler — null = ikke hentet endnu */
  const [vurdering, setVurdering] = useState<VurderingData | null>(null);
  /** Alle vurderinger fra Datafordeler — bruges til historiktabel */
  const [alleVurderinger, setAlleVurderinger] = useState<VurderingData[]>([]);
  /** BIZZ-494: Fradrag for forbedringer (vej/kloak) — vises under Grundværdi i Økonomi-tab */
  const [vurFradrag, setVurFradrag] = useState<VurderingResponse['fradrag']>(null);
  /** BIZZ-493: Ejerboligfordeling — vises som kort i Økonomi-tab for ejerlejlighedskomplekser */
  const [vurFordeling, setVurFordeling] = useState<VurderingResponse['fordeling']>([]);
  /** BIZZ-492: Grundværdispecifikation — nedbrydning af grundværdiberegning */
  const [vurGrundvaerdispec, setVurGrundvaerdispec] = useState<
    VurderingResponse['grundvaerdispec']
  >([]);
  /** BIZZ-491: Skattefritagelser for nyeste vurdering */
  const [vurFritagelser, setVurFritagelser] = useState<VurderingResponse['fritagelser']>([]);
  /** BIZZ-490: Loftansættelse (grundskatteloft, ESL §45 4,75%-loft) — vises i SKAT-tab */
  const [vurLoft, setVurLoft] = useState<VurderingResponse['loft']>([]);
  /** True mens vurderingsdata hentes — starter som true når prefetch giver BBR data med det samme */
  const [vurderingLoader, setVurderingLoader] = useState(!!prefetched?.bbrData);
  /** True = vis fuld vurderingshistorik-tabel */
  const [visVurderingHistorik, setVisVurderingHistorik] = useState(false);

  /** Ejere fra Ejerfortegnelsen (Datafordeler) */
  const [_ejereEjf, setEjere] = useState<EjerData[] | null>(null);
  /** True mens ejerdata hentes — starter som true når prefetched data medfører at ejerskab-fetch kører med det samme */
  const [ejereLoader, setEjereLoader] = useState(!!prefetched?.bbrData);
  /** True hvis Datafordeler returnerer 403 — Dataadgang-ansøgning mangler for EJF */
  const [_manglerEjereAdgang, setManglerEjereAdgang] = useState(false);

  /** BBR-tab: ID'er på bygningsrækker der er foldet ud */
  const [expandedBygninger, setExpandedBygninger] = useState<Set<string>>(new Set());
  /** BBR-tab: ID'er på enhedsrækker der er foldet ud */
  const [expandedEnheder, setExpandedEnheder] = useState<Set<string>>(new Set());

  /** Plandata (lokalplaner + kommuneplanrammer) for ejendommen */
  const [plandata, setPlandata] = useState<PlandataItem[] | null>(null);
  /** True mens plandata hentes */
  const [plandataLoader, setPlandataLoader] = useState(false);
  /** Fejlbesked fra plandata-endpoint */
  const [plandataFejl, setPlandataFejl] = useState<string | null>(null);

  /** Energimærkerapporter fra Energistyrelsen EMOData */
  const [energimaerker, setEnergimaerker] = useState<EnergimaerkeItem[] | null>(null);
  /** True mens energimærker hentes */
  const [energiLoader, setEnergiLoader] = useState(false);
  /** True = EMO_USERNAME/PASSWORD mangler i .env.local */
  const [energiManglerAdgang, setEnergiManglerAdgang] = useState(false);
  /** Fejlbesked fra energimærke-endpoint */
  const [energiFejl, setEnergiFejl] = useState<string | null>(null);
  /** ID'er på plan-rækker der er foldet ud i detaljevisning */
  const [expandedPlaner, setExpandedPlaner] = useState<Set<string>>(new Set());

  /** Salgshistorik fra EJF Datafordeler — handler med prisdata */
  const [salgshistorik, setSalgshistorik] = useState<HandelData[] | null>(null);
  /** True mens salgshistorik hentes */
  const [salgshistorikLoader, setSalgshistorikLoader] = useState(false);
  /** True hvis EJF-adgang mangler hos Geodatastyrelsen */
  const [salgshistorikManglerAdgang, setSalgshistorikManglerAdgang] = useState(false);

  /** Jordforureningsdata fra DkJord API — null = ikke hentet endnu */
  const [jordData, setJordData] = useState<JordParcelItem[] | null>(null);
  /** True mens jordforureningsdata hentes */
  const [jordLoader, setJordLoader] = useState(false);
  /** True = matriklen har ingen forureningsregistreringer */
  const [jordIngenData, setJordIngenData] = useState(false);
  /** Fejlbesked fra jord-endpoint */
  const [jordFejl, setJordFejl] = useState<string | null>(null);

  /** Forelobige vurderinger fra Vurderingsportalen — separat fra Datafordeler-vurderinger */
  const [forelobige, setForelobige] = useState<ForelobigVurdering[]>([]);
  /** True mens forelobige vurderinger hentes */
  const [forelobigLoader, setForelobigLoader] = useState(false);
  /** Matrikeldata fra Datafordeler MAT-registret */
  const [matrikelData, setMatrikelData] = useState<MatrikelEjendom | null>(null);
  /** True mens matrikeldata hentes */
  const [matrikelLoader, setMatrikelLoader] = useState(false);
  /** BIZZ-500: Matrikel-historik (udstykninger, sammenlægninger, arealændringer) */
  const [matrikelHistorik, setMatrikelHistorik] = useState<MatrikelHistorikEvent[]>([]);
  /** True mens matrikel-historik hentes */
  const [historikLoader, setHistorikLoader] = useState(false);
  /** Om matrikel-historik sektionen er åben (collapsible) */
  const [historikOpen, setHistorikOpen] = useState(false);
  /** ID'er på jord-rækker der er foldet ud */
  const [expandedJord, setExpandedJord] = useState<Set<string>>(new Set());

  const erDAWA = erDawaId(id);

  /** Om ejendommen er fulgt af brugeren — synkroniseret med localStorage */
  const [erFulgt, setErFulgt] = useState(false);
  /** True mens Følg/Følger-toggle-request er i gang — forhindrer dobbeltklik */
  const [foelgToggling, setFoelgToggling] = useState(false);
  /** Vis Følg-tooltip med info om overvåget data */
  const [visFoelgTooltip, setVisFoelgTooltip] = useState(false);

  /** Indlaes tracking-tilstand ved mount og lyt efter aendringer.
   *  Viser cached vaerdi med det samme, derefter opdaterer fra Supabase. */
  useEffect(() => {
    let ignore = false;
    // Instant render from cache
    setErFulgt(erTracked(id));
    // Then verify against Supabase — skip update if component unmounted or toggle in progress
    fetchErTracked(id)
      .then((v) => {
        if (!ignore && !foelgToggling) setErFulgt(v);
      })
      .catch(() => {});
    const handler = () => {
      if (ignore || foelgToggling) return;
      setErFulgt(erTracked(id));
      fetchErTracked(id)
        .then((v) => {
          if (!ignore && !foelgToggling) setErFulgt(v);
        })
        .catch(() => {});
    };
    window.addEventListener('ba-tracked-changed', handler);
    window.addEventListener('storage', handler);
    return () => {
      ignore = true;
      window.removeEventListener('ba-tracked-changed', handler);
      window.removeEventListener('storage', handler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /**
   * Sæt AI-kontekst når DAWA-adresse og BBR-data er tilgængeligt.
   * AI-assistenten kan dermed bruge BFE-nummer, adresse-ID og matrikeldata
   * direkte i sine tool-kald uden at søge efter dem.
   */
  useEffect(() => {
    if (!bbrData) return;
    const rel = bbrData.ejendomsrelationer?.[0];
    const bfeNummer = rel?.bfeNummer ? String(rel.bfeNummer) : undefined;
    const ejerlavKode = rel?.ejerlavKode ? String(rel.ejerlavKode) : undefined;
    const matrikelnr = rel?.matrikelnr ?? undefined;
    const adresseId = dawaAdresse?.id ?? undefined;
    const kommunekode = dawaJordstykke?.kommune?.kode
      ? String(dawaJordstykke.kommune.kode).padStart(4, '0')
      : undefined;
    const adresseStr = dawaAdresse
      ? [dawaAdresse.vejnavn, dawaAdresse.husnr, dawaAdresse.postnr, dawaAdresse.postnrnavn]
          .filter(Boolean)
          .join(' ')
      : undefined;
    setAICtx({
      adresse: adresseStr,
      adresseId,
      bfeNummer,
      kommunekode,
      matrikelnr,
      ejerlavKode,
    });
  }, [bbrData, dawaAdresse, dawaJordstykke, setAICtx]);

  /**
   * Detekterer om ejendommen er en kolonihave/fritidshytte på lejet grund.
   * BBR koder: 520 = Kolonihavehus, 540 = Campinghytte (bruges ofte for kolonihaver).
   * Kolonihaver på lejet grund er fritaget for ejendomsværdiskat
   * jf. EVL § 9, stk. 1, nr. 6 og Kolonihaveloven § 2.
   * Grundskyld betales af grundejer (typisk kommunen/foreningen), ikke den enkelte haveejer.
   */
  const KOLONIHAVE_KODER = new Set([520, 540]);
  const erKolonihave =
    bbrData?.bbr?.some(
      (b: LiveBBRBygning) => b.anvendelseskode != null && KOLONIHAVE_KODER.has(b.anvendelseskode)
    ) ?? false;

  // Grundskyld stigningsbegrænsning (4,75% loft, ESL § 45) — fjernet fra UI.
  // Kræver historisk grundskyld-data for korrekt beregning. Se backlog.

  /**
   * Memoized filtered BBR-bygningspunkter til PropertyMap.
   * Stable reference prevents PropertyMap (memo'd) from re-rendering when the parent
   * re-renders — without this the inline .filter() would create a new array each time.
   */
  const aktiveBygningPunkter = useMemo(
    () =>
      bbrData?.bygningPunkter?.filter(
        (p) =>
          p.status !== 'Nedrevet/slettet' &&
          p.status !== 'Bygning nedrevet' &&
          p.status !== 'Bygning bortfaldet'
      ) ?? undefined,
    [bbrData?.bygningPunkter]
  );

  /**
   * Memoized callback til PropertyMap — navigerer til en anden ejendom ved klik på markør.
   * Stabil reference forhindrer unødvendig genrendering af det memoized PropertyMap.
   *
   * @param newId - BFE-nummer eller DAWA UUID for den valgte ejendom
   */
  const handleAdresseValgt = useCallback(
    (newId: string) => {
      router.push(`/dashboard/ejendomme/${newId}`);
    },
    [router]
  );

  /**
   * Memoized callback til PropertyMap i mobil-kortoverlay.
   * Lukker overlayet og navigerer til den valgte ejendom.
   *
   * @param newId - BFE-nummer eller DAWA UUID for den valgte ejendom
   */
  const handleAdresseValgtMobil = useCallback(
    (newId: string) => {
      setMobilKortAaben(false);
      router.push(`/dashboard/ejendomme/${newId}`);
    },
    [router]
  );

  /**
   * Henter DAWA-adresse og jordstykke.
   * Skippes hvis server-side prefetch allerede leverede data (dawaAdresse er sat).
   * Al setState sker i async then-callback — ikke synkront.
   * AbortController sikrer at forældede svar fra tidligere navigation ignoreres.
   */
  useEffect(() => {
    if (!erDAWA) return;
    // Skip DAWA fetch hvis server-side prefetch allerede leverede adressen
    if (prefetched?.dawaAdresse) {
      // Stadig hent jordstykke (ikke prefetched) og gem besøg
      const adr = prefetched.dawaAdresse;
      const adresseLabel = adr.etage
        ? `${adr.vejnavn} ${adr.husnr}, ${adr.etage}.${adr.dør ? ` ${adr.dør}` : ''}`
        : adr.adressebetegnelse.split(',')[0];
      gemRecentEjendom({
        id,
        adresse: adresseLabel,
        postnr: adr.postnr,
        by: adr.postnrnavn,
        kommune: adr.kommunenavn,
        anvendelse: null,
      });
      recordRecentVisit('property', id, adresseLabel, `/dashboard/ejendomme/${id}`, {
        postnr: adr.postnr,
        by: adr.postnrnavn,
      });
      // Hent jordstykke asynkront (billigt kald)
      fetch(`/api/adresse/jordstykke?lng=${adr.x}&lat=${adr.y}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((jord: DawaJordstykke | null) => setDawaJordstykke(jord))
        .catch(() => {
          /* ignore */
        });
      return;
    }
    const controller = new AbortController();
    const signal = controller.signal;
    setDawaStatus('loader');
    fetch(`/api/adresse/lookup?id=${encodeURIComponent(id)}`, { signal })
      .then((r) => (r.ok ? r.json() : null))
      .then(async (adr: DawaAdresse | null) => {
        if (signal.aborted) return;
        if (!adr) {
          setDawaStatus('fejl');
          return;
        }
        setDawaAdresse(adr);
        const jordRes = await fetch(`/api/adresse/jordstykke?lng=${adr.x}&lat=${adr.y}`, {
          signal,
        });
        if (signal.aborted) return;
        const jord: DawaJordstykke | null = jordRes.ok ? await jordRes.json() : null;
        if (signal.aborted) return;
        setDawaJordstykke(jord);
        setDawaStatus('ok');

        // Gem besøget i "seneste sete ejendomme"-historikken
        const adresseLabel = adr.etage
          ? `${adr.vejnavn} ${adr.husnr}, ${adr.etage}.${adr.dør ? ` ${adr.dør}` : ''}`
          : adr.adressebetegnelse.split(',')[0];
        gemRecentEjendom({
          id,
          adresse: adresseLabel,
          postnr: adr.postnr,
          by: adr.postnrnavn,
          kommune: adr.kommunenavn,
          anvendelse: null, // opdateres nedenfor når BBR-data er klar
        });
        // Opdater recent tag-bar (virker også ved direkte URL-navigation)
        recordRecentVisit('property', id, adresseLabel, `/dashboard/ejendomme/${id}`, {
          postnr: adr.postnr,
          by: adr.postnrnavn,
        });
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        logger.error('[ejendom] DAWA fetch error:', err);
        setDawaStatus('fejl');
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, erDAWA]);

  /**
   * Henter BBR-data fra server-side API-route når DAWA-adressen er klar.
   * Skippes hvis server-side prefetch allerede leverede BBR-data.
   * Fejler stille — bbrData.bbrFejl beskriver årsagen hvis data mangler.
   * AbortController sikrer at forældede svar ignoreres ved hurtig navigation.
   */
  useEffect(() => {
    if (!erDAWA || dawaStatus !== 'ok') return;
    // Skip BBR fetch hvis server-side prefetch allerede leverede data
    if (prefetched?.bbrData) return;
    const controller = new AbortController();
    setBbrLoader(true);
    fetch(`/api/ejendom/${id}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: EjendomApiResponse | null) => {
        if (controller.signal.aborted) return;
        setBbrData(data);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        logger.error('[ejendom] BBR fetch error:', err);
        setBbrData(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBbrLoader(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, erDAWA, dawaStatus]);

  /**
   * Henter tinglysningsdata (tinglyst areal, ejerlejlighedsnr, fordelingstal) når BFE er klar.
   * Henter også summariske data (ejere/adkomster, hæftelser) til brug i Økonomi-tab.
   * Bruger ejerlejligheds-BFE hvis tilgængelig.
   * AbortController sikrer at forældede svar ignoreres ved hurtig navigation.
   */
  useEffect(() => {
    const erModerTl = dawaAdresse && !dawaAdresse.etage && !!bbrData?.ejerlejlighedBfe;
    const bfe = erModerTl
      ? (bbrData?.moderBfe ?? bbrData?.ejendomsrelationer?.[0]?.bfeNummer)
      : (bbrData?.ejerlejlighedBfe ?? bbrData?.ejendomsrelationer?.[0]?.bfeNummer);
    if (!bfe) return;
    const controller = new AbortController();
    const signal = controller.signal;
    setTlSumLoader(true);
    fetch(`/api/tinglysning?bfe=${bfe}`, { signal })
      .then(async (r) => {
        if (r.ok) return r.json();
        // BIZZ-525: Adresse-fallback når BFE-opslag returnerer 404
        if (r.status === 404 && dawaAdresse?.vejnavn && dawaAdresse?.husnr && dawaAdresse?.postnr) {
          const params = new URLSearchParams({
            vejnavn: dawaAdresse.vejnavn,
            husnummer: dawaAdresse.husnr,
            postnummer: dawaAdresse.postnr,
            ...(dawaAdresse.etage ? { etage: dawaAdresse.etage } : {}),
            ...(dawaAdresse.dør ? { sidedoer: dawaAdresse.dør } : {}),
          });
          const fallbackRes = await fetch(`/api/tinglysning?${params.toString()}`, { signal });
          if (fallbackRes.ok) return fallbackRes.json();

          // BIZZ-527: Tertiær fallback — landsejerlav + matrikel fra DAWA jordstykke
          if (
            fallbackRes.status === 404 &&
            dawaJordstykke?.ejerlav?.kode &&
            dawaJordstykke?.matrikelnr
          ) {
            const matParams = new URLSearchParams({
              landsejerlavid: String(dawaJordstykke.ejerlav.kode),
              matrikelnr: dawaJordstykke.matrikelnr,
            });
            const matRes = await fetch(`/api/tinglysning?${matParams.toString()}`, { signal });
            return matRes.ok ? matRes.json() : null;
          }
        }
        return null;
      })
      .then(async (data) => {
        if (signal.aborted) return;
        if (data && !data.error) {
          setTlTestFallback(!!data.testFallback);
          setTinglysningData({
            tinglystAreal: data.tinglystAreal ?? null,
            ejerlejlighedNr: data.ejerlejlighedNr ?? null,
            fordelingstal: data.fordelingstal ?? null,
          });
          // ESR-nummer = kommuneNummer-ejendomsnummer
          if (data.ejendomsnummer && data.kommuneNummer) {
            setEsrNummer(`${data.kommuneNummer}-${data.ejendomsnummer}`);
          }
          // Hent ejere + hæftelser for Økonomi-tab (sektions-kald)
          if (data.uuid) {
            Promise.all([
              fetch(`/api/tinglysning/summarisk?uuid=${data.uuid}&section=ejere`, { signal }).then(
                (r) => (r.ok ? r.json() : null)
              ),
              fetch(`/api/tinglysning/summarisk?uuid=${data.uuid}&section=haeftelser`, {
                signal,
              }).then((r) => (r.ok ? r.json() : null)),
            ])
              .then(([ejereData, haeftelserData]) => {
                if (signal.aborted) return;
                if (ejereData) setTlEjere(ejereData.ejere ?? []);
                if (haeftelserData) setTlHaeftelser(haeftelserData.haeftelser ?? []);
              })
              .catch((err) => {
                if (err.name === 'AbortError') return;
                /* Summarisk er valgfri */
              })
              .finally(() => {
                if (!signal.aborted) setTlSumLoader(false);
              });
          } else {
            setTlSumLoader(false);
          }
        } else {
          setTlSumLoader(false);
        }
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        logger.error('[ejendom] Tinglysning fetch error:', err);
        setTlSumLoader(false);
      });
    return () => controller.abort();
  }, [bbrData, dawaAdresse]);

  /**
   * Henter CVR-virksomheder på adressen via /api/cvr når DAWA-adressen er klar.
   * Fejler stille — viser tom liste hvis ingen resultater eller fejl.
   * AbortController sikrer at forældede svar ignoreres ved hurtig navigation.
   */
  useEffect(() => {
    if (!erDAWA || dawaStatus !== 'ok' || !dawaAdresse) return;
    const controller = new AbortController();
    const params = new URLSearchParams({
      vejnavn: dawaAdresse.vejnavn,
      husnr: dawaAdresse.husnr,
      postnr: dawaAdresse.postnr,
    });
    // For ejerlejligheder: filtrer på etage+dør for præcise resultater
    if (dawaAdresse.etage) params.set('etage', dawaAdresse.etage);
    if (dawaAdresse.dør) params.set('doer', dawaAdresse.dør);
    setCvrFetchComplete(false);
    fetch(`/api/cvr?${params}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : { virksomheder: [], tokenMangler: false }))
      .then((data: CVRResponse) => {
        if (controller.signal.aborted) return;
        setCvrVirksomheder(data.virksomheder);
        setCvrTokenMangler(data.tokenMangler);
        setCvrApiDown(data.apiDown ?? false);
        setCvrFetchComplete(true);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        logger.error('[ejendom] CVR fetch error:', err);
        setCvrVirksomheder([]);
        setCvrFetchComplete(true);
      });
    return () => controller.abort();
    // BIZZ-333: Use stable address components as deps instead of full dawaAdresse object
    // to avoid re-triggering (and aborting) the CVR fetch when BBR prefetch updates
    // dawaAdresse reference without changing the actual address values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, erDAWA, dawaStatus, dawaAdresse?.vejnavn, dawaAdresse?.husnr, dawaAdresse?.postnr]);

  /**
   * Henter alle ejerlejligheder for ejendommen fra /api/ejerlejligheder.
   * Søger via matrikel (ejerlavKode + matrikelnr) for at finde ALLE lejligheder
   * på tværs af opgange på samme matrikel.
   * Aktiveres kun for adresser UDEN etage/dør (dvs. moderejendommen).
   * AbortController sikrer at forældede svar ignoreres ved hurtig navigation.
   */
  useEffect(() => {
    // BIZZ-241: Hent lejligheder for hovedejendomme (ingen etage + har ejerlejlighedBfe)
    // Også hent hvis dawaAdresse er tilgængelig og viser en moderejendom
    const erModer = !dawaAdresse?.etage && !!bbrData?.ejerlejlighedBfe;
    if (!erModer) return;
    // Kræver matrikeldata fra BBR ejendomsrelationer
    const rel = bbrData?.ejendomsrelationer?.[0];
    if (!rel?.ejerlavKode || !rel?.matrikelnr) return;
    const controller = new AbortController();
    setLejlighederLoader(true);
    const params = new URLSearchParams({
      ejerlavKode: String(rel.ejerlavKode),
      matrikelnr: rel.matrikelnr,
    });
    fetch(`/api/ejerlejligheder?${params}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : { lejligheder: [] }))
      .then((data: { lejligheder: import('@/app/api/ejerlejligheder/route').Ejerlejlighed[] }) => {
        if (controller.signal.aborted) return;
        setLejligheder(data.lejligheder);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        logger.error('[ejendom] Ejerlejligheder fetch error:', err);
        setLejligheder([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLejlighederLoader(false);
      });
    return () => controller.abort();
  }, [id, erDAWA, dawaStatus, dawaAdresse, bbrData]);

  /**
   * Henter ejendomsvurdering og ejerskabsdata fra Datafordeler når BFEnummer
   * er tilgængeligt via BBR Ejendomsrelation.
   * Kører i parallel og fejler stille ved manglende API-nøgle.
   *
   * BFE-valg: fetchBfeInfo sætter ejendomsrelationer[0].bfeNummer = ejerlejlighedBfe ?? jordBfe.
   * For en moderejandom kan Vurderingsportalen fejlagtigt finde en child-ejerlejlighed-BFE,
   * så ejendomsrelationer[0].bfeNummer peger på en child-enhed i stedet for moderejandommen selv.
   * Rettelse: brug moderBfe (= jordBfe) når vi er på moderejandommens adresse (ingen etage/dør),
   * da moderBfe altid er den korrekte jordBFE. Venter på dawaAdresse for at afgøre dette.
   * AbortController sikrer at forældede svar ignoreres ved hurtig navigation.
   */
  useEffect(() => {
    if (!erDAWA || !bbrData?.ejendomsrelationer?.length || !dawaAdresse) return;
    // Moderejandom: ingen etage OG VP fandt en child-ejerlejlighed → brug moderBfe (jordBfe).
    // Ejerlejlighed / normal: brug ejendomsrelationer-BFE (= ejerlejlighedBfe eller jordBfe).
    const erModer = !dawaAdresse.etage && !!bbrData.ejerlejlighedBfe;
    const bfeNummer = erModer
      ? (bbrData.moderBfe ?? bbrData.ejendomsrelationer[0]?.bfeNummer)
      : bbrData.ejendomsrelationer[0]?.bfeNummer;
    if (!bfeNummer) return;

    const controller = new AbortController();
    const signal = controller.signal;

    setVurderingLoader(true);
    setEjereLoader(true);

    const kommunekode = dawaJordstykke?.kommune?.kode;
    const vurderingUrl = kommunekode
      ? `/api/vurdering?bfeNummer=${bfeNummer}&kommunekode=${kommunekode}`
      : `/api/vurdering?bfeNummer=${bfeNummer}`;

    fetch(vurderingUrl, { signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: VurderingResponse | null) => {
        if (signal.aborted) return;
        setVurdering(data?.vurdering ?? null);
        setAlleVurderinger(data?.alle ?? []);
        setVurFradrag(data?.fradrag ?? null);
        setVurFordeling(data?.fordeling ?? []);
        setVurGrundvaerdispec(data?.grundvaerdispec ?? []);
        setVurFritagelser(data?.fritagelser ?? []);
        setVurLoft(data?.loft ?? []);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        logger.error('[ejendom] Vurdering fetch error:', err);
        setVurdering(null);
      })
      .finally(() => {
        if (!signal.aborted) setVurderingLoader(false);
      });

    fetch(`/api/ejerskab?bfeNummer=${bfeNummer}`, { signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: EjerskabResponse | null) => {
        if (signal.aborted) return;
        setManglerEjereAdgang(data?.manglerAdgang ?? false);
        setEjere(data?.ejere ?? []);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        logger.error('[ejendom] Ejerskab fetch error:', err);
        setEjere([]);
      })
      .finally(() => {
        if (!signal.aborted) setEjereLoader(false);
      });

    setSalgshistorikLoader(true);
    fetch(`/api/salgshistorik?bfeNummer=${bfeNummer}`, { signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: SalgshistorikResponse | null) => {
        if (signal.aborted) return;
        setSalgshistorikManglerAdgang(data?.manglerAdgang ?? false);
        setSalgshistorik(data?.handler ?? []);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        logger.error('[ejendom] Salgshistorik fetch error:', err);
        setSalgshistorik([]);
      })
      .finally(() => {
        if (!signal.aborted) setSalgshistorikLoader(false);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, erDAWA, bbrData, dawaAdresse]);

  /**
   * Henter matrikeldata (jordstykker, landbrugsnotering m.m.) fra Datafordeler MAT-registret.
   * Kører når BFE-nummer er tilgængeligt via BBR Ejendomsrelation.
   * AbortController sikrer at forældede svar ignoreres ved hurtig navigation.
   */
  useEffect(() => {
    if (!erDAWA || !bbrData?.ejendomsrelationer?.length) return;
    const bfeNummer = bbrData.ejendomsrelationer[0]?.bfeNummer;
    if (!bfeNummer) return;
    const controller = new AbortController();
    setMatrikelLoader(true);
    fetch(`/api/matrikel?bfeNummer=${bfeNummer}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data: MatrikelResponse) => {
        if (controller.signal.aborted) return;
        if (data.matrikel) setMatrikelData(data.matrikel);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        logger.error('[ejendom] Matrikel fetch error:', err);
      })
      .finally(() => {
        if (!controller.signal.aborted) setMatrikelLoader(false);
      });
    return () => controller.abort();
  }, [erDAWA, bbrData]);

  /**
   * BIZZ-500: Lazy-loader matrikel-historik når brugeren åbner sektionen.
   * Hentes kun én gang per BFE — caches i state.
   */
  useEffect(() => {
    if (!historikOpen) return;
    if (matrikelHistorik.length > 0 || historikLoader) return;
    if (!erDAWA || !bbrData?.ejendomsrelationer?.length) return;
    const bfeNummer = bbrData.ejendomsrelationer[0]?.bfeNummer;
    if (!bfeNummer) return;
    const controller = new AbortController();
    setHistorikLoader(true);
    fetch(`/api/matrikel/historik?bfeNummer=${bfeNummer}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data: MatrikelHistorikResponse) => {
        if (controller.signal.aborted) return;
        if (data.historik?.length) setMatrikelHistorik(data.historik);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        logger.error('[ejendom] Matrikel historik fetch error:', err);
      })
      .finally(() => {
        if (!controller.signal.aborted) setHistorikLoader(false);
      });
    return () => controller.abort();
  }, [historikOpen, erDAWA, bbrData, matrikelHistorik.length, historikLoader]);

  /**
   * Henter forelobige ejendomsvurderinger fra Vurderingsportalen.
   * Proever foerst adgangsadresse-ID fra DAWA, derefter BFE-nummer fra BBR.
   * Disse er separate fra de endelige vurderinger fra Datafordeler.
   *
   * BFE-valg: for moderejendomme (ingen etage + ejerlejlighedBfe sat) bruger vi moderBfe
   * direkte fremfor adresseId, fordi adresseId-søgning returnerer child-enheder på adressen
   * og kan give forelobige vurderinger for en forkert ejerlejlighed.
   * AbortController sikrer at forældede svar ignoreres ved hurtig navigation.
   */
  useEffect(() => {
    if (!erDAWA) return;

    // Moderejandom: ingen etage OG VP fandt child-ejerlejlighed → brug moderBfe direkte.
    // adresseId-søgning returnerer child-enheder på adressen; moderBfe giver korrekt parent-dokument.
    const erModer = !dawaAdresse?.etage && !!bbrData?.ejerlejlighedBfe;

    const params = new URLSearchParams();
    if (erModer) {
      const moderBfe = bbrData?.moderBfe ?? bbrData?.ejendomsrelationer?.[0]?.bfeNummer;
      if (!moderBfe) return;
      params.set('bfeNummer', String(moderBfe));
    } else {
      // Always use BFE as primary — most reliable for VP matching.
      // adresseId as fallback only when BFE unavailable.
      const bfeNummer = bbrData?.ejendomsrelationer?.[0]?.bfeNummer;
      if (bfeNummer) {
        params.set('bfeNummer', String(bfeNummer));
      } else if (dawaAdresse?.id) {
        params.set('adresseId', dawaAdresse.id);
      } else {
        return;
      }
    }

    const controller = new AbortController();
    setForelobigLoader(true);
    // Cache-bust to avoid stale empty responses from Vercel CDN
    params.set('_t', String(Math.floor(Date.now() / 300000))); // 5-min buckets
    fetch(`/api/vurdering-forelobig?${params}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: ForelobigVurderingResponse | null) => {
        if (controller.signal.aborted) return;
        setForelobige(data?.forelobige ?? []);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        logger.error('[ejendom] Forelobig vurdering fetch error:', err);
        setForelobige([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setForelobigLoader(false);
      });
    return () => controller.abort();
  }, [id, erDAWA, dawaAdresse, bbrData]);

  /**
   * BIZZ-332: Henter energimærkerapporter via /api/energimaerke når BFE-nummer er tilgængeligt.
   *
   * Energimærker registreres på bygningsniveau (moderejendommen), ikke på den
   * individuelle ejerlejlighed. Opslag-BFE bestemmes efter følgende prioritering:
   *   1. Moderejendom (ingen etage + ejerlejlighedBfe sat): brug moderBfe direkte.
   *   2. Ejerlejlighed (har etage + moderBfe sat): brug moderBfe direkte — undgår
   *      et forgæves opslag på ejerlejlighedens egen BFE, som aldrig har et mærke.
   *   3. Normal ejendom (ingen ejerlejlighedBfe): brug ejendomsrelationernes BFE.
   *
   * Kræver EMO_USERNAME/PASSWORD i .env.local — fejler stille med manglerAdgang-flag.
   * AbortController sikrer at forældede svar ignoreres ved hurtig navigation.
   */
  useEffect(() => {
    if (!erDAWA || !bbrData?.ejendomsrelationer?.length || !dawaAdresse) return;

    // Bestem det korrekte BFE til energimærke-opslag.
    // Moderejendom: ingen etage OG har ejerlejlighedBfe (VP fandt en child-BFE).
    const erModerEjendom = !dawaAdresse.etage && !!bbrData.ejerlejlighedBfe;
    // Ejerlejlighed: har etage OG moderBfe er sat (= jordBFE / bygnings-BFE).
    const erEjerlejlighed = !!dawaAdresse.etage && !!bbrData.moderBfe;

    let bfeNummer: number | null | undefined;
    if (erModerEjendom || erEjerlejlighed) {
      // For begge cases: energimærket hænger på moderejendommens BFE (jordBFE).
      bfeNummer = bbrData.moderBfe ?? bbrData.ejendomsrelationer[0]?.bfeNummer;
    } else {
      // Normal ejendom uden ejerlejligheder.
      bfeNummer = bbrData.ejendomsrelationer[0]?.bfeNummer;
    }
    if (!bfeNummer) return;

    const controller = new AbortController();
    setEnergiLoader(true);
    fetch(`/api/energimaerke?bfeNummer=${bfeNummer}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: EnergimaerkeResponse | null) => {
        if (controller.signal.aborted) return;
        setEnergimaerker(data?.maerker ?? null);
        setEnergiManglerAdgang(data?.manglerAdgang ?? false);
        setEnergiFejl(data?.fejl ?? null);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        logger.error('[ejendom] Energimaerke fetch error:', err);
        setEnergiFejl(
          da ? 'Netværksfejl ved hentning af energimærker' : 'Network error fetching energy labels'
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setEnergiLoader(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, erDAWA, bbrData, dawaAdresse]);

  /**
   * Henter jordforureningsstatus fra DkJord API når ejerlavKode + matrikelnr er tilgængelige.
   * Åbne data — kræver ingen autentificering.
   * AbortController sikrer at forældede svar ignoreres ved hurtig navigation.
   */
  useEffect(() => {
    if (!erDAWA || !bbrData?.ejendomsrelationer?.length) return;
    const rel = bbrData.ejendomsrelationer[0];
    if (!rel?.ejerlavKode || !rel?.matrikelnr) return;

    const controller = new AbortController();
    setJordLoader(true);
    setJordData(null);
    setJordIngenData(false);
    setJordFejl(null);

    fetch(
      `/api/jord?ejerlavKode=${rel.ejerlavKode}&matrikelnr=${encodeURIComponent(rel.matrikelnr)}`,
      { signal: controller.signal }
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((data: JordResponse | null) => {
        if (controller.signal.aborted) return;
        setJordData(data?.items ?? null);
        setJordIngenData(data?.ingenData ?? false);
        setJordFejl(data?.fejl ?? null);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        logger.error('[ejendom] Jordforurening fetch error:', err);
        setJordFejl(
          da
            ? 'Netværksfejl ved hentning af jordforureningsdata'
            : 'Network error fetching contamination data'
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setJordLoader(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, erDAWA, bbrData]);

  /**
   * Henter lokalplaner og kommuneplanrammer via /api/plandata når DAWA-adressen er klar.
   * Kræver kun adresse-UUID — koordinater hentes internt af API-routen via DAWA.
   * AbortController sikrer at forældede svar ignoreres ved hurtig navigation.
   */
  useEffect(() => {
    if (!erDAWA || dawaStatus !== 'ok') return;
    const controller = new AbortController();
    setPlandataLoader(true);
    setPlandataFejl(null);
    fetch(`/api/plandata?adresseId=${id}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: PlandataResponse | null) => {
        if (controller.signal.aborted) return;
        setPlandata(data?.planer ?? null);
        if (data?.fejl) setPlandataFejl(data.fejl);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        logger.error('[ejendom] Plandata fetch error:', err);
        setPlandataFejl(
          da ? 'Netværksfejl ved hentning af plandata' : 'Network error fetching plan data'
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setPlandataLoader(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, erDAWA, dawaStatus]);

  /**
   * Toggler et dokument i udvalgslisten.
   * @param docId - Unikt dokument-id
   */
  const toggleDoc = (docId: string) =>
    setValgteDoc((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });

  /** True mens ZIP-filen genereres og downloades */
  const [zipLoader, setZipLoader] = useState(false);

  /**
   * Henter de valgte dokumenter fra Dokumenter-tabben og downloader dem som ZIP.
   * Bygger en liste over downloadbare PDF-URL'er baseret på valgte dokument-IDs,
   * POSTer til /api/dokumenter/zip og trigger browser-download af resultatet.
   */
  const handleDownloadZip = async () => {
    if (valgteDoc.size === 0 || zipLoader) return;

    const rel = bbrData?.ejendomsrelationer?.[0];
    const bfeNummer = rel?.bfeNummer;
    const ejerlavKode = rel?.ejerlavKode;
    const matrikelnr = rel?.matrikelnr;

    type ZipDoc = { filename: string; url: string };
    const docs: ZipDoc[] = [];

    for (const id of valgteDoc) {
      // BBR-meddelelse
      if (id === 'std-3' && bfeNummer) {
        docs.push({
          filename: 'BBR-meddelelse.pdf',
          url: `https://bbr.dk/pls/wwwdata/get_newois_pck.show_bbr_meddelelse_pdf?i_bfe=${bfeNummer}`,
        });
      }
      // Matrikelkort (intern API)
      if (id === 'std-5' && ejerlavKode && matrikelnr) {
        docs.push({
          filename: `Matrikelkort_${matrikelnr}.pdf`,
          url: `/api/matrikelkort?ejerlavKode=${ejerlavKode}&matrikelnr=${encodeURIComponent(matrikelnr)}`,
        });
      }
      // Jordforureningsattest — via intern /api/jord/pdf proxy der fetcher /report/generate direkte
      if (id === 'std-7' && ejerlavKode && matrikelnr) {
        docs.push({
          filename: `Jordforureningsattest_${matrikelnr}.pdf`,
          url: `/api/jord/pdf?elav=${ejerlavKode}&matrnr=${encodeURIComponent(matrikelnr)}`,
        });
      }
    }

    // Planer med doklink
    if (plandata) {
      for (const plan of plandata) {
        if (plan.doklink && valgteDoc.has(`pla-${plan.id}`)) {
          docs.push({
            filename: `Plan_${(plan.navn ?? plan.id ?? 'ukendt').replace(/[^a-zA-Z0-9æøåÆØÅ]/g, '_')}.pdf`,
            url: plan.doklink,
          });
        }
      }
    }

    // Energimærkerapporter — proxy URL åbnes direkte fra cachet state
    if (energimaerker) {
      for (const m of energimaerker) {
        if (m.pdfUrl && valgteDoc.has(`energi-${m.serialId}`)) {
          docs.push({
            filename: `Energimaerke_${m.serialId}.pdf`,
            url: m.pdfUrl,
          });
        }
      }
    }

    if (docs.length === 0) {
      alert(t.noDirectPdfLinks);
      return;
    }

    setZipLoader(true);
    try {
      const adresse =
        dawaStatus === 'ok' ? (dawaAdresse?.vejnavn ?? 'ejendom') : (ejendom?.adresse ?? 'ejendom');
      const res = await fetch('/api/dokumenter/zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          docs,
          arkivNavn: `BizzAssist_${adresse.replace(/[^a-zA-Z0-9æøåÆØÅ]/g, '_')}`,
        }),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({ fejl: t.unknownError }))) as { fejl?: string };
        alert(`ZIP-download fejlede: ${err.fejl ?? res.statusText}`);
        return;
      }

      // Trigger browser-download
      const springedeOver = res.headers.get('X-Springede-Over');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download =
        res.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] ??
        'dokumenter.zip';
      a.click();
      URL.revokeObjectURL(url);

      // Informér brugeren hvis nogle dokumenter ikke kunne valideres som gyldige PDF-filer
      if (springedeOver) {
        const liste = springedeOver
          .split(' | ')
          .map((s) => `• ${s}`)
          .join('\n');
        alert(`${t.zipDownloaded}\n\n${liste}\n\n${t.tryOpenInBrowser}`);
      }
    } catch (err) {
      alert(`ZIP-download fejlede: ${err instanceof Error ? err.message : t.unknownError}`);
    } finally {
      setZipLoader(false);
    }
  };

  // ── Kombineret salgshistorik: EJF + Tinglysning adkomster ──

  /** En samlet handel der kan stamme fra EJF, tinglysning eller begge */
  interface MergedHandel {
    kontantKoebesum: number | null;
    samletKoebesum: number | null;
    /** Løsøreværdi fra EJF (inventar, maskiner m.m. der ikke er fast ejendom) */
    loesoeresum: number | null;
    /** Entreprisesum fra EJF (nybyggeri/ombygning inkluderet i købet) */
    entreprisesum: number | null;
    koebsaftaleDato: string | null;
    overtagelsesdato: string | null;
    overdragelsesmaade: string | null;
    koeber: string | null;
    koebercvr: string | null;
    adkomstType: string | null;
    andel: string | null;
    tinglysningsdato: string | null;
    tinglysningsafgift: number | null;
    kilde: 'ejf' | 'tinglysning' | 'begge';
    /**
     * BIZZ-468: Struktureret liste af alle købere i denne handel med hver
     * deres andel. Bruges af render-laget i stedet for den concatenerede
     * `koeber`-streng så hver navn kan få sin egen andel-suffix (ikke kun
     * den sidste). Tom liste = én køber uden andel — brug fallback til
     * `koeber` + `andel`-felterne.
     */
    koebere?: { navn: string; cvr: string | null; andel: string | null }[];
    // BIZZ-481: Udvidede EJF_Ejerskifte felter
    /** True når handlen er tinglyst med uopfyldte betingelser — vigtigt advarselsflag */
    betinget?: boolean | null;
    /** Frist for opfyldelse af betingelser (ISO 8601) */
    fristDato?: string | null;
    /** Officiel forretningshændelse fra EJF — præcis klassificering i stedet for gæt */
    forretningshaendelse?: string | null;
    // BIZZ-480: Udvidede EJF_Handelsoplysninger felter
    /** Afståelsesdato — kan afvige fra overtagelsesdato */
    afstaaelsesdato?: string | null;
    /** Skødetekst — beskrivelse fra skødet */
    skoedetekst?: string | null;
  }

  /**
   * Merger EJF-salgshistorik med tinglysning-adkomster.
   * Matcher på overtagelsesdato (±30 dage) for at samle data fra begge kilder.
   * Tinglysning bidrager med købernavn, adkomsttype, andel og tinglysningsafgift.
   */
  const mergedSalgshistorik: MergedHandel[] = (() => {
    const merged: MergedHandel[] = [];
    const brugteTlIdx = new Set<number>();

    // Trin 1: Start med EJF-data og berig med tinglysning
    for (const h of salgshistorik ?? []) {
      const ejfDato = h.overtagelsesdato ?? h.koebsaftaleDato ?? '';
      let bestMatch: TLEjer | null = null;
      let bestIdx = -1;
      let bestDiff = Infinity;

      for (let i = 0; i < tlEjere.length; i++) {
        if (brugteTlIdx.has(i)) continue;
        const tlDato = tlEjere[i].overtagelsesdato ?? tlEjere[i].koebsaftaledato ?? '';
        if (!ejfDato || !tlDato) continue;
        const diff = Math.abs(new Date(ejfDato).getTime() - new Date(tlDato).getTime());
        if (diff < 30 * 24 * 60 * 60 * 1000 && diff < bestDiff) {
          bestDiff = diff;
          bestMatch = tlEjere[i];
          bestIdx = i;
        }
      }

      if (bestMatch && bestIdx >= 0) brugteTlIdx.add(bestIdx);

      merged.push({
        kontantKoebesum: h.kontantKoebesum,
        samletKoebesum: h.samletKoebesum,
        loesoeresum: h.loesoeresum,
        entreprisesum: h.entreprisesum,
        koebsaftaleDato: h.koebsaftaleDato,
        overtagelsesdato: h.overtagelsesdato,
        overdragelsesmaade: h.overdragelsesmaade,
        koeber: bestMatch?.navn ?? null,
        koebercvr: bestMatch?.cvr ?? null,
        adkomstType: bestMatch?.adkomstType ?? null,
        andel: bestMatch?.andel ?? null,
        tinglysningsdato: bestMatch?.tinglysningsdato ?? null,
        tinglysningsafgift: bestMatch?.tinglysningsafgift ?? null,
        kilde: bestMatch ? 'begge' : 'ejf',
        // BIZZ-480 + BIZZ-481: Propager nye EJF-felter til UI-laget.
        betinget: h.betinget ?? null,
        fristDato: h.fristDato ?? null,
        forretningshaendelse: h.forretningshaendelse ?? null,
        afstaaelsesdato: h.afstaaelsesdato ?? null,
        skoedetekst: h.skoedetekst ?? null,
      });
    }

    // Trin 2: Tilføj tinglysning-adkomster der ikke matchede EJF
    for (let i = 0; i < tlEjere.length; i++) {
      if (brugteTlIdx.has(i)) continue;
      const e = tlEjere[i];
      merged.push({
        kontantKoebesum: e.kontantKoebesum ?? e.koebesum,
        samletKoebesum: e.iAltKoebesum ?? e.koebesum,
        // Løsøre/entreprise comes only from EJF — not available in tinglysning records
        loesoeresum: null,
        entreprisesum: null,
        koebsaftaleDato: e.koebsaftaledato,
        overtagelsesdato: e.overtagelsesdato,
        overdragelsesmaade: e.adkomstType,
        koeber: e.navn,
        koebercvr: e.cvr,
        adkomstType: e.adkomstType,
        andel: e.andel,
        tinglysningsdato: e.tinglysningsdato,
        tinglysningsafgift: e.tinglysningsafgift,
        kilde: 'tinglysning',
      });
    }

    // BIZZ-444: Saml handler med samme dato + samme købesum til én linje
    // (f.eks. 50%/50% ejere der køber sammen vises som én handel)
    const grouped: MergedHandel[] = [];
    for (const h of merged) {
      const dato = h.overtagelsesdato ?? h.koebsaftaleDato ?? '';
      const sum = h.kontantKoebesum ?? h.samletKoebesum ?? 0;
      const existing = grouped.find((g) => {
        const gDato = g.overtagelsesdato ?? g.koebsaftaleDato ?? '';
        const gSum = g.kontantKoebesum ?? g.samletKoebesum ?? 0;
        return gDato === dato && gSum === sum && dato !== '';
      });
      if (existing && h.koeber) {
        // BIZZ-468: Build a structured koebere[] — each buyer keeps sin egen
        // andel. Undgår den gamle string-concat-bug hvor kun sidste køber
        // havde andel-suffix fordi første købers `andel` var null på
        // existing-rækken selvom den faktisk var kendt på en senere række.
        if (!existing.koebere || existing.koebere.length === 0) {
          // Seed koebere med existing's single buyer først
          existing.koebere = [
            { navn: existing.koeber ?? '', cvr: existing.koebercvr, andel: existing.andel },
          ];
        }
        existing.koebere.push({ navn: h.koeber, cvr: h.koebercvr, andel: h.andel });
        // Rebuild koeber-strengen — inkluder andel per navn hvis minimum ét
        // navn har en kendt andel. Hvis INGEN har andel, vis bare navnene.
        const anyAndel = existing.koebere.some((k) => k.andel);
        existing.koeber = existing.koebere
          .map((k) => (anyAndel && k.andel ? `${k.navn} (${k.andel})` : k.navn))
          .join(', ');
        // Når flere købere med andel: ryd top-level andel (vises inline pr navn)
        if (anyAndel) existing.andel = null;
      } else {
        grouped.push({ ...h });
      }
    }

    // Sortér nyeste først
    grouped.sort((a, b) => {
      const da2 = a.overtagelsesdato ?? a.koebsaftaleDato ?? '';
      const db = b.overtagelsesdato ?? b.koebsaftaleDato ?? '';
      return db.localeCompare(da2);
    });

    return grouped;
  })();

  /** Samlet pantegæld fra tinglysning-hæftelser (DKK) */
  const _samletPantegaeld = tlHaeftelser.reduce((sum, h) => sum + (h.beloeb ?? 0), 0);

  const ejendom = erDAWA ? null : getEjendomById(id);

  /**
   * Memoized adressestreng til PropertyMap i den ikke-DAWA renderingssti
   * (BFE-baseret ejendom-objekt fra server-side opslag).
   * Beregnes ud fra ejendom.adresse / postnummer / by — stable string-reference
   * der kun ændres når adressen selv ændres. Konsistent med projektets
   * React.memo + useMemo-mønster.
   */
  const bfrAdresseStreng = useMemo(
    () => (ejendom ? `${ejendom.adresse}, ${ejendom.postnummer} ${ejendom.by}` : ''),
    // ejendom is a derived constant (not state) so object identity is stable;
    // we depend on individual string fields to be precise about what triggers recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ejendom?.adresse, ejendom?.postnummer, ejendom?.by]
  );

  /**
   * Memoized BBR-bygningspunkter til PropertyMap i den ikke-DAWA renderingssti.
   * Stabil reference forhindrer unødvendig genrendering af det memo-wrapped PropertyMap
   * når bbrData opdateres med data der ikke vedrører bygningPunkter-arrayet.
   */
  const bfrBygningPunkter = useMemo(
    () => bbrData?.bygningPunkter ?? undefined,
    [bbrData?.bygningPunkter]
  );

  // ── DAWA: Loading ──
  if (erDAWA && dawaStatus === 'loader') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        <p className="text-slate-400 text-sm">{t.loadingAddress}</p>
      </div>
    );
  }

  // ── DAWA: Fejl ──
  if (erDAWA && dawaStatus === 'fejl') {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-6">
        <MapPin size={40} className="text-slate-600 mb-4" />
        <h2 className="text-white text-xl font-semibold mb-2">{t.addressNotFound}</h2>
        <p className="text-slate-400 text-sm mb-6">{t.addressNotFoundDesc}</p>
        <Link
          href="/dashboard/ejendomme"
          className="text-blue-400 hover:text-blue-300 flex items-center gap-2 text-sm"
        >
          <ArrowLeft size={16} /> {t.backToProperties}
        </Link>
      </div>
    );
  }

  // ── DAWA: Rigtig adresse fundet ──
  if (erDAWA && dawaAdresse) {
    const adresseStreng = `${dawaAdresse.vejnavn} ${dawaAdresse.husnr}${dawaAdresse.etage ? `, ${dawaAdresse.etage}.` : ''}${dawaAdresse.dør ? ` ${dawaAdresse.dør}` : ''}, ${dawaAdresse.postnr} ${dawaAdresse.postnrnavn}`;

    return (
      <div className={`flex-1 flex overflow-hidden${trækker ? ' select-none' : ''}`}>
        {/* ─── Venstre: header + tabs + indhold ─── */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {/* ─── Header ─── */}
          <div className="px-3 sm:px-6 pt-5 pb-0 border-b border-slate-700/50 bg-slate-900/30">
            <div className="flex items-center justify-between mb-3">
              <button
                onClick={() => router.push('/dashboard/ejendomme')}
                className="flex items-center gap-2 text-slate-400 hover:text-white text-sm transition-colors"
              >
                <ArrowLeft size={16} /> {t.back}
              </button>
              <div className="flex items-center gap-2">
                {/* Kort-toggle knap — åbner overlay på mobil, toggle sidepanel på desktop */}
                <button
                  onClick={() => {
                    if (visKort) {
                      setKortPanelÅben((prev) => !prev);
                    } else {
                      setMobilKortAaben(true);
                    }
                  }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 border rounded-lg text-sm transition-all ${
                    visKort && kortPanelÅben
                      ? 'bg-blue-600/20 hover:bg-blue-600/30 border-blue-500/40 text-blue-300'
                      : 'bg-slate-800 hover:bg-slate-700 border-slate-700/60 text-slate-300'
                  }`}
                  title={da ? 'Vis/skjul kort' : 'Show/hide map'}
                >
                  <MapIcon size={14} />
                  {da ? 'Kort' : 'Map'}
                </button>

                <div
                  className="relative"
                  onMouseEnter={() => !erFulgt && setVisFoelgTooltip(true)}
                  onMouseLeave={() => setVisFoelgTooltip(false)}
                >
                  <button
                    disabled={foelgToggling}
                    onClick={async () => {
                      if (foelgToggling) return;
                      setVisFoelgTooltip(false);
                      // Optimistic update — toggle colour immediately so the user
                      // sees instant feedback before the Supabase write completes.
                      const optimisticState = !erFulgt;
                      setErFulgt(optimisticState);
                      setFoelgToggling(true);
                      try {
                        const postnr = dawaAdresse?.postnr ?? '';
                        const by = dawaAdresse?.postnrnavn ?? '';
                        const kommune =
                          dawaAdresse?.kommunenavn ?? dawaJordstykke?.kommune.navn ?? '';
                        const anvendelse = bbrData?.bbr?.[0]?.anvendelse ?? null;
                        const nyTilstand = await toggleTrackEjendom({
                          id,
                          adresse: adresseStreng,
                          postnr,
                          by,
                          kommune,
                          anvendelse,
                        });
                        // Confirm with authoritative result from the toggle function
                        setErFulgt(nyTilstand);
                        window.dispatchEvent(new Event('ba-tracked-changed'));
                      } catch {
                        // Revert optimistic update on error
                        setErFulgt(!optimisticState);
                      } finally {
                        setFoelgToggling(false);
                      }
                    }}
                    className={`flex items-center gap-2 px-3 py-1.5 border rounded-lg text-sm transition-all disabled:opacity-60 disabled:cursor-not-allowed ${
                      erFulgt
                        ? 'bg-blue-600/20 hover:bg-blue-600/30 border-blue-500/40 text-blue-300'
                        : 'bg-slate-800 hover:bg-slate-700 border-slate-700/60 text-slate-300'
                    }`}
                    aria-label={
                      erFulgt
                        ? da
                          ? 'Stop med at følge ejendom'
                          : 'Unfollow property'
                        : da
                          ? 'Følg ejendom'
                          : 'Follow property'
                    }
                    aria-pressed={erFulgt}
                  >
                    <Bell size={14} className={erFulgt ? 'fill-blue-400 text-blue-400' : ''} />
                    {erFulgt ? t.following : t.follow}
                  </button>
                  <FoelgTooltip lang={da ? 'da' : 'en'} visible={visFoelgTooltip} />
                </div>
              </div>
            </div>

            <div className="mb-3">
              <div className="flex items-center gap-3">
                <h1 className="text-white text-xl font-bold">{adresseStreng}</h1>
                {/* Child unit (ejerlejlighed med etage): link til moderejandommen */}
                {bbrData?.ejerlejlighedBfe && bbrData?.moderBfe && !!dawaAdresse?.etage && (
                  <button
                    onClick={async () => {
                      try {
                        const jsRes = await fetch(
                          `/api/adresse/jordstykke?bfe=${bbrData.moderBfe}`
                        );
                        if (jsRes.ok) {
                          const js = await jsRes.json();
                          if (js?.adgangsadresseId) {
                            router.push(`/dashboard/ejendomme/${js.adgangsadresseId}`);
                            return;
                          }
                        }
                      } catch {
                        /* ignore */
                      }
                    }}
                    className="flex items-center gap-1.5 px-3 py-1 bg-amber-500/15 border border-amber-500/30 rounded-lg text-amber-400 text-xs font-medium hover:bg-amber-500/25 transition-colors flex-shrink-0"
                    title={
                      lang === 'da'
                        ? `Gå til hovedejendommen (BFE ${bbrData.moderBfe})`
                        : `Go to parent property (BFE ${bbrData.moderBfe})`
                    }
                  >
                    <Building2 size={12} />
                    {lang === 'da' ? 'Gå til hovedejendom' : 'Go to main property'}
                  </button>
                )}
                {/* Moderejandom (ingen etage, men har ejerlejlighedBfe): statisk badge */}
                {bbrData?.ejerlejlighedBfe && !dawaAdresse?.etage && (
                  <span
                    className="flex items-center gap-1.5 px-3 py-1 bg-amber-500/15 border border-amber-500/30 rounded-lg text-amber-400 text-xs font-medium flex-shrink-0"
                    title={
                      lang === 'da'
                        ? `Denne ejendom er en hovedejendom (BFE ${bbrData.moderBfe ?? bbrData.ejerlejlighedBfe})`
                        : `This property is a main property (BFE ${bbrData.moderBfe ?? bbrData.ejerlejlighedBfe})`
                    }
                  >
                    <Building2 size={12} />
                    {lang === 'da' ? 'Hovedejendom' : 'Main property'}
                  </span>
                )}
                {bbrData?.ejerlejlighedBfe && (
                  <span className="flex items-center gap-1 px-2 py-0.5 bg-purple-500/15 border border-purple-500/30 rounded-full text-purple-400 text-[10px] font-medium flex-shrink-0">
                    {lang === 'da' ? 'Ejerlejlighed' : 'Condominium'}
                  </span>
                )}
                {/* BIZZ-550: Ejendomstype-badge — primær kilde: VUR juridiskKategori,
                     fallback: udledt fra BBR bygningsanvendelser */}
                {(() => {
                  // 1. VUR juridiskKategori (nyt vurderingssystem)
                  if (vurdering?.juridiskKategori) {
                    return (
                      <span className="flex items-center gap-1 px-2.5 py-0.5 bg-blue-500/15 border border-blue-500/30 rounded-full text-blue-300 text-xs font-medium flex-shrink-0">
                        <Home size={11} />
                        {vurdering.juridiskKategori}
                      </span>
                    );
                  }
                  // 2. Udled fra BBR bygningsanvendelser (gammelt VUR system)
                  const bygninger = bbrData?.bbr?.filter(
                    (b) => b.status !== 'Nedrevet/slettet' && b.status !== 'Ikke opført'
                  );
                  if (!bygninger?.length) return null;
                  let harBolig = false;
                  let harErhverv = false;
                  for (const b of bygninger) {
                    const a = b.anvendelse.toLowerCase();
                    if (
                      a.includes('bolig') ||
                      a.includes('enfamilie') ||
                      a.includes('rækkehus') ||
                      a.includes('kædehus') ||
                      a.includes('dobbelthus') ||
                      a.includes('beboelse') ||
                      a.includes('kollegium') ||
                      a.includes('stuehus') ||
                      a.includes('fritliggende')
                    ) {
                      harBolig = true;
                    } else if (
                      a.includes('kontor') ||
                      a.includes('handel') ||
                      a.includes('lager') ||
                      a.includes('erhverv') ||
                      a.includes('industri') ||
                      a.includes('fabrik') ||
                      a.includes('værksted') ||
                      a.includes('butik') ||
                      a.includes('hotel') ||
                      a.includes('produktion') ||
                      a.includes('transport')
                    ) {
                      harErhverv = true;
                    }
                  }
                  const kategori =
                    harBolig && harErhverv
                      ? 'Blandet bolig/erhverv'
                      : harErhverv
                        ? 'Erhvervsejendom'
                        : harBolig
                          ? 'Beboelsesejendom'
                          : null;
                  if (!kategori) return null;
                  return (
                    <span className="flex items-center gap-1 px-2.5 py-0.5 bg-blue-500/15 border border-blue-500/30 rounded-full text-blue-300 text-xs font-medium flex-shrink-0">
                      <Home size={11} />
                      {kategori}
                    </span>
                  );
                })()}
                {/* BIZZ-457: Benyttelse (VUR) + byggeår (BBR) — "Værksted (1955)" */}
                {(() => {
                  const nyesteByg = bbrData?.bbr?.reduce<number | null>((latest, b) => {
                    if (b.opfoerelsesaar == null) return latest;
                    if (latest == null || b.opfoerelsesaar > latest) return b.opfoerelsesaar;
                    return latest;
                  }, null);
                  const label = formatBenyttelseOgByggeaar(
                    vurdering?.benyttelseskode ?? null,
                    nyesteByg ?? null,
                    // BIZZ-574: Pass zone og ejerlejlighed-flag så fritids-
                    // kategorier filtreres uden for sommerhuszone (forhindrer
                    // falsk "Sommerhus"-badge på ejerlejligheder i byen).
                    dawaAdresse?.zone ?? null,
                    !!bbrData?.ejerlejlighedBfe
                  );
                  if (!label) return null;
                  return (
                    <span className="flex items-center gap-1 px-2.5 py-0.5 bg-emerald-500/15 border border-emerald-500/30 rounded-full text-emerald-300 text-xs font-medium flex-shrink-0">
                      {label}
                    </span>
                  );
                })()}
              </div>
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <span className="flex items-center gap-1 px-2 py-0.5 bg-slate-800 border border-slate-700/50 rounded-full text-xs text-slate-300">
                  <MapPin size={11} />
                  {(dawaAdresse.kommunenavn || null) ?? dawaJordstykke?.kommune.navn ?? '–'}
                </span>
                {/* BIZZ-508: Supplerende bynavn (fx "Vejlgårde") */}
                {dawaAdresse.supplerendebynavn && (
                  <span className="flex items-center gap-1 px-2 py-0.5 bg-slate-800 border border-slate-700/50 rounded-full text-xs text-slate-400">
                    {dawaAdresse.supplerendebynavn}
                  </span>
                )}
                {dawaJordstykke && (
                  <span className="flex items-center gap-1 px-2 py-0.5 bg-slate-800 border border-slate-700/50 rounded-full text-xs text-slate-300">
                    <Building2 size={11} /> {dawaJordstykke.matrikelnr},{' '}
                    {dawaJordstykke.ejerlav.navn}
                  </span>
                )}
                {/* BIZZ-498: vis zone-badge for ALLE non-empty zone-værdier.
                    Plandata returnerer fx også "Udfaset" (zone-status under
                    udfasning) og diverse historiske kategorier — disse må
                    også vises, ikke kun de 3 standard. Standard 3 har
                    farve-kodet badge, øvrige får neutral slate-style. */}
                {dawaAdresse.zone && (
                  <span
                    className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border ${
                      dawaAdresse.zone === 'Byzone'
                        ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                        : dawaAdresse.zone === 'Landzone'
                          ? 'bg-amber-500/10 border-amber-500/20 text-amber-400'
                          : dawaAdresse.zone === 'Sommerhuszone'
                            ? 'bg-orange-500/10 border-orange-500/20 text-orange-400'
                            : 'bg-slate-800 border-slate-700/50 text-slate-300'
                    }`}
                    title={
                      da
                        ? 'Zone-klassifikation fra Plandata.dk'
                        : 'Zone classification from Plandata.dk'
                    }
                  >
                    {dawaAdresse.zone}
                  </span>
                )}
                {bbrData?.ejendomsrelationer?.[0]?.bfeNummer && (
                  <span className="px-2 py-0.5 bg-slate-800 border border-slate-700/50 rounded-full text-xs text-slate-300">
                    BFE: {bbrData.ejendomsrelationer[0].bfeNummer}
                  </span>
                )}
                {esrNummer && (
                  <span className="px-2 py-0.5 bg-slate-800 border border-slate-700/50 rounded-full text-xs text-slate-300">
                    ESR: {esrNummer}
                  </span>
                )}
                {/* BIZZ-496: Frednings/beskyttelses-badges fra matrikeldata */}
                {matrikelData?.jordstykker?.some((js) => js.fredskov) && (
                  <span className="px-2 py-0.5 bg-green-900/50 border border-green-800/40 rounded-full text-[10px] font-semibold text-green-400">
                    {t.protectedForest}
                  </span>
                )}
                {matrikelData?.jordstykker?.some((js) => js.strandbeskyttelse) && (
                  <span className="px-2 py-0.5 bg-blue-900/50 border border-blue-800/40 rounded-full text-[10px] font-semibold text-blue-400">
                    {t.coastalProtection}
                  </span>
                )}
                {matrikelData?.jordstykker?.some((js) => js.klitfredning) && (
                  <span className="px-2 py-0.5 bg-amber-900/50 border border-amber-800/40 rounded-full text-[10px] font-semibold text-amber-400">
                    {t.duneProtection}
                  </span>
                )}
                {matrikelData?.jordstykker?.some((js) => js.jordrente) && (
                  <span className="px-2 py-0.5 bg-purple-900/50 border border-purple-800/40 rounded-full text-[10px] font-semibold text-purple-400">
                    {t.groundRent}
                  </span>
                )}
              </div>
            </div>

            {/* Tabs */}
            <div role="tablist" className="flex gap-1 -mb-px overflow-x-auto scrollbar-hide">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  role="tab"
                  aria-selected={aktivTab === tab.id}
                  onClick={() => setAktivTab(tab.id)}
                  className={`flex items-center gap-1 px-2 py-1.5 text-xs font-medium border-b-2 transition-all whitespace-nowrap ${
                    aktivTab === tab.id
                      ? 'border-blue-500 text-blue-300'
                      : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600'
                  }`}
                >
                  {tab.ikon}
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-5">
            {/* ══ OVERBLIK ══ */}
            {aktivTab === 'overblik' && (
              <div className="space-y-2">
                {/* 2-spalte layout: ejendomsdata (venstre) + økonomi (højre) */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {/* ─── Rad 1: Matrikel (v) + Ejendomsvurdering (h)
                       CSS grid sikrer automatisk ens højde på disse to bokse ─── */}

                  {/* Matrikel / Lejlighedsinfo */}
                  {(() => {
                    const erModer = !dawaAdresse?.etage && !!bbrData?.ejerlejlighedBfe;
                    const erLejlighed = !!bbrData?.ejerlejlighedBfe && !erModer;
                    const enhed = erLejlighed ? (bbrData?.enheder ?? [])[0] : null;
                    // Grundareal: brug DAWA jordstykke → VUR vurderet areal som fallback
                    const grundareal =
                      (dawaJordstykke?.areal_m2 || null) ?? vurdering?.vurderetAreal ?? null;
                    const bygAreal =
                      bbrData?.bbr?.reduce((s, b) => s + (b.bebyggetAreal ?? 0), 0) ?? 0;
                    // Bebyggelsesprocent: fra VUR hvis tilgængeligt, ellers beregnet
                    const bebyggPct =
                      !erLejlighed && vurdering?.bebyggelsesprocent != null
                        ? vurdering.bebyggelsesprocent
                        : !erLejlighed && grundareal && bygAreal
                          ? Math.round((bygAreal / grundareal) * 100)
                          : null;
                    // Kommunenavn: DAWA → jordstykke som fallback
                    const kommunenavn =
                      (dawaAdresse.kommunenavn || null) ?? dawaJordstykke?.kommune.navn ?? null;
                    return (
                      <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-2.5">
                        <div className="flex items-baseline justify-between mb-1.5">
                          <div className="flex items-baseline gap-1">
                            <span className="text-white font-bold text-lg">
                              {erLejlighed ? '' : '1'}
                            </span>
                            <span className="text-slate-400 text-xs">
                              {erLejlighed ? (da ? 'Lejlighed' : 'Apartment') : t.cadastre}
                            </span>
                            {erLejlighed && tinglysningData?.ejerlejlighedNr && (
                              <span className="text-slate-500 text-xs ml-1">
                                nr. {tinglysningData.ejerlejlighedNr}
                              </span>
                            )}
                          </div>
                          {bebyggPct !== null && (
                            <span className="text-slate-400 text-xs font-medium">
                              {bebyggPct}% {t.builtUp}
                            </span>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                          {erLejlighed ? (
                            <>
                              {/* Lejligheds-specifik info */}
                              <div>
                                <p className="text-slate-500 text-xs leading-none mb-0.5">
                                  {da ? 'Tinglyst areal' : 'Registered area'}
                                </p>
                                <p className="text-white text-sm font-medium">
                                  {tinglysningData?.tinglystAreal
                                    ? `${tinglysningData.tinglystAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                    : '–'}
                                </p>
                              </div>
                              <div>
                                <p className="text-slate-500 text-xs leading-none mb-0.5">
                                  {da ? 'Værelser' : 'Rooms'}
                                </p>
                                <p className="text-white text-sm font-medium">
                                  {enhed?.vaerelser ?? '–'}
                                </p>
                              </div>
                              <div>
                                <p className="text-slate-500 text-xs leading-none mb-0.5">
                                  {t.cadastreNr}
                                </p>
                                <p className="text-white text-sm font-medium">
                                  {dawaJordstykke?.matrikelnr ?? dawaAdresse.matrikelnr ?? '–'}
                                </p>
                              </div>
                              <div>
                                <p className="text-slate-500 text-xs leading-none mb-0.5">
                                  {t.municipality}
                                </p>
                                <p className="text-white text-sm">{kommunenavn ?? '–'}</p>
                              </div>
                            </>
                          ) : (
                            <>
                              {/* Standard matrikel-info */}
                              <div>
                                <p className="text-slate-500 text-xs leading-none mb-0.5">
                                  {t.plotArea}
                                </p>
                                <p className="text-white text-sm font-medium">
                                  {grundareal
                                    ? `${grundareal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                    : '–'}
                                </p>
                              </div>
                              <div>
                                <p className="text-slate-500 text-xs leading-none mb-0.5">
                                  {t.cadastreNr}
                                </p>
                                <p className="text-white text-sm font-medium">
                                  {dawaJordstykke?.matrikelnr ?? dawaAdresse.matrikelnr ?? '–'}
                                </p>
                              </div>
                              <div>
                                <p className="text-slate-500 text-xs leading-none mb-0.5">
                                  {t.ejerlav}
                                </p>
                                <p className="text-white text-sm truncate">
                                  {dawaJordstykke?.ejerlav.navn ?? '–'}
                                </p>
                              </div>
                              <div>
                                <p className="text-slate-500 text-xs leading-none mb-0.5">
                                  {t.municipality}
                                </p>
                                <p className="text-white text-sm">{kommunenavn ?? '–'}</p>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Ejendomsvurdering */}
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-2.5">
                    <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-1.5 flex items-center gap-2">
                      <span>{t.propertyValuation}</span>
                      {vurdering?.erNytSystem && (
                        <span className="px-1.5 py-0.5 bg-blue-500/10 border border-blue-500/20 rounded text-[10px] text-blue-400 font-medium normal-case tracking-normal">
                          NY
                        </span>
                      )}
                    </p>
                    {vurderingLoader ? (
                      <div className="space-y-2 animate-pulse">
                        <div className="grid grid-cols-2 gap-x-3">
                          <div>
                            <div className="h-3 w-20 bg-slate-700/60 rounded mb-1.5" />
                            <div className="h-5 w-28 bg-slate-700/40 rounded" />
                          </div>
                          <div>
                            <div className="h-3 w-16 bg-slate-700/60 rounded mb-1.5" />
                            <div className="h-5 w-24 bg-slate-700/40 rounded" />
                          </div>
                        </div>
                        <div className="h-3 w-32 bg-slate-700/40 rounded" />
                      </div>
                    ) : vurdering ? (
                      <div className="space-y-2">
                        {/* Ejendomsværdi + Grundværdi side om side */}
                        <div className="grid grid-cols-2 gap-x-3">
                          <div>
                            <p className="text-slate-500 text-xs leading-none mb-0.5">
                              {t.propertyValue}
                              {vurdering.aar && (
                                <span className="ml-1 text-slate-600">({vurdering.aar})</span>
                              )}
                            </p>
                            <p className="text-white text-base font-bold">
                              {vurdering.ejendomsvaerdi
                                ? formatDKK(vurdering.ejendomsvaerdi)
                                : formatDKK(0)}
                            </p>
                            {vurdering.afgiftspligtigEjendomsvaerdi !== null &&
                              vurdering.afgiftspligtigEjendomsvaerdi !==
                                vurdering.ejendomsvaerdi && (
                                <p className="text-slate-500 text-xs mt-0.5">
                                  {t.taxable}: {formatDKK(vurdering.afgiftspligtigEjendomsvaerdi)}
                                </p>
                              )}
                          </div>
                          <div>
                            <p className="text-slate-500 text-xs leading-none mb-0.5">
                              {t.landValue}
                              {vurdering.aar && (
                                <span className="ml-1 text-slate-600">({vurdering.aar})</span>
                              )}
                            </p>
                            <p className="text-white text-sm font-medium">
                              {vurdering.grundvaerdi
                                ? formatDKK(vurdering.grundvaerdi)
                                : formatDKK(0)}
                            </p>
                            {vurdering.afgiftspligtigGrundvaerdi !== null &&
                              vurdering.afgiftspligtigGrundvaerdi !== vurdering.grundvaerdi && (
                                <p className="text-slate-500 text-xs mt-0.5">
                                  {t.taxable}: {formatDKK(vurdering.afgiftspligtigGrundvaerdi)}
                                </p>
                              )}
                          </div>
                        </div>
                        {/* Vurderet areal + Grundskyld side om side */}
                        <div className="grid grid-cols-2 gap-x-3 pt-1.5 border-t border-slate-700/30">
                          <div>
                            <p className="text-slate-500 text-xs leading-none mb-0.5">
                              {t.assessedArea}
                            </p>
                            <p className="text-white text-sm font-medium">
                              {vurdering.vurderetAreal
                                ? `${vurdering.vurderetAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                : '–'}
                            </p>
                          </div>
                          {/* Grundskyld — foretrækker faktisk fra Vurderingsportalen, falder tilbage til estimeret */}
                          {(() => {
                            const nyesteFrl = forelobige.length > 0 ? forelobige[0] : null;
                            const faktiskGrundskyld = nyesteFrl?.grundskyld ?? null;
                            if (faktiskGrundskyld !== null && faktiskGrundskyld > 0) {
                              return (
                                <div>
                                  <p className="text-slate-500 text-xs leading-none mb-0.5">
                                    {t.groundTax}
                                    <span className="text-slate-600 ml-1">
                                      ({nyesteFrl!.vurderingsaar})
                                    </span>
                                  </p>
                                  <p className="text-white text-sm font-medium flex items-center gap-1">
                                    {formatDKK(faktiskGrundskyld)}
                                    <span className="text-slate-500 text-xs">{t.perYear}</span>
                                  </p>
                                </div>
                              );
                            }
                            // BIZZ-445: Removed estimated grundskyld fallback — only show actual values
                            return null;
                          })()}
                        </div>
                      </div>
                    ) : forelobige.length === 0 ? (
                      <p className="text-slate-500 text-xs">
                        {bbrLoader || !bbrData
                          ? t.awaitingBBR
                          : !bbrData.ejendomsrelationer?.[0]?.bfeNummer
                            ? t.bfeNotFound
                            : 'Ingen vurderingsdata'}
                      </p>
                    ) : null}

                    {/* ── Forelobig vurdering — vises hvis nyere end nuvaerende vurdering ── */}
                    {(() => {
                      const nyesteForelobig = forelobige.length > 0 ? forelobige[0] : null;
                      const erNyere =
                        nyesteForelobig &&
                        (!vurdering?.aar || nyesteForelobig.vurderingsaar > vurdering.aar);
                      if (!nyesteForelobig || !erNyere) return null;
                      return (
                        <div className="mt-2 bg-amber-500/5 border border-amber-500/20 rounded-xl p-3">
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className="px-1.5 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded text-[10px] text-amber-400 font-medium">
                              {t.preliminary}
                            </span>
                          </div>
                          <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                            <div>
                              <p className="text-slate-500 text-xs leading-none mb-0.5">
                                {t.propertyValue}
                                <span className="ml-1 text-slate-600">
                                  ({nyesteForelobig.vurderingsaar})
                                </span>
                              </p>
                              <p className="text-amber-200 text-sm font-medium">
                                {nyesteForelobig.ejendomsvaerdi
                                  ? formatDKK(nyesteForelobig.ejendomsvaerdi)
                                  : formatDKK(0)}
                              </p>
                            </div>
                            <div>
                              <p className="text-slate-500 text-xs leading-none mb-0.5">
                                {t.landValue}
                                <span className="ml-1 text-slate-600">
                                  ({nyesteForelobig.vurderingsaar})
                                </span>
                              </p>
                              <p className="text-amber-200 text-sm font-medium">
                                {nyesteForelobig.grundvaerdi
                                  ? formatDKK(nyesteForelobig.grundvaerdi)
                                  : '0 DKK'}
                              </p>
                            </div>
                          </div>
                        </div>
                      );
                    })()}
                  </div>

                  {/* ─── Rad 2: Bygninger (v) + Enheder (h)
                       self-start: boksene strækkes ikke til at matche hinanden ─── */}

                  {/* Bygninger — vis for alle ejendomstyper, ekskluder nedrevne/historiske */}
                  {(() => {
                    const bygninger = (bbrData?.bbr ?? [])
                      .filter(
                        (b) =>
                          b.status !== 'Nedrevet/slettet' &&
                          b.status !== 'Bygning nedrevet' &&
                          b.status !== 'Bygning bortfaldet'
                      )
                      .sort((a, b) => (a.bygningsnr ?? 9999) - (b.bygningsnr ?? 9999));
                    const totAreal = bygninger.reduce(
                      (s, b) => s + (b.samletBygningsareal ?? 0),
                      0
                    );
                    const boligAreal = bygninger.reduce((s, b) => s + (b.samletBoligareal ?? 0), 0);
                    const erhvAreal = bygninger.reduce(
                      (s, b) => s + (b.samletErhvervsareal ?? 0),
                      0
                    );
                    const kaelder = bygninger.reduce((s, b) => s + (b.kaelder ?? 0), 0);
                    return (
                      <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-2.5 self-start">
                        <div className="flex items-baseline gap-1 mb-1.5">
                          <span className="text-white font-bold text-lg">
                            {bbrLoader ? '…' : bygninger.length || '–'}
                          </span>
                          <span className="text-slate-400 text-xs">{t.buildings}</span>
                        </div>
                        <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                          <div>
                            <p className="text-slate-500 text-xs leading-none mb-0.5">
                              {t.buildingArea}
                            </p>
                            <p className="text-white text-sm font-medium">
                              {totAreal
                                ? `${totAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                : formatDKK(0)}
                            </p>
                          </div>
                          <div>
                            <p className="text-slate-500 text-xs leading-none mb-0.5">
                              {t.residentialArea}
                            </p>
                            <p className="text-white text-sm font-medium">
                              {boligAreal
                                ? `${boligAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                : '0 m²'}
                            </p>
                          </div>
                          <div>
                            <p className="text-slate-500 text-xs leading-none mb-0.5">
                              {t.commercialArea}
                            </p>
                            <p className="text-white text-sm font-medium">
                              {erhvAreal
                                ? `${erhvAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                : formatDKK(0)}
                            </p>
                          </div>
                          <div>
                            <p className="text-slate-500 text-xs leading-none mb-0.5">
                              {t.basement}
                            </p>
                            <p className="text-white text-sm font-medium">
                              {kaelder
                                ? `${kaelder.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                : '0 m²'}
                            </p>
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  {/* Enheder */}
                  {(() => {
                    const erModerHer = !dawaAdresse?.etage && !!bbrData?.ejerlejlighedBfe;
                    const enheder = bbrData?.enheder ?? [];
                    const boligEnh = enheder.filter((e) => (e.arealBolig ?? 0) > 0).length;
                    const erhvEnh = enheder.filter((e) => (e.arealErhverv ?? 0) > 0).length;
                    const totAreal = enheder.reduce((s, e) => s + (e.areal ?? 0), 0);

                    // Hovedejendom: vis antal lejligheder i stedet for tom enheder-boks
                    if (erModerHer) {
                      const antalLej = lejligheder?.length ?? 0;
                      return (
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-2.5 self-start">
                          <div className="flex items-baseline gap-1 mb-1.5">
                            <span className="text-white font-bold text-lg">
                              {lejlighederLoader ? '…' : antalLej || '–'}
                            </span>
                            <span className="text-slate-400 text-xs">
                              {da ? 'ejerlejligheder' : 'condominiums'}
                            </span>
                          </div>
                          <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                            <div>
                              <p className="text-slate-500 text-xs leading-none mb-0.5">
                                {t.residentialUnits}
                              </p>
                              <p className="text-white text-sm font-medium">
                                {lejlighederLoader ? '…' : antalLej}
                              </p>
                            </div>
                            <div>
                              <p className="text-slate-500 text-xs leading-none mb-0.5">
                                {t.commercialUnits}
                              </p>
                              <p className="text-white text-sm font-medium">0</p>
                            </div>
                            <div className="col-span-2">
                              <p className="text-slate-500 text-xs leading-none mb-0.5">
                                {t.totalUnitArea}
                              </p>
                              <p className="text-white text-sm font-medium">
                                {lejligheder && antalLej > 0
                                  ? `${lejligheder.reduce((s, l) => s + (l.areal ?? 0), 0).toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                  : formatDKK(0)}
                              </p>
                            </div>
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-2.5 self-start">
                        <div className="flex items-baseline gap-1 mb-1.5">
                          <span className="text-white font-bold text-lg">
                            {bbrLoader ? '…' : enheder.length || '–'}
                          </span>
                          <span className="text-slate-400 text-xs">{t.units}</span>
                        </div>
                        <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                          <div>
                            <p className="text-slate-500 text-xs leading-none mb-0.5">
                              {t.residentialUnits}
                            </p>
                            <p className="text-white text-sm font-medium">{boligEnh}</p>
                          </div>
                          <div>
                            <p className="text-slate-500 text-xs leading-none mb-0.5">
                              {t.commercialUnits}
                            </p>
                            <p className="text-white text-sm font-medium">{erhvEnh}</p>
                          </div>
                          <div className="col-span-2">
                            <p className="text-slate-500 text-xs leading-none mb-0.5">
                              {t.totalUnitArea}
                            </p>
                            <p className="text-white text-sm font-medium">
                              {totAreal
                                ? `${totAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                : formatDKK(0)}
                            </p>
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </div>

                {/*
                  BIZZ-473 follow-up: "Virksomheder på adressen"-sektionen blinkede
                  kort op og forsvandt igen fordi synlighed afhang af et race:
                    - Initial: lejligheder=null → sektion synlig → CVR-fetch
                      kunne færdiggøre først → sektion rendret med data
                    - Senere: lejligheder-fetch afsluttede med .length > 0 →
                      ydre betingelse blev false → sektion forsvandt
                  Beslut i stedet deterministisk på "erModer" (hovedejendom,
                  opdelt i ejerlejligheder). For hovedejendomme skjuler vi
                  sektionen fra start; for andre viser vi den. Ingen race,
                  ingen flash.
                */}
                {(() => {
                  const erModer = !dawaAdresse?.etage && !!bbrData?.ejerlejlighedBfe;
                  return !erModer;
                })() && (
                  <>
                    {/* Virksomheder på adressen — CVR OpenData (skjult for ejerlejlighedsejendomme).
                        BIZZ-473: Don't render anything until fetch is complete, to avoid
                        the loading spinner briefly showing then disappearing when no results. */}
                    {!cvrFetchComplete ? null : cvrTokenMangler ? (
                      <div className="bg-amber-500/8 border border-amber-500/20 rounded-xl p-4">
                        <p className="text-amber-300 text-xs font-medium uppercase tracking-wide mb-2">
                          {t.companiesAtAddress}
                        </p>
                        <p className="text-slate-400 text-sm mb-3">{t.cvrAccessRequired}</p>
                        <ol className="text-slate-400 text-xs space-y-1 list-decimal list-inside leading-relaxed">
                          <li>
                            {da ? 'Gå til' : 'Go to'}{' '}
                            <span className="text-blue-400 font-medium">
                              datacvr.virk.dk/data/login
                            </span>{' '}
                            {da ? '→ opret gratis bruger' : '→ create free account'}
                          </li>
                          <li>
                            {da ? 'Tilføj til' : 'Add to'}{' '}
                            <code className="bg-slate-800 px-1 rounded">.env.local</code>:
                          </li>
                        </ol>
                        <code className="block bg-slate-900 rounded-lg px-3 py-2 mt-2 text-xs text-emerald-400 font-mono">
                          CVR_ES_USER=din@email.dk{'\n'}CVR_ES_PASS=dit_password
                        </code>
                        <p className="text-slate-500 text-xs mt-2">{t.restartDevServer}</p>
                      </div>
                    ) : cvrApiDown ? (
                      <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                        <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-2">
                          {t.companiesAtAddress}
                        </p>
                        <p className="text-slate-500 text-sm">
                          {da
                            ? 'CVR-data er midlertidigt utilgængeligt — prøv igen om lidt.'
                            : 'CVR data is temporarily unavailable — please try again shortly.'}
                        </p>
                      </div>
                    ) : cvrVirksomheder === null ? (
                      <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                        <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-2">
                          {t.companiesAtAddress}
                        </p>
                        <div className="flex items-center gap-2 text-slate-500 text-sm">
                          <div className="w-3.5 h-3.5 border border-slate-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                          {t.loadingCVR}
                        </div>
                      </div>
                    ) : cvrVirksomheder.length > 0 ? (
                      (() => {
                        // Aktive = virksomheden er aktiv OG stadig registreret på denne adresse
                        // Historiske = ophørte ELLER flyttet til en anden adresse
                        const aktive = cvrVirksomheder.filter((v) => v.aktiv && v.påAdressen);
                        const historiske = cvrVirksomheder.filter((v) => !v.aktiv || !v.påAdressen);
                        const visteVirksomheder = visOphoerte ? [...aktive, ...historiske] : aktive;

                        /** Beregn adresseperiode (fra–til for hvornår virksomheden var/er på adressen) */
                        const beregnPeriode = (v: CVRVirksomhed) => {
                          const fra = v.adresseFra ?? v.aktivFra;
                          if (!fra) return '–';
                          const fraDate = new Date(fra);
                          const fraStr = fraDate.toLocaleDateString('da-DK', {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                          });
                          if (v.adresseTil) {
                            const tilDate = new Date(v.adresseTil);
                            const tilStr = tilDate.toLocaleDateString('da-DK', {
                              day: 'numeric',
                              month: 'short',
                              year: 'numeric',
                            });
                            return `${fraStr} – ${tilStr}`;
                          }
                          return `${fraStr} –`;
                        };

                        return (
                          <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden overflow-x-auto">
                            <div className="px-4 py-3 border-b border-slate-700/40 flex items-center justify-between">
                              <p className="text-slate-200 text-sm font-semibold">
                                {t.companiesAtAddress}
                              </p>
                              <div className="flex items-center gap-3">
                                <span className="text-slate-500 text-xs">
                                  {aktive.length} {t.active}
                                  {historiske.length > 0 &&
                                    ` · ${historiske.length} ${t.historical}`}
                                </span>
                                {/* Toggle historiske virksomheder (ophørte + flyttede) */}
                                {historiske.length > 0 && (
                                  <button
                                    onClick={() => setVisOphoerte(!visOphoerte)}
                                    className="flex items-center gap-1 text-slate-500 hover:text-slate-300 text-xs transition-colors"
                                  >
                                    {visOphoerte ? (
                                      <ChevronDown size={13} />
                                    ) : (
                                      <ChevronRight size={13} />
                                    )}
                                    {visOphoerte
                                      ? t.hideHistorical
                                      : `${t.showHistorical} (${historiske.length})`}
                                  </button>
                                )}
                              </div>
                            </div>
                            {/* Tabelheader */}
                            <div className="min-w-[500px] grid grid-cols-[1fr_1fr_120px_72px] px-4 py-2 text-slate-500 text-xs font-medium border-b border-slate-700/30">
                              <span>{t.company}</span>
                              <span>{t.industry}</span>
                              <span className="text-right">{t.period}</span>
                              <span className="text-right">{t.employees}</span>
                            </div>
                            <div className="divide-y divide-slate-700/20">
                              {visteVirksomheder.map((v) => (
                                <div
                                  key={v.cvr}
                                  className={`min-w-[500px] grid grid-cols-[1fr_1fr_120px_72px] px-4 py-3 items-center gap-2 hover:bg-slate-700/10 transition-colors ${!v.aktiv || !v.påAdressen ? 'opacity-50' : ''}`}
                                >
                                  {/* Virksomhed */}
                                  <div className="min-w-0 flex items-center gap-2">
                                    <div
                                      className={`w-2 h-2 rounded-full flex-shrink-0 ${v.aktiv && v.påAdressen ? 'bg-emerald-400' : 'bg-slate-500'}`}
                                    />
                                    <div className="min-w-0">
                                      <Link
                                        href={`/dashboard/companies/${v.cvr}`}
                                        className="text-slate-200 text-sm font-medium hover:text-blue-400 transition-colors truncate block"
                                      >
                                        {v.navn}
                                      </Link>
                                      <p className="text-slate-500 text-xs truncate">
                                        {v.type ? `${v.type} · ` : ''}CVR {v.cvr}
                                      </p>
                                    </div>
                                  </div>
                                  {/* Industri */}
                                  <span className="text-slate-400 text-xs truncate pr-2">
                                    {v.branche ?? '–'}
                                  </span>
                                  {/* Periode */}
                                  <span className="text-slate-400 text-xs text-right">
                                    {beregnPeriode(v)}
                                  </span>
                                  {/* Ansatte */}
                                  <span className="text-slate-300 text-sm text-right font-medium">
                                    {v.ansatte ?? '–'}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })()
                    ) : (
                      <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                        <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-1">
                          {t.companiesAtAddress}
                        </p>
                        <p className="text-slate-500 text-sm">{t.noCVRFound}</p>
                      </div>
                    )}
                  </>
                )}

                {/* BBR-fejlbesked */}
                {bbrData?.bbrFejl && (
                  <div className="bg-orange-500/8 border border-orange-500/20 rounded-xl p-4 flex items-start gap-3">
                    <div className="w-5 h-5 rounded-full bg-orange-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <span className="text-orange-400 text-xs">!</span>
                    </div>
                    <div>
                      <p className="text-orange-300 text-sm font-medium">{t.bbrUnavailable}</p>
                      <p className="text-slate-400 text-xs mt-1">{bbrData.bbrFejl}</p>
                      <a
                        href="https://datafordeler.dk"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 text-xs hover:text-blue-300 mt-1 inline-block"
                      >
                        {t.openDatafordeler}
                      </a>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ══ BBR ══ — Live data, collapsible rækker */}
            {aktivTab === 'bbr' && (
              <div className="space-y-3">
                {bbrLoader && <TabLoadingSpinner label={t.loading} />}
                {bbrData?.bbrFejl && (
                  <div className="p-3 bg-orange-500/10 border border-orange-500/20 rounded-lg">
                    <p className="text-orange-300 text-sm">BBR: {bbrData.bbrFejl}</p>
                  </div>
                )}

                {/* Information */}
                <div>
                  <SectionTitle title={t.information} />
                  {(() => {
                    const grundareal =
                      (dawaJordstykke?.areal_m2 || null) ?? vurdering?.vurderetAreal ?? null;
                    const kommunenavn =
                      (dawaAdresse.kommunenavn || null) ?? dawaJordstykke?.kommune.navn ?? null;
                    return (
                      <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                        <div className="flex items-center gap-3 px-3 py-2 text-xs">
                          <MapIcon size={12} className="text-slate-500 flex-shrink-0" />
                          <span className="text-slate-200 font-medium flex-shrink-0">
                            {dawaJordstykke?.matrikelnr ?? dawaAdresse.matrikelnr ?? '–'}
                          </span>
                          <span className="text-slate-500">·</span>
                          <span className="text-slate-400 truncate flex-1">
                            {dawaJordstykke?.ejerlav.navn ?? '–'}
                          </span>
                          {kommunenavn && (
                            <>
                              <span className="text-slate-500">·</span>
                              <span className="text-slate-400 flex-shrink-0">{kommunenavn}</span>
                            </>
                          )}
                          {grundareal && (
                            <>
                              <span className="text-slate-500">·</span>
                              <span className="text-slate-300 flex-shrink-0 font-medium">
                                {grundareal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                </div>

                {/* Bygninger — ekskluder nedrevne/historiske */}
                {(() => {
                  // Filtrer til aktive bygninger (ekskluder nedrevne/historiske) så tabellen matcher BBR-kortet
                  const alleBygninger = bbrData?.bbr ?? [];
                  // Set af bygnings-IDs der har geodata (koordinater i WFS)
                  const geodataIds = new Set((bbrData?.bygningPunkter ?? []).map((p) => p.id));
                  const bygninger = alleBygninger
                    .filter(
                      (b) =>
                        b.status !== 'Nedrevet/slettet' &&
                        b.status !== 'Bygning nedrevet' &&
                        b.status !== 'Bygning bortfaldet'
                    )
                    .sort((a, b) => (a.bygningsnr ?? 9999) - (b.bygningsnr ?? 9999));
                  const totAreal = bygninger.reduce((s, b) => s + (b.samletBygningsareal ?? 0), 0);
                  const boligAreal = bygninger.reduce((s, b) => s + (b.samletBoligareal ?? 0), 0);
                  const erhvAreal = bygninger.reduce((s, b) => s + (b.samletErhvervsareal ?? 0), 0);
                  // BIZZ-487: Kælder + tagetage udledt fra BBR_Etage i fetchBbrData.ts
                  const kaelderAreal = bygninger.reduce((s, b) => s + (b.kaelder ?? 0), 0);
                  const tagetageAreal = bygninger.reduce((s, b) => s + (b.tagetage ?? 0), 0);
                  return (
                    <div>
                      <SectionTitle title={t.buildings} />
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
                        <DataKort
                          label={t.buildings}
                          value={bbrLoader ? '…' : `${bygninger.length}`}
                        />
                        <DataKort
                          label={t.buildingArea}
                          value={
                            totAreal ? `${totAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²` : '–'
                          }
                        />
                        <DataKort
                          label={t.residentialArea}
                          value={
                            boligAreal
                              ? `${boligAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                              : '0 m²'
                          }
                        />
                        <DataKort
                          label={t.commercialArea}
                          value={
                            erhvAreal
                              ? `${erhvAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                              : '–'
                          }
                        />
                        {/* BIZZ-487: Kælder vises kun når der er et areal > 0 */}
                        {kaelderAreal > 0 && (
                          <DataKort
                            label={t.basement}
                            value={`${kaelderAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`}
                          />
                        )}
                        {/* BIZZ-487: Tagetage vises kun når der er et areal > 0 */}
                        {tagetageAreal > 0 && (
                          <DataKort
                            label={da ? 'Tagetage' : 'Attic'}
                            value={`${tagetageAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`}
                          />
                        )}
                      </div>
                      {bbrLoader ? (
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden animate-pulse">
                          {[1, 2, 3].map((n) => (
                            <div
                              key={n}
                              className="px-3 py-2.5 border-b border-slate-700/20 flex items-center gap-3"
                            >
                              <div className="w-4 h-4 bg-slate-700/50 rounded" />
                              <div className="h-3 w-8 bg-slate-700/50 rounded" />
                              <div className="h-3 flex-1 bg-slate-700/30 rounded" />
                              <div className="h-3 w-12 bg-slate-700/40 rounded" />
                              <div className="h-3 w-16 bg-slate-700/40 rounded" />
                            </div>
                          ))}
                        </div>
                      ) : bygninger.length === 0 ? (
                        <div className="text-slate-500 text-sm text-center py-3">
                          {t.noActiveBuildings}
                        </div>
                      ) : (
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden overflow-x-auto">
                          {/* Kolonneheader: ▶ | Byg# | Anvendelse | Opf.år | Bebygget | Samlet | Geo | Status */}
                          <div className="min-w-[700px] grid grid-cols-[28px_40px_1fr_68px_96px_96px_52px_90px] px-3 py-2 text-slate-500 text-xs font-medium border-b border-slate-700/30">
                            <span />
                            <span className="text-center">{t.nr}</span>
                            <span>{t.usage}</span>
                            <span className="text-right">{t.builtYear}</span>
                            <span className="text-right">{t.builtArea}</span>
                            <span className="text-right">{t.totalArea}</span>
                            <span className="text-center">{t.geodata}</span>
                            <span className="text-center">{t.status}</span>
                          </div>
                          {bygninger.map((b, i) => {
                            const rowId = b.id || String(i);
                            const aaben = expandedBygninger.has(rowId);
                            // BIZZ-485: Risk-badges for materiale-risici
                            const risks = b.risks ?? {
                              asbestTag: false,
                              asbestYdervaeg: false,
                              traeYdervaeg: false,
                            };
                            // BIZZ-486: Opgang/etage data for denne bygning
                            const bygOpgange = (bbrData?.opgange ?? []).filter(
                              (o) =>
                                o.bygningId === b.id &&
                                o.status !== '7' &&
                                o.status !== 'Nedrevet/slettet'
                            );
                            const bygEtager = (bbrData?.etager ?? []).filter(
                              (e) =>
                                e.bygningId === b.id &&
                                e.status !== '7' &&
                                e.status !== 'Nedrevet/slettet'
                            );
                            const harElevator = bygOpgange.some((o) => o.elevator === true);
                            const etageBetegnelser = [
                              ...new Set(bygEtager.map((e) => e.etagebetegnelse).filter(Boolean)),
                            ].join(', ');
                            const detaljer: [string, string][] = (
                              [
                                [t.outerWall, b.ydervaeg || null],
                                [
                                  da ? 'Tagkonstruktion' : 'Roof construction',
                                  b.tagkonstruktion && b.tagkonstruktion !== '–'
                                    ? b.tagkonstruktion
                                    : null,
                                ],
                                [t.roofMaterial, b.tagmateriale || null],
                                [t.heatingInstallation, b.varmeinstallation || null],
                                [t.heatingForm, b.opvarmningsform || null],
                                [t.supplementaryHeat, b.supplerendeVarme || null],
                                [t.waterSupply, b.vandforsyning || null],
                                [t.drainage, b.afloeb || null],
                                [t.floors, b.antalEtager != null ? `${b.antalEtager}` : null],
                                // BIZZ-486: Opgange + elevator
                                [
                                  da ? 'Opgange' : 'Stairwells',
                                  bygOpgange.length > 0
                                    ? `${bygOpgange.length}${harElevator ? ` (${da ? 'med elevator' : 'with elevator'})` : ''}`
                                    : null,
                                ],
                                // BIZZ-486: Etage-betegnelser
                                [da ? 'Etager (BBR)' : 'Floors (BBR)', etageBetegnelser || null],
                                [
                                  'Boligareal',
                                  b.samletBoligareal
                                    ? `${b.samletBoligareal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                    : null,
                                ],
                                [
                                  'Erhvervsareal',
                                  b.samletErhvervsareal
                                    ? `${b.samletErhvervsareal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                    : null,
                                ],
                                [
                                  'Erhvervsenheder',
                                  b.antalErhvervsenheder != null && b.antalErhvervsenheder > 0
                                    ? `${b.antalErhvervsenheder}`
                                    : null,
                                ],
                                [
                                  da ? 'Ombygningsår' : 'Renovation year',
                                  b.ombygningsaar != null ? `${b.ombygningsaar}` : null,
                                ],
                                [t.preservation, b.fredning || null],
                                [t.conservationValue, b.bevaringsvaerdighed || null],
                                // BIZZ-488: Revisionsdato — diskret metadata så brugeren ved
                                // hvor aktuel BBR-registreringen er. Formateres som dansk/engelsk
                                // lokal dato når feltet er sat.
                                [
                                  da ? 'Data sidst revideret' : 'Data last revised',
                                  b.revisionsdato
                                    ? new Date(b.revisionsdato).toLocaleDateString(
                                        da ? 'da-DK' : 'en-GB',
                                        { year: 'numeric', month: 'short', day: 'numeric' }
                                      )
                                    : null,
                                ],
                              ] as [string, string | null][]
                            ).filter((row): row is [string, string] => row[1] !== null);
                            return (
                              <div
                                key={rowId}
                                className="border-t border-slate-700/30 first:border-0"
                              >
                                <button
                                  onClick={() =>
                                    setExpandedBygninger((prev) => {
                                      const next = new Set(prev);
                                      if (aaben) {
                                        next.delete(rowId);
                                      } else {
                                        next.add(rowId);
                                      }
                                      return next;
                                    })
                                  }
                                  className="w-full min-w-[700px] grid grid-cols-[28px_40px_1fr_68px_96px_96px_52px_90px] px-3 py-1.5 text-sm hover:bg-slate-700/20 transition-colors text-left items-center"
                                >
                                  {/* Chevron til venstre */}
                                  <ChevronRight
                                    size={14}
                                    className={`text-slate-500 transition-transform flex-shrink-0 ${aaben ? 'rotate-90' : ''}`}
                                  />
                                  {/* Bygningsnummer */}
                                  <span className="text-slate-500 text-xs text-center font-mono">
                                    {b.bygningsnr ?? '–'}
                                  </span>
                                  <span className="text-slate-200 truncate pr-2 flex items-center gap-1.5">
                                    <span className="truncate">{b.anvendelse || '–'}</span>
                                    {/* BIZZ-485: Risk-badges — asbest har højeste prioritet (rød).
                                        Træ-ydervæg vises kun hvis bygning er +40 år uden kendt ombygning. */}
                                    {/* BIZZ-485 v2: BBR's eksplicitte asbest-flag (byg036) —
                                        viser badge selv hvis tagmateriale-koden ikke er 3.
                                        Højere prioritet end udledte flags. */}
                                    {risks.asbestEksplicit &&
                                      !risks.asbestTag &&
                                      !risks.asbestYdervaeg && (
                                        <span
                                          className="flex-shrink-0 text-[9px] px-1 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/30"
                                          title={
                                            da
                                              ? 'BBR har bekræftet asbestholdigt materiale (byg036)'
                                              : 'BBR confirmed asbestos-containing material (byg036)'
                                          }
                                        >
                                          {da ? 'Asbest (BBR)' : 'Asbestos (BBR)'}
                                        </span>
                                      )}
                                    {risks.asbestTag && (
                                      <span
                                        className="flex-shrink-0 text-[9px] px-1 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/30"
                                        title={
                                          da
                                            ? 'Asbest i tagmateriale (fibercement pre-1986)'
                                            : 'Asbestos in roof (pre-1986 fibre cement)'
                                        }
                                      >
                                        {da ? 'Asbest tag' : 'Asbestos roof'}
                                      </span>
                                    )}
                                    {risks.asbestYdervaeg && (
                                      <span
                                        className="flex-shrink-0 text-[9px] px-1 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/30"
                                        title={
                                          da
                                            ? 'Asbest i ydervæg (eternit pre-1986)'
                                            : 'Asbestos in outer wall (pre-1986 eternit)'
                                        }
                                      >
                                        {da ? 'Asbest væg' : 'Asbestos wall'}
                                      </span>
                                    )}
                                    {risks.traeYdervaeg &&
                                      b.opfoerelsesaar != null &&
                                      new Date().getFullYear() - b.opfoerelsesaar > 40 &&
                                      !b.ombygningsaar && (
                                        <span
                                          className="flex-shrink-0 text-[9px] px-1 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20"
                                          title={
                                            da
                                              ? 'Træydervæg uden kendt ombygning — tjek efterisolering'
                                              : 'Wooden exterior without known renovation — check insulation'
                                          }
                                        >
                                          {da ? 'Ældre træ' : 'Old wood'}
                                        </span>
                                      )}
                                    {/* BIZZ-488: Fredet og bevaringsværdig badge — inline på bygning-rækken.
                                        Fredet (byg070Fredning) vinder over bevaringsværdig (byg071SAVE-score)
                                        hvis begge er sat, da fredning er en stærkere juridisk kategori. */}
                                    {b.fredning ? (
                                      <span
                                        className="flex-shrink-0 text-[9px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30"
                                        title={
                                          da
                                            ? `Fredet bygning: ${b.fredning}`
                                            : `Protected building: ${b.fredning}`
                                        }
                                      >
                                        {da ? 'Fredet' : 'Protected'}
                                      </span>
                                    ) : b.bevaringsvaerdighed ? (
                                      <span
                                        className="flex-shrink-0 text-[9px] px-1 py-0.5 rounded bg-purple-500/15 text-purple-300 border border-purple-500/30"
                                        title={
                                          da
                                            ? `Bevaringsværdig (SAVE): ${b.bevaringsvaerdighed}`
                                            : `Conservation value (SAVE): ${b.bevaringsvaerdighed}`
                                        }
                                      >
                                        SAVE
                                      </span>
                                    ) : null}
                                  </span>
                                  <span className="text-slate-400 text-right">
                                    {b.opfoerelsesaar ?? '–'}
                                  </span>
                                  <span className="text-slate-300 text-right">
                                    {b.bebyggetAreal
                                      ? `${b.bebyggetAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                      : formatDKK(0)}
                                  </span>
                                  <span className="text-slate-300 text-right">
                                    {b.samletBygningsareal
                                      ? `${b.samletBygningsareal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                      : formatDKK(0)}
                                  </span>
                                  {/* Geodata-status: grøn ✓ hvis koordinater kendes, rød ✗ hvis mangler */}
                                  <span className="flex justify-center">
                                    {geodataIds.has(b.id) ? (
                                      <CheckCircle size={14} className="text-emerald-400" />
                                    ) : (
                                      <XCircle size={14} className="text-red-400" />
                                    )}
                                  </span>
                                  {/* Status badge */}
                                  <span className="flex justify-center">
                                    {b.status == null || b.status.startsWith('Bygning opført') ? (
                                      <span className="text-emerald-400 text-xs">{t.erected}</span>
                                    ) : b.status === 'Projekteret bygning' ? (
                                      <span className="text-amber-400 text-xs">{t.projected}</span>
                                    ) : b.status === 'Bygning under opførelse' ? (
                                      <span className="text-amber-400 text-xs">
                                        {t.underConstruction}
                                      </span>
                                    ) : b.status === 'Midlertidig opførelse' ? (
                                      <span className="text-amber-400 text-xs">{t.temporary}</span>
                                    ) : b.status === 'Kondemneret' ? (
                                      <span className="text-red-400 text-xs">{t.condemned}</span>
                                    ) : (
                                      <span className="text-slate-400 text-xs truncate">
                                        {b.status}
                                      </span>
                                    )}
                                  </span>
                                </button>
                                {aaben && detaljer.length > 0 && (
                                  <div className="px-3 pb-2 bg-slate-900/40 border-t border-slate-700/20">
                                    <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs pt-2">
                                      {detaljer.map(([lbl, val]) => (
                                        <div key={lbl} className="flex justify-between gap-2">
                                          <span className="text-slate-500">{lbl}</span>
                                          <span className="text-slate-300 text-right">{val}</span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Enheder */}
                {(() => {
                  const bygningsnrMap = new Map(
                    (bbrData?.bygningPunkter ?? []).map((p) => [p.id, p.bygningsnr ?? 9999])
                  );
                  const enheder = (bbrData?.enheder ?? []).slice().sort((a, b) => {
                    const nrA = a.bygningId ? (bygningsnrMap.get(a.bygningId) ?? 9999) : 9999;
                    const nrB = b.bygningId ? (bygningsnrMap.get(b.bygningId) ?? 9999) : 9999;
                    return nrA - nrB;
                  });
                  const boligEnh = enheder.filter((e) => (e.arealBolig ?? 0) > 0).length;
                  const erhvEnh = enheder.filter((e) => (e.arealErhverv ?? 0) > 0).length;
                  const totAreal = enheder.reduce((s, e) => s + (e.areal ?? 0), 0);
                  return (
                    <div>
                      <SectionTitle title={t.units} />
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
                        <DataKort
                          label={t.totalUnits}
                          value={bbrLoader ? '…' : `${enheder.length}`}
                        />
                        <DataKort label={t.residentialUnits} value={`${boligEnh}`} />
                        <DataKort label={t.commercialUnits} value={`${erhvEnh}`} />
                        <DataKort
                          label={t.totalAreaLabel}
                          value={
                            totAreal ? `${totAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²` : '–'
                          }
                        />
                      </div>
                      {bbrLoader ? (
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden animate-pulse">
                          {[1, 2].map((n) => (
                            <div
                              key={n}
                              className="px-3 py-2.5 border-b border-slate-700/20 flex items-center gap-3"
                            >
                              <div className="w-4 h-4 bg-slate-700/50 rounded" />
                              <div className="h-3 w-8 bg-slate-700/50 rounded" />
                              <div className="h-3 flex-1 bg-slate-700/30 rounded" />
                              <div className="h-3 w-14 bg-slate-700/40 rounded" />
                            </div>
                          ))}
                        </div>
                      ) : enheder.length === 0 ? (
                        <div className="text-slate-500 text-sm text-center py-3">
                          {t.noUnitsAvailable}
                        </div>
                      ) : (
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden overflow-x-auto">
                          {/* Kolonneheader: ▶ | Byg.nr | Anvendelse | Areal | Værelser */}
                          <div className="min-w-[500px] grid grid-cols-[28px_44px_1fr_96px_72px] px-3 py-2 text-slate-500 text-xs font-medium border-b border-slate-700/30">
                            <span />
                            <span className="text-center">{t.bldg}</span>
                            <span>{t.usage}</span>
                            <span className="text-right">{t.area}</span>
                            <span className="text-right">{t.rooms}</span>
                          </div>
                          {enheder.map((e, i) => {
                            const rowId = e.id || String(i);
                            const aaben = expandedEnheder.has(rowId);
                            // Slå bygningsnummer op fra WFS-punkterne via bygningId
                            const bygningsnr = e.bygningId
                              ? ((bbrData?.bygningPunkter ?? []).find((p) => p.id === e.bygningId)
                                  ?.bygningsnr ?? null)
                              : null;
                            const detaljer: [string, string][] = (
                              [
                                [t.address, e.adressebetegnelse || null],
                                [t.floor, e.etage || null],
                                [t.door, e.doer || null],
                                [t.housingType, e.boligtype || null],
                                [t.status, e.status || null],
                                [
                                  'Boligareal',
                                  e.arealBolig
                                    ? `${e.arealBolig.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                    : null,
                                ],
                                [
                                  'Erhvervsareal',
                                  e.arealErhverv
                                    ? `${e.arealErhverv.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                    : null,
                                ],
                                [
                                  'Varmeinstallation',
                                  e.varmeinstallation !== '–' ? e.varmeinstallation : null,
                                ],
                                [t.energySupply, e.energiforsyning || null],
                              ] as [string, string | null][]
                            ).filter((row): row is [string, string] => row[1] !== null);
                            return (
                              <div
                                key={rowId}
                                className="border-t border-slate-700/30 first:border-0"
                              >
                                <button
                                  onClick={() =>
                                    setExpandedEnheder((prev) => {
                                      const next = new Set(prev);
                                      if (aaben) {
                                        next.delete(rowId);
                                      } else {
                                        next.add(rowId);
                                      }
                                      return next;
                                    })
                                  }
                                  className="w-full min-w-[500px] grid grid-cols-[28px_44px_1fr_96px_72px] px-3 py-1.5 text-sm hover:bg-slate-700/20 transition-colors text-left items-center"
                                >
                                  <ChevronRight
                                    size={14}
                                    className={`text-slate-500 transition-transform flex-shrink-0 ${aaben ? 'rotate-90' : ''}`}
                                  />
                                  <span className="text-slate-500 text-xs text-center font-mono">
                                    {bygningsnr ?? '–'}
                                  </span>
                                  <span className="min-w-0 pr-2">
                                    <span className="block text-slate-200 truncate">
                                      {e.anvendelse || '–'}
                                    </span>
                                    {(e.etage || e.doer) && (
                                      <span className="block text-slate-500 text-xs truncate">
                                        {[e.etage && `${e.etage}.`, e.doer]
                                          .filter(Boolean)
                                          .join(' ')}
                                      </span>
                                    )}
                                  </span>
                                  <span className="text-slate-300 text-right">
                                    {e.areal
                                      ? `${e.areal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                      : formatDKK(0)}
                                  </span>
                                  <span className="text-slate-400 text-right">
                                    {e.vaerelser ?? '–'}
                                  </span>
                                </button>
                                {aaben && detaljer.length > 0 && (
                                  <div className="px-3 pb-2 bg-slate-900/40 border-t border-slate-700/20">
                                    <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs pt-2">
                                      {detaljer.map(([lbl, val]) => (
                                        <div key={lbl} className="flex justify-between gap-2">
                                          <span className="text-slate-500">{lbl}</span>
                                          <span className="text-slate-300 text-right">{val}</span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Ingen BBR-data */}
                {!bbrLoader && !bbrData?.bbr && (
                  <div className="bg-orange-500/8 border border-orange-500/20 rounded-xl p-5">
                    <p className="text-orange-300 text-sm font-medium mb-1">
                      {t.bbrDataUnavailable}
                    </p>
                    <p className="text-slate-400 text-xs leading-relaxed">
                      {bbrData?.bbrFejl ?? t.bbrSubscriptionRequired}
                    </p>
                  </div>
                )}

                {/* BIZZ-484: Tekniske anlæg (solceller, varmepumper, oliefyr,
                    tanke etc.) — vises hvis nogen findes på adressen. */}
                {!bbrLoader && bbrData?.tekniskeAnlaeg && bbrData.tekniskeAnlaeg.length > 0 && (
                  <div className="mt-5">
                    <SectionTitle title={da ? 'Tekniske anlæg' : 'Technical installations'} />
                    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                      <div className="divide-y divide-slate-700/30">
                        {bbrData.tekniskeAnlaeg.map((t) => {
                          const tekst = tekniskAnlaegTekst(t.tek020Klassifikation);
                          const kategori = tekniskAnlaegKategori(t.tek020Klassifikation);
                          const farve =
                            kategori === 'energi'
                              ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20'
                              : kategori === 'tank'
                                ? 'text-amber-300 bg-amber-500/10 border-amber-500/20'
                                : 'text-slate-300 bg-slate-700/30 border-slate-600/30';
                          return (
                            <div
                              key={t.id_lokalId}
                              className="px-4 py-2.5 flex items-center justify-between gap-3"
                            >
                              <span className="text-slate-200 text-sm">{tekst}</span>
                              <span
                                className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${farve}`}
                              >
                                {kategori === 'energi'
                                  ? da
                                    ? 'Energi'
                                    : 'Energy'
                                  : kategori === 'tank'
                                    ? da
                                      ? 'Tank'
                                      : 'Tank'
                                    : da
                                      ? 'Andet'
                                      : 'Other'}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}

                {/* ── Matrikeloplysninger (Datafordeler MAT) ── */}
                <div className="mt-5">
                  <SectionTitle title={t.cadastreInfo} />
                  {matrikelLoader ? (
                    <SektionLoader label={t.loadingCadastre} rows={3} />
                  ) : matrikelData ? (
                    <div className="space-y-3">
                      {/* Ejendomsinfo */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        {matrikelData.landbrugsnotering && (
                          <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3">
                            <p className="text-slate-400 text-xs mb-0.5">{t.agriculturalNote}</p>
                            <p className="text-white text-sm font-medium">
                              {matrikelData.landbrugsnotering}
                            </p>
                          </div>
                        )}
                        {matrikelData.opdeltIEjerlejligheder && (
                          <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3">
                            <p className="text-slate-400 text-xs mb-0.5">{t.condominiums}</p>
                            <p className="text-white text-sm font-medium">
                              {t.dividedIntoCondominiums}
                            </p>
                          </div>
                        )}
                        {matrikelData.erFaelleslod && (
                          <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3">
                            <p className="text-slate-400 text-xs mb-0.5">{t.commonLot}</p>
                            <p className="text-white text-sm font-medium">{t.yes}</p>
                          </div>
                        )}
                        {matrikelData.udskiltVej && (
                          <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3">
                            <p className="text-slate-400 text-xs mb-0.5">{t.separatedRoad}</p>
                            <p className="text-white text-sm font-medium">{t.yes}</p>
                          </div>
                        )}
                      </div>

                      {/* Jordstykker tabel */}
                      {matrikelData.jordstykker.length > 0 && (
                        <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-hidden overflow-x-auto">
                          <div className="px-4 py-2.5 border-b border-slate-700/30">
                            <p className="text-slate-300 text-xs font-semibold uppercase tracking-wider">
                              {t.parcels} ({matrikelData.jordstykker.length})
                            </p>
                          </div>
                          <div className="divide-y divide-slate-700/20">
                            {matrikelData.jordstykker.map((js) => (
                              <div
                                key={js.id}
                                className="min-w-[450px] px-4 py-2.5 grid grid-cols-[1fr_100px_80px_auto] gap-3 items-center"
                              >
                                <div>
                                  <p className="text-white text-sm font-medium">
                                    {da ? 'Matr.nr.' : 'Cad. no.'} {js.matrikelnummer}
                                    {js.ejerlavskode && (
                                      <span className="text-slate-500 text-xs ml-2">
                                        {da ? 'Ejerlav' : 'District'} {js.ejerlavskode}
                                      </span>
                                    )}
                                  </p>
                                  {js.ejerlavsnavn && (
                                    <p className="text-slate-500 text-xs">{js.ejerlavsnavn}</p>
                                  )}
                                  {/* BIZZ-499: Vis arealtype fra MAT */}
                                  {js.arealtype && (
                                    <p className="text-slate-500 text-[10px]">
                                      {da ? 'Arealtype' : 'Area type'}: {js.arealtype}
                                    </p>
                                  )}
                                </div>
                                <p className="text-slate-300 text-sm tabular-nums text-right">
                                  {js.registreretAreal != null
                                    ? `${js.registreretAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                    : formatDKK(0)}
                                </p>
                                <p className="text-slate-500 text-xs text-right">
                                  {js.vejareal != null && js.vejareal > 0
                                    ? `${t.road}: ${js.vejareal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                    : ''}
                                </p>
                                <div className="flex gap-1.5 flex-wrap justify-end">
                                  {js.fredskov === true && (
                                    <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-green-900/50 text-green-400 border border-green-800/40">
                                      {t.protectedForest}
                                    </span>
                                  )}
                                  {js.strandbeskyttelse === true && (
                                    <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-blue-900/50 text-blue-400 border border-blue-800/40">
                                      {t.coastalProtection}
                                    </span>
                                  )}
                                  {js.klitfredning === true && (
                                    <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-amber-900/50 text-amber-400 border border-amber-800/40">
                                      {t.duneProtection}
                                    </span>
                                  )}
                                  {js.jordrente === true && (
                                    <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-purple-900/50 text-purple-400 border border-purple-800/40">
                                      {t.groundRent}
                                    </span>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* ── BIZZ-500: Matrikel-historik (collapsible tidslinje) ── */}
                      <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-hidden">
                        <button
                          type="button"
                          onClick={() => setHistorikOpen((prev) => !prev)}
                          className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-slate-700/20 transition-colors"
                          aria-expanded={historikOpen}
                        >
                          <span className="text-slate-300 text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5">
                            <Clock size={12} className="text-slate-500" />
                            {da ? 'Matrikel-historik' : 'Cadastre history'}
                          </span>
                          {historikOpen ? (
                            <ChevronDown size={14} className="text-slate-500" />
                          ) : (
                            <ChevronRight size={14} className="text-slate-500" />
                          )}
                        </button>
                        {historikOpen && (
                          <div className="px-4 pb-4 border-t border-slate-700/20">
                            {historikLoader ? (
                              <div className="py-4 text-center">
                                <div className="inline-block w-4 h-4 border-2 border-slate-600 border-t-blue-400 rounded-full animate-spin" />
                                <p className="text-slate-500 text-xs mt-2">
                                  {da ? 'Henter historik…' : 'Loading history…'}
                                </p>
                              </div>
                            ) : matrikelHistorik.length > 0 ? (
                              <div className="relative mt-3">
                                <div className="absolute left-[7px] top-2 bottom-2 w-px bg-slate-700/50" />
                                <div className="space-y-4">
                                  {matrikelHistorik.map((evt, idx) => {
                                    const typeColor =
                                      {
                                        oprettelse: 'bg-green-500',
                                        udstykning: 'bg-orange-500',
                                        sammenlægning: 'bg-blue-500',
                                        arealændring: 'bg-yellow-500',
                                        statusændring: 'bg-purple-500',
                                      }[evt.type] ?? 'bg-slate-500';
                                    const typeLabel = da
                                      ? {
                                          oprettelse: 'Oprettet',
                                          udstykning: 'Udstykning',
                                          sammenlægning: 'Sammenlægning',
                                          arealændring: 'Arealændring',
                                          statusændring: 'Statusændring',
                                        }[evt.type]
                                      : {
                                          oprettelse: 'Created',
                                          udstykning: 'Subdivision',
                                          sammenlægning: 'Merger',
                                          arealændring: 'Area change',
                                          statusændring: 'Status change',
                                        }[evt.type];
                                    const formattedDate = (() => {
                                      try {
                                        return new Date(evt.dato).toLocaleDateString(
                                          da ? 'da-DK' : 'en-GB',
                                          { year: 'numeric', month: 'short', day: 'numeric' }
                                        );
                                      } catch {
                                        return evt.dato;
                                      }
                                    })();
                                    return (
                                      <div
                                        key={`${evt.dato}-${evt.type}-${idx}`}
                                        className="relative pl-6"
                                      >
                                        <div
                                          className={`absolute left-0.5 top-1 w-3 h-3 rounded-full border-2 border-slate-900 ${typeColor}`}
                                        />
                                        <div>
                                          <div className="flex items-center gap-2 mb-0.5">
                                            <span className="text-slate-400 text-[10px] tabular-nums">
                                              {formattedDate}
                                            </span>
                                            <span
                                              className={`px-1.5 py-0.5 text-[10px] font-semibold rounded ${typeColor}/20 text-white/80`}
                                            >
                                              {typeLabel}
                                            </span>
                                          </div>
                                          <p className="text-slate-300 text-xs">
                                            {evt.beskrivelse}
                                          </p>
                                          {evt.detaljer && (
                                            <div className="mt-1 text-[10px] text-slate-500 space-y-0.5">
                                              {evt.detaljer.arealFoer != null &&
                                                evt.detaljer.arealEfter != null && (
                                                  <p>
                                                    {da ? 'Areal' : 'Area'}:{' '}
                                                    {evt.detaljer.arealFoer.toLocaleString(
                                                      da ? 'da-DK' : 'en-GB'
                                                    )}{' '}
                                                    m² →{' '}
                                                    {evt.detaljer.arealEfter.toLocaleString(
                                                      da ? 'da-DK' : 'en-GB'
                                                    )}{' '}
                                                    m²
                                                  </p>
                                                )}
                                              {evt.detaljer.jordstykkerFoer &&
                                                evt.detaljer.jordstykkerEfter && (
                                                  <p>
                                                    {da ? 'Jordstykker' : 'Parcels'}:{' '}
                                                    {evt.detaljer.jordstykkerFoer.join(', ')} →{' '}
                                                    {evt.detaljer.jordstykkerEfter.join(', ')}
                                                  </p>
                                                )}
                                              {evt.detaljer.forretningshaendelse && (
                                                <p className="italic">
                                                  {evt.detaljer.forretningshaendelse}
                                                </p>
                                              )}
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            ) : (
                              <p className="py-3 text-slate-500 text-xs text-center">
                                {da
                                  ? 'Ingen historik fundet for denne ejendom'
                                  : 'No history found for this property'}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="bg-slate-800/30 border border-slate-700/40 rounded-xl p-4 text-center">
                      <p className="text-slate-500 text-xs">{t.noCadastreData}</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ══ EJERFORHOLD — always mounted for prefetch (BIZZ-410), hidden when not active ══ */}
            <div className={aktivTab === 'ejerforhold' ? '' : 'hidden'}>
              <div className="space-y-2">
                {/* Loading state — vis spinner mens BBR eller ejerskab data hentes */}
                {(ejereLoader || bbrLoader || !bbrData) && (
                  <TabLoadingSpinner
                    label={da ? 'Henter ejerskabsdata…' : 'Loading ownership data…'}
                  />
                )}
                {/* ── Ejerskabsdiagram / Relationsdiagram (fra Tinglysning + EJF kæde) ── */}
                {!ejereLoader &&
                  !bbrLoader &&
                  bbrData &&
                  (() => {
                    const erModer = !dawaAdresse?.etage && !!bbrData?.ejerlejlighedBfe;
                    const bfeForDiagram =
                      bbrData?.ejerlejlighedBfe ?? bbrData?.ejendomsrelationer?.[0]?.bfeNummer;

                    // Hovedejendom opdelt i EL — vis info + lejlighedsliste
                    if (erModer) {
                      return (
                        <div className="space-y-4">
                          <SectionTitle title={t.ownershipStructure} />
                          <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-6 text-center space-y-3">
                            <div className="w-12 h-12 bg-amber-500/10 rounded-xl flex items-center justify-center mx-auto">
                              <Building2 size={22} className="text-amber-400" />
                            </div>
                            <p className="text-slate-300 text-sm font-medium">
                              {da
                                ? 'Ejendommen er opdelt i ejerlejligheder'
                                : 'Property is divided into condominiums'}
                            </p>
                            <p className="text-slate-500 text-xs max-w-md mx-auto">
                              {da
                                ? 'Ejerskab er registreret på de enkelte ejerlejligheder.'
                                : 'Ownership is registered on individual condominium units.'}
                            </p>
                          </div>

                          {/* Lejlighedsliste under info-boksen.
                              BIZZ-478: Ensartet blå TabLoadingSpinner. */}
                          {lejlighederLoader && (
                            <TabLoadingSpinner
                              label={da ? 'Henter lejlighedsdata…' : 'Loading apartment data…'}
                            />
                          )}
                          {lejligheder !== null && lejligheder.length > 0 && (
                            <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden overflow-x-auto">
                              <div className="px-3 py-2.5 border-b border-slate-700/40 flex items-center justify-between">
                                <p className="text-slate-200 text-xs font-semibold">
                                  {t.apartments}
                                </p>
                                <span className="text-slate-500 text-[10px]">
                                  {lejligheder.length} {da ? 'lejligheder' : 'apartments'}
                                </span>
                              </div>
                              <div className="min-w-[720px] grid grid-cols-[1fr_120px_60px_100px_80px] px-3 py-1.5 text-slate-500 text-[10px] font-medium border-b border-slate-700/30">
                                <span>{t.apartmentAddress}</span>
                                <span>{t.apartmentOwner}</span>
                                <span className="text-right">{t.apartmentArea}</span>
                                <span className="text-right">{t.apartmentPrice}</span>
                                <span className="text-right">{t.apartmentDate}</span>
                              </div>
                              <div className="divide-y divide-slate-700/20">
                                {lejligheder.map((lej) => (
                                  <Link
                                    key={lej.bfe}
                                    href={lej.dawaId ? `/dashboard/ejendomme/${lej.dawaId}` : '#'}
                                    onClick={
                                      lej.dawaId
                                        ? undefined
                                        : (e: React.MouseEvent) => e.preventDefault()
                                    }
                                    className={`min-w-[720px] grid grid-cols-[1fr_120px_60px_100px_80px] px-3 py-1.5 items-center gap-1 hover:bg-slate-700/15 transition-colors block ${lej.dawaId ? 'cursor-pointer' : 'cursor-default'}`}
                                  >
                                    <span
                                      className="text-slate-200 text-[11px] font-medium truncate"
                                      title={lej.adresse}
                                    >
                                      {lej.adresse.split(',').slice(0, 2).join(',')}
                                    </span>
                                    <span
                                      className="text-slate-400 text-[10px] truncate"
                                      title={lej.ejer}
                                    >
                                      {lej.ejer}
                                    </span>
                                    <span className="text-slate-300 text-[10px] text-right">
                                      {lej.areal ? `${lej.areal} m²` : '–'}
                                    </span>
                                    <span className="text-slate-300 text-[10px] text-right font-medium">
                                      {lej.koebspris
                                        ? `${lej.koebspris.toLocaleString('da-DK')} DKK`
                                        : '–'}
                                    </span>
                                    <span className="text-slate-400 text-[10px] text-right">
                                      {lej.koebsdato
                                        ? new Date(lej.koebsdato).toLocaleDateString('da-DK', {
                                            day: 'numeric',
                                            month: 'short',
                                            year: 'numeric',
                                          })
                                        : '–'}
                                    </span>
                                  </Link>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    }

                    if (!bfeForDiagram) return null;
                    return (
                      <div>
                        <PropertyOwnerDiagram
                          bfe={bfeForDiagram}
                          adresse={
                            dawaAdresse
                              ? `${dawaAdresse.vejnavn} ${dawaAdresse.husnr}${dawaAdresse.etage ? `, ${dawaAdresse.etage}.` : ''}${dawaAdresse.dør ? ` ${dawaAdresse.dør}` : ''}, ${dawaAdresse.postnr} ${dawaAdresse.postnrnavn}`
                              : `BFE ${bfeForDiagram}`
                          }
                          lang={lang}
                          erEjerlejlighed={!!bbrData?.ejerlejlighedBfe}
                        />
                      </div>
                    );
                  })()}
              </div>
            </div>

            {/* ══ TINGLYSNING ══ — altid mounted (hidden) så data ikke mistes ved tab-skift */}
            {(() => {
              const erModer = !dawaAdresse?.etage && !!bbrData?.ejerlejlighedBfe;
              const bfeForTl = erModer
                ? (bbrData?.moderBfe ?? bbrData?.ejendomsrelationer?.[0]?.bfeNummer ?? null)
                : (bbrData?.ejerlejlighedBfe ??
                  bbrData?.ejendomsrelationer?.[0]?.bfeNummer ??
                  null);
              return (
                <div className={aktivTab === 'tinglysning' ? '' : 'hidden'}>
                  <TinglysningTab bfe={bfeForTl} lang={lang} moderBfe={bbrData?.moderBfe ?? null} />
                </div>
              );
            })()}

            {/* ══ ØKONOMI ══ */}
            {aktivTab === 'oekonomi' && (
              <div className="space-y-5">
                {/* ── Ejendomsvurdering ── */}
                <div>
                  <SectionTitle title={t.propertyValuation} />
                  {vurderingLoader ? (
                    <div className="flex items-center gap-2 text-slate-500 text-sm py-4">
                      <div className="w-4 h-4 border-2 border-slate-600 border-t-blue-500 rounded-full animate-spin" />
                      {t.loadingValuation}
                    </div>
                  ) : vurdering ? (
                    <>
                      {/* Aktuelle tal */}
                      <div className="grid grid-cols-3 gap-3 mb-3">
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                          <p className="text-slate-400 text-xs mb-1">
                            {t.propertyValue}
                            {vurdering.aar && (
                              <span className="ml-1 text-slate-500">({vurdering.aar})</span>
                            )}
                          </p>
                          <p className="text-white text-lg font-bold">
                            {vurdering.ejendomsvaerdi
                              ? formatDKK(vurdering.ejendomsvaerdi)
                              : formatDKK(0)}
                          </p>
                        </div>
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                          <p className="text-slate-400 text-xs mb-1">{t.landValue}</p>
                          <p className="text-white text-lg font-bold">
                            {vurdering.grundvaerdi
                              ? formatDKK(vurdering.grundvaerdi)
                              : formatDKK(0)}
                          </p>
                        </div>
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                          <p className="text-slate-400 text-xs mb-1">{t.plotArea}</p>
                          <p className="text-white text-lg font-bold">
                            {vurdering.vurderetAreal != null
                              ? `${vurdering.vurderetAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                              : formatDKK(0)}
                          </p>
                        </div>
                      </div>

                      {/* BIZZ-494: Fradrag for forbedringer — vises under Grundværdi */}
                      {vurFradrag && vurFradrag.vaerdiSum != null && vurFradrag.vaerdiSum > 0 && (
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 mb-3">
                          <p className="text-slate-400 text-xs font-semibold uppercase tracking-wider mb-2">
                            {da ? 'Fradrag for forbedringer' : 'Improvement deductions'}
                          </p>
                          <p className="text-white text-sm font-bold mb-2">
                            {formatDKK(vurFradrag.vaerdiSum)}
                            {vurFradrag.foersteGangAar && (
                              <span className="text-slate-500 text-xs font-normal ml-2">
                                {da ? 'fra' : 'from'} {vurFradrag.foersteGangAar}
                              </span>
                            )}
                          </p>
                          {vurFradrag.poster.length > 0 && (
                            <div className="space-y-1">
                              {vurFradrag.poster.map((post, i) => (
                                <div key={i} className="flex items-center justify-between text-xs">
                                  <span className="text-slate-400">
                                    {post.tekst ?? (da ? 'Fradrag' : 'Deduction')}
                                    {post.aar && (
                                      <span className="text-slate-500 ml-1">({post.aar})</span>
                                    )}
                                  </span>
                                  <span className="text-slate-300 tabular-nums">
                                    {post.vaerdi != null ? formatDKK(post.vaerdi) : '—'}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* BIZZ-493: Ejerboligfordeling — skjult for enfamiliehuse */}
                      {vurFordeling.length > 0 && (
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 mb-3">
                          <p className="text-slate-400 text-xs font-semibold uppercase tracking-wider mb-2">
                            {da ? 'Ejerboligfordeling' : 'Owner-occupied allocation'}
                          </p>
                          <div className="space-y-2">
                            {vurFordeling.map((f, i) => (
                              <div key={i} className="grid grid-cols-2 gap-3">
                                {f.ejerboligvaerdi != null && (
                                  <div>
                                    <p className="text-slate-500 text-[10px] uppercase">
                                      {da ? 'Ejerboligværdi' : 'Owner-occupied value'}
                                    </p>
                                    <p className="text-white text-sm font-medium">
                                      {formatDKK(f.ejerboligvaerdi)}
                                    </p>
                                  </div>
                                )}
                                {f.ejerboliggrundvaerdi != null && (
                                  <div>
                                    <p className="text-slate-500 text-[10px] uppercase">
                                      {da ? 'Ejerboliggrundværdi' : 'Owner-occupied land value'}
                                    </p>
                                    <p className="text-white text-sm font-medium">
                                      {formatDKK(f.ejerboliggrundvaerdi)}
                                    </p>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* BIZZ-492: Grundværdispecifikation — nedbrydning af grundværdiberegning */}
                      {vurGrundvaerdispec.length > 0 && (
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden overflow-x-auto mb-3">
                          <div className="px-4 py-2.5 border-b border-slate-700/30">
                            <p className="text-slate-400 text-xs font-semibold uppercase tracking-wider">
                              {da ? 'Grundværdispecifikation' : 'Land value specification'}
                            </p>
                          </div>
                          <div className="min-w-[400px]">
                            <div className="grid grid-cols-[1fr_80px_90px_90px] px-4 py-1.5 text-slate-500 text-[10px] font-medium uppercase bg-slate-900/30">
                              <span>{da ? 'Beskrivelse' : 'Description'}</span>
                              <span className="text-right">{da ? 'Areal' : 'Area'}</span>
                              <span className="text-right">{da ? 'Enhedspris' : 'Unit price'}</span>
                              <span className="text-right">{da ? 'Beløb' : 'Amount'}</span>
                            </div>
                            {vurGrundvaerdispec.map((spec) => (
                              <div
                                key={spec.loebenummer}
                                className="grid grid-cols-[1fr_80px_90px_90px] px-4 py-2 text-sm border-t border-slate-700/20 items-center"
                              >
                                <span className="text-slate-300 text-xs">
                                  {spec.tekst ?? `#${spec.loebenummer}`}
                                </span>
                                <span className="text-slate-400 text-xs text-right tabular-nums">
                                  {spec.areal != null
                                    ? `${spec.areal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                    : '—'}
                                </span>
                                <span className="text-slate-400 text-xs text-right tabular-nums">
                                  {spec.enhedBeloeb != null ? formatDKK(spec.enhedBeloeb) : '—'}
                                </span>
                                <span className="text-white text-xs text-right tabular-nums font-medium">
                                  {spec.beloeb != null ? formatDKK(spec.beloeb) : '—'}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Vurderingshistorik — collapsible tabel med forelobige prepended */}
                      {(alleVurderinger.length > 1 || forelobige.length > 0) && (
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden overflow-x-auto">
                          <button
                            onClick={() => setVisVurderingHistorik((v) => !v)}
                            className="w-full flex items-center gap-2 px-4 py-3 hover:bg-slate-700/20 transition-colors"
                          >
                            <ChevronRight
                              size={14}
                              className={`text-slate-500 transition-transform flex-shrink-0 ${visVurderingHistorik ? 'rotate-90' : ''}`}
                            />
                            <span className="text-slate-300 text-sm font-medium">
                              {t.valuationHistory}
                            </span>
                            {forelobige.length > 0 && (
                              <span className="px-1.5 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded text-[10px] text-amber-400 font-medium">
                                {forelobige.length} {t.preliminary}
                                {forelobige.length > 1 ? 'E' : ''}
                              </span>
                            )}
                          </button>
                          {visVurderingHistorik && (
                            <>
                              {/* Header */}
                              <div className="min-w-[550px] grid grid-cols-[140px_1fr_1fr_100px] px-4 py-2 text-slate-500 text-xs font-medium border-t border-slate-700/30 bg-slate-900/30">
                                <span>{t.yearCol}</span>
                                <span>{t.propertyValueCol}</span>
                                <span>{t.landValueCol}</span>
                                <span className="text-right">{t.plotArea}</span>
                              </div>

                              {/* Forelobige vurderinger — prepended med amber badge */}
                              {forelobige.map((fv, i) => (
                                <div
                                  key={`forelobig-${fv.vurderingsaar}-${i}`}
                                  className="min-w-[550px] grid grid-cols-[140px_1fr_1fr_100px] px-4 py-2.5 text-sm border-t border-amber-500/10 bg-amber-500/[0.02] hover:bg-amber-500/5 items-center"
                                >
                                  <div className="flex items-center gap-2">
                                    <span className="text-amber-200 font-medium">
                                      {fv.vurderingsaar}
                                    </span>
                                    <span className="px-1.5 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded text-[10px] text-amber-400 font-medium">
                                      {t.preliminary}
                                    </span>
                                  </div>
                                  <span className="text-amber-200/80">
                                    {fv.ejendomsvaerdi
                                      ? formatDKK(fv.ejendomsvaerdi)
                                      : formatDKK(0)}
                                  </span>
                                  <span className="text-amber-200/80">
                                    {fv.grundvaerdi ? formatDKK(fv.grundvaerdi) : '0 DKK'}
                                  </span>
                                  <span className="text-slate-400 text-right">–</span>
                                </div>
                              ))}

                              {/* Endelige vurderinger fra Datafordeler */}
                              {alleVurderinger.map((v, i) => {
                                return (
                                  <div
                                    key={`${v.aar}-${i}`}
                                    className="min-w-[550px] grid grid-cols-[140px_1fr_1fr_100px] px-4 py-2.5 text-sm border-t border-slate-700/20 hover:bg-slate-700/10 items-center"
                                  >
                                    <div className="flex items-center gap-2">
                                      <span className="text-slate-200 font-medium">
                                        {v.aar ?? '–'}
                                      </span>
                                      {v.erNytSystem && (
                                        <span className="px-1.5 py-0.5 bg-blue-500/10 border border-blue-500/20 rounded text-[10px] text-blue-400 font-medium">
                                          NY
                                        </span>
                                      )}
                                    </div>
                                    <span className="text-slate-300">
                                      {v.ejendomsvaerdi != null
                                        ? formatDKK(v.ejendomsvaerdi)
                                        : formatDKK(0)}
                                    </span>
                                    <span className="text-slate-300">
                                      {v.grundvaerdi != null ? formatDKK(v.grundvaerdi) : '0 DKK'}
                                    </span>
                                    <span className="text-slate-400 text-right">
                                      {v.vurderetAreal != null
                                        ? `${v.vurderetAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                        : formatDKK(0)}
                                    </span>
                                  </div>
                                );
                              })}
                            </>
                          )}
                        </div>
                      )}
                    </>
                  ) : !bbrData?.ejendomsrelationer?.[0]?.bfeNummer ? (
                    <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4">
                      <p className="text-amber-300 text-sm font-medium mb-1">{t.bfeUnavailable}</p>
                      <p className="text-slate-400 text-xs">
                        Ejendomsvurdering kræver BFEnummer fra BBR Ejendomsrelation.
                      </p>
                    </div>
                  ) : (
                    <div className="bg-slate-800/30 border border-slate-700/40 rounded-xl p-4 text-center">
                      <p className="text-slate-500 text-xs">{t.noValuationFound}</p>
                    </div>
                  )}
                </div>

                {/* ── Salgshistorik (EJF + Tinglysning) ── */}
                {/* BIZZ-402: only render when loading or when there is data to show */}
                {(salgshistorikLoader || tlSumLoader || mergedSalgshistorik.length > 0) && (
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <SectionTitle title={t.salesHistory} />
                      {tlTestFallback && mergedSalgshistorik.length > 0 && (
                        <span className="px-2 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded text-[10px] text-amber-400 font-medium">
                          TESTDATA
                        </span>
                      )}
                    </div>
                    {salgshistorikLoader || tlSumLoader ? (
                      <SektionLoader label={t.loadingSalesHistory} rows={4} />
                    ) : mergedSalgshistorik.length > 0 ? (
                      <div className="bg-slate-800/20 border border-slate-700/30 rounded-xl overflow-hidden overflow-x-auto">
                        {/* BIZZ-324: table expanded with tinglysningsdato, tinglysningsafgift, loesoeresum and entreprisesum */}
                        <table className="w-full text-sm min-w-[900px]">
                          <thead>
                            <tr className="border-b border-slate-700/30 text-slate-500 text-xs uppercase tracking-wider">
                              <th className="text-left px-4 py-2.5 font-medium">{t.date}</th>
                              <th className="text-left px-4 py-2.5 font-medium">{t.buyerName}</th>
                              <th className="text-left px-4 py-2.5 font-medium">{t.type}</th>
                              <th className="text-right px-4 py-2.5 font-medium">
                                {t.purchasePrice}
                              </th>
                              <th className="text-right px-4 py-2.5 font-medium">{t.cashPrice}</th>
                              <th className="text-right px-4 py-2.5 font-medium">
                                {t.loesoereSum}
                              </th>
                              <th className="text-right px-4 py-2.5 font-medium">
                                {t.entrepriseSum}
                              </th>
                              <th className="text-right px-4 py-2.5 font-medium">
                                {t.registrationDate}
                              </th>
                              <th className="text-right px-4 py-2.5 font-medium">
                                {t.registrationFee}
                              </th>
                              <th className="text-right px-4 py-2.5 font-medium">{t.share}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {mergedSalgshistorik.map((h, i) => {
                              /** Primær dato: købsaftaledato foretrukkes, ellers overtagelsesdato */
                              const dato = h.koebsaftaleDato ?? h.overtagelsesdato;
                              const overdragelse = h.overdragelsesmaade ?? h.adkomstType;
                              return (
                                <tr
                                  key={i}
                                  className="border-b border-slate-700/20 last:border-0 hover:bg-white/[0.02] transition-colors"
                                >
                                  <td className="px-4 py-2.5 text-slate-300 tabular-nums whitespace-nowrap">
                                    {dato
                                      ? new Date(dato).toLocaleDateString(da ? 'da-DK' : 'en-GB', {
                                          year: 'numeric',
                                          month: 'short',
                                          day: 'numeric',
                                        })
                                      : '—'}
                                    {/* Show overtagelsesdato as secondary line when different from koebsaftaleDato */}
                                    {h.koebsaftaleDato &&
                                      h.overtagelsesdato &&
                                      h.koebsaftaleDato !== h.overtagelsesdato && (
                                        <p className="text-slate-600 text-[10px] mt-0.5">
                                          {t.overtagelsesdato}:{' '}
                                          {new Date(h.overtagelsesdato).toLocaleDateString(
                                            da ? 'da-DK' : 'en-GB',
                                            {
                                              year: 'numeric',
                                              month: 'short',
                                              day: 'numeric',
                                            }
                                          )}
                                        </p>
                                      )}
                                  </td>
                                  <td className="px-4 py-2.5">
                                    {h.koeber ? (
                                      <div>
                                        <p className="text-slate-200 text-sm leading-tight">
                                          {h.koebercvr ? (
                                            <Link
                                              href={`/dashboard/companies/${h.koebercvr}`}
                                              className="hover:text-blue-400 transition-colors"
                                            >
                                              {h.koeber}
                                            </Link>
                                          ) : (
                                            h.koeber
                                          )}
                                        </p>
                                        {h.koebercvr && (
                                          <p className="text-slate-500 text-[10px]">
                                            CVR {h.koebercvr}
                                          </p>
                                        )}
                                      </div>
                                    ) : (
                                      <span className="text-slate-500 text-xs">—</span>
                                    )}
                                  </td>
                                  <td className="px-4 py-2.5">
                                    <div className="flex flex-col gap-1">
                                      <span
                                        className={`text-xs px-2 py-0.5 rounded-full inline-block w-fit ${
                                          overdragelse?.toLowerCase().includes('frit')
                                            ? 'text-emerald-400 bg-emerald-500/10 border border-emerald-500/20'
                                            : overdragelse?.toLowerCase().includes('tvang')
                                              ? 'text-red-400 bg-red-500/10 border border-red-500/20'
                                              : 'text-slate-400 bg-slate-500/10 border border-slate-500/20'
                                        }`}
                                      >
                                        {overdragelse ?? '—'}
                                      </span>
                                      {/* BIZZ-481: Betinget-badge med frist-dato — vigtigt
                                          advarselsflag på tinglyste handler med uopfyldte
                                          betingelser (købesum ikke fuldt betalt, skøder
                                          afhænger af tilladelser etc.). */}
                                      {h.betinget && (
                                        <span
                                          className="text-[10px] px-2 py-0.5 rounded-full inline-block w-fit text-amber-300 bg-amber-500/10 border border-amber-500/20"
                                          title={
                                            da
                                              ? 'Tinglyst med uopfyldte betingelser'
                                              : 'Recorded with unfulfilled conditions'
                                          }
                                        >
                                          ⚠ {da ? 'Betinget' : 'Conditional'}
                                          {h.fristDato && (
                                            <span className="ml-1 text-amber-400/80">
                                              {' · '}
                                              {da ? 'Frist' : 'Deadline'}{' '}
                                              {new Date(h.fristDato).toLocaleDateString(
                                                da ? 'da-DK' : 'en-GB',
                                                { year: 'numeric', month: 'short', day: 'numeric' }
                                              )}
                                            </span>
                                          )}
                                        </span>
                                      )}
                                      {/* BIZZ-481: Officiel forretningshaendelse-klassificering
                                          fra EJF (fx "Salg", "Arv", "Gave", "Fusion"). Vises når
                                          den afviger fra den fritekstede overdragelsesmaade. */}
                                      {h.forretningshaendelse &&
                                        h.forretningshaendelse !== overdragelse && (
                                          <span className="text-[10px] text-slate-500 italic">
                                            {h.forretningshaendelse}
                                          </span>
                                        )}
                                    </div>
                                  </td>
                                  <td className="px-4 py-2.5 text-right text-white font-medium tabular-nums">
                                    {h.samletKoebesum != null
                                      ? `${h.samletKoebesum.toLocaleString(da ? 'da-DK' : 'en-GB')} kr.`
                                      : '—'}
                                  </td>
                                  <td className="px-4 py-2.5 text-right text-slate-400 tabular-nums">
                                    {h.kontantKoebesum != null
                                      ? `${h.kontantKoebesum.toLocaleString(da ? 'da-DK' : 'en-GB')} kr.`
                                      : '—'}
                                  </td>
                                  <td className="px-4 py-2.5 text-right text-slate-400 tabular-nums text-xs">
                                    {h.loesoeresum != null
                                      ? `${h.loesoeresum.toLocaleString(da ? 'da-DK' : 'en-GB')} kr.`
                                      : '—'}
                                  </td>
                                  <td className="px-4 py-2.5 text-right text-slate-400 tabular-nums text-xs">
                                    {h.entreprisesum != null
                                      ? `${h.entreprisesum.toLocaleString(da ? 'da-DK' : 'en-GB')} kr.`
                                      : '—'}
                                  </td>
                                  <td className="px-4 py-2.5 text-right text-slate-400 tabular-nums text-xs whitespace-nowrap">
                                    {h.tinglysningsdato
                                      ? new Date(h.tinglysningsdato).toLocaleDateString(
                                          da ? 'da-DK' : 'en-GB',
                                          {
                                            year: 'numeric',
                                            month: 'short',
                                            day: 'numeric',
                                          }
                                        )
                                      : '—'}
                                  </td>
                                  <td className="px-4 py-2.5 text-right text-slate-400 tabular-nums text-xs">
                                    {h.tinglysningsafgift != null
                                      ? `${h.tinglysningsafgift.toLocaleString(da ? 'da-DK' : 'en-GB')} kr.`
                                      : '—'}
                                  </td>
                                  <td className="px-4 py-2.5 text-right text-slate-400 tabular-nums text-xs">
                                    {h.andel ?? '—'}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="bg-slate-800/20 border border-slate-700/30 rounded-xl p-5 text-center space-y-2">
                        <TrendingUp size={22} className="text-slate-600 mx-auto" />
                        <p className="text-slate-500 text-xs">{t.noTransactions}</p>
                        {salgshistorikManglerAdgang && (
                          <p className="text-slate-600 text-[10px] max-w-sm mx-auto leading-relaxed">
                            {t.salesHistoryEJF}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Hæftelser fjernet — vises nu under Tinglysning-tab */}
                {/* BIZZ-325: Udbudshistorik og Lignende handler fjernet — ingen datakilde tilgængelig endnu */}
              </div>
            )}

            {/* ══ SKAT ══ */}
            {aktivTab === 'skatter' && (
              <div className="space-y-5">
                {/* ── Ejendomsskatter — baseret på foreløbige + estimerede data ── */}
                <div>
                  <SectionTitle title={t.propertyTaxes} />

                  {(() => {
                    // BIZZ-319: Show loader while tax data is being fetched
                    if (forelobigLoader || vurderingLoader) {
                      return (
                        <SektionLoader
                          label={da ? 'Henter skattedata…' : 'Loading tax data…'}
                          rows={3}
                        />
                      );
                    }

                    /** Nyeste foreløbig vurdering (typisk 2024) */
                    const nyeste = forelobige.length > 0 ? forelobige[0] : null;

                    if (!nyeste && !vurdering?.estimereretGrundskyld) {
                      return (
                        <div className="bg-slate-800/20 border border-slate-700/30 rounded-xl p-5 text-center">
                          <p className="text-slate-500 text-xs">{t.noTaxData}</p>
                        </div>
                      );
                    }

                    /** Ejendomsværdiskat = 0 for kolonihaver på lejet grund */
                    const visEjendomsskat =
                      !erKolonihave && nyeste?.ejendomsskat != null && nyeste.ejendomsskat > 0;
                    const effektivGrundskyld = nyeste?.grundskyld ?? 0;
                    const effektivEjendomsskat = erKolonihave ? 0 : (nyeste?.ejendomsskat ?? 0);

                    return (
                      <div className="space-y-4">
                        {/* ── {t.currentTaxation} (nyeste foreløbige) ── */}
                        {nyeste && (
                          <div>
                            <p className="text-slate-300 text-sm font-semibold mb-0.5">
                              {t.currentTaxation} ({nyeste.vurderingsaar + 1})
                            </p>
                            {/*
                              BIZZ-469: Forklar eksplicit år-mappingen i
                              selve Nuværende beskatning-sektion. Samme note
                              findes under Skattehistorik, men her møder den
                              brugeren FØR de ser det større historiske
                              afsnit og undgår forveksling af vurderingsår
                              og betalingsår på det nyeste tal.
                            */}
                            <p className="text-slate-500 text-[11px] mb-2 leading-relaxed">
                              {da
                                ? `Skat betalt i ${nyeste.vurderingsaar + 1}, beregnet ud fra vurderingen for ${nyeste.vurderingsaar}.`
                                : `Tax paid in ${nyeste.vurderingsaar + 1}, calculated from the ${nyeste.vurderingsaar} assessment.`}
                            </p>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              {/* Grundskyld */}
                              <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                                <p className="text-white text-lg font-bold flex items-center gap-1.5">
                                  {effektivGrundskyld > 0
                                    ? formatDKK(effektivGrundskyld)
                                    : formatDKK(0)}
                                  <span className="text-slate-500 text-xs font-normal">DKK</span>
                                </p>
                                <p className="text-slate-500 text-xs mt-0.5">
                                  {t.groundTaxToMunicipality}
                                </p>
                              </div>
                              {/* Ejendomsværdiskat */}
                              {visEjendomsskat && (
                                <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                                  <p className="text-white text-lg font-bold">
                                    {formatDKK(nyeste.ejendomsskat!)}
                                    <span className="text-slate-500 text-xs font-normal ml-1">
                                      DKK
                                    </span>
                                  </p>
                                  <p className="text-slate-500 text-xs mt-0.5">
                                    {t.propertyValueTax}
                                  </p>
                                </div>
                              )}
                              {/* Kolonihave: vis 0 kr med (i)-ikon tooltip */}
                              {erKolonihave && (
                                <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 relative group/info">
                                  <p className="text-white text-lg font-bold flex items-center gap-1.5">
                                    0<span className="text-slate-500 text-xs font-normal">DKK</span>
                                    <span className="relative">
                                      <Info className="w-3.5 h-3.5 text-blue-400/70 cursor-help" />
                                      <span className="absolute left-full top-1/2 -translate-y-1/2 ml-2 w-64 px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-300 leading-relaxed opacity-0 invisible group-hover/info:opacity-100 group-hover/info:visible transition-all z-50 pointer-events-none shadow-xl">
                                        {t.koloniTooltip}
                                        <span className="absolute right-full top-1/2 -translate-y-1/2 border-4 border-transparent border-r-slate-700" />
                                      </span>
                                    </span>
                                  </p>
                                  <p className="text-slate-500 text-xs mt-0.5">
                                    {t.propertyValueTaxExempt}
                                  </p>
                                </div>
                              )}
                            </div>

                            {/* {t.totalTax} */}
                            {(visEjendomsskat || erKolonihave) && (
                              <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 mt-3">
                                <p className="text-white text-lg font-bold">
                                  {formatDKK(effektivGrundskyld + effektivEjendomsskat)}
                                  <span className="text-slate-500 text-xs font-normal ml-1">
                                    DKK
                                  </span>
                                </p>
                                <p className="text-slate-500 text-xs mt-0.5">
                                  {t.totalTax}{' '}
                                  {erKolonihave ? t.taxBreakdownKoloni : t.taxBreakdownNormal}
                                </p>
                              </div>
                            )}
                          </div>
                        )}

                        {/* BIZZ-445: Removed estimated grundskyld fallback — only actual Vurderingsportalen data */}
                      </div>
                    );
                  })()}
                </div>

                {/* BIZZ-445 + BIZZ-469: Skattehistorik — kun faktiske tal fra Vurderingsportalen (estimater fjernet) */}
                {forelobige.length > 0 &&
                  (() => {
                    type SkatRaekke = {
                      aar: number;
                      ejendomsvaerdi: number | null;
                      grundvaerdi: number | null;
                      grundskyldAktuel: number | null;
                      ejendomsskatAktuel: number | null;
                    };

                    const alleRaekker: SkatRaekke[] = forelobige
                      .map((fv) => ({
                        aar: fv.vurderingsaar,
                        ejendomsvaerdi: fv.ejendomsvaerdi,
                        grundvaerdi: fv.grundvaerdi,
                        grundskyldAktuel: fv.grundskyld,
                        ejendomsskatAktuel: fv.ejendomsskat,
                      }))
                      .sort((a, b) => b.aar - a.aar);

                    if (alleRaekker.length === 0) return null;

                    return (
                      <div>
                        <SectionTitle title={da ? 'Skattehistorik' : 'Tax history'} />
                        <p className="text-slate-500 text-xs mb-2 leading-relaxed">
                          {da
                            ? 'Årstal refererer til vurderingsåret. Skatten baseret på vurderingen opkræves typisk det følgende år — fx bygger betalinger i 2025 på vurderingen for 2024.'
                            : 'Year refers to the assessment year. The tax based on that assessment is usually collected the following year — e.g. payments in 2025 are based on the 2024 assessment.'}
                        </p>
                        <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-hidden overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b border-slate-700/40">
                                <th className="px-4 py-2.5 text-left text-slate-500 font-medium">
                                  {da ? 'Vurderingsår' : 'Assessment year'}
                                </th>
                                <th className="px-4 py-2.5 text-right text-slate-500 font-medium">
                                  {da ? 'Ejendomsværdi' : 'Property value'}
                                </th>
                                <th className="px-4 py-2.5 text-right text-slate-500 font-medium">
                                  {da ? 'Grundværdi' : 'Land value'}
                                </th>
                                <th className="px-4 py-2.5 text-right text-slate-500 font-medium">
                                  {da ? 'Grundskyld' : 'Land tax'}
                                </th>
                                <th className="px-4 py-2.5 text-right text-slate-500 font-medium">
                                  {da ? 'Ejendomsværdiskat' : 'Property value tax'}
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {alleRaekker.map((r) => (
                                <tr
                                  key={r.aar}
                                  className="border-b border-slate-700/20 last:border-0 hover:bg-slate-800/30"
                                >
                                  <td className="px-4 py-2 text-slate-300 font-medium">
                                    {r.aar}
                                    <span className="ml-1.5 text-slate-600 text-[10px] font-normal">
                                      {da ? `(betales ${r.aar + 1})` : `(paid ${r.aar + 1})`}
                                    </span>
                                  </td>
                                  <td className="px-4 py-2 text-right text-slate-300">
                                    {r.ejendomsvaerdi ? formatDKK(r.ejendomsvaerdi) : '–'}
                                  </td>
                                  <td className="px-4 py-2 text-right text-slate-300">
                                    {r.grundvaerdi ? formatDKK(r.grundvaerdi) : '–'}
                                  </td>
                                  <td className="px-4 py-2 text-right font-medium tabular-nums">
                                    {r.grundskyldAktuel != null ? (
                                      <span className="text-emerald-400">
                                        {formatDKK(r.grundskyldAktuel)} kr/år
                                      </span>
                                    ) : (
                                      '–'
                                    )}
                                  </td>
                                  <td className="px-4 py-2 text-right tabular-nums">
                                    {r.ejendomsskatAktuel != null ? (
                                      <span className="text-emerald-400 font-medium">
                                        {formatDKK(r.ejendomsskatAktuel)} kr/år
                                      </span>
                                    ) : (
                                      <span className="text-slate-600 text-[10px]">
                                        {da ? 'ikke opkrævet' : 'not charged'}
                                      </span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    );
                  })()}

                {/* BIZZ-490: Grundskatteloft (Loftansættelse, ESL §45 4,75%-regulering).
                    Vises som info-kort mellem historik og fritagelser så brugeren kan se
                    at grundskylden er begrænset af loftet — ellers fremstår den som en
                    uforklaret diskrepans i forhold til "promille × grundværdi". */}
                {vurLoft.length > 0 &&
                  (() => {
                    const aktivLoft =
                      vurLoft.find((l) => l.basisaar != null && l.grundvaerdi != null) ??
                      vurLoft[0];
                    if (
                      !aktivLoft ||
                      (aktivLoft.basisaar == null && aktivLoft.grundvaerdi == null)
                    ) {
                      return null;
                    }
                    return (
                      <div className="bg-amber-500/5 border border-amber-500/30 rounded-xl p-4">
                        <div className="flex items-start gap-3">
                          <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center">
                            <Landmark size={16} className="text-amber-300" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-amber-200 text-sm font-semibold">
                                {da ? 'Grundskatteloft aktiv' : 'Land-tax ceiling active'}
                              </p>
                              <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30">
                                {da ? 'ESL §45' : 'ESL §45'}
                              </span>
                            </div>
                            <p className="text-slate-400 text-xs mt-1 leading-snug">
                              {da
                                ? 'Grundskylden kan maksimalt stige 4,75% om året (loftreguleret grundværdi). Når loftet er aktivt, beregnes skatten af den regulerede grundværdi, ikke den fulde offentlige vurdering.'
                                : 'Land tax can rise by at most 4.75% per year (capped land value). When the ceiling is active, tax is calculated from the capped value — not the full public valuation.'}
                            </p>
                            <div className="grid grid-cols-2 gap-x-6 gap-y-1 mt-3 text-xs">
                              {aktivLoft.basisaar != null && (
                                <div className="flex justify-between gap-2">
                                  <span className="text-slate-500">
                                    {da ? 'Basisår' : 'Base year'}
                                  </span>
                                  <span className="text-slate-300 tabular-nums">
                                    {aktivLoft.basisaar}
                                  </span>
                                </div>
                              )}
                              {aktivLoft.grundvaerdi != null && (
                                <div className="flex justify-between gap-2">
                                  <span className="text-slate-500">
                                    {da ? 'Loftværdi' : 'Capped value'}
                                  </span>
                                  <span className="text-slate-300 tabular-nums">
                                    {formatDKK(aktivLoft.grundvaerdi)}
                                  </span>
                                </div>
                              )}
                              {aktivLoft.pgf11 && (
                                <div className="flex justify-between gap-2 col-span-2">
                                  <span className="text-slate-500">
                                    {da ? 'Beregningsgrundlag' : 'Calculation basis'}
                                  </span>
                                  <span className="text-slate-300">{aktivLoft.pgf11}</span>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                {/* BIZZ-491: Skattefritagelser */}
                {vurFritagelser.length > 0 && (
                  <div>
                    <SectionTitle title={da ? 'Skattefritagelser' : 'Tax exemptions'} />
                    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                      {vurFritagelser.map((f) => (
                        <div
                          key={f.loebenummer}
                          className="px-4 py-3 border-b border-slate-700/20 last:border-b-0 flex items-center justify-between"
                        >
                          <div>
                            <p className="text-slate-300 text-sm">
                              {f.artKode ?? `#${f.loebenummer}`}
                            </p>
                            {f.omfangKode && (
                              <p className="text-slate-500 text-xs">
                                {da ? 'Omfang' : 'Scope'}: {f.omfangKode}
                              </p>
                            )}
                          </div>
                          <p className="text-white text-sm font-medium tabular-nums">
                            {f.beloeb != null ? formatDKK(f.beloeb) : '—'}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ══ DOKUMENTER ══ */}
            {aktivTab === 'dokumenter' && (
              <div className="space-y-2">
                {/* ── Dokumenter (samlet kort) ── */}
                <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-x-auto">
                  {/* Kort-header */}
                  <div className="px-4 py-2.5 border-b border-slate-700/30 flex items-center gap-2">
                    <FileText size={15} className="text-slate-400" />
                    <span className="text-sm font-semibold text-slate-200">{t.documents}</span>
                    {(plandataLoader || energiLoader || jordLoader) && (
                      <span className="ml-2 text-xs text-slate-500 animate-pulse">{t.loading}</span>
                    )}
                    {/* Download-knap — højrestillet */}
                    <button
                      onClick={handleDownloadZip}
                      disabled={valgteDoc.size === 0 || zipLoader}
                      className="ml-auto flex items-center gap-1.5 px-3 py-1 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed border border-slate-600 rounded-lg text-slate-300 text-xs font-medium transition-all"
                      title={
                        valgteDoc.size === 0
                          ? t.selectDocsToDownload
                          : `${t.downloadSelected} (${valgteDoc.size}) ZIP`
                      }
                    >
                      {zipLoader ? (
                        <>
                          <span className="w-3 h-3 border border-slate-400 border-t-transparent rounded-full animate-spin" />
                          {t.loading}
                        </>
                      ) : (
                        <>
                          <Download size={12} />
                          {t.downloadSelected} ({valgteDoc.size})
                        </>
                      )}
                    </button>
                  </div>

                  {/* ── {t.standardDocs} subsection ── */}
                  {(() => {
                    const rel = bbrData?.ejendomsrelationer?.[0];
                    const bfeNummer = rel?.bfeNummer;
                    // PDF-link åbner Miljøportalens viewer i browser; ZIP-download bruger /api/jord/pdf proxy der fetcher /report/generate direkte
                    const rapportUrl =
                      rel?.ejerlavKode && rel?.matrikelnr
                        ? `https://jord.miljoeportal.dk/report?elav=${rel.ejerlavKode}&matrnr=${encodeURIComponent(rel.matrikelnr)}`
                        : null;

                    const jordItem = jordData?.[0] ?? null;
                    const jordIsV2 =
                      jordItem?.pollutionStatusCodeValue === '08' ||
                      jordItem?.pollutionStatusCodeValue === '13';
                    const jordIsV1 = jordItem?.pollutionStatusCodeValue === '07';
                    const jordIsUdgaaet =
                      jordItem?.pollutionStatusCodeValue === '16' ||
                      jordItem?.pollutionStatusCodeValue === '17';
                    const jordStatusKlasse = jordIsV2
                      ? 'bg-red-500/15 text-red-400'
                      : jordIsV1
                        ? 'bg-amber-500/15 text-amber-400'
                        : jordIsUdgaaet
                          ? 'bg-slate-700/40 text-slate-400'
                          : 'bg-orange-500/15 text-orange-400';

                    const formatDato = (iso: string | null) =>
                      iso
                        ? new Date(iso).toLocaleDateString(da ? 'da-DK' : 'en-GB', {
                            day: 'numeric',
                            month: 'long',
                            year: 'numeric',
                          })
                        : null;

                    const jordDetaljer = jordItem
                      ? [
                          jordItem.pollutionStatusText && {
                            label: t.mappingStatus,
                            value: `${jordItem.pollutionStatusCodeValue} — ${jordItem.pollutionStatusText}`,
                          },
                          jordItem.pollutionNuanceStatus.length > 0 && {
                            label: t.nuance,
                            value: jordItem.pollutionNuanceStatus.join(', '),
                          },
                          jordItem.locationReferences.length > 0 && {
                            label: t.locationRef,
                            value: jordItem.locationReferences.join(', '),
                          },
                          jordItem.locationNames.length > 0 && {
                            label: t.location,
                            value: jordItem.locationNames[0],
                          },
                          jordItem.locationNames.length > 1 && {
                            label: t.otherLocations,
                            value: jordItem.locationNames.slice(1).join(' · '),
                          },
                          formatDato(jordItem.recalculationDate) && {
                            label: t.reevalDate,
                            value: formatDato(jordItem.recalculationDate)!,
                          },
                          formatDato(jordItem.modifiedDate) && {
                            label: t.lastModified,
                            value: formatDato(jordItem.modifiedDate)!,
                          },
                          {
                            label: t.cadastreLabel,
                            value: `${jordItem.landParcelIdentifier} (ejerlav ${jordItem.cadastralDistrictIdentifier})`,
                          },
                          jordItem.regionNavn && { label: t.region, value: jordItem.regionNavn },
                          jordItem.municipalityCode && {
                            label: t.municipalityCode,
                            value: String(jordItem.municipalityCode),
                          },
                          jordItem.housingStatementIndicator && {
                            label: t.housingStatement,
                            value: 'Ja',
                          },
                        ].filter((r): r is { label: string; value: string } => Boolean(r))
                      : [];

                    const jordErUdvidet = jordItem ? expandedJord.has(jordItem.id) : false;

                    return (
                      <div className="border-b border-slate-700/30">
                        {/* Kolonneheader — identisk med plan-tabellen */}
                        <div className="min-w-[500px] grid grid-cols-[28px_72px_1fr_120px_80px] gap-x-3 px-4 py-1.5 border-b border-slate-700/20">
                          <span />
                          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                            {da ? 'År' : 'Year'}
                          </span>
                          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                            {da ? 'Dokument' : 'Document'}
                          </span>
                          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                            Status
                          </span>
                          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                            {da ? 'Dok.' : 'Doc.'}
                          </span>
                        </div>

                        {/* BBR-meddelelse */}
                        <div className="min-w-[500px] grid grid-cols-[28px_72px_1fr_120px_80px] gap-x-3 px-4 py-2 border-b border-slate-700/15 hover:bg-slate-700/10 transition-colors items-start">
                          <span />
                          <span className="text-sm text-slate-300 tabular-nums">
                            {(() => {
                              const datoer = (bbrData?.bbr ?? [])
                                .map((b) => b.revisionsdato)
                                .filter((d): d is string => !!d);
                              if (!datoer.length) return '—';
                              return Math.max(...datoer.map((d) => new Date(d).getFullYear()));
                            })()}
                          </span>
                          <div>
                            <span className="text-sm text-slate-200">{t.bbrNotice}</span>
                          </div>
                          <span />
                          <div className="flex items-center gap-1.5 self-start">
                            {bfeNummer ? (
                              <a
                                href={`https://bbr.dk/pls/wwwdata/get_newois_pck.show_bbr_meddelelse_pdf?i_bfe=${bfeNummer}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                              >
                                <FileText size={11} />
                                PDF
                              </a>
                            ) : (
                              <span className="text-slate-600 text-xs">—</span>
                            )}
                            {bfeNummer && (
                              <label
                                className="flex items-center cursor-pointer flex-shrink-0"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <input
                                  type="checkbox"
                                  className="sr-only"
                                  checked={valgteDoc.has('std-3')}
                                  onChange={() => toggleDoc('std-3')}
                                />
                                <span
                                  className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${valgteDoc.has('std-3') ? 'bg-blue-500 border-blue-500' : 'bg-[#0a1020] border-slate-400'}`}
                                >
                                  {valgteDoc.has('std-3') && (
                                    <svg
                                      viewBox="0 0 10 10"
                                      className="w-2 h-2 text-white"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2.5"
                                    >
                                      <path d="M1.5 5.5l2.5 2.5 4.5-4.5" />
                                    </svg>
                                  )}
                                </span>
                              </label>
                            )}
                          </div>
                        </div>

                        {/* Jordforureningsattest */}
                        <div>
                          <div
                            className="min-w-[500px] grid grid-cols-[28px_72px_1fr_120px_80px] gap-x-3 px-4 py-2 hover:bg-slate-700/10 transition-colors cursor-pointer items-start"
                            onClick={() => {
                              if (!jordItem) return;
                              setExpandedJord((prev) => {
                                const next = new Set(prev);
                                if (next.has(jordItem.id)) next.delete(jordItem.id);
                                else next.add(jordItem.id);
                                return next;
                              });
                            }}
                          >
                            <ChevronRight
                              size={14}
                              className={`text-slate-500 mt-0.5 transition-transform flex-shrink-0 ${!jordItem ? 'opacity-0' : ''} ${jordErUdvidet ? 'rotate-90' : ''}`}
                            />
                            <span className="text-sm text-slate-300 tabular-nums">
                              {jordItem?.modifiedDate
                                ? new Date(jordItem.modifiedDate).getFullYear()
                                : '—'}
                            </span>
                            <div>
                              <span className="text-sm text-slate-200">{t.soilContamination}</span>
                              {jordLoader && (
                                <p className="text-xs text-slate-500 mt-0.5 animate-pulse">
                                  {t.loading}
                                </p>
                              )}
                            </div>
                            {/* Status — alignet med plan-status kolonnen */}
                            <div className="self-start">
                              {!jordLoader && jordIngenData && (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-500/15 text-emerald-400">
                                  {t.notMapped}
                                </span>
                              )}
                              {!jordLoader && jordItem && (
                                <span
                                  className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${jordStatusKlasse}`}
                                >
                                  {jordItem.pollutionStatusText ??
                                    jordItem.pollutionStatusCodeValue}
                                </span>
                              )}
                              {jordFejl && (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-500/15 text-red-400">
                                  Fejl
                                </span>
                              )}
                            </div>
                            {/* PDF-link + checkbox — URL peger på intern /api/jord/pdf der konverterer via Puppeteer */}
                            <div className="flex items-center gap-1.5 self-start">
                              {rapportUrl ? (
                                <a
                                  href={rapportUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                                >
                                  <FileText size={11} />
                                  PDF
                                </a>
                              ) : (
                                <span className="text-slate-600 text-xs">—</span>
                              )}
                              {rapportUrl && (
                                <label
                                  className="flex items-center cursor-pointer flex-shrink-0"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <input
                                    type="checkbox"
                                    className="sr-only"
                                    checked={valgteDoc.has('std-7')}
                                    onChange={() => toggleDoc('std-7')}
                                  />
                                  <span
                                    className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${valgteDoc.has('std-7') ? 'bg-blue-500 border-blue-500' : 'bg-[#0a1020] border-slate-400'}`}
                                  >
                                    {valgteDoc.has('std-7') && (
                                      <svg
                                        viewBox="0 0 10 10"
                                        className="w-2 h-2 text-white"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2.5"
                                      >
                                        <path d="M1.5 5.5l2.5 2.5 4.5-4.5" />
                                      </svg>
                                    )}
                                  </span>
                                </label>
                              )}
                            </div>
                          </div>

                          {/* Detaljepanel */}
                          {jordErUdvidet && jordDetaljer.length > 0 && (
                            <div className="ml-10 mr-4 mb-2 bg-slate-800/40 rounded-lg border border-slate-700/30 overflow-hidden">
                              <div className="divide-y divide-slate-700/20">
                                {jordDetaljer.map((r) => (
                                  <div
                                    key={r.label}
                                    className="grid grid-cols-[180px_1fr] px-3 py-1 text-xs"
                                  >
                                    <span className="text-slate-500">{r.label}</span>
                                    <span className="text-slate-300">{r.value}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Matrikelkort */}
                        {(() => {
                          const rel = bbrData?.ejendomsrelationer?.[0];
                          const downloadUrl =
                            rel?.ejerlavKode && rel?.matrikelnr
                              ? `/api/matrikelkort?ejerlavKode=${rel.ejerlavKode}&matrikelnr=${encodeURIComponent(rel.matrikelnr)}`
                              : null;
                          return (
                            <div className="min-w-[500px] grid grid-cols-[28px_72px_1fr_120px_80px] gap-x-3 px-4 py-2 border-b border-slate-700/15 hover:bg-slate-700/10 transition-colors items-start">
                              <span />
                              <span className="text-sm text-slate-300 tabular-nums">—</span>
                              <div>
                                <span className="text-sm text-slate-200">{t.cadastreMap}</span>
                              </div>
                              <span />
                              <div className="flex items-center gap-1.5 self-start">
                                {downloadUrl ? (
                                  <a
                                    href={downloadUrl}
                                    download
                                    className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                                  >
                                    <FileText size={11} />
                                    PDF
                                  </a>
                                ) : (
                                  <span className="text-slate-600 text-xs">—</span>
                                )}
                                {downloadUrl && (
                                  <label className="flex items-center cursor-pointer flex-shrink-0">
                                    <input
                                      type="checkbox"
                                      className="sr-only"
                                      checked={valgteDoc.has('std-5')}
                                      onChange={() => toggleDoc('std-5')}
                                    />
                                    <span
                                      className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${valgteDoc.has('std-5') ? 'bg-blue-500 border-blue-500' : 'bg-[#0a1020] border-slate-400'}`}
                                    >
                                      {valgteDoc.has('std-5') && (
                                        <svg
                                          viewBox="0 0 10 10"
                                          className="w-2 h-2 text-white"
                                          fill="none"
                                          stroke="currentColor"
                                          strokeWidth="2.5"
                                        >
                                          <path d="M1.5 5.5l2.5 2.5 4.5-4.5" />
                                        </svg>
                                      )}
                                    </span>
                                  </label>
                                )}
                              </div>
                            </div>
                          );
                        })()}

                        {/* Fredet bygning — kun hvis BBR har fredningsdata */}
                        {bbrData?.bbr?.some((b) => b.fredning) && (
                          <div className="min-w-[500px] grid grid-cols-[28px_72px_1fr_120px_80px] gap-x-3 px-4 py-2 border-b border-slate-700/15 hover:bg-slate-700/10 transition-colors items-start">
                            <span />
                            <span className="text-sm text-slate-300 tabular-nums">—</span>
                            <div>
                              <span className="text-sm text-slate-200">{t.slotsOgKultur}</span>
                              <p className="text-xs text-slate-500 mt-0.5">{t.protectedBuilding}</p>
                            </div>
                            <span className="inline-flex items-center self-start px-2 py-0.5 rounded text-xs font-medium bg-amber-500/15 text-amber-400">
                              Fredet
                            </span>
                            <a
                              href="https://www.kulturarv.dk/fbb/offentligbygningsoeg.pub?public=true"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors self-start"
                            >
                              <FileText size={11} />
                              PDF
                            </a>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* ── Planer subsection ── */}
                  <div className="border-b border-slate-700/30">
                    <div className="px-4 py-2 flex items-center gap-2">
                      <MapIcon size={13} className="text-slate-500" />
                      <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                        Planer
                      </span>
                    </div>

                    {plandataFejl && (
                      <div className="px-4 py-2 text-xs text-red-400">{plandataFejl}</div>
                    )}

                    {!plandataLoader && !plandataFejl && (!plandata || plandata.length === 0) && (
                      <div className="px-4 py-3 text-center text-slate-500 text-xs">
                        {t.noPlansFound}
                      </div>
                    )}

                    {plandata && plandata.length > 0 && (
                      <div>
                        {/* Header */}
                        <div className="min-w-[500px] grid grid-cols-[28px_72px_1fr_120px_80px] gap-x-3 px-4 py-2 border-b border-slate-700/20">
                          <span />
                          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                            {da ? 'År' : 'Year'}
                          </span>
                          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                            {da ? 'Type' : 'Type'}
                          </span>
                          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                            Status
                          </span>
                          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                            {da ? 'Dok.' : 'Doc.'}
                          </span>
                        </div>

                        {/* Rows — lokalplaner med samme doklink som et delområde vises ikke
                          da delområdet er mere specifikt og deler samme PDF-dokument */}
                        {(() => {
                          const lokalplanDoklinks = new Set(
                            plandata
                              .filter((p) => p.type === 'Lokalplan' && p.doklink)
                              .map((p) => p.doklink!)
                          );
                          const synligePlaner = plandata.filter(
                            (p) =>
                              !(
                                p.type === 'Delområde' &&
                                p.doklink &&
                                lokalplanDoklinks.has(p.doklink)
                              )
                          );
                          return synligePlaner;
                        })().map((plan, i) => {
                          const rowKey = `${plan.type}-${plan.id}-${i}`;
                          const erUdvidet = expandedPlaner.has(rowKey);

                          const statusColor =
                            plan.status === 'Vedtaget'
                              ? 'bg-emerald-500/15 text-emerald-400'
                              : plan.status === 'Forslag'
                                ? 'bg-amber-500/15 text-amber-400'
                                : 'bg-red-500/15 text-red-400';

                          // Byg detaljefelt-liste — kun vis felter med værdier
                          const d = plan.detaljer;
                          const detaljeRækker: { label: string; value: string }[] = [
                            d.anvendelse && { label: t.generalUsage, value: d.anvendelse },
                            d.delnr && { label: t.subAreaNo, value: d.delnr },
                            d.bebygpct && {
                              label: t.maxBuildingCoverage,
                              value: `${d.bebygpct} %`,
                            },
                            d.maxetager && {
                              label: t.maxFloors,
                              value: String(d.maxetager),
                            },
                            d.maxbygnhjd && {
                              label: t.maxBuildingHeight,
                              value: `${d.maxbygnhjd} m`,
                            },
                            d.minuds && {
                              label: t.minPlotSubdivision,
                              value: `${d.minuds.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`,
                            },
                            d.datoforsl && { label: t.proposalDate, value: d.datoforsl },
                            d.datovedt && { label: t.approvalDate, value: d.datovedt },
                            d.datoikraft && { label: t.effectiveDate, value: d.datoikraft },
                            d.datostart && { label: t.startDate, value: d.datostart },
                            d.datoslut && { label: t.endDate, value: d.datoslut },
                          ].filter((r): r is { label: string; value: string } => Boolean(r));

                          return (
                            <div
                              key={rowKey}
                              className="border-b border-slate-700/15 last:border-b-0"
                            >
                              {/* Hoved-række */}
                              <div
                                className="min-w-[500px] grid grid-cols-[28px_72px_1fr_120px_80px] gap-x-3 px-4 py-2 hover:bg-slate-700/10 transition-colors cursor-pointer items-start"
                                onClick={() =>
                                  setExpandedPlaner((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(rowKey)) next.delete(rowKey);
                                    else next.add(rowKey);
                                    return next;
                                  })
                                }
                              >
                                <ChevronRight
                                  size={14}
                                  className={`text-slate-500 mt-0.5 transition-transform flex-shrink-0 ${erUdvidet ? 'rotate-90' : ''}`}
                                />
                                <span className="text-sm text-slate-300 tabular-nums">
                                  {plan.aar ?? '—'}
                                </span>
                                <div>
                                  <span className="text-sm text-slate-200">
                                    {plan.type} ({plan.nummer})
                                  </span>
                                  {plan.navn && (
                                    <p className="text-xs text-slate-500 mt-0.5 leading-tight">
                                      {plan.navn}
                                    </p>
                                  )}
                                </div>
                                <span
                                  className={`inline-flex items-center self-start px-2 py-0.5 rounded text-xs font-medium ${statusColor}`}
                                >
                                  {plan.status}
                                </span>
                                <div className="flex items-center gap-1.5 self-start">
                                  {plan.doklink ? (
                                    <a
                                      href={plan.doklink}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                                    >
                                      <FileText size={11} />
                                      PDF
                                    </a>
                                  ) : (
                                    <span className="text-slate-600 text-xs">—</span>
                                  )}
                                  {plan.doklink && (
                                    <label
                                      className="flex items-center cursor-pointer flex-shrink-0"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <input
                                        type="checkbox"
                                        className="sr-only"
                                        checked={valgteDoc.has(`pla-${plan.id}`)}
                                        onChange={() => toggleDoc(`pla-${plan.id}`)}
                                      />
                                      <span
                                        className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${valgteDoc.has(`pla-${plan.id}`) ? 'bg-blue-500 border-blue-500' : 'bg-[#0a1020] border-slate-400'}`}
                                      >
                                        {valgteDoc.has(`pla-${plan.id}`) && (
                                          <svg
                                            viewBox="0 0 10 10"
                                            className="w-2 h-2 text-white"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="2.5"
                                          >
                                            <path d="M1.5 5.5l2.5 2.5 4.5-4.5" />
                                          </svg>
                                        )}
                                      </span>
                                    </label>
                                  )}
                                </div>
                              </div>

                              {/* Detalje-panel */}
                              {erUdvidet && (
                                <div className="ml-10 mr-4 mb-1.5 bg-slate-800/40 rounded-lg border border-slate-700/30 overflow-hidden">
                                  {detaljeRækker.length > 0 ? (
                                    detaljeRækker.map((r) => (
                                      <div
                                        key={r.label}
                                        className="flex items-baseline justify-between px-3 py-1 border-b border-slate-700/20 last:border-b-0"
                                      >
                                        <span className="text-xs text-slate-400">{r.label}</span>
                                        <span className="text-xs text-slate-200 font-medium ml-4 text-right">
                                          {r.value}
                                        </span>
                                      </div>
                                    ))
                                  ) : (
                                    <p className="px-3 py-1.5 text-xs text-slate-500">
                                      {t.noAdditionalDetails}
                                    </p>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  {/* end planer subsection */}

                  {/* ── Energimærker subsection ──
                      BIZZ-565: Header alignet med Planer-sektionen ovenover
                      (ikon-style + text-color/size). Tidligere brugte vi en
                      emoji-prefix der gjorde sektionen visuelt anderledes
                      end de øvrige dokument-sektioner. */}
                  <div className="border-t border-slate-700/30">
                    <div className="px-4 py-2 flex items-center gap-2">
                      <Zap size={13} className="text-slate-500" />
                      <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                        {t.energyReports}
                      </span>
                    </div>

                    {/* BIZZ-332: For ejerlejligheder vises energimærker fra moderejendommen,
                        da mærker registreres på bygningsniveau — ikke på den individuelle lejlighed. */}
                    {!!dawaAdresse?.etage && !!bbrData?.moderBfe && (
                      <div className="px-4 pb-2 text-xs text-slate-500 italic">
                        {da
                          ? `Energimærker hentes fra moderejendommen (BFE ${bbrData.moderBfe}) — mærker registreres på bygningsniveau.`
                          : `Energy labels are fetched from the parent property (BFE ${bbrData.moderBfe}) — labels are registered at building level.`}
                      </div>
                    )}

                    {energiManglerAdgang && (
                      <div className="px-4 pb-2 text-xs text-amber-400">
                        EMO_USERNAME / EMO_PASSWORD ikke sat i .env.local
                      </div>
                    )}

                    {!energiManglerAdgang && energiFejl && (
                      <div className="px-4 pb-2 text-xs text-red-400">{energiFejl}</div>
                    )}

                    {!energiLoader &&
                      !energiFejl &&
                      !energiManglerAdgang &&
                      (!energimaerker || energimaerker.length === 0) && (
                        <div className="px-4 py-3 text-center text-slate-500 text-xs">
                          {t.noEnergyLabels}
                        </div>
                      )}

                    {energimaerker && energimaerker.length > 0 && (
                      <div>
                        {/* BIZZ-565 v4: Grid alignet med Dokumenter+Planer-sektionerne
                            ovenfor: 28px leading (matches chevron-kolonne) +
                            72px ÅR + 1fr ADRESSE + 60px KLASSE + 100px GF +
                            100px GT + 120px STATUS + 80px RAPPORT (PDF +
                            checkbox slået sammen som i Planer-sektionen). Det
                            sikrer at ÅR, STATUS og RAPPORT-kolonnerne ligger
                            præcis under tilsvarende kolonner i de øvrige
                            dokument-sektioner. */}
                        <div className="min-w-[760px] grid grid-cols-[28px_72px_1fr_60px_100px_100px_120px_80px] gap-x-3 px-4 py-1.5 border-b border-slate-700/20">
                          <span />
                          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                            {da ? 'År' : 'Year'}
                          </span>
                          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                            {da ? 'Adresse' : 'Address'}
                          </span>
                          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                            Klasse
                          </span>
                          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                            {da ? 'Gyldig fra' : 'Valid from'}
                          </span>
                          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                            {da ? 'Gyldig til' : 'Valid until'}
                          </span>
                          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                            Status
                          </span>
                          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                            {da ? 'Rapport' : 'Report'}
                          </span>
                        </div>
                        {energimaerker.map((m) => {
                          // Officielle EU energimærke farver (Building Energy Performance Directive)
                          const klasseStyle = (() => {
                            const k = m.klasse.toUpperCase();
                            if (k.startsWith('A'))
                              return { backgroundColor: '#00843D', color: '#fff' };
                            if (k === 'B') return { backgroundColor: '#4BAE33', color: '#fff' };
                            if (k === 'C') return { backgroundColor: '#ABCB44', color: '#fff' };
                            if (k === 'D') return { backgroundColor: '#F5E700', color: '#1a1a1a' };
                            if (k === 'E') return { backgroundColor: '#F5AB00', color: '#fff' };
                            if (k === 'F') return { backgroundColor: '#EF7D00', color: '#fff' };
                            if (k === 'G') return { backgroundColor: '#EB3223', color: '#fff' };
                            return { backgroundColor: '#475569', color: '#e2e8f0' };
                          })();
                          const statusKlasse =
                            m.status === 'Gyldig'
                              ? 'bg-emerald-500/15 text-emerald-400'
                              : m.status === 'Ugyldig'
                                ? 'bg-red-500/15 text-red-400'
                                : m.status === 'Erstattet'
                                  ? 'bg-amber-500/15 text-amber-400'
                                  : 'bg-slate-700/40 text-slate-400';
                          // BIZZ-565: Udtræk år fra gyldigFra til ÅR-kolonne.
                          // Format kan være "19. jul. 2022", "2022-07-19" eller andet —
                          // grab første 4 cifre (årstal-mønster) som fallback.
                          const aar = (() => {
                            const s = m.gyldigFra ?? '';
                            const m4 = s.match(/(\d{4})/);
                            return m4 ? m4[1] : '—';
                          })();
                          return (
                            <div
                              key={m.serialId}
                              className="min-w-[760px] grid grid-cols-[28px_72px_1fr_60px_100px_100px_120px_80px] gap-x-3 px-4 py-2 border-b border-slate-700/15 hover:bg-slate-700/10 transition-colors items-center"
                            >
                              {/* 0. (tom — matcher chevron-kolonne i Dokumenter/Planer) */}
                              <span />
                              {/* 1. ÅR */}
                              <span className="text-sm tabular-nums text-slate-300">{aar}</span>
                              {/* 2. ADRESSE */}
                              <div>
                                <p className="text-sm text-slate-200">{m.adresse ?? '—'}</p>
                                {m.bygninger.length > 0 && (
                                  <p className="text-xs text-slate-500 mt-0.5">
                                    {m.bygninger.length === 1
                                      ? `${t.buildingLabel} ${m.bygninger[0].bygningsnr}`
                                      : `${m.bygninger.length} ${t.buildingsLabel}`}
                                    {m.bygninger[0]?.opfoerelsesaar != null &&
                                      ` · ${m.bygninger[0].opfoerelsesaar}`}
                                    {m.bygninger[0]?.varmeforsyning &&
                                      ` · ${m.bygninger[0].varmeforsyning}`}
                                  </p>
                                )}
                              </div>
                              {/* 3. KLASSE */}
                              <span
                                style={klasseStyle}
                                className="inline-flex items-center justify-center w-7 h-7 rounded-md text-xs font-bold"
                              >
                                {m.klasse}
                              </span>
                              {/* 4. GYLDIG FRA */}
                              <span className="text-sm tabular-nums text-slate-400">
                                {m.gyldigFra ?? '—'}
                              </span>
                              {/* 5. GYLDIG TIL */}
                              <span
                                className={`text-sm tabular-nums ${m.status === 'Ugyldig' ? 'text-red-400' : 'text-slate-300'}`}
                              >
                                {m.udloeber ?? '—'}
                              </span>
                              {/* 6. STATUS */}
                              <span
                                className={`inline-flex items-center self-start px-2 py-0.5 rounded text-xs font-medium ${statusKlasse}`}
                              >
                                {m.status ?? '—'}
                              </span>
                              {/* 7. RAPPORT — PDF + checkbox samme celle som Planer-sektionen */}
                              <div className="flex items-center gap-1.5 self-start">
                                {m.pdfUrl ? (
                                  <a
                                    href={m.pdfUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                                  >
                                    <FileText size={12} />
                                    PDF
                                  </a>
                                ) : (
                                  <span className="text-xs text-slate-600">—</span>
                                )}
                                {m.pdfUrl && (
                                  <label
                                    className="flex items-center cursor-pointer flex-shrink-0"
                                    onClick={(ev) => ev.stopPropagation()}
                                  >
                                    <input
                                      type="checkbox"
                                      className="sr-only"
                                      checked={valgteDoc.has(`energi-${m.serialId}`)}
                                      onChange={() => toggleDoc(`energi-${m.serialId}`)}
                                    />
                                    <span
                                      className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${valgteDoc.has(`energi-${m.serialId}`) ? 'bg-blue-500 border-blue-500' : 'bg-[#0a1020] border-slate-400'}`}
                                    >
                                      {valgteDoc.has(`energi-${m.serialId}`) && (
                                        <svg
                                          viewBox="0 0 10 10"
                                          className="w-2 h-2 text-white"
                                          fill="none"
                                          stroke="currentColor"
                                          strokeWidth="2.5"
                                        >
                                          <path d="M1.5 5.5l2.5 2.5 4.5-4.5" />
                                        </svg>
                                      )}
                                    </span>
                                  </label>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  {/* end energimærker subsection */}
                </div>
                {/* end Dokumenter card */}
              </div>
            )}
          </div>
        </div>

        {/* Adskillelseslinie */}
        {visKort && kortPanelÅben && (
          <div
            className={`w-1.5 flex-shrink-0 cursor-col-resize flex items-center justify-center group transition-colors ${trækker ? 'bg-blue-500/30' : 'bg-slate-800 hover:bg-blue-500/20'}`}
            onMouseDown={(e) => {
              e.preventDefault();
              trækStart.current = { x: e.clientX, bredde: kortBredde };
              setTrækker(true);
            }}
          >
            <div
              className={`w-0.5 h-10 rounded-full transition-colors ${trækker ? 'bg-blue-400' : 'bg-slate-600 group-hover:bg-blue-400'}`}
            />
          </div>
        )}

        {/* Kortpanel — strækker fuld højde */}
        {visKort && kortPanelÅben && (
          <div className="relative flex-shrink-0 self-stretch" style={{ width: kortBredde }}>
            <div className="absolute inset-0">
              <Suspense
                fallback={
                  <div className="w-full h-full flex items-center justify-center bg-slate-900">
                    <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                  </div>
                }
              >
                <PropertyMap
                  lat={dawaAdresse.y}
                  lng={dawaAdresse.x}
                  adresse={adresseStreng}
                  visMatrikel={true}
                  onAdresseValgt={handleAdresseValgt}
                  fullMapHref={`/dashboard/kort?ejendom=${id}`}
                  erEjerlejlighed={!!bbrData?.ejerlejlighedBfe}
                  bygningPunkter={aktiveBygningPunkter}
                />
              </Suspense>
            </div>
          </div>
        )}

        {/*
         * ─── Mobil: Kortoverlay — fylder hele skærmen ───
         *
         * Portalen er påkrævet fordi iOS Safari ikke respekterer `position: fixed`
         * korrekt inde i en `overflow: hidden`-beholder (BIZZ-76).
         * createPortal løfter overlayet ud af DOM-træet til document.body,
         * hvorved det altid dækker hele viewport uanset forældrets overflow-mode.
         */}
        {!visKort &&
          mobilKortAaben &&
          createPortal(
            <div className="fixed inset-0 z-50 flex flex-col bg-slate-950">
              {/* Overlay-header */}
              <div className="flex items-center justify-between px-4 py-3 bg-slate-900 border-b border-slate-700/50 flex-shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                  <MapIcon size={15} className="text-blue-400 flex-shrink-0" />
                  <span className="text-white text-sm font-medium truncate">{adresseStreng}</span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                  <Link
                    href={`/dashboard/kort?ejendom=${id}`}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-slate-300 text-xs font-medium transition-all"
                  >
                    <MapIcon size={11} />
                    {da ? 'Fuldt kort' : 'Full map'}
                  </Link>
                  <button
                    onClick={() => setMobilKortAaben(false)}
                    className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
                    aria-label={da ? 'Luk kort' : 'Close map'}
                  >
                    <X size={18} />
                  </button>
                </div>
              </div>
              {/* Kortindhold */}
              <div className="flex-1 relative">
                <Suspense
                  fallback={
                    <div className="absolute inset-0 flex items-center justify-center bg-slate-900">
                      <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                    </div>
                  }
                >
                  <PropertyMap
                    lat={dawaAdresse.y}
                    lng={dawaAdresse.x}
                    adresse={adresseStreng}
                    visMatrikel={true}
                    onAdresseValgt={handleAdresseValgtMobil}
                    erEjerlejlighed={!!bbrData?.ejerlejlighedBfe}
                    bygningPunkter={aktiveBygningPunkter}
                  />
                </Suspense>
              </div>
            </div>,
            document.body
          )}
      </div>
    );
  }

  // ── Mock: {t.propertyNotFound} ──
  if (!ejendom) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-6">
        <MapPin size={40} className="text-slate-600 mb-4" />
        <h2 className="text-white text-xl font-semibold mb-2">{t.propertyNotFound}</h2>
        <p className="text-slate-400 text-sm mb-6">{t.propertyNotFoundDesc}</p>
        <Link
          href="/dashboard/ejendomme"
          className="text-blue-400 hover:text-blue-300 flex items-center gap-2 text-sm"
        >
          <ArrowLeft size={16} /> {t.backToProperties}
        </Link>
      </div>
    );
  }

  /** {t.priceHistory} tilpasset til Recharts */
  const prisData = ejendom.handelHistorik
    .slice()
    .reverse()
    .map((h) => ({
      dato: new Date(h.dato).getFullYear().toString(),
      pris: Math.round(h.pris / 1000000),
      prisPerM2: h.prisPerM2,
    }));

  return (
    <div className={`flex-1 flex flex-col overflow-hidden${trækker ? ' select-none' : ''}`}>
      {/* ─── Header ─── */}
      <div className="px-6 pt-3 pb-0 border-b border-slate-700/50 bg-slate-900/30">
        {/* Tilbage + handlinger */}
        <div className="flex items-center justify-between mb-2">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-2 text-slate-400 hover:text-white text-sm transition-colors"
          >
            <ArrowLeft size={16} />
            {t.back}
          </button>

          <div className="flex items-center gap-2">
            {/* Kort-toggle knap — åbner overlay på mobil, toggle sidepanel på desktop */}
            <button
              onClick={() => {
                if (visKort) {
                  setKortPanelÅben((prev) => !prev);
                } else {
                  setMobilKortAaben(true);
                }
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 border rounded-lg text-sm transition-all ${
                visKort && kortPanelÅben
                  ? 'bg-blue-600/20 hover:bg-blue-600/30 border-blue-500/40 text-blue-300'
                  : 'bg-slate-800 hover:bg-slate-700 border-slate-700/60 text-slate-300'
              }`}
              title={da ? 'Vis/skjul kort' : 'Show/hide map'}
            >
              <MapIcon size={14} />
              {da ? 'Kort' : 'Map'}
            </button>
            <div
              className="relative"
              onMouseEnter={() => !erFulgt && setVisFoelgTooltip(true)}
              onMouseLeave={() => setVisFoelgTooltip(false)}
            >
              <button
                disabled={foelgToggling}
                onClick={async () => {
                  if (foelgToggling) return;
                  setVisFoelgTooltip(false);
                  if (!ejendom) return;
                  // Optimistic update — toggle colour immediately so the user
                  // sees instant feedback before the Supabase write completes.
                  const optimisticState = !erFulgt;
                  setErFulgt(optimisticState);
                  setFoelgToggling(true);
                  try {
                    const adresse = `${ejendom.adresse}, ${ejendom.postnummer} ${ejendom.by}`;
                    const nyTilstand = await toggleTrackEjendom({
                      id,
                      adresse,
                      postnr: ejendom.postnummer,
                      by: ejendom.by,
                      kommune: ejendom.kommune,
                      anvendelse: null,
                    });
                    // Confirm with authoritative result from the toggle function
                    setErFulgt(nyTilstand);
                    window.dispatchEvent(new Event('ba-tracked-changed'));
                  } catch {
                    // Revert optimistic update on error
                    setErFulgt(!optimisticState);
                  } finally {
                    setFoelgToggling(false);
                  }
                }}
                className={`flex items-center gap-2 px-3 py-1.5 border rounded-lg text-sm transition-all disabled:opacity-60 disabled:cursor-not-allowed ${
                  erFulgt
                    ? 'bg-blue-600/20 hover:bg-blue-600/30 border-blue-500/40 text-blue-300'
                    : 'bg-slate-800 hover:bg-slate-700 border-slate-700/60 text-slate-300'
                }`}
                aria-label={
                  erFulgt
                    ? da
                      ? 'Stop med at følge ejendom'
                      : 'Unfollow property'
                    : da
                      ? 'Følg ejendom'
                      : 'Follow property'
                }
                aria-pressed={erFulgt}
              >
                <Bell size={14} className={erFulgt ? 'fill-blue-400 text-blue-400' : ''} />
                {erFulgt ? t.following : t.follow}
              </button>
              <FoelgTooltip lang="da" visible={visFoelgTooltip} />
            </div>
          </div>
        </div>

        {/* Adresse + meta */}
        <div className="mb-2">
          <h1 className="text-white text-lg font-bold leading-tight">
            {ejendom.adresse}, {ejendom.postnummer} {ejendom.by}
          </h1>
          <div className="flex items-center gap-3 mt-1 text-slate-400 text-xs">
            <span>BFE: {ejendom.bfe}</span>
            <span>·</span>
            <span>ESR: {ejendom.esr}</span>
          </div>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className="flex items-center gap-1 px-2 py-0.5 bg-slate-800 border border-slate-700/50 rounded-full text-xs text-slate-300">
              <MapPin size={11} />
              {ejendom.kommune}
            </span>
            <span className="flex items-center gap-1 px-2 py-0.5 bg-slate-800 border border-slate-700/50 rounded-full text-xs text-slate-300">
              <Building2 size={11} />
              {ejendom.matrikelNummer}
            </span>
            <span className="px-2 py-0.5 bg-slate-800 border border-slate-700/50 rounded-full text-xs text-slate-300">
              {ejendom.ejendomstype}
            </span>
          </div>
        </div>

        {/* Tab navigation */}
        <div role="tablist" className="flex gap-1 -mb-px">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={aktivTab === tab.id}
              onClick={() => setAktivTab(tab.id)}
              className={`flex items-center gap-1 px-2 py-1.5 text-xs font-medium border-b-2 transition-all whitespace-nowrap ${
                aktivTab === tab.id
                  ? 'border-blue-500 text-blue-300'
                  : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600'
              }`}
            >
              {tab.ikon}
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* ─── Indhold + kort ─── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Venstre kolonne: scrollbart indhold + evt. download-bar */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-5">
            {/* ══════════════════════════════════════════
              OVERBLIK
          ══════════════════════════════════════════ */}
            {aktivTab === 'overblik' && (
              <div className="space-y-5">
                {/* 3-kolonne summary: Matrikel / Bygning / Enhed */}
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {/* Matrikel */}
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                    <p className="text-slate-400 text-xs font-medium mb-3">
                      <span className="text-white font-bold text-base">
                        {ejendom.jordstykker?.length ?? 1}
                      </span>{' '}
                      {t.cadastre}
                    </p>
                    <div className="space-y-2">
                      <DataKort
                        label={t.plotArea}
                        value={`${ejendom.grundareal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`}
                      />
                      <DataKort
                        label={t.buildingCoverage}
                        value={`${ejendom.bebyggelsesprocent}%`}
                      />
                    </div>
                  </div>

                  {/* Bygning */}
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                    <p className="text-slate-400 text-xs font-medium mb-3">
                      <span className="text-white font-bold text-base">
                        {ejendom.bygninger.length}
                      </span>{' '}
                      {t.building}
                    </p>
                    <div className="space-y-2">
                      <DataKort
                        label={t.buildingArea}
                        value={`${ejendom.bygningsareal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`}
                      />
                      <DataKort label={t.basement} value={`${ejendom.kaelder} m²`} />
                      <DataKort label={t.atticUsed} value="0 m²" />
                    </div>
                  </div>

                  {/* Enhed */}
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                    <p className="text-slate-400 text-xs font-medium mb-3">
                      <span className="text-white font-bold text-base">
                        {ejendom.erhvervsenheder + ejendom.beboelsesenheder}
                      </span>{' '}
                      {t.unit}
                    </p>
                    <div className="space-y-2">
                      {ejendom.beboelsesareal > 0 && (
                        <DataKort
                          label={t.residentialArea}
                          value={`${ejendom.beboelsesareal} m²`}
                        />
                      )}
                      <DataKort
                        label={t.commercialArea}
                        value={`${ejendom.erhvervsareal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`}
                      />
                      <DataKort label={t.commercialUnits} value={`${ejendom.erhvervsenheder}`} />
                    </div>
                  </div>
                </div>

                {/* Ejer + {t.latestTransaction} */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {/* Ejer */}
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                    <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-3">
                      Ejere
                    </p>
                    <div className="space-y-2">
                      {ejendom.ejere.map((ejer, i) => (
                        <div key={i} className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-lg bg-blue-500/20 flex items-center justify-center">
                              <Users size={13} className="text-blue-400" />
                            </div>
                            <div>
                              {ejer.cvr ? (
                                <Link
                                  href={`/dashboard/virksomheder/${ejer.cvr}`}
                                  className="text-white text-sm font-medium hover:text-blue-300 transition-colors flex items-center gap-1"
                                >
                                  {ejer.navn}
                                  <ChevronRight size={12} />
                                </Link>
                              ) : (
                                <p className="text-white text-sm font-medium">{ejer.navn}</p>
                              )}
                              <p className="text-slate-500 text-xs">CVR {ejer.cvr ?? 'Person'}</p>
                            </div>
                          </div>
                          <span className="text-slate-300 text-sm font-semibold">
                            {ejer.ejerandel}%
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* {t.latestTransaction} */}
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                    <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-3">
                      {t.latestTransaction}
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <p className="text-white text-2xl font-bold">
                          {formatDKK(ejendom.senesteHandel.pris)}
                        </p>
                        <p className="text-slate-500 text-xs mt-0.5">
                          {formatDato(ejendom.senesteHandel.dato)}
                        </p>
                      </div>
                      <div className="flex flex-col justify-center">
                        <p className="text-slate-400 text-xs">{t.pricePerSqm}</p>
                        <p className="text-slate-200 font-semibold">
                          {ejendom.senesteHandel.prisPerM2.toLocaleString(da ? 'da-DK' : 'en-GB')}{' '}
                          DKK
                        </p>
                      </div>
                      <div>
                        <p className="text-slate-400 text-xs">{t.propertyValue}</p>
                        <p className="text-slate-200 font-semibold text-sm">
                          {formatDKK(ejendom.ejendomsvaerdi)}
                        </p>
                      </div>
                      <div>
                        <p className="text-slate-400 text-xs">{t.groundTax}</p>
                        <p className="text-slate-200 font-semibold text-sm">
                          {formatDKK(ejendom.grundskyld)}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Virksomheder på adressen */}
                {ejendom.virksomhederPaaAdressen && ejendom.virksomhederPaaAdressen.length > 0 && (
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                    <div className="px-4 py-3 border-b border-slate-700/40 flex items-center justify-between">
                      <h3 className="text-white font-semibold text-sm">{t.companiesAtAddress}</h3>
                      <span className="text-slate-500 text-xs">
                        {ejendom.virksomhederPaaAdressen.length} {t.companies}
                      </span>
                    </div>
                    <table className="w-full">
                      <thead>
                        <tr className="text-slate-500 text-xs border-b border-slate-700/30">
                          <th className="px-4 py-2 text-left font-medium">{t.company}</th>
                          <th className="px-4 py-2 text-left font-medium">{t.industry}</th>
                          <th className="px-4 py-2 text-left font-medium">{t.period}</th>
                          <th className="px-4 py-2 text-right font-medium">{t.employees}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ejendom.virksomhederPaaAdressen.map((v) => (
                          <tr
                            key={v.cvr}
                            className="border-t border-slate-700/30 hover:bg-slate-700/20 transition-colors"
                          >
                            <td className="px-4 py-3">
                              <Link
                                href={`/dashboard/virksomheder/${v.cvr}`}
                                className="text-blue-300 hover:text-blue-200 text-sm font-medium transition-colors flex items-center gap-1"
                              >
                                {v.navn}
                                <ChevronRight size={12} />
                              </Link>
                              <p className="text-slate-500 text-xs">CVR {v.cvr}</p>
                            </td>
                            <td className="px-4 py-3 text-slate-300 text-xs">{v.industri}</td>
                            <td className="px-4 py-3 text-slate-400 text-xs">{v.periode}</td>
                            <td className="px-4 py-3 text-right text-slate-300 text-sm">
                              {v.ansatte ?? '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* {t.environmentalIndicators} */}
                <div>
                  <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-3">
                    {t.environmentalIndicators}
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {ejendom.miljoeindikatorer.map((m) => (
                      <div
                        key={m.id}
                        className={`flex items-center justify-between p-3 border rounded-xl ${miljoStatusColor[m.status]}`}
                      >
                        <div className="flex items-center gap-3">
                          <span className="text-lg">{m.ikon}</span>
                          <div>
                            <p className="text-slate-200 text-sm font-medium">{m.titel}</p>
                            <p className="text-slate-400 text-xs">{m.beskrivelse}</p>
                          </div>
                        </div>
                        <button
                          className="text-slate-600 hover:text-slate-400 ml-2 flex-shrink-0"
                          aria-label="Vis på kort"
                        >
                          <MapPin size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* ══════════════════════════════════════════
              BBR — Live data fra Datafordeler
          ══════════════════════════════════════════ */}
            {aktivTab === 'bbr' && (
              <div className="space-y-3">
                {bbrLoader && <TabLoadingSpinner label={t.loading} />}
                {/* BBR-fejlbesked */}
                {bbrData?.bbrFejl && (
                  <div className="p-3 bg-orange-500/10 border border-orange-500/20 rounded-lg">
                    <p className="text-orange-300 text-sm">BBR: {bbrData.bbrFejl}</p>
                  </div>
                )}

                {/* Jordstykker */}
                <div>
                  <SectionTitle title={t.landPlots} />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                    <DataKort label={t.cadastres} value="1" />
                    <DataKort
                      label={t.plotArea}
                      value={
                        dawaJordstykke
                          ? `${dawaJordstykke.areal_m2.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                          : '–'
                      }
                    />
                  </div>
                  {dawaJordstykke && (
                    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                      <div className="flex items-center gap-4 px-4 py-3 text-sm">
                        <MapIcon size={13} className="text-slate-500 flex-shrink-0" />
                        <span className="text-slate-200 font-medium w-24 flex-shrink-0">
                          {dawaJordstykke.matrikelnr}
                        </span>
                        <span className="text-slate-400 flex-1 truncate">
                          {dawaJordstykke.ejerlav.navn}
                        </span>
                        <span className="text-slate-300 flex-shrink-0">
                          {dawaJordstykke.areal_m2.toLocaleString(da ? 'da-DK' : 'en-GB')} m²
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                {/* Bygninger — live BBR data */}
                {(() => {
                  const bygninger = bbrData?.bbr ?? [];
                  const totAreal = bygninger.reduce((s, b) => s + (b.samletBygningsareal ?? 0), 0);
                  const boligAreal = bygninger.reduce((s, b) => s + (b.samletBoligareal ?? 0), 0);
                  const erhvAreal = bygninger.reduce((s, b) => s + (b.samletErhvervsareal ?? 0), 0);
                  // BIZZ-487: Kælder + tagetage udledt fra BBR_Etage i fetchBbrData.ts
                  const kaelderAreal = bygninger.reduce((s, b) => s + (b.kaelder ?? 0), 0);
                  const tagetageAreal = bygninger.reduce((s, b) => s + (b.tagetage ?? 0), 0);
                  return (
                    <div>
                      <SectionTitle title={t.buildings} />
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
                        <DataKort
                          label={t.buildings}
                          value={bbrLoader ? '…' : `${bygninger.length}`}
                        />
                        <DataKort
                          label={t.buildingArea}
                          value={
                            totAreal ? `${totAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²` : '–'
                          }
                        />
                        <DataKort
                          label={t.residentialArea}
                          value={
                            boligAreal
                              ? `${boligAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                              : '0 m²'
                          }
                        />
                        <DataKort
                          label={t.commercialArea}
                          value={
                            erhvAreal
                              ? `${erhvAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                              : '–'
                          }
                        />
                        {/* BIZZ-487: Kælder vises kun når der er et areal > 0 */}
                        {kaelderAreal > 0 && (
                          <DataKort
                            label={t.basement}
                            value={`${kaelderAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`}
                          />
                        )}
                        {/* BIZZ-487: Tagetage vises kun når der er et areal > 0 */}
                        {tagetageAreal > 0 && (
                          <DataKort
                            label={da ? 'Tagetage' : 'Attic'}
                            value={`${tagetageAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`}
                          />
                        )}
                      </div>

                      {bbrLoader ? (
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden animate-pulse">
                          {[1, 2, 3].map((n) => (
                            <div
                              key={n}
                              className="px-3 py-2.5 border-b border-slate-700/20 flex items-center gap-3"
                            >
                              <div className="w-4 h-4 bg-slate-700/50 rounded" />
                              <div className="h-3 w-8 bg-slate-700/50 rounded" />
                              <div className="h-3 flex-1 bg-slate-700/30 rounded" />
                              <div className="h-3 w-12 bg-slate-700/40 rounded" />
                              <div className="h-3 w-16 bg-slate-700/40 rounded" />
                            </div>
                          ))}
                        </div>
                      ) : bygninger.length === 0 ? (
                        <div className="text-slate-500 text-sm text-center py-3">
                          {da ? 'Ingen bygningsdata tilgængeligt' : 'No building data available'}
                        </div>
                      ) : (
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden overflow-x-auto">
                          {/* Kolonneheader */}
                          <div className="min-w-[500px] grid grid-cols-[1fr_72px_100px_100px_28px] px-4 py-2 text-slate-500 text-xs font-medium border-b border-slate-700/30">
                            <span>{t.usage}</span>
                            <span className="text-right">{t.builtYear}</span>
                            <span className="text-right">{t.builtArea}</span>
                            <span className="text-right">{t.totalArea}</span>
                            <span />
                          </div>
                          {bygninger.map((b) => {
                            const aaben = expandedBygninger.has(b.id);
                            const detaljer: [string, string | null][] = [
                              [t.outerWall, b.ydervaeg || null],
                              [t.roofMaterial, b.tagmateriale || null],
                              [t.heatingInstallation, b.varmeinstallation || null],
                              [t.heatingForm, b.opvarmningsform || null],
                              [t.waterSupply, b.vandforsyning || null],
                              [t.drainage, b.afloeb || null],
                              [t.floors, b.antalEtager != null ? `${b.antalEtager}` : null],
                              [
                                'Boligareal',
                                b.samletBoligareal
                                  ? `${b.samletBoligareal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                  : null,
                              ],
                              [
                                'Erhvervsareal',
                                b.samletErhvervsareal
                                  ? `${b.samletErhvervsareal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                  : null,
                              ],
                              [
                                da ? 'Ombygningsår' : 'Renovation year',
                                b.ombygningsaar != null ? `${b.ombygningsaar}` : null,
                              ],
                              [t.preservation, b.fredning || null],
                              [t.status, b.status || null],
                            ].filter((row): row is [string, string] => row[1] !== null);
                            return (
                              <div
                                key={b.id}
                                className="border-t border-slate-700/30 first:border-0"
                              >
                                <button
                                  onClick={() =>
                                    setExpandedBygninger((prev) => {
                                      const next = new Set(prev);
                                      if (aaben) {
                                        next.delete(b.id);
                                      } else {
                                        next.add(b.id);
                                      }
                                      return next;
                                    })
                                  }
                                  className="w-full min-w-[500px] grid grid-cols-[1fr_72px_100px_100px_28px] px-4 py-3 text-sm hover:bg-slate-700/20 transition-colors text-left items-center"
                                >
                                  <span className="text-slate-200 truncate pr-2">
                                    {b.anvendelse || '–'}
                                  </span>
                                  <span className="text-slate-400 text-right">
                                    {b.opfoerelsesaar ?? '–'}
                                  </span>
                                  <span className="text-slate-300 text-right">
                                    {b.bebyggetAreal
                                      ? `${b.bebyggetAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                      : formatDKK(0)}
                                  </span>
                                  <span className="text-slate-300 text-right">
                                    {b.samletBygningsareal
                                      ? `${b.samletBygningsareal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                      : formatDKK(0)}
                                  </span>
                                  <ChevronRight
                                    size={14}
                                    className={`text-slate-500 transition-transform ml-auto ${aaben ? 'rotate-90' : ''}`}
                                  />
                                </button>
                                {aaben && detaljer.length > 0 && (
                                  <div className="px-3 pb-2 bg-slate-900/40 border-t border-slate-700/20">
                                    <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs pt-2">
                                      {detaljer.map(([lbl, val]) => (
                                        <div key={lbl} className="flex justify-between gap-2">
                                          <span className="text-slate-500">{lbl}</span>
                                          <span className="text-slate-300 text-right">{val}</span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Enheder — live BBR data */}
                {(() => {
                  const enheder = bbrData?.enheder ?? [];
                  const boligEnh = enheder.filter((e) => (e.arealBolig ?? 0) > 0).length;
                  const erhvEnh = enheder.filter((e) => (e.arealErhverv ?? 0) > 0).length;
                  const totAreal = enheder.reduce((s, e) => s + (e.areal ?? 0), 0);
                  return (
                    <div>
                      <SectionTitle title={t.units} />
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
                        <DataKort
                          label={t.totalUnits}
                          value={bbrLoader ? '…' : `${enheder.length}`}
                        />
                        <DataKort label={t.residentialUnits} value={`${boligEnh}`} />
                        <DataKort label={t.commercialUnits} value={`${erhvEnh}`} />
                        <DataKort
                          label={t.totalAreaLabel}
                          value={
                            totAreal ? `${totAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²` : '–'
                          }
                        />
                      </div>

                      {bbrLoader ? (
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden animate-pulse">
                          {[1, 2].map((n) => (
                            <div
                              key={n}
                              className="px-3 py-2.5 border-b border-slate-700/20 flex items-center gap-3"
                            >
                              <div className="w-4 h-4 bg-slate-700/50 rounded" />
                              <div className="h-3 w-8 bg-slate-700/50 rounded" />
                              <div className="h-3 flex-1 bg-slate-700/30 rounded" />
                              <div className="h-3 w-14 bg-slate-700/40 rounded" />
                            </div>
                          ))}
                        </div>
                      ) : enheder.length === 0 ? (
                        <div className="text-slate-500 text-sm text-center py-3">
                          {t.noUnitsAvailable}
                        </div>
                      ) : (
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden overflow-x-auto">
                          <div className="min-w-[400px] grid grid-cols-[1fr_90px_72px_28px] px-4 py-2 text-slate-500 text-xs font-medium border-b border-slate-700/30">
                            <span>{t.usage}</span>
                            <span className="text-right">{t.area}</span>
                            <span className="text-right">{t.rooms}</span>
                            <span />
                          </div>
                          {enheder.map((e) => {
                            const aaben = expandedEnheder.has(e.id);
                            const detaljer: [string, string | null][] = [
                              [t.floor, e.etage || null],
                              [
                                'Boligareal',
                                e.arealBolig
                                  ? `${e.arealBolig.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                  : null,
                              ],
                              [
                                'Erhvervsareal',
                                e.arealErhverv
                                  ? `${e.arealErhverv.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                  : null,
                              ],
                              [da ? 'Energimærke' : 'Energy label', e.energimaerke || null],
                              [t.heatingInstallation, e.varmeinstallation || null],
                            ].filter((row): row is [string, string] => row[1] !== null);
                            return (
                              <div
                                key={e.id}
                                className="border-t border-slate-700/30 first:border-0"
                              >
                                <button
                                  onClick={() =>
                                    setExpandedEnheder((prev) => {
                                      const next = new Set(prev);
                                      if (aaben) {
                                        next.delete(e.id);
                                      } else {
                                        next.add(e.id);
                                      }
                                      return next;
                                    })
                                  }
                                  className="w-full min-w-[400px] grid grid-cols-[1fr_90px_72px_28px] px-4 py-3 text-sm hover:bg-slate-700/20 transition-colors text-left items-center"
                                >
                                  <span className="text-slate-200 truncate pr-2">
                                    {e.anvendelse || '–'}
                                  </span>
                                  <span className="text-slate-300 text-right">
                                    {e.areal
                                      ? `${e.areal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                      : formatDKK(0)}
                                  </span>
                                  <span className="text-slate-400 text-right">
                                    {e.vaerelser ?? '–'}
                                  </span>
                                  <ChevronRight
                                    size={14}
                                    className={`text-slate-500 transition-transform ml-auto ${aaben ? 'rotate-90' : ''}`}
                                  />
                                </button>
                                {aaben && detaljer.length > 0 && (
                                  <div className="px-3 pb-2 bg-slate-900/40 border-t border-slate-700/20">
                                    <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs pt-2">
                                      {detaljer.map(([lbl, val]) => (
                                        <div key={lbl} className="flex justify-between gap-2">
                                          <span className="text-slate-500">{lbl}</span>
                                          <span className="text-slate-300 text-right">{val}</span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* ── Matrikeloplysninger (Datafordeler MAT) ── */}
                <div className="mt-5">
                  <SectionTitle title={t.cadastreInfo} />
                  {matrikelLoader ? (
                    <SektionLoader label={t.loadingCadastre} rows={3} />
                  ) : matrikelData ? (
                    <div className="space-y-3">
                      {/* Ejendomsinfo */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        {matrikelData.landbrugsnotering && (
                          <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3">
                            <p className="text-slate-400 text-xs mb-0.5">{t.agriculturalNote}</p>
                            <p className="text-white text-sm font-medium">
                              {matrikelData.landbrugsnotering}
                            </p>
                          </div>
                        )}
                        {matrikelData.opdeltIEjerlejligheder && (
                          <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3">
                            <p className="text-slate-400 text-xs mb-0.5">{t.condominiums}</p>
                            <p className="text-white text-sm font-medium">
                              {t.dividedIntoCondominiums}
                            </p>
                          </div>
                        )}
                        {matrikelData.erFaelleslod && (
                          <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3">
                            <p className="text-slate-400 text-xs mb-0.5">{t.commonLot}</p>
                            <p className="text-white text-sm font-medium">{t.yes}</p>
                          </div>
                        )}
                        {matrikelData.udskiltVej && (
                          <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3">
                            <p className="text-slate-400 text-xs mb-0.5">{t.separatedRoad}</p>
                            <p className="text-white text-sm font-medium">{t.yes}</p>
                          </div>
                        )}
                      </div>

                      {/* Jordstykker tabel */}
                      {matrikelData.jordstykker.length > 0 && (
                        <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-hidden overflow-x-auto">
                          <div className="px-4 py-2.5 border-b border-slate-700/30">
                            <p className="text-slate-300 text-xs font-semibold uppercase tracking-wider">
                              {t.parcels} ({matrikelData.jordstykker.length})
                            </p>
                          </div>
                          <div className="divide-y divide-slate-700/20">
                            {matrikelData.jordstykker.map((js) => (
                              <div
                                key={js.id}
                                className="min-w-[450px] px-4 py-2.5 grid grid-cols-[1fr_100px_80px_auto] gap-3 items-center"
                              >
                                <div>
                                  <p className="text-white text-sm font-medium">
                                    {da ? 'Matr.nr.' : 'Cad. no.'} {js.matrikelnummer}
                                    {js.ejerlavskode && (
                                      <span className="text-slate-500 text-xs ml-2">
                                        {da ? 'Ejerlav' : 'District'} {js.ejerlavskode}
                                      </span>
                                    )}
                                  </p>
                                  {js.ejerlavsnavn && (
                                    <p className="text-slate-500 text-xs">{js.ejerlavsnavn}</p>
                                  )}
                                  {/* BIZZ-499: Vis arealtype fra MAT */}
                                  {js.arealtype && (
                                    <p className="text-slate-500 text-[10px]">
                                      {da ? 'Arealtype' : 'Area type'}: {js.arealtype}
                                    </p>
                                  )}
                                </div>
                                <p className="text-slate-300 text-sm tabular-nums text-right">
                                  {js.registreretAreal != null
                                    ? `${js.registreretAreal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                    : formatDKK(0)}
                                </p>
                                <p className="text-slate-500 text-xs text-right">
                                  {js.vejareal != null && js.vejareal > 0
                                    ? `${t.road}: ${js.vejareal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²`
                                    : ''}
                                </p>
                                <div className="flex gap-1.5 flex-wrap justify-end">
                                  {js.fredskov === true && (
                                    <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-green-900/50 text-green-400 border border-green-800/40">
                                      {t.protectedForest}
                                    </span>
                                  )}
                                  {js.strandbeskyttelse === true && (
                                    <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-blue-900/50 text-blue-400 border border-blue-800/40">
                                      {t.coastalProtection}
                                    </span>
                                  )}
                                  {js.klitfredning === true && (
                                    <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-amber-900/50 text-amber-400 border border-amber-800/40">
                                      {t.duneProtection}
                                    </span>
                                  )}
                                  {js.jordrente === true && (
                                    <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-purple-900/50 text-purple-400 border border-purple-800/40">
                                      {t.groundRent}
                                    </span>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* ── BIZZ-500: Matrikel-historik (collapsible tidslinje) — mobil ── */}
                      <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-hidden">
                        <button
                          type="button"
                          onClick={() => setHistorikOpen((prev) => !prev)}
                          className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-slate-700/20 transition-colors"
                          aria-expanded={historikOpen}
                        >
                          <span className="text-slate-300 text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5">
                            <Clock size={12} className="text-slate-500" />
                            {da ? 'Matrikel-historik' : 'Cadastre history'}
                          </span>
                          {historikOpen ? (
                            <ChevronDown size={14} className="text-slate-500" />
                          ) : (
                            <ChevronRight size={14} className="text-slate-500" />
                          )}
                        </button>
                        {historikOpen && (
                          <div className="px-4 pb-4 border-t border-slate-700/20">
                            {historikLoader ? (
                              <div className="py-4 text-center">
                                <div className="inline-block w-4 h-4 border-2 border-slate-600 border-t-blue-400 rounded-full animate-spin" />
                                <p className="text-slate-500 text-xs mt-2">
                                  {da ? 'Henter historik…' : 'Loading history…'}
                                </p>
                              </div>
                            ) : matrikelHistorik.length > 0 ? (
                              <div className="relative mt-3">
                                <div className="absolute left-[7px] top-2 bottom-2 w-px bg-slate-700/50" />
                                <div className="space-y-4">
                                  {matrikelHistorik.map((evt, idx) => {
                                    const typeColor =
                                      {
                                        oprettelse: 'bg-green-500',
                                        udstykning: 'bg-orange-500',
                                        sammenlægning: 'bg-blue-500',
                                        arealændring: 'bg-yellow-500',
                                        statusændring: 'bg-purple-500',
                                      }[evt.type] ?? 'bg-slate-500';
                                    const typeLabel = da
                                      ? {
                                          oprettelse: 'Oprettet',
                                          udstykning: 'Udstykning',
                                          sammenlægning: 'Sammenlægning',
                                          arealændring: 'Arealændring',
                                          statusændring: 'Statusændring',
                                        }[evt.type]
                                      : {
                                          oprettelse: 'Created',
                                          udstykning: 'Subdivision',
                                          sammenlægning: 'Merger',
                                          arealændring: 'Area change',
                                          statusændring: 'Status change',
                                        }[evt.type];
                                    const formattedDate = (() => {
                                      try {
                                        return new Date(evt.dato).toLocaleDateString(
                                          da ? 'da-DK' : 'en-GB',
                                          { year: 'numeric', month: 'short', day: 'numeric' }
                                        );
                                      } catch {
                                        return evt.dato;
                                      }
                                    })();
                                    return (
                                      <div
                                        key={`m-${evt.dato}-${evt.type}-${idx}`}
                                        className="relative pl-6"
                                      >
                                        <div
                                          className={`absolute left-0.5 top-1 w-3 h-3 rounded-full border-2 border-slate-900 ${typeColor}`}
                                        />
                                        <div>
                                          <div className="flex items-center gap-2 mb-0.5">
                                            <span className="text-slate-400 text-[10px] tabular-nums">
                                              {formattedDate}
                                            </span>
                                            <span
                                              className={`px-1.5 py-0.5 text-[10px] font-semibold rounded ${typeColor}/20 text-white/80`}
                                            >
                                              {typeLabel}
                                            </span>
                                          </div>
                                          <p className="text-slate-300 text-xs">
                                            {evt.beskrivelse}
                                          </p>
                                          {evt.detaljer && (
                                            <div className="mt-1 text-[10px] text-slate-500 space-y-0.5">
                                              {evt.detaljer.arealFoer != null &&
                                                evt.detaljer.arealEfter != null && (
                                                  <p>
                                                    {da ? 'Areal' : 'Area'}:{' '}
                                                    {evt.detaljer.arealFoer.toLocaleString(
                                                      da ? 'da-DK' : 'en-GB'
                                                    )}{' '}
                                                    m² →{' '}
                                                    {evt.detaljer.arealEfter.toLocaleString(
                                                      da ? 'da-DK' : 'en-GB'
                                                    )}{' '}
                                                    m²
                                                  </p>
                                                )}
                                              {evt.detaljer.jordstykkerFoer &&
                                                evt.detaljer.jordstykkerEfter && (
                                                  <p>
                                                    {da ? 'Jordstykker' : 'Parcels'}:{' '}
                                                    {evt.detaljer.jordstykkerFoer.join(', ')} →{' '}
                                                    {evt.detaljer.jordstykkerEfter.join(', ')}
                                                  </p>
                                                )}
                                              {evt.detaljer.forretningshaendelse && (
                                                <p className="italic">
                                                  {evt.detaljer.forretningshaendelse}
                                                </p>
                                              )}
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            ) : (
                              <p className="py-3 text-slate-500 text-xs text-center">
                                {da
                                  ? 'Ingen historik fundet for denne ejendom'
                                  : 'No history found for this property'}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="bg-slate-800/30 border border-slate-700/40 rounded-xl p-4 text-center">
                      <p className="text-slate-500 text-xs">{t.noCadastreData}</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ══════════════════════════════════════════
              EJERFORHOLD
          ══════════════════════════════════════════ */}
            {aktivTab === 'ejerforhold' && (
              <div className="space-y-6">
                {/* Loading state for ejerskab */}
                {ejereLoader && (
                  <TabLoadingSpinner
                    label={da ? 'Henter ejerskabsdata…' : 'Loading ownership data…'}
                  />
                )}
                {/* Ejer-kort */}
                {ejendom.ejerDetaljer && (
                  <div>
                    <SectionTitle title={t.owner} />
                    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                      {/* Toprække: logo + navn + badges */}
                      <div className="flex items-start gap-4 mb-4">
                        <div className="w-12 h-12 rounded-xl bg-blue-500/20 border border-blue-500/30 flex items-center justify-center flex-shrink-0">
                          <Briefcase size={20} className="text-blue-400" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            {ejendom.ejere[0]?.cvr ? (
                              <Link
                                href={`/dashboard/virksomheder/${ejendom.ejere[0].cvr}`}
                                className="text-white font-bold text-base hover:text-blue-300 transition-colors flex items-center gap-1"
                              >
                                {ejendom.ejerDetaljer.navn}
                                <ChevronRight size={14} />
                              </Link>
                            ) : (
                              <p className="text-white font-bold text-base">
                                {ejendom.ejerDetaljer.navn}
                              </p>
                            )}
                            <span className="px-2 py-0.5 bg-blue-500/10 border border-blue-500/20 rounded-full text-xs text-blue-300">
                              {t.primaryContact}
                            </span>
                            {ejendom.ejerDetaljer.reklamebeskyttet && (
                              <span className="px-2 py-0.5 bg-orange-500/10 border border-orange-500/20 rounded-full text-xs text-orange-300">
                                {t.adBlocked}
                              </span>
                            )}
                          </div>
                          <p className="text-slate-400 text-xs mt-0.5">
                            CVR {ejendom.ejerDetaljer.cvr}
                          </p>
                        </div>
                      </div>

                      {/* Detaljeliste */}
                      <div className="grid grid-cols-1 gap-0 divide-y divide-slate-700/30">
                        {[
                          {
                            label: t.acquisitionDate,
                            value: formatDato(ejendom.ejerDetaljer.overtagelsesdato),
                          },
                          { label: t.ownerType, value: ejendom.ejerDetaljer.ejertype },
                          { label: t.branchName, value: ejendom.ejerDetaljer.branche },
                          {
                            label: t.phone,
                            value: ejendom.ejerDetaljer.telefon,
                            ikon: <Phone size={11} className="text-slate-500" />,
                          },
                          {
                            label: t.email,
                            value: ejendom.ejerDetaljer.email,
                            ikon: <Mail size={11} className="text-slate-500" />,
                          },
                          {
                            label: t.signingRule,
                            value: ejendom.ejerDetaljer.tegningsregel,
                          },
                        ].map((row) => (
                          <div
                            key={row.label}
                            className="flex items-center justify-between py-2.5 first:pt-0"
                          >
                            <span className="text-slate-500 text-xs">{row.label}</span>
                            <span className="text-slate-200 text-xs flex items-center gap-1">
                              {row.ikon}
                              {row.value}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* Ejerstruktur — relationsdiagram */}
                {(() => {
                  const erModer = !dawaAdresse?.etage && !!bbrData?.ejerlejlighedBfe;
                  const bfe =
                    bbrData?.ejerlejlighedBfe ?? bbrData?.ejendomsrelationer?.[0]?.bfeNummer;
                  if (!bfe) return null;

                  // BIZZ-362: Hovedejendom — vis info + lejlighedsliste med ejere
                  if (erModer) {
                    return (
                      <div className="space-y-4">
                        <SectionTitle title={t.ownershipStructure} />
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-6 text-center space-y-3">
                          <div className="w-12 h-12 bg-amber-500/10 rounded-xl flex items-center justify-center mx-auto">
                            <Building2 size={22} className="text-amber-400" />
                          </div>
                          <p className="text-slate-300 text-sm font-medium">
                            {da
                              ? 'Ejendommen er opdelt i ejerlejligheder'
                              : 'Property is divided into condominiums'}
                          </p>
                          <p className="text-slate-500 text-xs max-w-md mx-auto">
                            {da
                              ? 'Ejerskab er registreret på de enkelte ejerlejligheder.'
                              : 'Ownership is registered on individual condominium units.'}
                          </p>
                        </div>
                        {/* BIZZ-478: Ensartet blå TabLoadingSpinner. */}
                        {lejlighederLoader && (
                          <TabLoadingSpinner
                            label={da ? 'Henter lejlighedsdata…' : 'Loading apartment data…'}
                          />
                        )}
                        {lejligheder !== null && lejligheder.length > 0 && (
                          <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden overflow-x-auto">
                            <div className="px-3 py-2.5 border-b border-slate-700/40 flex items-center justify-between">
                              <p className="text-slate-200 text-xs font-semibold">{t.apartments}</p>
                              <span className="text-slate-500 text-[10px]">
                                {lejligheder.length} {da ? 'lejligheder' : 'apartments'}
                              </span>
                            </div>
                            <div className="min-w-[720px] grid grid-cols-[1fr_120px_60px_100px_80px] px-3 py-1.5 text-slate-500 text-[10px] font-medium border-b border-slate-700/30">
                              <span>{t.apartmentAddress}</span>
                              <span>{t.apartmentOwner}</span>
                              <span className="text-right">{t.apartmentArea}</span>
                              <span className="text-right">{t.apartmentPrice}</span>
                              <span className="text-right">{t.apartmentDate}</span>
                            </div>
                            <div className="divide-y divide-slate-700/20">
                              {lejligheder.map((lej) => (
                                <Link
                                  key={lej.bfe}
                                  href={lej.dawaId ? `/dashboard/ejendomme/${lej.dawaId}` : '#'}
                                  onClick={
                                    lej.dawaId
                                      ? undefined
                                      : (e: React.MouseEvent) => e.preventDefault()
                                  }
                                  className={`min-w-[720px] grid grid-cols-[1fr_120px_60px_100px_80px] px-3 py-1.5 items-center gap-1 hover:bg-slate-700/15 transition-colors block ${lej.dawaId ? 'cursor-pointer' : 'cursor-default'}`}
                                >
                                  <span
                                    className="text-slate-200 text-[11px] font-medium truncate"
                                    title={lej.adresse}
                                  >
                                    {lej.adresse.split(',').slice(0, 2).join(',')}
                                  </span>
                                  <span
                                    className="text-slate-400 text-[10px] truncate"
                                    title={lej.ejer}
                                  >
                                    {lej.ejer}
                                  </span>
                                  <span className="text-slate-300 text-[10px] text-right">
                                    {lej.areal ? `${lej.areal} m²` : '–'}
                                  </span>
                                  <span className="text-slate-300 text-[10px] text-right font-medium">
                                    {lej.koebspris
                                      ? `${lej.koebspris.toLocaleString('da-DK')} DKK`
                                      : '–'}
                                  </span>
                                  <span className="text-slate-400 text-[10px] text-right">
                                    {lej.koebsdato
                                      ? new Date(lej.koebsdato).toLocaleDateString('da-DK', {
                                          day: 'numeric',
                                          month: 'short',
                                          year: 'numeric',
                                        })
                                      : '–'}
                                  </span>
                                </Link>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  }

                  return (
                    <div>
                      <SectionTitle title={t.ownershipStructure} />
                      <PropertyOwnerDiagram
                        bfe={bfe}
                        adresse={
                          dawaAdresse
                            ? `${dawaAdresse.vejnavn} ${dawaAdresse.husnr}${dawaAdresse.etage ? `, ${dawaAdresse.etage}.` : ''}${dawaAdresse.dør ? ` ${dawaAdresse.dør}` : ''}`
                            : `BFE ${bfe}`
                        }
                        lang={lang}
                        erEjerlejlighed={!!bbrData?.ejerlejlighedBfe}
                      />
                    </div>
                  );
                })()}

                {/* Nøgletal */}
                {ejendom.ejerDetaljer && (
                  <div>
                    <SectionTitle
                      title={`${da ? 'Nøgletal' : 'Key figures'} ${ejendom.ejerDetaljer.noegletal.aar} ${da ? 'for' : 'for'} ${ejendom.ejerDetaljer.navn}`}
                    />
                    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                      <div className="px-4 py-2 border-b border-slate-700/30">
                        <p className="text-slate-400 text-xs font-medium">{t.incomeStatement}</p>
                      </div>
                      <table className="w-full">
                        <tbody>
                          <tr className="border-b border-slate-700/30 hover:bg-slate-700/20">
                            <td className="px-4 py-3 text-slate-300 text-sm">
                              {t.profitBeforeTax}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span
                                className={`text-sm font-semibold ${ejendom.ejerDetaljer.noegletal.resultatFoerSkat >= 0 ? 'text-green-400' : 'text-red-400'}`}
                              >
                                {formatDKK(ejendom.ejerDetaljer.noegletal.resultatFoerSkat)}
                              </span>
                            </td>
                          </tr>
                          <tr className="hover:bg-slate-700/20">
                            <td className="px-4 py-3 text-slate-300 text-sm">{t.result}</td>
                            <td className="px-4 py-3 text-right">
                              <span
                                className={`text-sm font-semibold ${ejendom.ejerDetaljer.noegletal.resultat >= 0 ? 'text-green-400' : 'text-red-400'}`}
                              >
                                {formatDKK(ejendom.ejerDetaljer.noegletal.resultat)}
                              </span>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Fallback: vis eksisterende ejere hvis ingen ejerDetaljer */}
                {!ejendom.ejerDetaljer && (
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                    <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-3">
                      {t.currentOwners}
                    </p>
                    <div className="space-y-3">
                      {ejendom.ejere.map((ejer, i) => (
                        <div
                          key={i}
                          className="flex items-center justify-between p-3 bg-slate-900/40 rounded-xl"
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-blue-500/20 flex items-center justify-center">
                              <Users size={16} className="text-blue-400" />
                            </div>
                            <div>
                              {ejer.cvr ? (
                                <Link
                                  href={`/dashboard/virksomheder/${ejer.cvr}`}
                                  className="text-white font-semibold hover:text-blue-300 transition-colors flex items-center gap-1 text-sm"
                                >
                                  {ejer.navn}
                                  <ChevronRight size={13} />
                                </Link>
                              ) : (
                                <p className="text-white font-semibold text-sm">{ejer.navn}</p>
                              )}
                              <p className="text-slate-500 text-xs">
                                {ejer.type === 'selskab' ? `CVR ${ejer.cvr}` : t.privatPerson} ·
                                {t.acquired} {formatDato(ejer.erhvervsdato)}
                              </p>
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="text-white font-bold text-lg">{ejer.ejerandel}%</p>
                            <p className="text-slate-500 text-xs">{t.ownershipShare}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ══════════════════════════════════════════
              TINGLYSNING
          ══════════════════════════════════════════ */}
            {aktivTab === 'tinglysning' && (
              <div className="space-y-6">
                {/* Tingbogsattest */}
                {ejendom.tingbogsattest && (
                  <div>
                    {/* TODO BIZZ-195: onDownload skjult indtil korrekte eTL PDF-URLer er implementeret */}
                    <SectionTitle title={t.landRegisterCert} />
                    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                        <div>
                          <p className="text-slate-500 text-xs mb-1">
                            {da ? 'BFE-nr.' : 'BFE no.'}
                          </p>
                          <p className="text-white font-semibold text-sm">{ejendom.bfe}</p>
                        </div>
                        <div>
                          <p className="text-slate-500 text-xs mb-1">{t.cadastres}</p>
                          {ejendom.tingbogsattest.matrikler.map((m, i) => (
                            <p key={i} className="text-white text-sm font-medium">
                              {m.matrikelNummer}{' '}
                              <span className="text-slate-400 font-normal">
                                ({m.areal.toLocaleString(da ? 'da-DK' : 'en-GB')} m²){' '}
                              </span>
                              <span className="text-slate-500 text-xs">{m.registreringsdato}</span>
                            </p>
                          ))}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-700/60 rounded-lg text-slate-300 text-xs hover:bg-slate-700/40 transition-colors">
                          {da ? 'Akt nr.' : 'Act no.'} {ejendom.tingbogsattest.aktNummer}
                        </button>
                        {/* TODO BIZZ-196: Knyt til REST API tingbogsattest-endpoint når tilgængeligt (1. maj 2026) */}
                        <button
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 rounded-lg text-white text-xs font-medium transition-colors opacity-50 cursor-not-allowed"
                          disabled
                          title={
                            da
                              ? 'PDF-download kræver REST API (tilgængeligt 1. maj 2026)'
                              : 'PDF download requires REST API (available May 1, 2026)'
                          }
                        >
                          <Download size={12} />
                          Tingbogsattest
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Adkomsthaver */}
                {ejendom.adkomsthaver && (
                  <div>
                    <SectionTitle title={t.titleHolder} />
                    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                      <table className="w-full">
                        <thead>
                          <tr className="text-slate-500 text-xs border-b border-slate-700/30">
                            <th className="px-4 py-2 text-left font-medium">{t.titleHolder}</th>
                            <th className="px-4 py-2 text-left font-medium">{t.type}</th>
                            <th className="px-4 py-2 text-right font-medium">{t.amount}</th>
                            <th className="px-4 py-2 text-right font-medium">{t.date}</th>
                            <th className="px-2 py-2"></th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr className="border-t border-slate-700/30 hover:bg-slate-700/20 transition-colors">
                            <td className="px-4 py-3">
                              {ejendom.adkomsthaver.cvr ? (
                                <Link
                                  href={`/dashboard/virksomheder/${ejendom.adkomsthaver.cvr}`}
                                  className="text-blue-300 hover:text-blue-200 text-sm font-medium flex items-center gap-1"
                                >
                                  {ejendom.adkomsthaver.navn}
                                  <ChevronRight size={12} />
                                </Link>
                              ) : (
                                <p className="text-slate-200 text-sm font-medium">
                                  {ejendom.adkomsthaver.navn}
                                </p>
                              )}
                              <p className="text-slate-500 text-xs">
                                {ejendom.adkomsthaver.andel}% andel
                              </p>
                            </td>
                            <td className="px-4 py-3 text-slate-300 text-sm">
                              {ejendom.adkomsthaver.type}
                            </td>
                            <td className="px-4 py-3 text-white text-sm font-semibold text-right">
                              {formatDKK(ejendom.adkomsthaver.beloeb)}
                            </td>
                            <td className="px-4 py-3 text-slate-400 text-sm text-right">
                              {formatDato(ejendom.adkomsthaver.dato)}
                            </td>
                            <td className="px-2 py-3 text-right">
                              <button
                                className="text-slate-600 hover:text-slate-300 transition-colors"
                                aria-label="Vis dokument"
                              >
                                <FileText size={13} />
                              </button>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Historiske adkomster */}
                {ejendom.historiskeAdkomster && ejendom.historiskeAdkomster.length > 0 && (
                  <div>
                    <SectionTitle title={t.historicalTitles} />
                    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                      <table className="w-full">
                        <thead>
                          <tr className="text-slate-500 text-xs border-b border-slate-700/30">
                            <th className="px-4 py-2 text-left font-medium">{t.titleHolder}</th>
                            <th className="px-4 py-2 text-left font-medium">{t.type}</th>
                            <th className="px-4 py-2 text-right font-medium">{t.amount}</th>
                            <th className="px-4 py-2 text-right font-medium">{t.date}</th>
                            <th className="px-2 py-2"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {ejendom.historiskeAdkomster.map((ha, i) => (
                            <tr
                              key={i}
                              className="border-t border-slate-700/30 hover:bg-slate-700/20 transition-colors"
                            >
                              <td className="px-4 py-3">
                                {ha.navne.map((navn, ni) => (
                                  <p key={ni} className="text-slate-200 text-sm">
                                    {navn}
                                    {ha.andele.length > 1 && (
                                      <span className="text-slate-500 ml-1 text-xs">
                                        ({ha.andele[ni]}%)
                                      </span>
                                    )}
                                  </p>
                                ))}
                              </td>
                              <td className="px-4 py-3 text-slate-300 text-sm">{ha.type}</td>
                              <td className="px-4 py-3 text-slate-200 text-sm font-semibold text-right">
                                {formatDKK(ha.beloeb)}
                              </td>
                              <td className="px-4 py-3 text-slate-400 text-sm text-right">
                                {formatDato(ha.dato)}
                              </td>
                              <td className="px-2 py-3 text-right">
                                <button
                                  className="text-slate-600 hover:text-slate-300 transition-colors"
                                  aria-label="Vis dokument"
                                >
                                  <FileText size={13} />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Hæftelser */}
                <div>
                  <SectionTitle title={t.encumbrances} />
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                    <table className="w-full">
                      <thead>
                        <tr className="text-slate-500 text-xs border-b border-slate-700/30">
                          <th className="px-4 py-2 text-left font-medium">{t.priority}</th>
                          <th className="px-4 py-2 text-left font-medium">{t.creditor}</th>
                          <th className="px-4 py-2 text-left font-medium">{t.debtor}</th>
                          <th className="px-4 py-2 text-left font-medium">{t.type}</th>
                          <th className="px-4 py-2 text-right font-medium">{t.principal}</th>
                          <th className="px-4 py-2 text-right font-medium">{t.date}</th>
                          <th className="px-2 py-2"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {ejendom.haeftelser.map((h) => (
                          <tr
                            key={h.id}
                            className="border-t border-slate-700/30 hover:bg-slate-700/20 transition-colors"
                          >
                            <td className="px-4 py-3">
                              {h.prioritet !== undefined ? (
                                <span className="inline-flex items-center justify-center w-5 h-5 bg-slate-700/60 rounded text-slate-300 text-xs font-semibold">
                                  {h.prioritet}
                                </span>
                              ) : (
                                <span className="text-slate-500 text-sm">—</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-slate-200 text-sm">{h.kreditor}</td>
                            <td className="px-4 py-3 text-slate-300 text-sm">{h.debitor ?? '—'}</td>
                            <td className="px-4 py-3 text-slate-300 text-sm capitalize">
                              {h.type}
                            </td>
                            <td className="px-4 py-3 text-right">
                              {h.beloeb !== undefined ? (
                                <span className="text-white text-sm font-semibold">
                                  {formatDKK(h.beloeb)}
                                </span>
                              ) : (
                                <span className="text-slate-500 text-sm">—</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-slate-400 text-sm text-right">
                              {formatDato(h.tinglysningsdato)}
                            </td>
                            <td className="px-2 py-3 text-right">
                              <button
                                className="text-slate-600 hover:text-slate-300 transition-colors"
                                aria-label="Vis dokument"
                              >
                                <FileText size={13} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Matrikel-tæller */}
                  <p className="text-slate-500 text-xs mt-2 text-right">
                    {ejendom.jordstykker?.length ?? 1} matrikel · {ejendom.haeftelser.length}{' '}
                    {t.encumbrances.toLowerCase()}
                  </p>
                </div>
              </div>
            )}

            {/* ══════════════════════════════════════════
              ØKONOMI
          ══════════════════════════════════════════ */}
            {aktivTab === 'oekonomi' && (
              <div className="space-y-6">
                {/* Vurdering */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <DataKort
                    label={t.propertyValue}
                    value={formatDKK(ejendom.ejendomsvaerdi)}
                    sub={t.latestValuation}
                  />
                  <DataKort
                    label={t.landValue}
                    value={formatDKK(ejendom.grundvaerdi)}
                    sub={t.latestValuation}
                  />
                  <DataKort
                    label={t.totalTaxLabel}
                    value={formatDKK(ejendom.skat)}
                    sub={t.annualTax}
                  />
                  <DataKort
                    label={t.groundTax}
                    value={formatDKK(ejendom.grundskyld)}
                    sub={t.annualTax}
                  />
                </div>

                {/* {t.priceHistory} graf */}
                <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-slate-200 text-sm font-semibold">{t.priceHistory}</p>
                    <div className="flex items-center gap-1 text-slate-400 text-xs">
                      <TrendingUp size={12} />
                      <span>mio. DKK</span>
                    </div>
                  </div>
                  <EjendomPrisChart data={prisData} lang={lang} />
                </div>

                {/* Salgshistorik */}
                <div>
                  <SectionTitle title={t.salesHistory} onDownload={() => undefined} />
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                    <table className="w-full">
                      <thead>
                        <tr className="text-slate-500 text-xs border-b border-slate-700/30">
                          <th className="px-4 py-2 text-left font-medium">{t.buyer}</th>
                          <th className="px-4 py-2 text-left font-medium">{t.type}</th>
                          <th className="px-4 py-2 text-right font-medium">{t.share}</th>
                          <th className="px-4 py-2 text-right font-medium">{t.price}</th>
                          <th className="px-4 py-2 text-right font-medium">{t.date}</th>
                          <th className="px-2 py-2"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {(
                          ejendom.salgshistorik ??
                          ejendom.handelHistorik.map((h) => ({
                            koebere: [
                              {
                                navn: h.koeberType === 'selskab' ? t.companyType : t.privatPerson,
                                andel: 100 as number | undefined,
                              },
                            ],
                            handelstype: da ? 'Skøde' : 'Deed',
                            kilde: 'tinglysning' as const,
                            andel: 100,
                            pris: h.pris,
                            dato: h.dato,
                          }))
                        ).map((s, i) => (
                          <tr
                            key={i}
                            className="border-t border-slate-700/30 hover:bg-slate-700/20 transition-colors"
                          >
                            <td className="px-4 py-3">
                              {s.koebere.map((k, ki) => (
                                <p key={ki} className="text-slate-200 text-sm">
                                  {k.navn}
                                  {k.andel !== undefined && s.koebere.length > 1 && (
                                    <span className="text-slate-500 ml-1 text-xs">
                                      ({k.andel}%)
                                    </span>
                                  )}
                                </p>
                              ))}
                            </td>
                            <td className="px-4 py-3">
                              <p className="text-slate-300 text-sm">{s.handelstype}</p>
                              <p className="text-orange-400 text-xs capitalize">{s.kilde}</p>
                            </td>
                            <td className="px-4 py-3 text-slate-300 text-sm text-right">
                              {s.andel !== undefined ? `${s.andel}%` : '—'}
                            </td>
                            <td className="px-4 py-3 text-white text-sm font-semibold text-right">
                              {formatDKK(s.pris)}
                            </td>
                            <td className="px-4 py-3 text-slate-400 text-sm text-right">
                              {formatDato(s.dato)}
                            </td>
                            <td className="px-2 py-3 text-right">
                              <ChevronRight size={14} className="text-slate-600 ml-auto" />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Udbudshistorik — only rendered when data exists (BIZZ-363) */}
                {ejendom.udbudshistorik && ejendom.udbudshistorik.length > 0 && (
                  <div>
                    <SectionTitle title={t.listingHistory} />
                    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                      <table className="w-full">
                        <thead>
                          <tr className="text-slate-500 text-xs border-b border-slate-700/30">
                            <th className="px-4 py-2 text-left font-medium">{t.status}</th>
                            <th className="px-4 py-2 text-right font-medium">{t.priceChange}</th>
                            <th className="px-4 py-2 text-right font-medium">{t.price}</th>
                            <th className="px-4 py-2 text-right font-medium">{t.date}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ejendom.udbudshistorik && ejendom.udbudshistorik.length > 0 ? (
                            ejendom.udbudshistorik.map((u, i) => (
                              <tr
                                key={i}
                                className="border-t border-slate-700/30 hover:bg-slate-700/20 transition-colors"
                              >
                                <td className="px-4 py-3 text-slate-200 text-sm">{u.status}</td>
                                <td className="px-4 py-3 text-right">
                                  {u.prisaendring !== undefined ? (
                                    <span
                                      className={`text-sm font-medium ${u.prisaendring >= 0 ? 'text-green-400' : 'text-red-400'}`}
                                    >
                                      {u.prisaendring >= 0 ? '+' : ''}
                                      {u.prisaendring.toLocaleString(da ? 'da-DK' : 'en-GB')} DKK
                                    </span>
                                  ) : (
                                    <span className="text-slate-500 text-sm">—</span>
                                  )}
                                </td>
                                <td className="px-4 py-3 text-white text-sm font-semibold text-right">
                                  {formatDKK(u.pris)}
                                </td>
                                <td className="px-4 py-3 text-slate-400 text-sm text-right">
                                  {formatDato(u.dato)}
                                </td>
                              </tr>
                            ))
                          ) : (
                            <tr>
                              <td
                                colSpan={4}
                                className="px-4 py-6 text-center text-slate-500 text-sm"
                              >
                                {t.noListingHistory}
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* (det separate checklist-panel er fjernet — checkboxe sidder nu direkte ved PDF-ikonerne i dokumenttabellen ovenfor) */}
            {aktivTab === 'dokumenter' && false && (
              <div className="space-y-4 pb-4">
                {/* ── {t.standardDocs} ── */}
                <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-700/40 flex items-center justify-between">
                    <h3 className="text-white font-semibold text-sm">{t.standardDocs}</h3>
                    <Download
                      size={14}
                      className="text-slate-600 hover:text-slate-300 cursor-pointer transition-colors"
                    />
                  </div>
                  {/* Kolonneheader */}
                  <div className="px-4 py-2 border-b border-slate-700/30 flex items-center gap-3">
                    <input
                      type="checkbox"
                      className="w-3.5 h-3.5 accent-blue-500 opacity-0"
                      readOnly
                    />
                    <span className="text-slate-500 text-xs font-medium flex-1">Navn</span>
                  </div>
                  {[
                    { id: 'std-1', navn: 'BizzAssist ejendomsrapport', sub: 'gratis', link: true },
                    {
                      id: 'std-2',
                      navn: 'Ejendomsdatarapport',
                      sub: 'pris: kr. 105 inkl. moms',
                      link: true,
                    },
                    { id: 'std-3', navn: 'BBR-meddelelse', sub: null, link: false },
                    { id: 'std-4', navn: 'BBR-tabeller (Excel)', sub: null, link: false },
                    { id: 'std-5', navn: 'Matrikelkort', sub: null, link: false },
                    {
                      id: 'std-6',
                      navn: 'Konfliktrapport',
                      sub: null,
                      link: false,
                      settings: true,
                    },
                    { id: 'std-7', navn: 'Jordforureningsattest', sub: null, link: true },
                  ].map((doc) => (
                    <div
                      key={doc.id}
                      className="px-4 py-2.5 border-b border-slate-700/20 last:border-0 flex items-center gap-3 hover:bg-slate-700/20 transition-colors group"
                    >
                      <input
                        type="checkbox"
                        checked={valgteDoc.has(doc.id)}
                        onChange={() => toggleDoc(doc.id)}
                        className="w-3.5 h-3.5 accent-blue-500 cursor-pointer"
                      />
                      <span
                        className={`flex-1 text-sm ${doc.link ? 'text-blue-400 hover:text-blue-300 cursor-pointer' : 'text-slate-300'}`}
                      >
                        {doc.navn}
                        {doc.sub && <span className="text-slate-500 ml-1">({doc.sub})</span>}
                      </span>
                      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        {doc.settings && <FileText size={13} className="text-slate-500" />}
                        <FileText size={13} className="text-slate-500" />
                      </div>
                    </div>
                  ))}
                </div>

                {/* ── Tinglysning ── */}
                <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-700/40 flex items-center justify-between">
                    <h3 className="text-white font-semibold text-sm">{t.landRegistry}</h3>
                    <Download
                      size={14}
                      className="text-slate-600 hover:text-slate-300 cursor-pointer transition-colors"
                    />
                  </div>
                  <div className="px-4 py-2 border-b border-slate-700/30 flex items-center gap-3">
                    <input
                      type="checkbox"
                      className="w-3.5 h-3.5 accent-blue-500 opacity-0"
                      readOnly
                    />
                    <span className="text-slate-500 text-xs font-medium flex-1">Type</span>
                  </div>
                  {[
                    { id: 'tgl-1', navn: 'Tingbogsattest', link: true, expandable: false },
                    {
                      id: 'tgl-2',
                      navn: `Indskannet akt nr. ${ejendom?.tingbogsattest?.aktNummer ?? '7_CO21'}`,
                      link: true,
                      expandable: false,
                    },
                    {
                      id: 'tgl-3',
                      navn: da
                        ? 'Adkomster inkl. påtegninger og bilag'
                        : 'Title deeds incl. endorsements and annexes',
                      link: false,
                      expandable: true,
                    },
                    {
                      id: 'tgl-4',
                      navn: da
                        ? 'Hæftelser inkl. påtegninger og bilag'
                        : 'Encumbrances incl. endorsements and annexes',
                      link: false,
                      expandable: true,
                    },
                  ].map((doc) => (
                    <div
                      key={doc.id}
                      className="px-4 py-2.5 border-b border-slate-700/20 last:border-0 flex items-center gap-3 hover:bg-slate-700/20 transition-colors group"
                    >
                      <input
                        type="checkbox"
                        checked={valgteDoc.has(doc.id)}
                        onChange={() => toggleDoc(doc.id)}
                        className="w-3.5 h-3.5 accent-blue-500 cursor-pointer"
                      />
                      {doc.expandable && <ChevronRight size={13} className="text-slate-500" />}
                      <span
                        className={`flex-1 text-sm ${doc.link ? 'text-blue-400 hover:text-blue-300 cursor-pointer' : 'text-slate-300'}`}
                      >
                        {doc.navn}
                      </span>
                      <FileText
                        size={13}
                        className="text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity"
                      />
                    </div>
                  ))}
                  {/* Servitutter — ingen data */}
                  <div className="px-4 py-2.5 flex items-center gap-3">
                    <input
                      type="checkbox"
                      className="w-3.5 h-3.5 accent-blue-500 opacity-0"
                      readOnly
                    />
                    <span className="text-slate-500 text-sm italic">{t.servitutNote}</span>
                    <FileText size={13} className="text-slate-700 ml-auto" />
                  </div>
                </div>

                {/* ── Planer ── */}
                <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-700/40 flex items-center justify-between">
                    <h3 className="text-white font-semibold text-sm">{t.plans}</h3>
                    <Download
                      size={14}
                      className="text-slate-600 hover:text-slate-300 cursor-pointer transition-colors"
                    />
                  </div>
                  {[
                    {
                      id: 'pla-1',
                      navn: 'Kommuneplan',
                      sub: 'Hvidovre Kommuneplan 2022',
                      link: true,
                    },
                    {
                      id: 'pla-2',
                      navn: 'Lokalplan',
                      sub: da
                        ? 'LP 110 — Erhvervsområde Risbjerg'
                        : 'LP 110 — Commercial area Risbjerg',
                      link: true,
                    },
                  ].map((doc) => (
                    <div
                      key={doc.id}
                      className="px-4 py-2.5 border-b border-slate-700/20 last:border-0 flex items-center gap-3 hover:bg-slate-700/20 transition-colors group"
                    >
                      <input
                        type="checkbox"
                        checked={valgteDoc.has(doc.id)}
                        onChange={() => toggleDoc(doc.id)}
                        className="w-3.5 h-3.5 accent-blue-500 cursor-pointer"
                      />
                      <span className="flex-1 text-sm text-blue-400 hover:text-blue-300 cursor-pointer">
                        {doc.navn}
                        {doc.sub && (
                          <span className="text-slate-500 ml-1 font-normal">— {doc.sub}</span>
                        )}
                      </span>
                      <FileText
                        size={13}
                        className="text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Download-bar fjernet — knappen er nu i dokumenter-kortets header */}
        </div>

        {/* Adskillelseslinie — træk for at ændre kortpanel-bredde */}
        {visKort && kortPanelÅben && (
          <div
            className={`w-1.5 flex-shrink-0 cursor-col-resize flex items-center justify-center group transition-colors ${trækker ? 'bg-blue-500/30' : 'bg-slate-800 hover:bg-blue-500/20'}`}
            onMouseDown={(e) => {
              e.preventDefault();
              trækStart.current = { x: e.clientX, bredde: kortBredde };
              setTrækker(true);
            }}
          >
            <div
              className={`w-0.5 h-10 rounded-full transition-colors ${trækker ? 'bg-blue-400' : 'bg-slate-600 group-hover:bg-blue-400'}`}
            />
          </div>
        )}

        {/* ─── Kortpanel — højre side ─── */}
        {visKort && kortPanelÅben && (
          <div className="relative flex-shrink-0 self-stretch" style={{ width: kortBredde }}>
            <div className="absolute inset-0">
              <Suspense
                fallback={
                  <div className="w-full h-full flex flex-col items-center justify-center bg-slate-900 gap-3">
                    <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                    <p className="text-slate-500 text-xs">{t.loadingMap}</p>
                  </div>
                }
              >
                <PropertyMap
                  lat={ejendom.lat}
                  lng={ejendom.lng}
                  adresse={bfrAdresseStreng}
                  visMatrikel={true}
                  onAdresseValgt={handleAdresseValgt}
                  fullMapHref={`/dashboard/kort?ejendom=${id}`}
                  erEjerlejlighed={!!bbrData?.ejerlejlighedBfe}
                  bygningPunkter={bfrBygningPunkter}
                />
              </Suspense>
            </div>
          </div>
        )}
      </div>

      {/*
       * ─── Mobil: Kortoverlay — fylder hele skærmen ───
       *
       * Portalen er påkrævet fordi iOS Safari ikke respekterer `position: fixed`
       * korrekt inde i en `overflow: hidden`-beholder (BIZZ-76).
       * createPortal løfter overlayet ud af DOM-træet til document.body,
       * hvorved det altid dækker hele viewport uanset forældrets overflow-mode.
       */}
      {!visKort &&
        mobilKortAaben &&
        createPortal(
          <div className="fixed inset-0 z-50 flex flex-col bg-slate-950">
            {/* Overlay-header */}
            <div className="flex items-center justify-between px-4 py-3 bg-slate-900 border-b border-slate-700/50 flex-shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <MapIcon size={15} className="text-blue-400 flex-shrink-0" />
                <span className="text-white text-sm font-medium truncate">
                  {ejendom.adresse}, {ejendom.postnummer} {ejendom.by}
                </span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                <Link
                  href={`/dashboard/kort?ejendom=${id}`}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-slate-300 text-xs font-medium transition-all"
                >
                  <MapIcon size={11} />
                  {da ? 'Fuldt kort' : 'Full map'}
                </Link>
                <button
                  onClick={() => setMobilKortAaben(false)}
                  className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
                  aria-label={da ? 'Luk kort' : 'Close map'}
                >
                  <X size={18} />
                </button>
              </div>
            </div>
            {/* Kortindhold */}
            <div className="flex-1 relative">
              <Suspense
                fallback={
                  <div className="absolute inset-0 flex items-center justify-center bg-slate-900">
                    <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                  </div>
                }
              >
                <PropertyMap
                  lat={ejendom.lat}
                  lng={ejendom.lng}
                  adresse={bfrAdresseStreng}
                  visMatrikel={true}
                  onAdresseValgt={handleAdresseValgtMobil}
                  erEjerlejlighed={!!bbrData?.ejerlejlighedBfe}
                  bygningPunkter={bfrBygningPunkter}
                />
              </Suspense>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
// ─── PropertyOwnerDiagram ──────────────────────────────────────────────────

/**
 * Henter ejerskabskæden for en ejendom og viser den som et relationsdiagram.
 * Ejendom = grøn, virksomheder = blå, personer = lilla.
 */
interface EjerDetalje {
  navn: string;
  cvr: string | null;
  enhedsNummer: number | null;
  type: 'person' | 'selskab' | 'status';
  andel: string | null;
  adresse: string | null;
  overtagelsesdato: string | null;
  adkomstType: string | null;
  koebesum: number | null;
  isCeased?: boolean;
}

function PropertyOwnerDiagram({
  bfe,
  adresse,
  lang,
  erEjerlejlighed = false,
}: {
  bfe: number;
  adresse: string;
  lang: 'da' | 'en';
  /**
   * BIZZ-470: True når ejendommen er en ejerlejlighed. Signalerer til
   * /api/ejerskab/chain at Tinglysning-opslagene kan springes over —
   * Tinglysning returnerer alligevel kun "Opdelt i ejerlejlighed" som
   * status, og EJF leverer de faktiske ejere meget hurtigere.
   */
  erEjerlejlighed?: boolean;
}) {
  const _router = useRouter();
  const da = lang === 'da';
  const [graph, setGraph] = useState<DiagramGraph | null>(null);
  const [ejerDetaljer, setEjerDetaljer] = useState<EjerDetalje[]>([]);
  const [loading, setLoading] = useState(true);
  const [_chainFejl, setChainFejl] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setGraph(null);
    setEjerDetaljer([]);
    setChainFejl(null);

    const controller = new AbortController();

    const typeParam = erEjerlejlighed ? '&type=ejerlejlighed' : '';
    fetch(`/api/ejerskab/chain?bfe=${bfe}&adresse=${encodeURIComponent(adresse)}${typeParam}`, {
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        setChainFejl((data.fejl as string | null) ?? null);
        if (data.nodes?.length > 0) {
          setGraph({
            nodes: data.nodes.map((n: Record<string, unknown>) => ({
              id: n.id as string,
              label: n.label as string,
              type: n.type as 'person' | 'company' | 'property' | 'status',
              cvr: n.cvr as number | undefined,
              link: n.link as string | undefined,
              // Propagate bfeNummer so DiagramForce renders "BFE X" on the
              // property node (bug seen 2026-04-18 where root property
              // node was a blank box)
              bfeNummer: n.bfeNummer as number | undefined,
            })),
            edges: data.edges.map((e: Record<string, unknown>) => ({
              from: e.from as string,
              to: e.to as string,
              ejerandel: e.ejerandel as string | undefined,
            })),
            mainId: data.mainId as string,
          });
          setEjerDetaljer(data.ejerDetaljer ?? []);
        }
      })
      .catch((err) => {
        if (err.name !== 'AbortError') logger.error('[ejerskab/chain] fetch error:', err);
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [bfe, adresse, erEjerlejlighed]);

  if (loading)
    // BIZZ-478: Brug den blå TabLoadingSpinner-bar i stedet for box-spinner
    // så ejendomssidens diagram-tab visuelt matcher resten af appen.
    return (
      <TabLoadingSpinner label={da ? 'Henter ejerstruktur…' : 'Loading ownership structure…'} />
    );

  if (!graph || graph.nodes.length <= 1) {
    const besked = da ? 'Ingen ejerstruktur tilgængelig' : 'No ownership structure available';
    return (
      <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-6 text-center">
        <p className="text-slate-500 text-sm">{besked}</p>
      </div>
    );
  }

  const adkomstTypeMap: Record<string, string> = {
    skoede: da ? 'Skøde' : 'Deed',
    auktionsskoede: da ? 'Auktionsskøde' : 'Auction deed',
    arv: da ? 'Arv' : 'Inheritance',
    gave: da ? 'Gave' : 'Gift',
  };

  return (
    <div className="space-y-2">
      {/* Ejer info-bokse */}
      {ejerDetaljer.map((ejer, i) => (
        <div key={i} className="bg-slate-800/40 border border-slate-700/40 rounded-xl px-3 py-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <div
                className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
                  ejer.type === 'selskab'
                    ? 'bg-blue-500/20 border border-blue-500/30'
                    : ejer.type === 'status'
                      ? 'bg-slate-600/20 border border-slate-600/30'
                      : 'bg-purple-500/20 border border-purple-500/30'
                }`}
              >
                {ejer.type === 'selskab' ? (
                  <Building2 size={15} className="text-blue-400" />
                ) : ejer.type === 'status' ? (
                  <Building2 size={15} className="text-slate-400" />
                ) : (
                  <Users size={15} className="text-purple-400" />
                )}
              </div>
              <div>
                {ejer.type === 'status' ? (
                  <p className="text-slate-300 font-semibold text-sm">{ejer.navn}</p>
                ) : ejer.cvr ? (
                  <Link
                    href={`/dashboard/companies/${ejer.cvr}`}
                    className="text-blue-300 font-semibold text-sm hover:text-blue-200 transition-colors flex items-center gap-1 underline decoration-blue-500/30 hover:decoration-blue-400/50"
                  >
                    {ejer.navn} {ejer.andel ? `(${ejer.andel})` : ''}
                    {ejer.isCeased && (
                      <span className="ml-1.5 text-[10px] font-medium text-red-400 bg-red-500/15 border border-red-500/30 rounded px-1.5 py-0.5">
                        {da ? 'Ophørt' : 'Ceased'}
                      </span>
                    )}
                    <ChevronRight size={13} />
                  </Link>
                ) : ejer.enhedsNummer ? (
                  <Link
                    href={`/dashboard/owners/${ejer.enhedsNummer}`}
                    className="text-purple-300 font-semibold text-sm hover:text-purple-200 transition-colors flex items-center gap-1 underline decoration-purple-500/30 hover:decoration-purple-400/50"
                  >
                    {ejer.navn} {ejer.andel ? `(${ejer.andel})` : ''}
                    <ChevronRight size={13} />
                  </Link>
                ) : (
                  <p className="text-white font-semibold text-sm">
                    {ejer.navn} {ejer.andel ? `(${ejer.andel})` : ''}
                  </p>
                )}
                {ejer.adresse && (
                  <p className="text-slate-400 text-xs mt-0.5 break-words">{ejer.adresse}</p>
                )}
              </div>
            </div>
          </div>

          {ejer.type === 'status' ? (
            <p className="text-slate-500 text-xs mt-2 pt-2 border-t border-slate-700/30">
              {da
                ? 'Ejerskab registreret på de enkelte ejerlejligheder'
                : 'Ownership registered on the individual condominiums'}
            </p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1.5 mt-2 pt-2 border-t border-slate-700/30">
              {ejer.overtagelsesdato && (
                <div>
                  <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                    {da ? 'Overtagelsesdato' : 'Acquisition date'}
                  </p>
                  <p className="text-slate-200 text-xs">
                    {new Date(ejer.overtagelsesdato.split('+')[0]).toLocaleDateString('da-DK', {
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                    })}
                  </p>
                </div>
              )}
              <div>
                <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                  {da ? 'Ejertype' : 'Owner type'}
                </p>
                <p className="text-slate-200 text-xs">
                  {ejer.type === 'selskab'
                    ? da
                      ? 'Selskab'
                      : 'Company'
                    : da
                      ? 'Privatperson'
                      : 'Private person'}
                </p>
              </div>
              {ejer.adkomstType && (
                <div>
                  <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                    {da ? 'Adkomsttype' : 'Title type'}
                  </p>
                  <p className="text-slate-200 text-xs">
                    {adkomstTypeMap[ejer.adkomstType] ?? ejer.adkomstType}
                  </p>
                </div>
              )}
              {ejer.koebesum != null && ejer.koebesum > 0 && (
                <div>
                  <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                    {da ? 'Købesum' : 'Purchase price'}
                  </p>
                  <p className="text-slate-200 text-xs">
                    {ejer.koebesum.toLocaleString('da-DK')} DKK
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      ))}

      {/* Relationsdiagram — samme DiagramForce som virksomheds- og personsiderne */}
      <DiagramForce graph={graph} lang={lang} />
    </div>
  );
}
