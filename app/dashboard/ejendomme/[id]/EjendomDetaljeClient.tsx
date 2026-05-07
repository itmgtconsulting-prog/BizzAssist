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
  Bell,
  X,
  MapPin,
  Building2,
  Home,
  FileText,
  Users,
  Landmark,
  BarChart3,
  Map as MapIcon,
  Briefcase,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
/** BIZZ-600: PropertyMap wraps mapbox-gl (browser-only) — dynamic() keeps mapbox-gl out of initial bundle */
// prettier-ignore
const PropertyMap = dynamic(/* mapbox-gl */ () => import('@/app/components/ejendomme/PropertyMap'), { ssr: false, loading: () => (<div className="w-full h-64 bg-slate-800/50 rounded-xl animate-pulse flex items-center justify-center"><span className="text-slate-500 text-sm">Indlæser kort...</span></div>) });
/** Diagram v2 — feature-flagged, kun synlig i dev/preview */
import { type EjerstrukturNode } from '@/app/lib/mock/ejendomme';
import { erDawaId, type DawaAdresse, type DawaJordstykke } from '@/app/lib/dawa';
import { formatBenyttelseOgByggeaar } from '@/app/lib/benyttelseskoder';
import { isUdfasetStatusLabel } from '@/app/lib/bbrKoder';
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
import CreateCaseModal from '@/app/components/sager/CreateCaseModal';
import { useDomainMemberships } from '@/app/hooks/useDomainMemberships';
import { useLanguage } from '@/app/context/LanguageContext';
import { useSetAIPageContext } from '@/app/context/AIPageContext';
import dynamic from 'next/dynamic';
import { logger } from '@/app/lib/logger';
// isDiagram2Enabled fjernet
import TinglysningTab from './TinglysningTab';
// BIZZ-657: Tab-subkomponenter extraheret til selvstændige præsentations-komponenter
import EjendomSkatTab from './tabs/EjendomSkatTab';
import EjendomDokumenterTab from './tabs/EjendomDokumenterTab';
import EjendomEjerforholdTab from './tabs/EjendomEjerforholdTab';
import type { EjerDetalje } from './EjerKort';
import GenerateListingModal from '@/app/components/ejendomme/GenerateListingModal';
import EjendomOekonomiTab from './tabs/EjendomOekonomiTab';
import EjendomBBRTab from './tabs/EjendomBBRTab';
import DataFreshnessBadge from '@/app/components/DataFreshnessBadge';
import FloodRiskBadge from '@/app/components/ejendomme/FloodRiskBadge';
import EjendomOverblikTab from './tabs/EjendomOverblikTab';
// BIZZ-583: Administrator-kort bruges nu kun via EjendomEjerforholdTab — import fjernet fra master.
// BIZZ-601: DiagramForce + DiagramGraph-type var kun brugt i
// BIZZ-1143: PropertyOwnerDiagram slettet — erstattet af EjerKort (ren præsentation).

