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
  X,
  MapPin,
  Building2,
  FileText,
  Users,
  Landmark,
  BarChart3,
  Map as MapIcon,
} from 'lucide-react';
/** BIZZ-600: PropertyMap wraps mapbox-gl (browser-only) — dynamic() keeps mapbox-gl out of initial bundle */
// prettier-ignore
const PropertyMap = dynamic(/* mapbox-gl */ () => import('@/app/components/ejendomme/PropertyMap'), { ssr: false, loading: () => (<div className="w-full h-64 bg-slate-800/50 rounded-xl animate-pulse flex items-center justify-center"><span className="text-slate-500 text-sm">Indlæser kort...</span></div>) });
import { erDawaId, type DawaAdresse, type DawaJordstykke } from '@/app/lib/dawa';
import { benyttelseskodeTilBoligtype } from '@/app/lib/benyttelseskoder';
import { isAktivStatusLabel } from '@/app/lib/bbrKoder';
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
// FoelgTooltip moved to EjendomHeader (BIZZ-1230)
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
import EjendomOverblikTab from './tabs/EjendomOverblikTab';
import EjendomHeader from './EjendomHeader';
import { buildMergedSalgshistorik } from './helpers/mergedSalgshistorik';
import { handleDownloadZip as executeDownloadZip } from './helpers/downloadZip';
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
  // BIZZ-1284: Kort deferred — starter lukket og åbner efter idle/timeout.
  // Eliminerer Mapbox GL JS (~200KB) + tile-fetch fra critical render path.
  // Desktop: åbner efter 800ms (requestIdleCallback) for at prioritere diagram.
  const [visKort, setVisKort] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 900px)');
    // Defer kort-load så diagram og data renderes først
    const show = () => {
      if (mq.matches) setVisKort(true);
    };
    const idleId =
      typeof requestIdleCallback !== 'undefined'
        ? requestIdleCallback(show, { timeout: 1200 })
        : undefined;
    const fallbackId = idleId == null ? setTimeout(show, 800) : undefined;
    const handler = (e: MediaQueryListEvent) => setVisKort(e.matches);
    mq.addEventListener('change', handler);
    return () => {
      mq.removeEventListener('change', handler);
      if (idleId != null) cancelIdleCallback(idleId);
      if (fallbackId != null) clearTimeout(fallbackId);
    };
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
  const [vurdering, setVurdering] = useState<VurderingData | null>(
    prefetched?.vurderingData?.vurdering ?? null
  );
  /** Alle vurderinger fra Datafordeler — bruges til historiktabel */
  const [alleVurderinger, setAlleVurderinger] = useState<VurderingData[]>(
    prefetched?.vurderingData?.alle ?? []
  );
  /** BIZZ-494: Fradrag for forbedringer (vej/kloak) — vises under Grundværdi i Økonomi-tab */
  const [vurFradrag, setVurFradrag] = useState<VurderingResponse['fradrag']>(
    prefetched?.vurderingData?.fradrag ?? null
  );
  /** BIZZ-493: Ejerboligfordeling — vises som kort i Økonomi-tab for ejerlejlighedskomplekser */
  const [vurFordeling, setVurFordeling] = useState<VurderingResponse['fordeling']>(
    prefetched?.vurderingData?.fordeling ?? []
  );
  /** BIZZ-492: Grundværdispecifikation — nedbrydning af grundværdiberegning */
  const [vurGrundvaerdispec, setVurGrundvaerdispec] = useState<
    VurderingResponse['grundvaerdispec']
  >(prefetched?.vurderingData?.grundvaerdispec ?? []);
  /** BIZZ-491: Skattefritagelser for nyeste vurdering */
  const [vurFritagelser, setVurFritagelser] = useState<VurderingResponse['fritagelser']>(
    prefetched?.vurderingData?.fritagelser ?? []
  );
  /** BIZZ-490: Loftansættelse (grundskatteloft, ESL §45 4,75%-loft) — vises i SKAT-tab */
  const [vurLoft, setVurLoft] = useState<VurderingResponse['loft']>(
    prefetched?.vurderingData?.loft ?? []
  );
  /** True mens vurderingsdata hentes — false når prefetched vurdering er tilgængelig */
  const [vurderingLoader, setVurderingLoader] = useState(
    !!prefetched?.bbrData && !prefetched?.vurderingData
  );
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

    // BIZZ-1304: whitelist — kun bygninger med kendt aktiv status (ekskluderer null/"Ukendt (!)")
    const aktiveBygninger = bbrData?.bbr?.filter((b) => isAktivStatusLabel(b.status));
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
    // BIZZ-1324: whitelist for kortvisning
    () => bbrData?.bygningPunkter?.filter((p) => isAktivStatusLabel(p.status)) ?? undefined,
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
    if (!erDAWA || !bbrData?.ejendomsrelationer?.length) return;
    // BIZZ-1213: Fjernet dawaAdresse-dependency for at køre parallelt med adresse-fetch.
    // Moderejandom-check bruger nu bbrData alene (ejerlejlighedBfe + moderBfe).
    // Ejerlejlighed: brug ejendomsrelationer-BFE. Moderejandom: brug moderBfe.
    const erModer = !bbrData.ejerlejlighedBfe ? false : !!bbrData.moderBfe;
    const bfeNummer = erModer
      ? (bbrData.moderBfe ?? bbrData.ejendomsrelationer[0]?.bfeNummer)
      : bbrData.ejendomsrelationer[0]?.bfeNummer;
    if (!bfeNummer) return;

    const controller = new AbortController();
    const signal = controller.signal;

    setEjereLoader(true);

    // BIZZ-1287: Skip klient-side vurdering-fetch hvis server-side prefetch leverede data
    if (!prefetched?.vurderingData) {
      setVurderingLoader(true);
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
    }

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
    // BIZZ-1213: Fjernet dawaAdresse fra deps — vurdering/ejerskab starter nu
    // med det samme bbrData er tilgængelig (parallelt med adresse-fetch)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, erDAWA, bbrData]);

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
   * Henter de valgte dokumenter og downloader dem som ZIP.
   * BIZZ-1230: Logik ekstraheret til helpers/downloadZip.ts
   */
  const handleDownloadZip = async () => {
    if (valgteDoc.size === 0 || zipLoader) return;
    setZipLoader(true);
    try {
      await executeDownloadZip({
        valgteDoc,
        bbrData,
        plandata,
        energimaerker,
        dawaAdresse,
        t,
      });
    } catch (err) {
      alert(`ZIP-download fejlede: ${err instanceof Error ? err.message : t.unknownError}`);
    } finally {
      setZipLoader(false);
    }
  };

  // ── Kombineret salgshistorik: EJF + Tinglysning adkomster ──
  // BIZZ-1230: Merge-logik ekstraheret til helpers/mergedSalgshistorik.ts
  const mergedSalgshistorik = buildMergedSalgshistorik(salgshistorik, tlEjere);

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
          {/* BIZZ-1230: Header extraheret til EjendomHeader.tsx */}
          <EjendomHeader
            id={id}
            da={da}
            lang={lang}
            adresseStreng={adresseStreng}
            dawaAdresse={dawaAdresse}
            dawaJordstykke={dawaJordstykke}
            bbrData={bbrData}
            vurdering={vurdering}
            matrikelData={matrikelData}
            esrNummer={esrNummer}
            erKolonihave={erKolonihave}
            strukturTree={strukturTree}
            strukturLoader={strukturLoader}
            erFulgt={erFulgt}
            foelgToggling={foelgToggling}
            visFoelgTooltip={visFoelgTooltip}
            setVisFoelgTooltip={setVisFoelgTooltip}
            onToggleFoelg={async () => {
              if (foelgToggling) return;
              setVisFoelgTooltip(false);
              const optimisticState = !erFulgt;
              setErFulgt(optimisticState);
              setFoelgToggling(true);
              try {
                const postnr = dawaAdresse?.postnr ?? '';
                const by = dawaAdresse?.postnrnavn ?? '';
                const kommune = dawaAdresse?.kommunenavn ?? dawaJordstykke?.kommune.navn ?? '';
                const anvendelse = bbrData?.bbr?.[0]?.anvendelse ?? null;
                const nyTilstand = await toggleTrackEjendom({
                  id,
                  adresse: adresseStreng,
                  postnr,
                  by,
                  kommune,
                  anvendelse,
                });
                setErFulgt(nyTilstand);
                window.dispatchEvent(new Event('ba-tracked-changed'));
              } catch {
                setErFulgt(!optimisticState);
              } finally {
                setFoelgToggling(false);
              }
            }}
            visKort={visKort}
            kortPanelAaben={kortPanelÅben}
            onToggleKortPanel={() => setKortPanelÅben((prev) => !prev)}
            onOpenMobilKort={() => setMobilKortAaben(true)}
            domainMemberships={domainMemberships}
            onOpretSag={() => setOpretSagOpen(true)}
            bbrFromCache={bbrFromCache}
            bbrSyncedAt={bbrSyncedAt}
            bbrRefreshing={bbrRefreshing}
            onBbrRefresh={handleBbrRefresh}
            aktivTab={aktivTab}
            setAktivTab={setAktivTab}
            tabs={tabs}
            lejligheder={lejligheder}
            t={t}
          />

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
                currentDawaId={erDAWA ? id : undefined}
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
          boligtype={benyttelseskodeTilBoligtype(vurdering?.benyttelseskode) ?? undefined}
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