type Tab =
  | 'overblik'
  | 'bbr'
  | 'ejerforhold'
  // diagram2 fjernet — DiagramV2 vises nu på ejerskab-fanen
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
    // Diagram v2 fane fjernet — diagrammet vises nu på Ejerskab-fanen
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
    back: da ? 'Ejendomme' : 'Properties',
    backToProperties: da ? 'Tilbage til ejendomme' : 'Back to properties',
    following: da ? 'Følger' : 'Following',
    follow: da ? 'Følg' : 'Follow',
    loadingAddress: da ? 'Henter adressedata…' : 'Loading address data…',
    addressNotFound: da ? 'Adresse ikke fundet' : 'Address not found',
    addressNotFoundDesc: da
      ? 'Adressen kunne ikke hentes fra DAWA.'
      : 'The address could not be retrieved from DAWA.',
    propertyNotFound: da ? 'Ejendom ikke fundet' : 'Property not found',
    propertyNotFoundDesc: da
      ? 'BFE-nummeret findes ikke i systemet.'
      : 'The BFE number does not exist in the system.',
    protectedForest: da ? 'Fredskov' : 'Protected forest',
    coastalProtection: da ? 'Strandbeskyttelse' : 'Coastal protection',
    duneProtection: da ? 'Klitfredning' : 'Dune protection',
    groundRent: da ? 'Jordrente' : 'Ground rent',
    unknownError: da ? 'Ukendt fejl' : 'Unknown error',
    noDirectPdfLinks: da
      ? 'De valgte dokumenter har ingen direkte PDF-links der kan downloades.'
      : 'The selected documents have no direct PDF links that can be downloaded.',
    zipDownloaded: da
      ? 'ZIP-filen er hentet, men følgende dokumenter kunne ikke inkluderes (ikke en gyldig PDF):'
      : 'The ZIP file has been downloaded, but the following documents could not be included (not a valid PDF):',
    tryOpenInBrowser: da
      ? 'Prøv at åbne dem direkte i browseren.'
      : 'Try opening them directly in the browser.',
  };

  const [aktivTab, setAktivTab] = useState<Tab>('overblik');
  /** BIZZ-1121: Lazy-mount — mount ved første klik, behold med display:none */
  // diagram2Mounted fjernet
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
  /** BIZZ-919: Cache-metadata fra BBR API-response */
  const [bbrFromCache, setBbrFromCache] = useState(false);
  const [bbrSyncedAt, setBbrSyncedAt] = useState<string | null>(null);
  const [bbrRefreshing, setBbrRefreshing] = useState(false);
  /** BIZZ-919: Incrementing key triggers BBR data re-fetch */
  const [bbrRefreshKey, setBbrRefreshKey] = useState(0);

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
  const [_tlHaeftelser, setTlHaeftelser] = useState<TLHaeftelse[]>([]);
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

  /** Ejendomsstruktur-træ (SFE → Hovedejendom → Ejerlejlighed) */
  const [strukturTree, setStrukturTree] = useState<
    import('@/app/api/ejendom-struktur/route').StrukturNode | null
  >(null);
  /** True mens strukturdata hentes */
  const [strukturLoader, setStrukturLoader] = useState(false);

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

  /** BIZZ-1143: Ejer-detaljer fra /api/ejerskab/chain (prefetched parallelt) */
  const [chainEjerDetaljer, setChainEjerDetaljer] = useState<EjerDetalje[]>([]);
  /** BIZZ-1143: True mens chain-data hentes */
  const [chainLoader, setChainLoader] = useState(false);
  /** BIZZ-1143: Prefetched diagram-graf fra /api/diagram/resolve */
  const [prefetchedDiagramGraph, setPrefetchedDiagramGraph] = useState<{ graph: unknown } | null>(
    null
  );
  /** BIZZ-1143: True mens diagram-resolve hentes */
  const [diagramResolveLoader, setDiagramResolveLoader] = useState(false);

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
  /** BIZZ-808: Opret sag-modal state */
  const [opretSagOpen, setOpretSagOpen] = useState(false);
  /** BIZZ-1179: Modal for AI annoncegenerering */
  const [annonceModalOpen, setAnnonceModalOpen] = useState(false);
  const { memberships: domainMemberships } = useDomainMemberships();

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
    // BIZZ-1023: Preload vurdering, BBR-summary og ejerskab i AI-kontekst
    const ejendomVurdering = vurdering
      ? {
          ejendomsvaerdi: vurdering.ejendomsvaerdi ?? null,
          grundvaerdi: vurdering.grundvaerdi ?? null,
          vurderingsaar: vurdering.aar ?? null,
        }
      : undefined;

    const aktiveBygninger = bbrData?.bbr?.filter((b) => !isUdfasetStatusLabel(b.status));
    const ejendomBBR = aktiveBygninger
      ? {
          antalBygninger: aktiveBygninger.length,
          samletAreal:
            aktiveBygninger.reduce((sum, b) => sum + (b.samletBygningsareal ?? 0), 0) || null,
          opfoerelsesaar: aktiveBygninger[0]?.opfoerelsesaar ?? null,
          anvendelse: aktiveBygninger[0]?.anvendelse ?? null,
        }
      : undefined;

    setAICtx({
      adresse: adresseStr,
      adresseId,
      bfeNummer,
      kommunekode,
      matrikelnr,
      ejerlavKode,
      pageType: 'ejendom',
      activeTab: aktivTab,
      ejendomVurdering,
      ejendomBBR,
    });
  }, [bbrData, dawaAdresse, dawaJordstykke, aktivTab, vurdering, setAICtx]);

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
    () => bbrData?.bygningPunkter?.filter((p) => !isUdfasetStatusLabel(p.status)) ?? undefined,
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
    // Skip BBR fetch hvis server-side prefetch allerede leverede data (undtagen ved refresh)
    if (prefetched?.bbrData && bbrRefreshKey === 0) return;
    const controller = new AbortController();
    setBbrLoader(true);
    fetch(`/api/ejendom/${id}`, { signal: controller.signal })
      .then((r) => {
        // BIZZ-919: Læs cache-metadata fra API-response headers
        const cacheHit = r.headers.get('X-Cache-Hit');
        const synced = r.headers.get('X-Synced-At');
        setBbrFromCache(cacheHit === 'true');
        setBbrSyncedAt(synced);
        return r.ok ? (r.json() as Promise<EjendomApiResponse>) : null;
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        setBbrData(data);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        logger.error('[ejendom] BBR fetch error:', err);
        setBbrData(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setBbrLoader(false);
          setBbrRefreshing(false);
        }
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, erDAWA, dawaStatus, bbrRefreshKey]);

  /** BIZZ-919: Force-refresh — inkrementer bbrRefreshKey for at gen-trigge BBR useEffect */
  const handleBbrRefresh = useCallback(() => {
    setBbrRefreshing(true);
    setBbrRefreshKey((k) => k + 1);
  }, []);

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
    // BIZZ-832: Også hent for child-units (ejerlejligheder med etage) for søster-enheder
    // BIZZ-841: Prefetch så snart matrikelData ELLER bbrData har ejerlavkode+matrikelnr —
    // tidligere ventede vi udelukkende på BBR's ejendomsrelationer, hvilket
    // serialiserede BBR → MAT → ejerlejligheder. Nu kan ejerlejligheder-fetch
    // starte så snart én af de to kilder har koordinater.
    const erModer = !dawaAdresse?.etage && !!bbrData?.ejerlejlighedBfe;
    const erChild = !!dawaAdresse?.etage && !!bbrData?.ejerlejlighedBfe;
    // Fallback: hvis matrikelData er klar før BBR, kan vi ikke vide om det er
    // opdelt. Prefetch kun hvis vi har bbr-signal eller matrikel-opdelt-flag.
    const matOpdelt = matrikelData?.opdeltIEjerlejligheder === true;
    if (!erModer && !erChild && !matOpdelt) return;

    // Find ejerlavkode + matrikelnr — foretræk BBR (konsistent med eksisterende
    // logic), fallback til MAT når BBR endnu ikke er loaded.
    const bbrRel = bbrData?.ejendomsrelationer?.[0];
    const matJs = matrikelData?.jordstykker?.[0];
    const ejerlavKode = bbrRel?.ejerlavKode ?? matJs?.ejerlavskode;
    const matrikelnr = bbrRel?.matrikelnr ?? matJs?.matrikelnummer;
    if (!ejerlavKode || !matrikelnr) return;
    const controller = new AbortController();
    setLejlighederLoader(true);
    const params = new URLSearchParams({
      ejerlavKode: String(ejerlavKode),
      matrikelnr: String(matrikelnr),
    });
    // BIZZ-695: Send ejerlejlighedBfe so DAWA fallback can look up owners via ejf_ejerskab
    if (bbrData?.ejerlejlighedBfe) params.set('moderBfe', String(bbrData.ejerlejlighedBfe));
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
  }, [id, erDAWA, dawaStatus, dawaAdresse, bbrData, matrikelData]);

  /**
   * Henter ejendomsstruktur (SFE → Hovedejendom → Ejerlejlighed) for opdelte
   * ejendomme. Aktiveres kun når ejendommen er opdelt i ejerlejligheder.
   * Bruger samme ejerlav+matrikelnr som ejerlejligheder-fetch.
   */
  useEffect(() => {
    const erModer = !dawaAdresse?.etage && !!bbrData?.ejerlejlighedBfe;
    const erChild = !!dawaAdresse?.etage && !!bbrData?.ejerlejlighedBfe;
    const matOpdelt = matrikelData?.opdeltIEjerlejligheder === true;
    // Vis struktur for hele hierarkiet: moderejendommen, children (ejerlejligheder),
    // og ejendomme der er opdelt ifølge matrikeldata.
    if (!erModer && !erChild && !matOpdelt) return;

    const bbrRel = bbrData?.ejendomsrelationer?.[0];
    const matJs = matrikelData?.jordstykker?.[0];
    const ejerlavKode = bbrRel?.ejerlavKode ?? matJs?.ejerlavskode;
    const matrikelnr = bbrRel?.matrikelnr ?? matJs?.matrikelnummer;
    if (!ejerlavKode || !matrikelnr) return;

    const controller = new AbortController();
    setStrukturLoader(true);
    const params = new URLSearchParams({
      ejerlavKode: String(ejerlavKode),
      matrikelnr: String(matrikelnr),
    });
    const sfeBfe = bbrData?.moderBfe ?? bbrRel?.bfeNummer;
    if (sfeBfe) params.set('sfeBfe', String(sfeBfe));

    fetch(`/api/ejendom-struktur?${params}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : { tree: null }))
      .then((data: { tree: import('@/app/api/ejendom-struktur/route').StrukturNode | null }) => {
        if (controller.signal.aborted) return;
        setStrukturTree(data.tree);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        logger.warn('[ejendom] Struktur fetch error:', err);
      })
      .finally(() => {
        if (!controller.signal.aborted) setStrukturLoader(false);
      });
    return () => controller.abort();
  }, [id, erDAWA, dawaStatus, dawaAdresse, bbrData, matrikelData]);

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

    // BIZZ-1143: Fetch ejerskab/chain + diagram/resolve PARALLELT og gem resultatet.
    // EjerKort og DiagramV2 modtager data via props — ingen intern fetch i child.
    const erEjerlej = !!bbrData.ejerlejlighedBfe;
    const chainAdresse = dawaAdresse
      ? `${dawaAdresse.vejnavn} ${dawaAdresse.husnr}${dawaAdresse.etage ? `, ${dawaAdresse.etage}.` : ''}${dawaAdresse.dør ? ` ${dawaAdresse.dør}` : ''}, ${dawaAdresse.postnr} ${dawaAdresse.postnrnavn}`
      : '';
    const chainParams = new URLSearchParams({
      bfe: String(bfeNummer),
      adresse: chainAdresse,
    });
    if (erEjerlej) chainParams.set('type', 'ejerlejlighed');
    setChainLoader(true);
    fetch(`/api/ejerskab/chain?${chainParams}`, { signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (signal.aborted) return;
        setChainEjerDetaljer((data?.ejerDetaljer as EjerDetalje[]) ?? []);
      })
      .catch(() => {})
      .finally(() => {
        if (!signal.aborted) setChainLoader(false);
      });
    const resolveParams = new URLSearchParams({ type: 'property', id: String(bfeNummer) });
    if (chainAdresse) resolveParams.set('label', chainAdresse);
    setDiagramResolveLoader(true);
    fetch(`/api/diagram/resolve?${resolveParams}`, { signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (signal.aborted) return;
        if (data) setPrefetchedDiagramGraph(data);
      })
      .catch(() => {})
      .finally(() => {
        if (!signal.aborted) setDiagramResolveLoader(false);
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
      const adresse = dawaAdresse?.vejnavn ?? 'ejendom';
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

      // BIZZ-693: EJF har ofte null købesum — fallback til Tinglysning-match
      merged.push({
        kontantKoebesum:
          h.kontantKoebesum ?? bestMatch?.kontantKoebesum ?? bestMatch?.koebesum ?? null,
        samletKoebesum: h.samletKoebesum ?? bestMatch?.iAltKoebesum ?? bestMatch?.koebesum ?? null,
        loesoeresum: h.loesoeresum,
        entreprisesum: h.entreprisesum,
        koebsaftaleDato: h.koebsaftaleDato,
        overtagelsesdato: h.overtagelsesdato,
        overdragelsesmaade: h.overdragelsesmaade,
        // BIZZ-685/693: prefer Tinglysning match (has adkomst-detaljer),
        // fall back til ejf-enriched navn fra /api/salgshistorik så rækker
        // ikke længere vises som tomme købere når Tinglysning ikke matcher.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        koeber: bestMatch?.navn ?? (h as any).koeber ?? null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        koebercvr: bestMatch?.cvr ?? (h as any).koeberCvr ?? null,
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

    // BIZZ-444: Saml handler med samme dato til én linje (f.eks. 50%/50%
    // ejere der køber sammen vises som én handel).
    // BIZZ-844: Group på dato ALENE — tidligere (dato+sum) splittede rækker
    // når Tinglysning-enrichment kun matchede én af flere EJF-rows på samme
    // dato. Resulterede i "phantom"-rækker med samme dato men uden pris der
    // gav visningen "Brian Holm Larsen, Jakob Juul Rasmussen" ved siden af
    // en rigtig Jakob-række med pris. Ved merge foretrækkes den højeste
    // (non-null) sum så prisen ikke går tabt.
    const grouped: MergedHandel[] = [];
    for (const h of merged) {
      const dato = h.overtagelsesdato ?? h.koebsaftaleDato ?? '';
      const existing = grouped.find((g) => {
        const gDato = g.overtagelsesdato ?? g.koebsaftaleDato ?? '';
        return gDato === dato && dato !== '';
      });
      if (existing) {
        // Behold højeste known sum (non-null) — Tinglysning-pris overskriver
        // EJF's null-pris.
        if (
          h.kontantKoebesum != null &&
          (existing.kontantKoebesum == null || h.kontantKoebesum > existing.kontantKoebesum)
        ) {
          existing.kontantKoebesum = h.kontantKoebesum;
        }
        if (
          h.samletKoebesum != null &&
          (existing.samletKoebesum == null || h.samletKoebesum > existing.samletKoebesum)
        ) {
          existing.samletKoebesum = h.samletKoebesum;
        }
        if (h.tinglysningsdato && !existing.tinglysningsdato) {
          existing.tinglysningsdato = h.tinglysningsdato;
        }
        if (h.tinglysningsafgift != null && existing.tinglysningsafgift == null) {
          existing.tinglysningsafgift = h.tinglysningsafgift;
        }
      }
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
        // BIZZ-844: Skip hvis samme navn+cvr allerede er i koebere (dedup
        // når EJF + Tinglysning returnerer samme person for samme handel).
        const dupKey = `${h.koeber}__${h.koebercvr ?? ''}`;
        const alreadyPresent = existing.koebere.some((k) => `${k.navn}__${k.cvr ?? ''}` === dupKey);
        if (!alreadyPresent) {
          existing.koebere.push({ navn: h.koeber, cvr: h.koebercvr, andel: h.andel });
        }
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
                {/* BIZZ-1179: Generer annonce-knap */}
                <button
                  type="button"
                  onClick={() => setAnnonceModalOpen(true)}
                  className="flex items-center gap-2 px-3 py-1.5 border rounded-lg text-sm transition-all bg-slate-800 hover:bg-slate-700 border-slate-700/60 text-slate-300"
                  aria-label={da ? 'Generer boligannonce' : 'Generate property listing'}
                >
                  <Sparkles size={14} />
                  {da ? 'Annonce' : 'Listing'}
                </button>
                {/* BIZZ-808: Opret sag-knap — kun synlig for domain-brugere */}
                {domainMemberships.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setOpretSagOpen(true)}
                    className="flex items-center gap-2 px-3 py-1.5 border rounded-lg text-sm transition-all bg-emerald-600/20 hover:bg-emerald-600/30 border-emerald-500/40 text-emerald-300"
                    aria-label={
                      da ? 'Opret sag for denne ejendom' : 'Create case for this property'
                    }
                  >
                    <Briefcase size={14} />
                    {da ? 'Opret sag' : 'Create case'}
                  </button>
                )}
              </div>
            </div>

            <div className="mb-3">
              <div className="flex items-center gap-3">
                <h1 className="text-white text-xl font-bold">{adresseStreng}</h1>
                {/* BIZZ-728: Child unit (enhed med etage/dør) — link til hovedejendom.
                    Virker for ejerlejligheder OG erhvervsenheder o.lign. — vi navigerer
                    altid til parent-adgangsadresse (uden etage). moderBfe-stien bruges som
                    fallback hvis Vurderingsportalen har den (giver korrekt hovedejendom-BFE
                    til title), ellers navigerer vi direkte til adgangsadressen. */}
                {bbrData?.parentAdgangsadresseId && !!dawaAdresse?.etage && (
                  <button
                    onClick={async () => {
                      // Prefer moderBfe-path when Vurderingsportalen gave us a real
                      // hovedejendom-BFE (ejerlejligheder) — ellers gå direkte til
                      // adgangsadressen.
                      if (bbrData.moderBfe) {
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
                          /* fall through to adgangsadresse */
                        }
                      }
                      router.push(`/dashboard/ejendomme/${bbrData.parentAdgangsadresseId}`);
                    }}
                    className="flex items-center gap-1.5 px-3 py-1 bg-amber-500/15 border border-amber-500/30 rounded-lg text-amber-400 text-xs font-medium hover:bg-amber-500/25 transition-colors flex-shrink-0"
                    title={
                      lang === 'da'
                        ? bbrData.moderBfe
                          ? `Gå til hovedejendommen (BFE ${bbrData.moderBfe})`
                          : 'Gå til hovedejendommen (bygning/adgangsadresse)'
                        : bbrData.moderBfe
                          ? `Go to parent property (BFE ${bbrData.moderBfe})`
                          : 'Go to parent property (building/address)'
                    }
                  >
                    <Building2 size={12} />
                    {da ? 'Gå til hovedejendom' : 'Go to main property'}
                  </button>
                )}
                {/* Moderejandom (ingen etage, men har ejerlejlighedBfe): klikbar
                    "Gå til SFE" knap når strukturTree har en SFE med dawaId,
                    ellers statisk badge. */}
                {bbrData?.ejerlejlighedBfe &&
                  !dawaAdresse?.etage &&
                  (strukturTree?.niveau === 'sfe' && strukturTree.dawaId ? (
                    <button
                      onClick={() => {
                        router.push(`/dashboard/ejendomme/${strukturTree.dawaId}`);
                      }}
                      className="flex items-center gap-1.5 px-3 py-1 bg-amber-500/15 border border-amber-500/30 rounded-lg text-amber-400 text-xs font-medium hover:bg-amber-500/25 transition-colors flex-shrink-0"
                      title={
                        da
                          ? `Gå til SFE-ejendommen (BFE ${strukturTree.bfe})`
                          : `Go to SFE property (BFE ${strukturTree.bfe})`
                      }
                    >
                      <Building2 size={12} />
                      {da ? 'Gå til SFE ejendom' : 'Go to SFE property'}
                    </button>
                  ) : (
                    <span
                      className="flex items-center gap-1.5 px-3 py-1 bg-amber-500/15 border border-amber-500/30 rounded-lg text-amber-400 text-xs font-medium flex-shrink-0"
                      title={
                        da
                          ? `Denne ejendom er en hovedejendom (BFE ${bbrData.moderBfe ?? bbrData.ejerlejlighedBfe})`
                          : `This property is a main property (BFE ${bbrData.moderBfe ?? bbrData.ejerlejlighedBfe})`
                      }
                    >
                      <Building2 size={12} />
                      {da ? 'Hovedejendom' : 'Main property'}
                    </span>
                  ))}
                {bbrData?.ejerlejlighedBfe && (
                  <span className="flex items-center gap-1 px-2 py-0.5 bg-purple-500/15 border border-purple-500/30 rounded-full text-purple-400 text-[10px] font-medium flex-shrink-0">
                    {lang === 'da' ? 'Ejerlejlighed' : 'Condominium'}
                  </span>
                )}
                {/* BIZZ-550: Ejendomstype-badge — primær kilde: VUR juridiskKategori,
                     fallback: udledt fra BBR bygningsanvendelser.
                     BIZZ-840: BBR-kolonihave (kode 520/540) overrider VUR juridiskKategori
                     fordi VUR nogle gange fejlklassificerer kolonihaver som
                     "Blandet bolig/erhverv" — BBR er authoritative for bygningstype. */}
                {(() => {
                  // 0. BBR kolonihave override (mest specifik + authoritative)
                  if (erKolonihave) {
                    return (
                      <span
                        className="flex items-center gap-1 px-2.5 py-0.5 bg-emerald-500/15 border border-emerald-500/30 rounded-full text-emerald-300 text-xs font-medium flex-shrink-0"
                        title={
                          da
                            ? 'Kolonihave/fritidshytte — BBR-anvendelseskode 520 eller 540'
                            : 'Allotment/summer house — BBR use-code 520 or 540'
                        }
                      >
                        <Home size={11} />
                        {da ? 'Kolonihave' : 'Allotment'}
                      </span>
                    );
                  }
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
                  // BIZZ-825: udfaset via central helper; 'Ikke opført' er
                  // ikke i BBR status-kodesættet (legacy VUR-værdi) så den
                  // fortsat string-match'es.
                  const bygninger = bbrData?.bbr?.filter(
                    (b) => !isUdfasetStatusLabel(b.status) && b.status !== 'Ikke opført'
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
                {/* BIZZ-854: Ejendomstype-badge — amber for SFE/hovedejendom,
                    emerald for ejerlejlighed. Første chip i rækken. */}
                {(() => {
                  const erModer = !dawaAdresse?.etage && !!bbrData?.ejerlejlighedBfe;
                  const erEjerlej = !!dawaAdresse?.etage && !!bbrData?.ejerlejlighedBfe;
                  // Skelne SFE vs. underliggende hovedejendom via strukturTree:
                  // Hvis denne BFE matcher root-noden i træet, er det SFE.
                  const currentBfeNum =
                    bbrData?.ejerlejlighedBfe ??
                    bbrData?.moderBfe ??
                    bbrData?.ejendomsrelationer?.[0]?.bfeNummer;
                  const erSfe =
                    erModer && strukturTree?.niveau === 'sfe' && currentBfeNum === strukturTree.bfe;
                  if (erModer)
                    return (
                      <span
                        className="flex items-center gap-1 px-2.5 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded-full text-amber-300 text-xs font-medium flex-shrink-0"
                        title={
                          da
                            ? erSfe
                              ? 'Samlet Fast Ejendom — matrikel-niveau ejendom'
                              : 'Hovedejendom under en SFE'
                            : erSfe
                              ? 'Collective Real Property — cadastral-level property'
                              : 'Main property under an SFE'
                        }
                      >
                        <Building2 size={11} />
                        {erSfe
                          ? da
                            ? 'Hovedejendom (SFE)'
                            : 'Main property (SFE)'
                          : da
                            ? 'Hovedejendom'
                            : 'Main property'}
                      </span>
                    );
                  if (erEjerlej)
                    return (
                      <span
                        className="flex items-center gap-1 px-2.5 py-0.5 bg-emerald-500/10 border border-emerald-500/20 rounded-full text-emerald-300 text-xs font-medium flex-shrink-0"
                        title={
                          da
                            ? 'Ejerlejlighed under en hovedejendom'
                            : 'Condominium unit under a main property'
                        }
                      >
                        <Home size={11} />
                        {da ? 'Ejerlejlighed' : 'Condominium'}
                      </span>
                    );
                  return null;
                })()}
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
                {/* BIZZ-498: vis zone-badge for standard zone-værdier.
                    BIZZ-856: "Udfaset" er zone-polygon-historik (ikke
                    ejendommens status) — skjult da det forvirrer brugere. */}
                {dawaAdresse.zone && dawaAdresse.zone !== 'Udfaset' && (
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
                {/* BIZZ-919: Data freshness badge + refresh */}
                <DataFreshnessBadge fromCache={bbrFromCache} syncedAt={bbrSyncedAt} lang={lang} />
                <button
                  onClick={handleBbrRefresh}
                  disabled={bbrRefreshing}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] text-slate-400 hover:text-blue-400 bg-slate-700/30 border border-slate-700/40 hover:border-blue-500/30 transition-colors disabled:opacity-50"
                  aria-label={lang === 'da' ? 'Genindlæs data' : 'Refresh data'}
                  title={lang === 'da' ? 'Genindlæs data' : 'Refresh data'}
                >
                  <RefreshCw size={9} className={bbrRefreshing ? 'animate-spin' : ''} />
                </button>
                {/* BIZZ-948: Oversvømmelsesrisiko-badge */}
                <FloodRiskBadge
                  lat={dawaAdresse?.y ?? null}
                  lng={dawaAdresse?.x ?? null}
                  lang={lang}
                />
              </div>
            </div>

            {/* BIZZ-725 / BIZZ-787: Info banner for udfasede ejendomme.
                Root-cause fix: tidligere brugte vi Plandata zone='Udfaset'
                som signal, men det felt indikerer kun at en zone-POLYGON i
                Plandata er blevet afløst af en nyere polygon — det har
                intet med ejendommens tilstand at gøre. Arnold Nielsens
                Boulevard 62A-62C er et eksempel: alle 6 enheder blev
                fejlagtigt banner-markeret som udfasede fordi deres
                zone-polygon var historisk.

                Korrekt signal er BBR bygning-status: hvis ALLE bygninger
                på ejendommen har status Nedrevet/slettet, Bygning nedrevet
                eller Bygning bortfaldet, er den fysiske ejendom udfaset.
                Minst én aktiv bygning → vis ikke banneret. */}
            {(() => {
              // BIZZ-825: Central isUdfasetStatusLabel erstatter lokal Set.
              const bygninger = bbrData?.bbr;
              const erUdfasetEjendom =
                !!bygninger &&
                bygninger.length > 0 &&
                bygninger.every((b) => isUdfasetStatusLabel(b.status));
              return erUdfasetEjendom;
            })() && (
              <div
                role="status"
                className="mb-4 flex items-start gap-3 px-4 py-3 bg-amber-900/20 border border-amber-700/40 rounded-lg"
              >
                <Building2 size={16} className="text-amber-400 mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-amber-200 text-sm font-medium">
                    {da ? 'Udfaset ejendom' : 'Retired property'}
                  </p>
                  <p className="text-amber-100/70 text-xs mt-1 leading-relaxed">
                    {da
                      ? 'Alle bygninger på denne ejendom er registreret som nedrevet eller bortfaldet i BBR. Matriklen kan være sammenlagt eller ejendommen genopført under et nyt BFE-nummer.'
                      : 'All buildings on this property are registered as demolished or withdrawn in BBR. The matrikel may have been merged or the property rebuilt under a new BFE number.'}
                  </p>
                  {dawaJordstykke && (
                    <button
                      onClick={() => {
                        // BIZZ-763: Navigate to the universal search with
                        // matrikel query params so the search page runs a
                        // dedicated matrikel lookup (all ejerlejligheder on
                        // the jordstykke) instead of a generic text search.
                        const params = new URLSearchParams({
                          type: 'matrikel',
                          ejerlavKode: String(dawaJordstykke.ejerlav.kode ?? ''),
                          matrikelnr: String(dawaJordstykke.matrikelnr ?? ''),
                        });
                        if (dawaJordstykke.ejerlav.navn) {
                          params.set('ejerlavNavn', dawaJordstykke.ejerlav.navn);
                        }
                        router.push(`/dashboard/search?${params.toString()}`);
                      }}
                      className="mt-2 inline-flex items-center gap-1.5 px-3 py-1 bg-amber-500/15 border border-amber-500/30 rounded-md text-amber-300 text-xs font-medium hover:bg-amber-500/25 transition-colors"
                    >
                      <Building2 size={11} />
                      {da
                        ? 'Find andre ejendomme på matriklen'
                        : 'Find other properties on matrikel'}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* BIZZ-832: Søster-enheder — skjules når ejendomsstruktur
                er tilgængelig (redundant info). Fallback for ejendomme
                uden strukturtræ. */}
            {!strukturTree &&
              !!dawaAdresse?.etage &&
              lejligheder &&
              lejligheder.length > 1 &&
              (() => {
                const siblings = lejligheder.filter(
                  (l) =>
                    l.adresse !==
                    `${dawaAdresse?.vejnavn} ${dawaAdresse?.husnr}, ${dawaAdresse?.etage ?? ''}${dawaAdresse?.dør ? `. ${dawaAdresse.dør}` : ''}`
                );
                if (siblings.length === 0) return null;
                return (
                  <div className="rounded-lg border border-slate-700/50 bg-[#0f172a] p-3 space-y-2">
                    <h3 className="text-slate-400 text-xs font-medium uppercase tracking-wide flex items-center gap-1.5">
                      <Building2 size={12} />
                      {da ? 'Søster-enheder' : 'Sibling units'}
                    </h3>
                    <div className="flex flex-wrap gap-1.5">
                      {siblings.slice(0, 20).map((sib) => {
                        const sibHref = sib.dawaId
                          ? `/dashboard/ejendomme/${sib.dawaId}`
                          : `/dashboard/ejendomme/${sib.bfe}`;
                        // BIZZ-996: Vis husnr + etage + dør i stedet for etage + m²
                        const husnr = dawaAdresse?.husnr ?? '';
                        const label = [husnr, sib.etage, sib.doer].filter(Boolean).join(', ');
                        return (
                          <Link
                            key={sib.bfe}
                            href={sibHref}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded bg-slate-800/80 border border-slate-700/40 text-slate-300 text-xs hover:border-blue-500/40 hover:text-white transition-colors"
                          >
                            {label || `BFE ${sib.bfe}`}
                          </Link>
                        );
                      })}
                      {siblings.length > 20 && bbrData?.parentAdgangsadresseId && (
                        <Link
                          href={`/dashboard/ejendomme/${bbrData.parentAdgangsadresseId}`}
                          className="text-blue-400 hover:text-blue-300 text-xs self-center"
                        >
                          +{siblings.length - 20}{' '}
                          {da ? 'mere — gå til hovedejendom' : 'more — go to main property'}
                        </Link>
                      )}
                      {siblings.length > 20 && !bbrData?.parentAdgangsadresseId && (
                        <span className="text-slate-500 text-xs self-center">
                          +{siblings.length - 20} {da ? 'mere' : 'more'}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })()}

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
              <EjendomOverblikTab
                lang={da ? 'da' : 'en'}
                bbrLoader={bbrLoader}
                vurderingLoader={vurderingLoader}
                bbrData={bbrData}
                dawaAdresse={dawaAdresse}
                dawaJordstykke={dawaJordstykke}
                vurdering={vurdering}
                forelobige={forelobige}
                tinglysningData={tinglysningData}
                lejligheder={lejligheder}
                lejlighederLoader={lejlighederLoader}
                cvrVirksomheder={cvrVirksomheder}
                cvrFetchComplete={cvrFetchComplete}
                cvrTokenMangler={cvrTokenMangler}
                cvrApiDown={cvrApiDown}
                visOphoerte={visOphoerte}
                setVisOphoerte={setVisOphoerte}
                kommunekode={
                  dawaJordstykke?.kommune?.kode ? String(dawaJordstykke.kommune.kode) : null
                }
                energimaerker={energimaerker}
                energiLoader={energiLoader}
                onNavigerDokumenter={() => setAktivTab('dokumenter')}
              />
            )}

            {/* ══ BBR ══ — Live data, collapsible rækker */}
            {aktivTab === 'bbr' && (
              <EjendomBBRTab
                lang={da ? 'da' : 'en'}
                bbrLoader={bbrLoader}
                bbrData={bbrData}
                dawaAdresse={dawaAdresse}
                dawaJordstykke={dawaJordstykke}
                vurdering={vurdering}
                expandedBygninger={expandedBygninger}
                setExpandedBygninger={setExpandedBygninger}
                expandedEnheder={expandedEnheder}
                setExpandedEnheder={setExpandedEnheder}
                historikOpen={historikOpen}
                setHistorikOpen={setHistorikOpen}
                historikLoader={historikLoader}
                matrikelLoader={matrikelLoader}
                matrikelData={matrikelData}
                matrikelHistorik={matrikelHistorik}
                kommunekode={
                  dawaJordstykke?.kommune?.kode ? String(dawaJordstykke.kommune.kode) : null
                }
              />
            )}

            {/* Diagram v2 fane fjernet — DiagramV2 vises nu på Ejerskab-fanen */}

            {/* ══ EJERFORHOLD — always mounted for prefetch (BIZZ-410), hidden when not active ══ */}
            <div className={aktivTab === 'ejerforhold' ? '' : 'hidden'}>
              <EjendomEjerforholdTab
                lang={da ? 'da' : 'en'}
                bbrData={bbrData}
                dawaAdresse={dawaAdresse}
                bbrLoader={bbrLoader}
                ejereLoader={ejereLoader}
                lejlighederLoader={lejlighederLoader}
                lejligheder={lejligheder}
                strukturTree={strukturTree}
                strukturLoader={strukturLoader}
                currentBfe={
                  bbrData?.ejerlejlighedBfe ??
                  bbrData?.moderBfe ??
                  bbrData?.ejendomsrelationer?.[0]?.bfeNummer ??
                  undefined
                }
                bbrEnheder={
                  bbrData?.enheder?.map((e) => ({
                    etage: e.etage ?? null,
                    doer: e.doer ?? null,
                    vaerelser: e.vaerelser ?? null,
                  })) ?? []
                }
                chainEjerDetaljer={chainEjerDetaljer}
                chainLoader={chainLoader}
                prefetchedDiagramGraph={prefetchedDiagramGraph}
                diagramResolveLoader={diagramResolveLoader}
              />
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
              <EjendomOekonomiTab
                lang={da ? 'da' : 'en'}
                vurderingLoader={vurderingLoader}
                vurdering={vurdering}
                vurFradrag={vurFradrag}
                vurFordeling={vurFordeling}
                vurGrundvaerdispec={vurGrundvaerdispec}
                alleVurderinger={alleVurderinger}
                forelobige={forelobige}
                visVurderingHistorik={visVurderingHistorik}
                setVisVurderingHistorik={setVisVurderingHistorik}
                salgshistorikLoader={salgshistorikLoader}
                salgshistorikManglerAdgang={salgshistorikManglerAdgang}
                tlSumLoader={tlSumLoader}
                tlTestFallback={tlTestFallback}
                mergedSalgshistorik={mergedSalgshistorik}
                bbrData={bbrData}
                // BIZZ-860: Signal om ejendommen er opdelt — kilde er MAT-data
                // (matrikelData.opdeltIEjerlejligheder) eller fallback via bbrData.
                opdeltIEjerlejligheder={
                  // BIZZ-1147: Ejerlejligheder har egen vurdering — vis IKKE
                  // "fordelt på ejerlejligheder" for dem, kun for moderejendomme.
                  // erModer = ingen etage + har ejerlejlighedBfe (= hovedejendom)
                  (() => {
                    const erModer = !dawaAdresse?.etage && !!bbrData?.ejerlejlighedBfe;
                    return (
                      erModer &&
                      (matrikelData?.opdeltIEjerlejligheder ??
                        bbrData?.opdeltIEjerlejligheder ??
                        false)
                    );
                  })()
                }
                lejlighederCount={lejligheder?.length ?? 0}
                postnr={dawaAdresse?.postnr ?? null}
                kommunekode={
                  dawaJordstykke?.kommune?.kode ? String(dawaJordstykke.kommune.kode) : null
                }
                adresse={
                  dawaAdresse
                    ? `${dawaAdresse.vejnavn} ${dawaAdresse.husnr}, ${dawaAdresse.postnr} ${dawaAdresse.postnrnavn}`
                    : ''
                }
                kommune={dawaJordstykke?.kommune?.navn ?? null}
                boligareal={bbrData?.bbr?.[0]?.samletBoligareal ?? null}
                grundareal={dawaJordstykke?.areal_m2 ?? null}
                opfoerelsesaar={bbrData?.bbr?.[0]?.opfoerelsesaar ?? null}
              />
            )}

            {/* ══ SKAT ══ */}
            {aktivTab === 'skatter' && (
              <EjendomSkatTab
                lang={da ? 'da' : 'en'}
                forelobigLoader={forelobigLoader}
                vurderingLoader={vurderingLoader}
                forelobige={forelobige}
                vurdering={vurdering}
                vurLoft={vurLoft}
                vurFritagelser={vurFritagelser}
                erKolonihave={erKolonihave}
              />
            )}

            {/* ══ DOKUMENTER ══ */}
            {/* ══ DOKUMENTER ══ */}
            {aktivTab === 'dokumenter' && (
              <EjendomDokumenterTab
                lang={da ? 'da' : 'en'}
                plandataLoader={plandataLoader}
                energiLoader={energiLoader}
                jordLoader={jordLoader}
                bbrData={bbrData}
                dawaAdresse={dawaAdresse}
                plandata={plandata}
                plandataFejl={plandataFejl}
                energimaerker={energimaerker}
                energiFejl={energiFejl}
                energiManglerAdgang={energiManglerAdgang}
                jordData={jordData}
                jordIngenData={jordIngenData}
                jordFejl={jordFejl}
                valgteDoc={valgteDoc}
                toggleDoc={toggleDoc}
                handleDownloadZip={handleDownloadZip}
                zipLoader={zipLoader}
                expandedPlaner={expandedPlaner}
                setExpandedPlaner={setExpandedPlaner}
                expandedJord={expandedJord}
                setExpandedJord={setExpandedJord}
              />
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
        {/* BIZZ-808: Opret sag-modal — ejendom pre-populeres som kunde */}
        {opretSagOpen && (
          <CreateCaseModal
            initialEntity={{
              kind: 'ejendom',
              id: String(bbrData?.ejendomsrelationer?.[0]?.bfeNummer ?? id),
              label: adresseStreng,
            }}
            onClose={() => setOpretSagOpen(false)}
          />
        )}
        {/* BIZZ-1179: AI annonce-modal */}
        <GenerateListingModal
          bfe={bbrData?.ejerlejlighedBfe ?? bbrData?.ejendomsrelationer?.[0]?.bfeNummer ?? 0}
          adresse={adresseStreng}
          lang={da ? 'da' : 'en'}
          open={annonceModalOpen}
          onClose={() => setAnnonceModalOpen(false)}
          postnummer={dawaAdresse?.postnr ? Number(dawaAdresse.postnr) : undefined}
          areal={bbrData?.bbr?.[0]?.samletBoligareal ?? undefined}
          lat={dawaAdresse?.y || undefined}
          lon={dawaAdresse?.x || undefined}
        />
      </div>
    );
  }

  // Non-DAWA IDs are no longer supported (mock data removed in BIZZ-657).
  // Show a not-found message and link back to search.
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-6">
      <MapPin size={40} className="text-slate-600 mb-4" />
      <h2 className="text-white text-xl font-semibold mb-2">{t.propertyNotFound}</h2>
      <p className="text-slate-400 text-sm mb-6">{t.propertyNotFoundDesc}</p>
      <Link
        href="/dashboard"
        className="text-blue-400 hover:text-blue-300 flex items-center gap-2 text-sm"
      >
        <ArrowLeft size={16} /> {t.backToProperties}
      </Link>
    </div>
  );
}
