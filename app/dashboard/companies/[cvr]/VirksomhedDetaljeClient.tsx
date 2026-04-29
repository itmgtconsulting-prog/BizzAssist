'use client';

'use no memo'; // Opt-out af React Compiler — filen har render-body mutations der konflikter

/**
 * Virksomhedsdetaljeside — viser fuld information om en dansk virksomhed.
 *
 * Henter data fra Erhvervsstyrelsens CVR via /api/cvr-public.
 * Viser virksomhedsinfo fordelt på 10 tabs: Overblik, Diagram, Ejendomme,
 * Virksomheder, Regnskab (inkl. årsrapporter), Nøglepersoner,
 * Historik og Tinglysning (inkl. tinglyste dokumenter).
 *
 * @param params.cvr - 8-cifret CVR-nummer fra URL
 */

import { useState, useEffect, use, useCallback, useRef, useMemo, Fragment } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  Building2,
  Briefcase,
  Users,
  CreditCard,
  MapPin,
  Loader2,
  AlertTriangle,
  CheckCircle,
  XCircle,
  ExternalLink,
  Bell,
  LayoutDashboard,
  FileText,
  ArrowRightLeft,
  Home,
  Clock,
  Scale,
  Download,
  ChevronDown,
  ChevronRight,
  Plus,
  X,
  Newspaper,
  Globe,
  Sparkles,
  Lock,
  Zap,
  RefreshCw,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { useSetAIPageContext } from '@/app/context/AIPageContext';
import { translations } from '@/app/lib/translations';
import type { CVRPublicData } from '@/app/api/cvr-public/route';
import type { Regnskab } from '@/app/api/regnskab/route';
import type { RegnskabsAar } from '@/app/api/regnskab/xbrl/route';
import type { RelateretVirksomhed } from '@/app/api/cvr-public/related/route';
import type { CvrHandelData } from '@/app/api/salgshistorik/cvr/route';
import type { EjendomSummary } from '@/app/api/ejendomme-by-owner/route';
import CreateCaseModal from '@/app/components/sager/CreateCaseModal';
import { useDomainMemberships } from '@/app/hooks/useDomainMemberships';
import type { PersonbogHaeftelse, PersonbogDokument } from '@/app/api/tinglysning/personbog/route';
import type { VirksomhedEjendomsrolle } from '@/app/api/tinglysning/virksomhed/route';
import type { BilbogBil } from '@/app/api/tinglysning/bilbog/route';
import type { AndelsbogBolig } from '@/app/api/tinglysning/andelsbog/route';
import PaategningTimeline from '@/app/components/tinglysning/PaategningTimeline';
import { saveRecentCompany } from '@/app/lib/recentCompanies';
import { recordRecentVisit } from '@/app/lib/recordRecentVisit';
import { useSubscription } from '@/app/context/SubscriptionContext';
import { useSubscriptionAccess } from '@/app/components/SubscriptionGate';
import { resolvePlan, formatTokens, isSubscriptionFunctional } from '@/app/lib/subscriptions';
import { buildDiagramGraph } from '@/app/components/diagrams/DiagramData';
import type { DiagramPropertySummary } from '@/app/components/diagrams/DiagramData';
import { isDiagram2Enabled } from '@/app/lib/featureFlags';
import dynamic from 'next/dynamic';
import VerifiedLinks from '@/app/components/VerifiedLinks';
import TabLoadingSpinner from '@/app/components/TabLoadingSpinner';
import DataFreshnessBadge from '@/app/components/DataFreshnessBadge';
import VirksomhedOverblikTab from './tabs/VirksomhedOverblikTab';
import VirksomhedEjendommeTab from './tabs/VirksomhedEjendommeTab';
import VirksomhedGruppeTab from './tabs/VirksomhedGruppeTab';
import VirksomhedRegnskabTab from './tabs/VirksomhedRegnskabTab';
import VirksomhedNoeglepersonerTab from './tabs/VirksomhedNoeglepersonerTab';
import VirksomhedHistorikTab from './tabs/VirksomhedHistorikTab';
/** BIZZ-600: DiagramForce uses d3-force — dynamic() keeps d3-force out of initial bundle */
// prettier-ignore
const DiagramForce = dynamic(/* d3-force */ () => import('@/app/components/diagrams/DiagramForce'), { ssr: false, loading: () => <div className="w-full h-96 bg-slate-800/50 rounded-xl animate-pulse" /> });
/** Diagram v2 — feature-flagged, kun synlig i dev/preview */
const DiagramV2 = dynamic(() => import('@/app/components/diagrams/DiagramV2'), { ssr: false });

// ─── Tracked Companies (localStorage) ────────────────────────────────────────

const TRACKED_COMPANIES_KEY = 'ba-tracked-companies';

/** En fulgt virksomhed i localStorage */
interface TrackedCompany {
  /** CVR-nummer */
  cvr: string;
  /** Virksomhedsnavn */
  navn: string;
  /** Unix timestamp (ms) */
  trackedSiden: number;
}

/**
 * Henter alle fulgte virksomheder fra localStorage.
 *
 * @returns Liste af fulgte virksomheder
 */
function hentTrackedCompanies(): TrackedCompany[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(TRACKED_COMPANIES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as TrackedCompany[];
  } catch {
    return [];
  }
}

/**
 * Tjekker om en virksomhed er fulgt.
 *
 * @param cvr - CVR-nummer
 * @returns true hvis virksomheden følges
 */
function erTrackedCompany(cvr: string): boolean {
  return hentTrackedCompanies().some((c) => c.cvr === cvr);
}

/**
 * Toggler tracking af en virksomhed — returnerer ny tilstand.
 *
 * @param cvr - CVR-nummer
 * @param navn - Virksomhedsnavn
 * @returns true hvis virksomheden nu følges, false hvis unfølget
 */
function toggleTrackCompany(cvr: string, navn: string): boolean {
  if (typeof window === 'undefined') return false;
  const liste = hentTrackedCompanies();
  const alleredeFulgt = liste.some((c) => c.cvr === cvr);
  try {
    if (alleredeFulgt) {
      const opdateret = liste.filter((c) => c.cvr !== cvr);
      window.localStorage.setItem(TRACKED_COMPANIES_KEY, JSON.stringify(opdateret));
      return false;
    } else {
      const opdateret: TrackedCompany[] = [{ cvr, navn, trackedSiden: Date.now() }, ...liste].slice(
        0,
        50
      );
      window.localStorage.setItem(TRACKED_COMPANIES_KEY, JSON.stringify(opdateret));
      return true;
    }
  } catch {
    return alleredeFulgt;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Formaterer ISO-dato til kort dansk format (d. mmm yyyy).
 *
 * @param iso - ISO-dato streng
 */
function formatDatoKort(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('da-DK', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ─── Tab Definitions ─────────────────────────────────────────────────────────

/** Tab-identifikatorer for virksomhedsdetaljesiden */
type TabId =
  | 'overview'
  | 'diagram'
  | 'diagram2'
  | 'tradeHistory'
  | 'properties'
  | 'companies'
  | 'financials'
  | 'keyPersons'
  | 'history'
  | 'liens';

/** Tab-ikoner */
const tabIcons: Record<TabId, React.ReactNode> = {
  overview: <LayoutDashboard size={12} />,
  diagram: <Briefcase size={12} />,
  diagram2: <Sparkles size={12} />,
  tradeHistory: <ArrowRightLeft size={12} />,
  properties: <Home size={12} />,
  companies: <Building2 size={12} />,
  financials: <CreditCard size={12} />,
  keyPersons: <Users size={12} />,
  history: <Clock size={12} />,
  liens: <Scale size={12} />,
};

/** Basis-rækkefølge af tabs (diagram2 tilføjes runtime via isDiagram2Enabled) */
const baseTabOrder: TabId[] = [
  'overview',
  'diagram',
  'properties',
  'companies',
  'financials',
  'keyPersons',
  'history',
  'liens',
];

/** Historik-type ikoner og farver */
// ─── Types ────────────────────────────────────────────────────────────────────

interface PageProps {
  params: Promise<{ cvr: string }>;
}

// ─── Component ────────────────────────────────────────────────────────────────

// ─── OwnerChainNode + extractOwners (brugt af diagram + Gruppe-tab) ──────────

/** En ejer-node i ejerskabskæden */
interface OwnerChainNode {
  /** Navn */
  navn: string;
  /** Enhedsnummer fra CVR ES */
  enhedsNummer: number | null;
  /** CVR-nummer (8 cifre) — resolved via API for virksomheder */
  cvr: number | null;
  /** Om det er en virksomhed */
  erVirksomhed: boolean;
  /** Ejerandel */
  ejerandel: string | null;
  /** Whether this company is ceased/ophørt (BIZZ-357) */
  isCeased?: boolean;
  /** Ejere af denne node (rekursivt) */
  parents: OwnerChainNode[];
}

/**
 * Udtrækker aktive ejere fra en virksomheds deltagere-array.
 *
 * @param deltagere - Deltagere-array fra CVRPublicData
 * @returns Ejere med navn, enhedsNummer, erVirksomhed, ejerandel
 */
/**
 * BIZZ-564: Identificér LEGALE ejere — IKKE Reelle Ejere (RBE).
 *
 * "Reel ejer" (Real Beneficial Owner / RBE) er en KAP-anmeldelse-konstruktion
 * fra hvidvasklovgivningen og repræsenterer NOT direkte juridisk ejerskab.
 * Diagram + ejerandels-summering må KUN inkludere legalt ejerskab (EJERREGISTER,
 * LEGALE_EJERE, INTERESSENT, FULDT_ANSVARLIG) — ellers fås duplikater og
 * ejerandel summer over 100% (en person kan både være legal ejer OG reel ejer
 * af samme virksomhed → tælles 2x).
 */
function erLegalEjerRolle(rolle: string): boolean {
  const role = rolle.toUpperCase();
  // Eksklusiv check: "REEL EJER" matcher .includes('EJER') så vi MÅ filtrere
  // den fra eksplicit. Ditto "REELLE_EJERE" (variant brugt i CVR ES).
  if (role.includes('REEL')) return false;
  return (
    role.includes('EJER') ||
    role.includes('LEGALE') ||
    role.includes('INTERESSENT') ||
    // CVR ES bruger mellemrum: "Fuldt ansvarlig deltager" — matcher begge former
    (role.includes('FULDT') && role.includes('ANSVARLIG'))
  );
}

function extractOwners(deltagere: CVRPublicData['deltagere']): {
  navn: string;
  enhedsNummer: number | null;
  erVirksomhed: boolean;
  ejerandel: string | null;
}[] {
  return (deltagere ?? [])
    .filter((d) => d.roller.some((r) => erLegalEjerRolle(r.rolle) && !r.til))
    .map((d) => {
      const ejerRolle = d.roller.find((r) => erLegalEjerRolle(r.rolle) && !r.til);
      return {
        navn: d.navn,
        enhedsNummer: d.enhedsNummer,
        erVirksomhed: d.erVirksomhed,
        ejerandel: ejerRolle?.ejerandel ?? null,
      };
    });
}

/**
 * VirksomhedDetalje — Hovedkomponent for virksomhedsdetaljesiden.
 *
 * Fetcher virksomhedsdata fra /api/cvr-public ved mount og viser
 * loading/error/data states med sticky header og tab-navigation.
 *
 * @param props.params - Route params med CVR-nummer
 */
export default function VirksomhedDetaljeClient({ params }: PageProps) {
  const { cvr } = use(params);
  const router = useRouter();
  const { lang } = useLanguage();
  const t = translations[lang];
  const c = t.company;
  /** Sæt AI-kontekst med CVR-nummer og virksomhedsnavn så AI'en kan bruge dem direkte */
  const setAICtx = useSetAIPageContext();

  /** Tab-labels hentet fra centraliseret oversættelsessystem */
  const tabLabelMap: Record<TabId, string> = {
    overview: c.tabs.overview,
    diagram: lang === 'da' ? 'Diagram' : 'Diagram',
    diagram2: 'Diagram v2',
    tradeHistory: c.tabs.tradeHistory,
    properties: c.tabs.properties,
    companies: c.tabs.companies,
    financials: c.tabs.financials,
    keyPersons: c.tabs.keyPersons,
    history: c.tabs.history,
    liens: c.tabs.liens,
  };

  const [data, setData] = useState<CVRPublicData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** BIZZ-919: Cache-metadata fra primær API-response */
  const [cacheFromCache, setCacheFromCache] = useState(false);
  const [cacheSyncedAt, setCacheSyncedAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** BIZZ-919: Incrementing key triggers data re-fetch */
  const [refreshKey, setRefreshKey] = useState(0);
  const [aktivTab, setAktivTab] = useState<TabId>('overview');
  /** Tab-rækkefølge — diagram2 injiceres runtime bag feature flag */
  const tabOrder = useMemo<TabId[]>(() => {
    if (!isDiagram2Enabled()) return baseTabOrder;
    const idx = baseTabOrder.indexOf('diagram');
    const order = [...baseTabOrder];
    order.splice(idx + 1, 0, 'diagram2');
    return order;
  }, []);
  const [erFulgt, setErFulgt] = useState(false);
  // BIZZ-808: Opret sag-modal state
  const [opretSagOpen, setOpretSagOpen] = useState(false);
  const { memberships: domainMemberships } = useDomainMemberships();

  /**
   * JS-baseret breakpoint detektion (≥900px).
   * Viser nyheder-sidepanel på desktop, overlay på mobil.
   */
  const [isDesktop, setIsDesktop] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 900px)');
    setIsDesktop(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  /** Styrer om nyheder/sociale medier-panelet er synligt på desktop. */
  const [nyhedsPanelÅben, setNyhedsPanelÅben] = useState(true);

  /** Styrer om mobil nyheder-overlay er åbent. */
  const [mobilNyhederAaben, setMobilNyhederAaben] = useState(false);

  /** AI-fundne sociale medier-URLs med confidence — udfyldes efter artikel-søgning */
  const [aiSocials, setAiSocials] = useState<
    Record<string, { url: string; confidence: number; reason?: string }>
  >({});

  /** AI-fundne alternative links per platform med confidence — udfyldes efter artikel-søgning */
  const [aiAlternatives, setAiAlternatives] = useState<
    Record<string, Array<{ url: string; confidence: number; reason?: string }>>
  >({});

  /** Confidence-tærskel fra ai_settings — default 70 */
  const [confidenceThreshold, setConfidenceThreshold] = useState(70);

  /** Regnskab state — lazy-loaded when financials tab is activated */
  const [regnskaber, setRegnskaber] = useState<Regnskab[] | null>(null);
  const [regnskabLoading, setRegnskabLoading] = useState(false);
  const [_regnskabError, setRegnskabError] = useState<string | null>(null);
  const regnskabFetchedRef = useRef(false);

  /** XBRL regnskabstal — progressivt loaded i batches */
  const [xbrlData, setXbrlData] = useState<RegnskabsAar[] | null>(null);
  const [xbrlLoading, setXbrlLoading] = useState(false);
  const [xbrlLoadingMore, setXbrlLoadingMore] = useState(false);
  const xbrlFetchedRef = useRef(false);
  const xbrlAbortRef = useRef<AbortController | null>(null);

  /** Relaterede virksomheder (gruppe) — lazy-loaded when companies tab is activated */
  const [relatedCompanies, setRelatedCompanies] = useState<RelateretVirksomhed[]>([]);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const relatedFetchedRef = useRef(false);
  const relatedAbortRef = useRef<AbortController | null>(null);

  /** Ejerkæde opad (fra RelationsDiagram) — deles mellem diagram og Gruppe-tab */
  const [ownerChainShared, setOwnerChainShared] = useState<OwnerChainNode[]>([]);
  const ownerChainFetchedTopRef = useRef(false);

  /** Hovedvirksomhedens enhedsNummer fra CVR ES — bruges til dedup i diagram */
  const [_parentEnhedsNummer, setParentEnhedsNummer] = useState<number | null>(null);

  /** Detaljerede modervirksomheds-data — lazy-loaded for Gruppe-tab visning */
  const [parentCompanyDetails, setParentCompanyDetails] = useState<
    Map<number, RelateretVirksomhed>
  >(new Map());
  const parentDetailsFetchedRef = useRef(false);

  /** Om modervirksomheds-sektionen er udfoldet (default: collapsed) */
  const [parentSectionOpen, setParentSectionOpen] = useState(false);
  /** BIZZ-475: Vis historiske datterselskaber (ophørte/solgte). Default off. */
  const [visHistorik, setVisHistorik] = useState(false);

  /** Om datterselskabs-sektionen er udfoldet (default: open) */
  const [childSectionOpen, setChildSectionOpen] = useState(true);

  // ── Eagerly resolve owner chain so all diagram tabs can use it ──
  useEffect(() => {
    if (!data || ownerChainFetchedTopRef.current) return;
    ownerChainFetchedTopRef.current = true;

    const directOwners = extractOwners(data.deltagere);
    const companyOwners = directOwners.filter((o) => o.erVirksomhed && o.enhedsNummer);
    if (companyOwners.length === 0) {
      setOwnerChainShared(directOwners.map((o) => ({ ...o, cvr: null, parents: [] })));
      return;
    }

    // BIZZ-253: Pre-seed cache with the current company's data to avoid re-fetching
    // BIZZ-357: Also cache enddate so ceased status propagates into the owner chain
    const fetchedCache = new Map<
      number,
      { deltagere: CVRPublicData['deltagere']; cvr: number; enddate: string | null }
    >();
    if (data.vat) {
      fetchedCache.set(data.vat, {
        deltagere: data.deltagere ?? [],
        cvr: data.vat,
        enddate: data.enddate ?? null,
      });
    }

    async function resolveChainTop(
      ownerList: ReturnType<typeof extractOwners>,
      depth: number,
      maxDepth: number
    ): Promise<OwnerChainNode[]> {
      const resolved = await Promise.all(
        ownerList.map(async (o): Promise<OwnerChainNode | null> => {
          if (!o.erVirksomhed || !o.enhedsNummer || depth >= maxDepth) {
            return { ...o, cvr: null, parents: [] };
          }
          try {
            let cached = fetchedCache.get(o.enhedsNummer);
            if (!cached) {
              const res = await fetch(`/api/cvr-public?enhedsNummer=${o.enhedsNummer}`);
              if (res.ok) {
                const json = await res.json();
                if (!json.error && json.vat) {
                  // BIZZ-357: Store enddate alongside deltagere so ceased status is known
                  cached = {
                    deltagere: json.deltagere ?? [],
                    cvr: json.vat,
                    enddate: json.enddate ?? null,
                  };
                  fetchedCache.set(o.enhedsNummer, cached);
                }
              }
            }
            if (!cached) return { ...o, cvr: null, parents: [] };

            // BIZZ-471: Ophørte virksomheder kan ikke være reelle nuværende
            // ejere — drop dem fra ejerstrukturen helt. CVR registeret kan
            // stadig liste en ceased entity som deltager fordi role.til
            // ikke altid bliver sat, men selskabet eksisterer ikke længere.
            // Matches /api/ejerskab/chain's filter-logik for konsistens.
            if (cached.enddate != null) {
              return null;
            }

            const parentOwners = extractOwners(cached.deltagere);
            const resolvedParents = await resolveChainTop(parentOwners, depth + 1, maxDepth);
            return {
              ...o,
              cvr: cached.cvr,
              parents: resolvedParents,
            };
          } catch {
            return { ...o, cvr: null, parents: [] };
          }
        })
      );
      return resolved.filter((n): n is OwnerChainNode => n !== null);
    }

    resolveChainTop(directOwners, 0, 4).then(setOwnerChainShared);
  }, [data]);

  /** Gruppe-tab: regnskabsdata per CVR — lazy-loaded */
  const [gruppeFinans, setGruppeFinans] = useState<
    Map<number, { brutto: number | null; balance: number | null; egenkapital: number | null }>
  >(new Map());
  const [gruppeFinansLoading, setGruppeFinansLoading] = useState(false);
  const gruppeFinansFetchedRef = useRef(false);

  /** Ejendomshandler — lazy-loaded */
  const [ejendomshandler, setEjendomshandler] = useState<CvrHandelData[]>([]);
  const [handlerLoading, setHandlerLoading] = useState(false);
  const [handlerManglerAdgang, setHandlerManglerAdgang] = useState(false);
  const handlerFetchedRef = useRef(false);

  /** Ejendomme portefølje — progressivt lazy-loaded when properties tab is activated */
  const [ejendommeData, setEjendommeData] = useState<EjendomSummary[]>([]);
  const [ejendommeLoading, setEjendommeLoading] = useState(false);
  const [ejendommeLoadingMore, setEjendommeLoadingMore] = useState(false);
  const [ejendommeFetchComplete, setEjendommeFetchComplete] = useState(false);

  /**
   * BIZZ-569: Pre-enriched data per BFE fra batch-endpoint.
   * Map<bfeNummer, EnrichedRow>. Bruges af PropertyOwnerCard via preEnriched-prop
   * for at undgå N parallelle per-card-fetches (hver med Vercel cold-start).
   */
  const [preEnrichedByBfe, setPreEnrichedByBfe] = useState<
    Map<
      number,
      {
        areal: number | null;
        vurdering: number | null;
        vurderingsaar: number | null;
        erGrundvaerdi?: boolean;
        ejerNavn: string | null;
        koebesum: number | null;
        koebsdato: string | null;
        boligAreal: number | null;
        erhvervsAreal: number | null;
        matrikelAreal: number | null;
      }
    >
  >(new Map());
  const [ejendommeManglerNoegle, setEjendommeManglerNoegle] = useState(false);
  const [ejendommeManglerAdgang, setEjendommeManglerAdgang] = useState(false);
  const [ejendommeTotalBfe, setEjendommeTotalBfe] = useState(0);
  /** BIZZ-455: Toggle for visning af tidligere ejede (solgte) ejendomme */
  const [visSolgte, setVisSolgte] = useState(false);
  /** BIZZ-diagram: Memoized diagram graph — only rebuilds when ejendomme fully loaded,
   * preventing "jumping" as properties stream in progressively. Shows active only. */
  const diagramGraphStable = useMemo(() => {
    if (!data) return { nodes: [], edges: [], mainId: '' };
    // BIZZ-926: Vent med diagram-build til ejendomme-fetch er komplet.
    // Uden denne guard bygges grafen med ufuldstændige data ved første
    // render → DiagramForce cancelerer igangværende D3-simulation →
    // positions forbliver tom → blank canvas (identisk med BIZZ-925).
    if (!ejendommeFetchComplete) return { nodes: [], edges: [], mainId: '' };
    const aktiveEjendomme = ejendommeData.filter((p) => p.aktiv !== false);
    const propertiesByCvr =
      aktiveEjendomme.length > 0
        ? aktiveEjendomme.reduce((map, p) => {
            const cvrNum = parseInt(p.ownerCvr, 10);
            if (!map.has(cvrNum)) map.set(cvrNum, []);
            map.get(cvrNum)!.push(p as DiagramPropertySummary);
            return map;
          }, new Map<number, DiagramPropertySummary[]>())
        : undefined;
    return buildDiagramGraph(
      data.name,
      data.vat,
      data.companydesc ?? null,
      ownerChainShared,
      relatedCompanies,
      data.industrydesc ?? null,
      propertiesByCvr
    );
    // Only rebuild when ejendomme loading finishes (ejendommeFetchComplete flips true)
    // OR when ownership/company data changes. Deliberately EXCLUDE ejendommeData so
    // progressive batches don't trigger re-simulation mid-load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    data?.name,
    data?.vat,
    data?.companydesc,
    data?.industrydesc,
    ownerChainShared,
    relatedCompanies,
    ejendommeFetchComplete,
  ]);
  /** Kommasepereret CVR-nøgle der sidst blev hentet — forhindrer duplicate-fetches */
  const ejendomFetchKeyRef = useRef('');
  /** AbortController for igangværende progressiv ejendomshentning */
  const ejendomAbortRef = useRef<AbortController | null>(null);

  /** Personbog (tinglysning) — lazy-loaded when liens tab is activated */
  const [personbogData, setPersonbogData] = useState<PersonbogHaeftelse[]>([]);
  /** BIZZ-533: Tinglyste dokumenter (vedtægter, fusioner, ejerpantebreve) fra Personbog */
  const [personbogDokumenter, setPersonbogDokumenter] = useState<{
    vedtaegter: PersonbogDokument[];
    fusioner: PersonbogDokument[];
    ejerpantebreve: PersonbogDokument[];
  }>({ vedtaegter: [], fusioner: [], ejerpantebreve: [] });
  const [personbogLoading, setPersonbogLoading] = useState(false);
  const [personbogFejl, setPersonbogFejl] = useState<string | null>(null);
  const [expandedPant, setExpandedPant] = useState<Set<number>>(new Set());
  const [selectedPantDocs, setSelectedPantDocs] = useState<Set<string>>(new Set());
  const personbogFetchedRef = useRef(false);

  /** Tinglysning-tab: om Personbogen-rækken er udfoldet */
  const [personbogRowOpen, setPersonbogRowOpen] = useState(false);

  /**
   * BIZZ-521 — Fast ejendom data fra e-TL soegvirksomhed (bog=1).
   * Separate arrays for ejer- og kreditor-rolle. Lazy-loaded samtidig med
   * Personbogen når Tinglysning-tab'en aktiveres.
   */
  // Kun kreditor-rækken bruges i UI'en (ejer-listen dubletterer Ejendomme-tab).
  const [fastEjendomKreditor, setFastEjendomKreditor] = useState<VirksomhedEjendomsrolle[]>([]);
  const [fastEjendomLoading, setFastEjendomLoading] = useState(false);
  const [fastEjendomFejl, setFastEjendomFejl] = useState<string | null>(null);
  const fastEjendomFetchedRef = useRef(false);
  /** Hvilke af Fast ejendom-underrækkerne der er udfoldet (pt. kun kreditor) */
  const [fastEjendomOpen, setFastEjendomOpen] = useState<Set<'ejer' | 'kreditor'>>(new Set());

  /**
   * BIZZ-529 — Bilbog data fra e-TL soegbil + bil/uuid.
   * Lazy-loadet sammen med personbog når Tinglysning-tab'en aktiveres.
   */
  const [bilbogData, setBilbogData] = useState<BilbogBil[]>([]);
  const [bilbogLoading, setBilbogLoading] = useState(false);
  const [bilbogFejl, setBilbogFejl] = useState<string | null>(null);
  const [bilbogOpen, setBilbogOpen] = useState(false);
  const bilbogFetchedRef = useRef(false);

  /**
   * BIZZ-530 — Andelsbog data fra e-TL andelsbolig/virksomhed + andelsbolig/{uuid}.
   * Lazy-loadet sammen med personbog når Tinglysning-tab'en aktiveres.
   */
  const [andelsbogData, setAndelsbogData] = useState<AndelsbogBolig[]>([]);
  const [andelsbogLoading, setAndelsbogLoading] = useState(false);
  const [andelsbogFejl, setAndelsbogFejl] = useState<string | null>(null);
  const [andelsbogOpen, setAndelsbogOpen] = useState(false);
  const andelsbogFetchedRef = useRef(false);

  // Auto-åbn Personbogen-rækken når data loader ind og der er hæftelser

  useEffect(() => {
    if (!personbogLoading && personbogData.length > 0) {
      setPersonbogRowOpen(true);
    }
  }, [personbogLoading, personbogData.length]);

  /** Valgte dokumenter til batch-download (regnskab-tab) */
  const [valgteDoc, setValgteDoc] = useState<Set<string>>(new Set());
  /** Vis alle regnskaber på regnskab-tab (default: kun 3) */
  const [visAlleRegnskaber, setVisAlleRegnskaber] = useState(false);

  /** Personer-tab: hvilke historiske rollegrupper der er udfoldet */
  const [expandedHistPersoner, setExpandedHistPersoner] = useState<Set<string>>(new Set());

  /** Personer-tab: hvilke kategorier der viser ALLE historiske (default: kun de første 5) */
  const [visAlleHistPersoner, setVisAlleHistPersoner] = useState<Set<string>>(new Set());

  /** Historik-tab: aktivt filter (null = vis alle) */
  const [historikFilter, setHistorikFilter] = useState<string | null>(null);

  /** Personer-tab: aktivt kategori-filter (null = vis alle) */
  const [personerFilter, setPersonerFilter] = useState<string | null>(null);

  /** Oversigt-tab: aktivt filter — null = vis alle, ellers kun valgt sektion */
  const [oversigtFilter, setOversigtFilter] = useState<string | null>(null);

  // BIZZ-441: ejendommeFilter removed — handler section hidden

  /** Toggler et dokument-ID i valgteDoc-sættet */
  const toggleDoc = useCallback((id: string) => {
    setValgteDoc((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Ref til scrollbart indholdsområde — bruges til at scrolle til top ved tab-skift */
  const contentRef = useRef<HTMLDivElement>(null);

  /** Scroll til top når tab skiftes — forhindrer page-jump */
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
  }, [aktivTab]);

  /** Synkroniserer følg-status fra localStorage ved mount */
  useEffect(() => {
    setErFulgt(erTrackedCompany(cvr));
  }, [cvr]);

  /** Henter virksomhedsdata fra /api/cvr-public ved mount. Prøver CVR først, fallback til enhedsNummer. */
  useEffect(() => {
    let cancelled = false;

    async function fetchData() {
      setLoading(true);
      setError(null);

      try {
        let res = await fetch(`/api/cvr-public?vat=${encodeURIComponent(cvr)}`);
        let json = await res.json();

        // Fallback: URL-param kan være et enhedsNummer (f.eks. fra ejer-links) — prøv opslag via enhedsNummer
        if ((!res.ok || json.error) && /^\d+$/.test(cvr)) {
          const res2 = await fetch(`/api/cvr-public?enhedsNummer=${encodeURIComponent(cvr)}`);
          const json2 = await res2.json();
          if (res2.ok && !json2.error) {
            // Redirect til korrekt CVR-URL så URL'en altid er kanonisk
            const realCvr = (json2 as CVRPublicData).vat;
            if (!cancelled && realCvr && String(realCvr) !== cvr) {
              router.replace(`/dashboard/companies/${realCvr}`);
              return;
            }
            res = res2;
            json = json2;
          }
        }

        if (cancelled) return;

        if (!res.ok || json.error) {
          setError(json.error ?? c.notFound);
          return;
        }

        const company = json as CVRPublicData;
        setData(company);

        // BIZZ-919: Læs cache-metadata fra API-response headers
        const cacheHit = res.headers?.get?.('X-Cache-Hit');
        const synced = res.headers?.get?.('X-Synced-At');
        setCacheFromCache(cacheHit === 'true');
        setCacheSyncedAt(synced ?? null);

        // Gem i seneste besøgte — kun ved faktisk åbning af detaljesiden
        saveRecentCompany({
          cvr: company.vat,
          name: company.name,
          industry: company.industrydesc,
          address: company.address,
          zipcode: company.zipcode,
          city: company.city,
          active: !company.enddate,
          companyType: company.companydesc ?? null,
        });
        // Opdater recent tag-bar (virker også ved direkte URL-navigation)
        recordRecentVisit(
          'company',
          String(company.vat),
          company.name,
          `/dashboard/companies/${company.vat}`
        );
      } catch {
        if (!cancelled) {
          setError(c.networkError);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchData();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cvr, lang, refreshKey]);

  /** BIZZ-919: Force-refresh — inkrementer refreshKey for at gen-trigge useEffect */
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    setRefreshKey((k) => k + 1);
  }, []);

  /** BIZZ-919: Nulstil refreshing-spinner når loading afsluttes */
  useEffect(() => {
    if (!loading && refreshing) setRefreshing(false);
  }, [loading, refreshing]);

  /**
   * Sæt AI-kontekst når virksomhedsdata er loadet.
   * AI-assistenten kan dermed bruge CVR-nummeret direkte i tool-kald.
   */
  useEffect(() => {
    if (!data) return;
    // BIZZ-941: Send pre-loaded ejendomme så AI ikke re-fetcher dem.
    const preloadedEjendomme = ejendommeFetchComplete
      ? ejendommeData
          .filter((e) => e.aktiv !== false)
          .slice(0, 50)
          .map((e) => ({
            bfe: e.bfeNummer,
            adresse: e.adresse ?? null,
            type: e.ejendomstype ?? null,
            ejerandel: e.ejerandel ?? null,
          }))
      : undefined;

    // BIZZ-941: Inkluder datterselskaber i AI-kontekst
    const preloadedDatter =
      relatedCompanies.length > 0
        ? relatedCompanies.slice(0, 30).map((v) => ({
            cvr: v.cvr,
            navn: v.navn,
            aktiv: v.aktiv,
            branche: v.branche ?? null,
          }))
        : undefined;

    // BIZZ-1002: Kontaktinfo
    const virksomhedKontakt = {
      telefon: data.phone ?? null,
      email: data.email ?? null,
      adresse: data.address ?? null,
      postnr: data.zipcode ?? null,
      by: data.city ?? null,
    };

    // BIZZ-1002: Nøglepersoner — ejere, bestyrelse, direktion (max 20)
    // Aktive roller har til=null (ingen slutdato)
    const virksomhedNoeglePersoner = data.deltagere
      ?.filter((d) => d.roller.some((r) => !r.til))
      .slice(0, 20)
      .map((d) => ({
        navn: d.navn,
        roller: d.roller.filter((r) => !r.til).map((r) => r.rolle),
        ejerandel: d.roller.find((r) => r.ejerandel)?.ejerandel ?? null,
        aktiv: true,
      }));

    // BIZZ-1002: Seneste regnskabstal (kun hvis loaded)
    const seneste = xbrlData?.[0];
    const virksomhedRegnskab = seneste
      ? {
          aar: seneste.aar,
          omsaetning: seneste.resultat?.omsaetning ?? null,
          bruttofortjeneste: seneste.resultat?.bruttofortjeneste ?? null,
          resultat: seneste.resultat?.aaretsResultat ?? null,
          egenkapital: seneste.balance?.egenkapital ?? null,
          balancesum: seneste.balance?.aktiverIAlt ?? null,
          ansatte: null as number | null,
        }
      : undefined;

    setAICtx({
      cvrNummer: String(data.vat),
      virksomhedNavn: data.name,
      pageType: 'virksomhed',
      activeTab: aktivTab,
      preloadedEjendomme,
      ejendommeTotal: ejendommeFetchComplete ? ejendommeTotalBfe : undefined,
      preloadedDatterselskaber: preloadedDatter,
      virksomhedKontakt,
      virksomhedNoeglePersoner,
      virksomhedRegnskab,
    });
  }, [
    data,
    aktivTab,
    ejendommeData,
    ejendommeFetchComplete,
    ejendommeTotalBfe,
    relatedCompanies,
    xbrlData,
    setAICtx,
  ]);

  /**
   * Lazy-loader regnskabsdata når bruger klikker på Regnskab-tab.
   * Fetcher kun én gang — cacher i state.
   */
  const fetchRegnskaber = useCallback(async () => {
    if (regnskabFetchedRef.current) return;
    regnskabFetchedRef.current = true;
    setRegnskabLoading(true);
    setRegnskabError(null);

    try {
      const res = await fetch(`/api/regnskab?cvr=${encodeURIComponent(cvr)}`);
      const json = await res.json();

      if (!res.ok || json.error) {
        setRegnskabError(json.error ?? c.noFinancials);
        return;
      }

      setRegnskaber(json.regnskaber ?? []);
    } catch {
      setRegnskabError(c.networkError);
    } finally {
      setRegnskabLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cvr]);

  /**
   * Henter XBRL-regnskabstal med Supabase cache-first strategi:
   * 1. API tjekker Supabase cache — returnerer øjeblikkeligt hvis ES-tidsstempel matcher
   * 2. Ved cache miss: progressiv batching med XBRL-parsing, gemmes i Supabase
   */
  const fetchXbrl = useCallback(async () => {
    if (xbrlFetchedRef.current) return;
    xbrlFetchedRef.current = true;

    xbrlAbortRef.current?.abort();
    const controller = new AbortController();
    xbrlAbortRef.current = controller;

    const FIRST_BATCH = 4;
    const REST_BATCH = 8;

    /** Merger nye år ind med deduplikering */
    const mergeYears = (prev: RegnskabsAar[], incoming: RegnskabsAar[]): RegnskabsAar[] => {
      const map = new Map<number, RegnskabsAar>();
      const countF = (y: RegnskabsAar) => {
        let n = 0;
        for (const v of Object.values(y.resultat)) if (v !== null) n++;
        for (const v of Object.values(y.balance)) if (v !== null) n++;
        return n;
      };
      const pDage = (y: RegnskabsAar) =>
        (new Date(y.periodeSlut).getTime() - new Date(y.periodeStart).getTime()) / 86400000;
      for (const y of [...prev, ...incoming]) {
        const ex = map.get(y.aar);
        if (!ex) {
          map.set(y.aar, y);
          continue;
        }
        const nf = countF(y),
          ef = countF(ex);
        if (nf > ef || (nf === ef && pDage(y) > pDage(ex))) map.set(y.aar, y);
      }
      return [...map.values()].sort((a, b) => b.aar - a.aar);
    };

    setXbrlData([]);
    setXbrlLoading(true);
    setXbrlLoadingMore(false);

    try {
      // ── Første kald: API tjekker Supabase cache server-side ──
      const res = await fetch(`/api/regnskab/xbrl?cvr=${cvr}&offset=0&limit=${FIRST_BATCH}`, {
        signal: controller.signal,
      });
      const json = await res.json();
      const firstYears: RegnskabsAar[] = json.years ?? [];
      const total: number = json.total ?? 0;
      const wasCached: boolean = json.cached === true;

      setXbrlData(firstYears);
      setXbrlLoading(false);

      // Hvis server returnerede cached data → alt er allerede hentet, vi er færdige
      if (wasCached) {
        setXbrlLoadingMore(false);
        return;
      }

      // ── Cache miss — hent resten progressivt + trigger cache-write parallelt ──
      if (total > FIRST_BATCH) {
        setXbrlLoadingMore(true);

        // BIZZ-255: Start server-side cache-write in parallel with progressive fetch.
        // Previously this ran AFTER progressive fetch completed, causing redundant
        // re-parsing of all XBRL docs. Starting in parallel means the cache is ready
        // sooner for subsequent visits while the user sees progressive results.
        fetch(`/api/regnskab/xbrl?cvr=${cvr}&offset=0&limit=${total}`, {
          signal: controller.signal,
        }).catch(() => {
          /* cache-write non-fatal */
        });

        let offset = FIRST_BATCH;
        while (offset < total) {
          if (controller.signal.aborted) break;
          const res2 = await fetch(
            `/api/regnskab/xbrl?cvr=${cvr}&offset=${offset}&limit=${REST_BATCH}`,
            { signal: controller.signal }
          );
          const json2 = await res2.json();
          const moreYears: RegnskabsAar[] = json2.years ?? [];
          if (moreYears.length === 0) break;
          setXbrlData((prev) => mergeYears(prev ?? [], moreYears));
          offset += REST_BATCH;
        }
      }
    } catch {
      if (!controller.signal.aborted) {
        setXbrlData((prev) => (prev && prev.length > 0 ? prev : []));
      }
    } finally {
      setXbrlLoading(false);
      setXbrlLoadingMore(false);
    }
  }, [cvr]);

  /** Reset related-fetch guard when CVR changes to prevent stale ref blocking re-fetch */
  useEffect(() => {
    relatedFetchedRef.current = false;
    relatedAbortRef.current?.abort();
    relatedAbortRef.current = null;
  }, [cvr]);

  /** Henter relaterede virksomheder (gruppe) fra /api/cvr-public/related */
  const fetchRelated = useCallback(async () => {
    if (relatedFetchedRef.current) return;
    relatedFetchedRef.current = true;
    relatedAbortRef.current?.abort();
    const controller = new AbortController();
    relatedAbortRef.current = controller;
    setRelatedLoading(true);
    try {
      const res = await fetch(`/api/cvr-public/related?cvr=${encodeURIComponent(cvr)}`, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const json = await res.json();
      setRelatedCompanies(json.virksomheder ?? []);
      if (typeof json.parentEnhedsNummer === 'number')
        setParentEnhedsNummer(json.parentEnhedsNummer);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setRelatedCompanies([]);
    } finally {
      setRelatedLoading(false);
    }
  }, [cvr]);

  /** Hent ejendomshandler for CVR — lazy-loaded ved tab-aktivering */
  const fetchEjendomshandler = useCallback(async () => {
    if (handlerFetchedRef.current) return;
    handlerFetchedRef.current = true;
    setHandlerLoading(true);
    try {
      const res = await fetch(`/api/salgshistorik/cvr?cvr=${encodeURIComponent(cvr)}`);
      const json = await res.json();
      setEjendomshandler(json.handler ?? []);
      setHandlerManglerAdgang(json.manglerAdgang === true);
    } catch {
      setEjendomshandler([]);
    } finally {
      setHandlerLoading(false);
    }
  }, [cvr]);

  // Regnskab + XBRL-fetch startes lazy fra tab-useEffect nedenfor

  /**
   * Lazy-loader personbogsdata når bruger klikker på Tinglysning-tab.
   * Fetcher kun én gang — cacher i state.
   */
  const fetchPersonbog = useCallback(async () => {
    if (personbogFetchedRef.current) return;
    personbogFetchedRef.current = true;
    setPersonbogLoading(true);
    setPersonbogFejl(null);

    try {
      const res = await fetch(`/api/tinglysning/personbog?cvr=${encodeURIComponent(cvr)}`);
      const json = await res.json();

      if (!res.ok) {
        setPersonbogFejl(json.error ?? c.personbogError);
        return;
      }

      if (json.fejl) {
        setPersonbogFejl(json.fejl);
        return;
      }

      setPersonbogData(json.haeftelser ?? []);
      // BIZZ-533: Gem tinglyste dokumenter (vedtægter/fusioner/ejerpantebreve)
      setPersonbogDokumenter({
        vedtaegter: json.vedtaegter ?? [],
        fusioner: json.fusioner ?? [],
        ejerpantebreve: json.ejerpantebreve ?? [],
      });
    } catch {
      setPersonbogFejl(c.personbogError);
    } finally {
      setPersonbogLoading(false);
    }
  }, [cvr, c.personbogError]);

  /**
   * BIZZ-521 — Lazy-loader Fast ejendom-data (ejer + kreditor) når
   * Tinglysning-tab'en aktiveres. Fetcher kun én gang per CVR.
   */
  const fetchFastEjendom = useCallback(async () => {
    if (fastEjendomFetchedRef.current) return;
    fastEjendomFetchedRef.current = true;
    setFastEjendomLoading(true);
    setFastEjendomFejl(null);

    try {
      const res = await fetch(`/api/tinglysning/virksomhed?cvr=${encodeURIComponent(cvr)}`);
      const json = await res.json();

      if (!res.ok) {
        setFastEjendomFejl(json.error ?? c.fastEjendomError);
        return;
      }
      if (json.fejl) {
        setFastEjendomFejl(json.fejl);
        return;
      }

      // json.ejer droppes bevidst — listen er duplikeret med Ejendomme-tab
      setFastEjendomKreditor(json.kreditor ?? []);
    } catch {
      setFastEjendomFejl(c.fastEjendomError);
    } finally {
      setFastEjendomLoading(false);
    }
  }, [cvr, c.fastEjendomError]);

  /**
   * BIZZ-529 — Lazy-loader bilbogsdata når Tinglysning-tab aktiveres.
   * Hver bil kommer med egen liste af hæftelser (virksomhedspant,
   * ejendomsforbehold, leasing m.fl.). Fetcher kun én gang per CVR.
   */
  const fetchBilbog = useCallback(async () => {
    if (bilbogFetchedRef.current) return;
    bilbogFetchedRef.current = true;
    setBilbogLoading(true);
    setBilbogFejl(null);

    try {
      const res = await fetch(`/api/tinglysning/bilbog?cvr=${encodeURIComponent(cvr)}`);
      const json = await res.json();
      if (!res.ok) {
        setBilbogFejl(json.error ?? c.bilbogError);
        return;
      }
      if (json.fejl) {
        setBilbogFejl(json.fejl);
        return;
      }
      setBilbogData(json.biler ?? []);
    } catch {
      setBilbogFejl(c.bilbogError);
    } finally {
      setBilbogLoading(false);
    }
  }, [cvr, c.bilbogError]);

  /**
   * BIZZ-530 — Lazy-loader andelsbogsdata når Tinglysning-tab aktiveres.
   * Fetcher kun én gang per CVR.
   */
  const fetchAndelsbog = useCallback(async () => {
    if (andelsbogFetchedRef.current) return;
    andelsbogFetchedRef.current = true;
    setAndelsbogLoading(true);
    setAndelsbogFejl(null);

    try {
      const res = await fetch(`/api/tinglysning/andelsbog?cvr=${encodeURIComponent(cvr)}`);
      const json = await res.json();
      if (!res.ok) {
        setAndelsbogFejl(json.error ?? c.andelsbogError);
        return;
      }
      if (json.fejl) {
        setAndelsbogFejl(json.fejl);
        return;
      }
      setAndelsbogData(json.andele ?? []);
    } catch {
      setAndelsbogFejl(c.andelsbogError);
    } finally {
      setAndelsbogLoading(false);
    }
  }, [cvr, c.andelsbogError]);

  /** Trigger regnskab-fetch når financials-tab aktiveres */
  useEffect(() => {
    if (aktivTab === 'financials') {
      fetchRegnskaber();
      fetchXbrl();
    }
    if (aktivTab === 'companies' || aktivTab === 'overview' || aktivTab === 'diagram') {
      fetchRelated();
    }
    if (aktivTab === 'overview') {
      fetchXbrl();
    }
    if (aktivTab === 'tradeHistory' || aktivTab === 'properties') {
      fetchEjendomshandler();
    }
    /* Ejendomme-tab: hent også relaterede virksomheder (datterselskaber) */
    if (aktivTab === 'properties') {
      fetchRelated();
    }
    if (aktivTab === 'liens') {
      fetchPersonbog();
      fetchFastEjendom();
      fetchBilbog();
      fetchAndelsbog();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aktivTab]);

  /**
   * BIZZ-732: Prefetch de tungeste data-sæt ved sidens mount i stedet for
   * først ved tab-klik. Diagram- og Ejendomme-fanen kræver normalt fetchRelated
   * + fetchEjendomshandler som kan tage flere sekunder. Prefetch'es via
   * requestIdleCallback (eller setTimeout 0 som fallback) så det ikke
   * konkurrerer med LCP. fetchedRef-mønsteret i hver fetcher dedupliker, så
   * efterfølgende tab-klik blot læser cached state.
   * Liens (personbog/fastejendom/bilbog/andelsbog) prefetcher vi IKKE — de er
   * mindre trafikerede og tungere pr. request.
   */
  useEffect(() => {
    if (!cvr) return;
    let cancelled = false;
    const schedule = (fn: () => void) => {
      if (typeof window === 'undefined') return;
      const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => number })
        .requestIdleCallback;
      if (typeof ric === 'function') ric(fn);
      else setTimeout(fn, 0);
    };
    schedule(() => {
      if (cancelled) return;
      fetchRelated();
      fetchEjendomshandler();
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cvr]);

  /**
   * Henter ejendomsportefølje progressivt: første batch (5) vises straks,
   * efterfølgende batches tilføjes automatisk i baggrunden.
   * Bruger AbortController til at annullere igangværende hentning ved CVR-ændring.
   */
  /**
   * BIZZ-265: Extended to support enhedsNummer for ENK owner-owned properties.
   */
  const fetchEjendommeProgressively = useCallback(
    async (uniqueCvrs: string[], ownerEnhedsNumre?: string[]) => {
      ejendomAbortRef.current?.abort();
      const controller = new AbortController();
      ejendomAbortRef.current = controller;

      const FIRST_BATCH = 5;
      const REST_BATCH = 10;

      setEjendommeData([]);
      setEjendommeFetchComplete(false);
      setEjendommeLoadingMore(false);
      setEjendommeLoading(true);
      setEjendommeManglerNoegle(false);
      setEjendommeManglerAdgang(false);

      const params = new URLSearchParams();
      if (uniqueCvrs.length > 0) params.set('cvr', uniqueCvrs.join(','));
      if (ownerEnhedsNumre && ownerEnhedsNumre.length > 0)
        params.set('enhedsNummer', ownerEnhedsNumre.join(','));
      params.set('offset', '0');
      params.set('limit', String(FIRST_BATCH));

      try {
        const res = await fetch(`/api/ejendomme-by-owner?${params}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`${res.status}`);
        const json = (await res.json()) as {
          ejendomme: EjendomSummary[];
          totalBfe: number;
          manglerNoegle: boolean;
          manglerAdgang: boolean;
        };

        if (controller.signal.aborted) return;

        setEjendommeData(json.ejendomme ?? []);
        setEjendommeTotalBfe(json.totalBfe ?? 0);
        setEjendommeManglerNoegle(json.manglerNoegle === true);
        setEjendommeManglerAdgang(json.manglerAdgang === true);
        setEjendommeLoading(false);

        let offset = FIRST_BATCH;
        const total = json.totalBfe ?? 0;

        if (offset < total) setEjendommeLoadingMore(true);

        while (offset < total) {
          if (controller.signal.aborted) return;

          params.set('offset', String(offset));
          params.set('limit', String(REST_BATCH));
          const res2 = await fetch(`/api/ejendomme-by-owner?${params}`, {
            signal: controller.signal,
          });
          if (!res2.ok) break;
          const json2 = (await res2.json()) as { ejendomme: EjendomSummary[] };

          if (controller.signal.aborted) return;

          setEjendommeData((prev) => [...prev, ...(json2.ejendomme ?? [])]);
          offset += REST_BATCH;
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        setEjendommeData([]);
      } finally {
        if (!controller.signal.aborted) {
          setEjendommeLoading(false);
          setEjendommeLoadingMore(false);
          setEjendommeFetchComplete(true);
        }
      }
    },
    []
  );

  /**
   * BIZZ-569: Batch-enrich alle BFE'er i ÉT endpoint-kald i stedet for ét
   * per kort. Sparer N × Vercel cold-start og giver dramatisk hurtigere
   * card-rendering på sider med mange ejendomme.
   *
   * BIZZ-848: aktivTab-guard fjernet så prefetch starter så snart ejendomme-
   * data er loaded (ikke først ved tab-klik). Ejendomme-tab er nu klar
   * uden ventetid når brugeren klikker derhen.
   */
  useEffect(() => {
    if (ejendommeData.length === 0) return;

    // Find BFE'er der mangler enriched data
    const missing = ejendommeData.filter((e) => !preEnrichedByBfe.has(e.bfeNummer));
    if (missing.length === 0) return;

    const controller = new AbortController();
    const bfes = missing.map((e) => e.bfeNummer).join(',');
    const dawaIds = missing.map((e) => e.dawaId ?? '').join(',');
    // BIZZ-634: Vedhæft ejer-datoer fra ejendomsdata så historiske/solgte
    // ejendomme kan få ejer-specifik købs- + salgspris på kortene.
    const ownerBuyDates = missing.map((e) => e.ownerBuyDate ?? '').join(',');
    const ownerSellDates = missing.map((e) => e.solgtDato ?? '').join(',');
    const url =
      `/api/ejendomme-by-owner/enrich-batch?bfes=${bfes}&dawaIds=${dawaIds}` +
      (ownerBuyDates.replace(/,/g, '')
        ? `&ownerBuyDates=${encodeURIComponent(ownerBuyDates)}`
        : '') +
      (ownerSellDates.replace(/,/g, '')
        ? `&ownerSellDates=${encodeURIComponent(ownerSellDates)}`
        : '');

    fetch(url, {
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data || controller.signal.aborted) return;
        setPreEnrichedByBfe((prev) => {
          const next = new Map(prev);
          for (const [bfe, row] of Object.entries(data)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            next.set(parseInt(bfe, 10), row as any);
          }
          return next;
        });
      })
      .catch(() => {});

    return () => controller.abort();
    // BIZZ-848: aktivTab fjernet fra dep-array da guarden er fjernet i body.
  }, [ejendommeData, preEnrichedByBfe]);

  /**
   * Trigger progressiv ejendomshentning når properties-tab aktiveres eller CVR-sæt ændres.
   * Kører igen når relatedCompanies ændres (datterselskaber loader ind).
   * BIZZ-848: prefetch også ved overview-tab — giver props-tab uden ventetid.
   */
  useEffect(() => {
    if (aktivTab !== 'properties' && aktivTab !== 'diagram' && aktivTab !== 'overview') return;

    /* Saml CVR-numre: hovedvirksomhed + aktive datterselskaber */
    const cvrList = [
      cvr,
      ...relatedCompanies.filter((v) => v.aktiv).map((v) => String(v.cvr).padStart(8, '0')),
    ];
    const uniqueCvrs = [...new Set(cvrList)].slice(0, 30);

    /* BIZZ-265: For ENK virksomheder — find ejerens enhedsNummer for personligt ejede ejendomme */
    const ownerEnhedsNumre: string[] = [];
    const isEnk =
      data?.companydesc?.toUpperCase()?.includes('ENKELTMANDSVIRKSOMHED') ||
      data?.companydesc?.toUpperCase()?.includes('ENK');
    if (isEnk && ownerChainShared.length > 0) {
      for (const owner of ownerChainShared) {
        if (!owner.erVirksomhed && owner.enhedsNummer) {
          ownerEnhedsNumre.push(String(owner.enhedsNummer));
        }
      }
    }

    const fetchKey = [...uniqueCvrs, ...ownerEnhedsNumre].sort().join(',');

    /* Spring over hvis vi allerede henter for nøjagtigt dette sæt */
    if (ejendomFetchKeyRef.current === fetchKey) return;
    ejendomFetchKeyRef.current = fetchKey;

    void fetchEjendommeProgressively(
      uniqueCvrs,
      ownerEnhedsNumre.length > 0 ? ownerEnhedsNumre : undefined
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aktivTab, cvr, relatedCompanies, fetchEjendommeProgressively]);

  /** Lazy-load regnskabstal for alle relaterede virksomheder (parallelt) */
  useEffect(() => {
    if (
      (aktivTab !== 'companies' && aktivTab !== 'overview') ||
      relatedCompanies.length === 0 ||
      gruppeFinansFetchedRef.current
    )
      return;
    gruppeFinansFetchedRef.current = true;
    setGruppeFinansLoading(true);

    const cvrList = relatedCompanies.filter((v) => v.aktiv).map((v) => v.cvr);
    Promise.allSettled(
      cvrList.map(async (companyCvr) => {
        const res = await fetch(`/api/regnskab/xbrl?cvr=${companyCvr}`, {
          signal: AbortSignal.timeout(15000),
        });
        const json = await res.json();
        const years = (json.years ?? []) as RegnskabsAar[];
        if (years.length === 0)
          return { cvr: companyCvr, brutto: null, balance: null, egenkapital: null };
        const latest = years[0]; // Nyeste år
        return {
          cvr: companyCvr,
          brutto: latest.resultat?.bruttofortjeneste ?? null,
          balance: latest.balance?.aktiverIAlt ?? null,
          egenkapital: latest.balance?.egenkapital ?? null,
        };
      })
    ).then((results) => {
      const map = new Map<
        number,
        { brutto: number | null; balance: number | null; egenkapital: number | null }
      >();
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          map.set(r.value.cvr, {
            brutto: r.value.brutto,
            balance: r.value.balance,
            egenkapital: r.value.egenkapital,
          });
        }
      }
      setGruppeFinans(map);
      setGruppeFinansLoading(false);
    });
  }, [aktivTab, relatedCompanies]);

  /**
   * Lazy-load detaljerede data for modervirksomheder (opad i ejerkæden).
   * Henter CVR-data + regnskab for hver parent company, så de kan vises
   * med samme detaljegrad som datterselskaber i Gruppe-tab.
   */
  useEffect(() => {
    if (
      (aktivTab !== 'companies' && aktivTab !== 'overview') ||
      ownerChainShared.length === 0 ||
      parentDetailsFetchedRef.current
    )
      return;

    // Saml unikke parent-virksomheders CVR/enhedsNummer
    const parentIds: {
      navn: string;
      cvr: number | null;
      enhedsNummer: number | null;
      ejerandel: string | null;
    }[] = [];
    const seen = new Set<number>();
    function collectParents(nodes: OwnerChainNode[]) {
      for (const n of nodes) {
        if (n.erVirksomhed) {
          const id = n.cvr ?? n.enhedsNummer ?? 0;
          if (id && !seen.has(id) && id !== Number(cvr)) {
            seen.add(id);
            parentIds.push({
              navn: n.navn,
              cvr: n.cvr,
              enhedsNummer: n.enhedsNummer,
              ejerandel: n.ejerandel,
            });
          }
        }
        if (n.parents.length > 0) collectParents(n.parents);
      }
    }
    collectParents(ownerChainShared);
    if (parentIds.length === 0) return;

    parentDetailsFetchedRef.current = true;

    // Fetch detaljeret CVR-data for hver parent parallelt
    Promise.allSettled(
      parentIds.map(async (pc) => {
        const lookupParam = pc.cvr ? `vat=${pc.cvr}` : `enhedsNummer=${pc.enhedsNummer}`;
        const res = await fetch(`/api/cvr-public?${lookupParam}`, {
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return null;
        const json = (await res.json()) as CVRPublicData & { error?: string };
        if (json.error || !json.vat) return null;

        // Hent regnskab parallelt
        let brutto: number | null = null;
        let balance: number | null = null;
        let egenkapital: number | null = null;
        try {
          const xbrlRes = await fetch(`/api/regnskab/xbrl?cvr=${json.vat}`, {
            signal: AbortSignal.timeout(10000),
          });
          const xbrlJson = await xbrlRes.json();
          const years = (xbrlJson.years ?? []) as RegnskabsAar[];
          if (years.length > 0) {
            const latest = years[0];
            brutto = latest.resultat?.bruttofortjeneste ?? null;
            balance = latest.balance?.aktiverIAlt ?? null;
            egenkapital = latest.balance?.egenkapital ?? null;
          }
        } catch {
          /* ignore regnskab errors */
        }

        // Find direktør
        const direktion = (json.deltagere ?? []).find((d) =>
          d.roller.some((r) => r.rolle.toUpperCase().includes('DIREKTION') && !r.til)
        );

        // Map til RelateretVirksomhed-lignende objekt
        const mapped: RelateretVirksomhed & {
          _finans?: { brutto: number | null; balance: number | null; egenkapital: number | null };
        } = {
          cvr: json.vat,
          navn: json.name,
          form: json.companydesc ?? null,
          branche: json.industrydesc ?? null,
          adresse: json.address ?? null,
          postnr: json.zipcode ?? null,
          by: json.city ?? null,
          aktiv: !json.enddate,
          ansatte: json.employees ?? null,
          ejerandel: pc.ejerandel,
          ejerandelNum: 0,
          stiftet: json.stiftet ?? null,
          direktoer: direktion?.navn ?? null,
          antalPenheder: (json.productionunits ?? []).filter((p) => p.active).length,
          antalDatterselskaber: 0,
          ejetAfCvr: null,
          ejere: [],
          direktion: [],
          bestyrelse: [],
          _finans: { brutto, balance, egenkapital },
        };
        return mapped;
      })
    ).then((results) => {
      const map = new Map<number, RelateretVirksomhed>();
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          map.set(r.value.cvr, r.value);
          // Tilføj regnskab til gruppeFinans map
          const fin = (
            r.value as RelateretVirksomhed & {
              _finans?: {
                brutto: number | null;
                balance: number | null;
                egenkapital: number | null;
              };
            }
          )._finans;
          if (fin) {
            setGruppeFinans((prev) => {
              const next = new Map(prev);
              next.set(r.value!.cvr, fin);
              return next;
            });
          }
        }
      }
      setParentCompanyDetails(map);
    });
  }, [aktivTab, ownerChainShared, cvr]);

  // ── Loading state — matches loading.tsx skeleton for seamless transition ──
  if (loading) {
    return (
      <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 animate-pulse">
        {/* Back link */}
        <div className="h-4 w-24 bg-slate-700/20 rounded" />
        {/* Company header */}
        <div>
          <div className="h-8 w-72 bg-slate-700/40 rounded-lg" />
          <div className="flex gap-2 mt-3">
            <div className="h-6 w-24 bg-blue-700/20 rounded-full" />
            <div className="h-6 w-16 bg-green-700/20 rounded-full" />
            <div className="h-6 w-28 bg-slate-700/20 rounded-full" />
          </div>
        </div>
        {/* Loading indicator */}
        <div className="flex items-center gap-2 py-1">
          <Loader2
            size={14}
            className="text-blue-400 flex-shrink-0"
            style={{ animation: 'spin 0.8s linear infinite' }}
          />
          <span className="text-slate-400 text-sm" style={{ animation: 'none' }}>
            {c.loading}
          </span>
        </div>
        {/* Tabs skeleton */}
        <div className="flex gap-4 border-b border-slate-700/30 pb-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-4 w-20 bg-slate-700/20 rounded" />
          ))}
        </div>
        {/* Content cards */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-white/5 border border-white/8 rounded-2xl p-6 space-y-4">
              <div className="h-5 w-32 bg-slate-700/30 rounded" />
              <div className="space-y-2">
                <div className="h-3 w-full bg-slate-700/15 rounded" />
                <div className="h-3 w-3/4 bg-slate-700/10 rounded" />
                <div className="h-3 w-1/2 bg-slate-700/10 rounded" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Error state ──
  if (error || !data) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 max-w-md text-center">
          <AlertTriangle className="w-10 h-10 text-amber-500" />
          <h2 className="text-white text-lg font-semibold">{c.error}</h2>
          <p className="text-slate-400 text-sm">{error ?? c.unknownError}</p>
          <button
            onClick={() => router.back()}
            className="mt-2 px-4 py-2 bg-slate-800 text-slate-300 rounded-lg hover:bg-slate-700 transition text-sm"
          >
            {c.goBack}
          </button>
        </div>
      </div>
    );
  }

  /** Om virksomheden stadig er aktiv (ingen slutdato) */
  const erAktiv = !data.enddate;

  /**
   * Kategoriserer roller i prioriteret rækkefølge: EJER → BESTYRELSE → STIFTER → REVISION → DIREKTION → ANDET.
   * Returnerer en sorteret liste af rollegrupper med aktive + historiske deltagere.
   */
  const rolleKategoriOrdning = ['EJER', 'BESTYRELSE', 'STIFTER', 'REVISION', 'DIREKTION', 'ANDET'];

  /** Mapper rollenavn til kategori */
  const rolleKategori = (rolle: string): string => {
    const upper = rolle.toUpperCase();
    if (
      upper.includes('EJER') ||
      upper.includes('FULDT_ANSVARLIG') ||
      upper.includes('LEGALE_EJERE') ||
      upper.includes('REELLE_EJERE') ||
      upper.includes('INTERESSENT')
    )
      return 'EJER';
    if (upper.includes('BESTYRELSE') || upper.includes('TILSYNSRÅD')) return 'BESTYRELSE';
    if (upper.includes('STIFTER') || upper.includes('FOUNDER')) return 'STIFTER';
    if (upper.includes('REVISION') || upper.includes('REVISOR')) return 'REVISION';
    if (upper.includes('DIREKTION') || upper.includes('DIREKTØR')) return 'DIREKTION';
    return 'ANDET';
  };

  type PersonMedRolle = {
    deltager: CVRPublicData['deltagere'][0];
    rolle: CVRPublicData['deltagere'][0]['roller'][0];
  };

  /** Grupperer deltagere efter rollekategori med aktive/historiske */
  const personerByKategori = (() => {
    const result: Record<string, { aktive: PersonMedRolle[]; historiske: PersonMedRolle[] }> = {};
    for (const d of data.deltagere ?? []) {
      for (const r of d.roller) {
        const kat = rolleKategori(r.rolle);
        if (!result[kat]) result[kat] = { aktive: [], historiske: [] };
        const entry = { deltager: d, rolle: r };
        if (r.til === null) {
          result[kat].aktive.push(entry);
        } else {
          result[kat].historiske.push(entry);
        }
      }
    }
    // Sorter historiske nyeste først
    for (const kat of Object.values(result)) {
      kat.historiske.sort((a, b) => (b.rolle.til ?? '').localeCompare(a.rolle.til ?? ''));
    }
    return result;
  })();

  /** Sorteret kategoriliste — kun dem med data */
  const sorteredeKategorier = rolleKategoriOrdning.filter((k) => personerByKategori[k]);

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* ─── Left: Main Content ─── */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* ─── Sticky Header ─── */}
        <div className="px-3 sm:px-6 pt-5 pb-0 border-b border-slate-700/50 bg-slate-900/30">
          {/* Top row: back button + actions */}
          <div className="flex items-center justify-between mb-3">
            <button
              onClick={() => router.push('/dashboard/companies')}
              className="flex items-center gap-2 text-slate-400 hover:text-white text-sm transition-colors"
            >
              <ArrowLeft size={16} />
              {c.title}
            </button>
            <div className="flex items-center gap-2">
              {/* Nyheder/AI-søgning toggle knap */}
              <button
                onClick={() => {
                  if (isDesktop) {
                    setNyhedsPanelÅben((prev) => !prev);
                  } else {
                    setMobilNyhederAaben(true);
                  }
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 border rounded-lg text-sm transition-all ${
                  (isDesktop && nyhedsPanelÅben) || (!isDesktop && mobilNyhederAaben)
                    ? 'bg-blue-600/20 hover:bg-blue-600/30 border-blue-500/40 text-blue-300'
                    : 'bg-slate-800 hover:bg-slate-700 border-slate-700/60 text-slate-300'
                }`}
                title={lang === 'da' ? 'Medier & AI artikel søgning' : 'Media & AI article search'}
              >
                <Newspaper size={14} />
                {lang === 'da' ? 'Medier' : 'Media'}
              </button>
              {/* Følg button */}
              <button
                onClick={async () => {
                  const nyTilstand = toggleTrackCompany(cvr, data.name);
                  setErFulgt(nyTilstand);
                  window.dispatchEvent(new Event('ba-tracked-changed'));
                  try {
                    if (nyTilstand) {
                      await fetch('/api/tracked', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          entity_id: cvr,
                          label: data.name,
                          entity_data: { type: 'company', companydesc: data.companydesc },
                        }),
                      });
                    } else {
                      await fetch(`/api/tracked?id=${encodeURIComponent(cvr)}`, {
                        method: 'DELETE',
                      });
                    }
                  } catch {
                    /* Supabase ikke tilgængelig */
                  }
                }}
                className={`flex items-center gap-2 px-3 py-1.5 border rounded-lg text-sm transition-all ${
                  erFulgt
                    ? 'bg-blue-600/20 hover:bg-blue-600/30 border-blue-500/40 text-blue-300'
                    : 'bg-slate-800 hover:bg-slate-700 border-slate-700/60 text-slate-300'
                }`}
              >
                <Bell size={14} className={erFulgt ? 'fill-blue-400 text-blue-400' : ''} />
                {erFulgt ? c.following : c.follow}
              </button>
              {/* BIZZ-808: Opret sag-knap — kun synlig for domain-brugere */}
              {domainMemberships.length > 0 && (
                <button
                  type="button"
                  onClick={() => setOpretSagOpen(true)}
                  className="flex items-center gap-2 px-3 py-1.5 border rounded-lg text-sm transition-all bg-emerald-600/20 hover:bg-emerald-600/30 border-emerald-500/40 text-emerald-300"
                  aria-label={
                    lang === 'da'
                      ? 'Opret sag for denne virksomhed'
                      : 'Create case for this company'
                  }
                >
                  <Briefcase size={14} />
                  {lang === 'da' ? 'Opret sag' : 'Create case'}
                </button>
              )}
            </div>
          </div>

          {/* Company name + badges */}
          <div className="mb-3">
            <h1 className="text-white text-xl font-bold truncate">{data.name}</h1>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-blue-600/20 text-blue-400 text-xs font-medium">
                CVR {data.vat}
              </span>
              <span
                className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-xs font-medium ${
                  erAktiv ? 'bg-emerald-600/20 text-emerald-400' : 'bg-red-600/20 text-red-400'
                }`}
              >
                {erAktiv ? (
                  <>
                    <CheckCircle size={12} />
                    {c.active}
                  </>
                ) : (
                  <>
                    <XCircle size={12} />
                    {c.ceased}
                  </>
                )}
              </span>
              {data.companydesc && (
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-slate-800 border border-slate-700/50 text-xs text-slate-300">
                  <Briefcase size={11} />
                  {data.companydesc}
                </span>
              )}
              {data.employees && (
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-slate-800 border border-slate-700/50 text-xs text-slate-300">
                  <Users size={11} />
                  {data.employees} {c.employeesShort}
                </span>
              )}
              {/* BIZZ-919: Data freshness badge + refresh */}
              <DataFreshnessBadge fromCache={cacheFromCache} syncedAt={cacheSyncedAt} lang={lang} />
              <button
                onClick={handleRefresh}
                disabled={refreshing}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] text-slate-400 hover:text-blue-400 bg-slate-700/30 border border-slate-700/40 hover:border-blue-500/30 transition-colors disabled:opacity-50"
                aria-label={lang === 'da' ? 'Genindlæs data' : 'Refresh data'}
                title={lang === 'da' ? 'Genindlæs data' : 'Refresh data'}
              >
                <RefreshCw size={9} className={refreshing ? 'animate-spin' : ''} />
              </button>
            </div>
          </div>

          {/* Tab bar */}
          <div className="flex gap-1 -mb-px overflow-x-auto scrollbar-hide">
            {tabOrder.map((tabId) => (
              <button
                key={tabId}
                onClick={() => setAktivTab(tabId)}
                className={`flex items-center gap-1 px-2 py-1.5 text-xs font-medium border-b-2 transition-all whitespace-nowrap ${
                  aktivTab === tabId
                    ? 'border-blue-500 text-blue-300'
                    : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600'
                }`}
              >
                {tabIcons[tabId]}
                {tabLabelMap[tabId]}
              </button>
            ))}
          </div>
        </div>

        {/* ─── Global loading-indikator ─── */}
        {(xbrlLoading ||
          xbrlLoadingMore ||
          ejendommeLoading ||
          ejendommeLoadingMore ||
          handlerLoading ||
          relatedLoading) && (
          <div className="flex items-center gap-2 px-4 py-1.5 bg-blue-600/10 border-b border-blue-500/20">
            <Loader2 size={12} className="animate-spin text-blue-400" />
            <span className="text-blue-300 text-xs">
              {lang === 'da' ? 'Henter data…' : 'Loading data…'}
            </span>
          </div>
        )}

        {/* ─── Scrollable Content Area ─── */}
        <div ref={contentRef} className="flex-1 overflow-y-auto px-3 sm:px-6 py-5">
          {/* ══ OVERBLIK ══ */}
          {/* ══ OVERBLIK ══ */}
          {aktivTab === 'overview' && (
            <VirksomhedOverblikTab
              lang={lang}
              data={data}
              relatedCompanies={relatedCompanies}
              ownerChainShared={ownerChainShared}
              xbrlData={xbrlData}
              xbrlLoading={xbrlLoading}
              personerByKategori={personerByKategori}
              relatedLoading={relatedLoading}
              oversigtFilter={oversigtFilter}
              setOversigtFilter={setOversigtFilter}
            />
          )}

          {/* ══ RELATIONSDIAGRAM (Force Graph — original) ══ */}
          {aktivTab === 'diagram' && (
            <div className="relative">
              {/* BIZZ-1098: Konsolideret til én loading-indikator (corner badge nedenfor).
                  DiagramForce håndterer sin egen initial-state med pulse-dot. */}
              <DiagramForce
                graph={diagramGraphStable}
                lang={lang}
                onDiagramReady={(base64) => {
                  setAICtx({ diagramBase64: base64 });
                }}
              />
              {/* BIZZ-729: Loading overlay — ejendomme loades progressivt men diagrammet
                  rebuilds kun ved ejendommeFetchComplete=true for at undgå re-simulation.
                  Uden denne indikator ser diagrammet "færdigt" ud indtil ejendomme pludselig
                  popper ind. Viser spinner + progress-counter mens hentning står på. */}
              {(ejendommeLoading || ejendommeLoadingMore) && (
                <div
                  role="status"
                  aria-live="polite"
                  className="absolute top-3 right-3 flex items-center gap-2 px-3 py-2 bg-blue-900/90 backdrop-blur-sm border border-blue-500/40 rounded-lg shadow-lg text-blue-100 text-xs font-medium pointer-events-none animate-pulse"
                >
                  <Loader2 size={14} className="animate-spin text-blue-300" />
                  <span>
                    {lang === 'da' ? 'Henter ejendomme' : 'Loading properties'}
                    {ejendommeTotalBfe > 0
                      ? ` — ${ejendommeData.length}/${ejendommeTotalBfe}`
                      : '…'}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* ══ DIAGRAM v2 (feature-flagged) ══ */}
          {aktivTab === 'diagram2' && data && (
            <DiagramV2
              rootType="company"
              rootId={String(data.vat)}
              rootLabel={data.name ?? ''}
              lang={lang}
            />
          )}

          {/* ══ EJENDOMME ══ */}
          {aktivTab === 'properties' && (
            <VirksomhedEjendommeTab
              lang={lang}
              data={data}
              ejendommeLoading={ejendommeLoading}
              ejendommeLoadingMore={ejendommeLoadingMore}
              ejendommeData={ejendommeData}
              ejendommeFetchComplete={ejendommeFetchComplete}
              ejendommeManglerNoegle={ejendommeManglerNoegle}
              ejendommeManglerAdgang={ejendommeManglerAdgang}
              ejendommeTotalBfe={ejendommeTotalBfe}
              preEnrichedByBfe={preEnrichedByBfe}
              relatedCompanies={relatedCompanies}
              ejendomshandler={ejendomshandler}
              handlerLoading={handlerLoading}
              handlerManglerAdgang={handlerManglerAdgang}
              visSolgte={visSolgte}
              setVisSolgte={setVisSolgte}
            />
          )}

          {/* ══ GRUPPE ══ */}
          {/* ══ COMPANIES ══ */}
          {aktivTab === 'companies' && (
            <VirksomhedGruppeTab
              lang={lang}
              data={data}
              relatedCompanies={relatedCompanies}
              relatedLoading={relatedLoading}
              ownerChainShared={ownerChainShared}
              gruppeFinans={gruppeFinans}
              gruppeFinansLoading={gruppeFinansLoading}
              parentCompanyDetails={parentCompanyDetails}
              xbrlData={xbrlData}
              xbrlLoading={xbrlLoading}
              parentSectionOpen={parentSectionOpen}
              setParentSectionOpen={setParentSectionOpen}
              childSectionOpen={childSectionOpen}
              setChildSectionOpen={setChildSectionOpen}
              visHistorik={visHistorik}
              setVisHistorik={setVisHistorik}
            />
          )}

          {/* ══ REGNSKAB ══ */}
          {/* ══ FINANCIALS ══ */}
          {aktivTab === 'financials' && (
            <VirksomhedRegnskabTab
              lang={lang}
              xbrlData={xbrlData}
              xbrlLoading={xbrlLoading}
              xbrlLoadingMore={xbrlLoadingMore}
              regnskaber={regnskaber}
              regnskabLoading={regnskabLoading}
              valgteDoc={valgteDoc}
              toggleDoc={toggleDoc}
              visAlleRegnskaber={visAlleRegnskaber}
              setVisAlleRegnskaber={setVisAlleRegnskaber}
            />
          )}

          {/* ══ NØGLEPERSONER ══ */}
          {/* ══ KEYPERSONS ══ */}
          {aktivTab === 'keyPersons' && (
            <VirksomhedNoeglepersonerTab
              lang={lang}
              personerByKategori={personerByKategori}
              sorteredeKategorier={sorteredeKategorier}
              personerFilter={personerFilter}
              setPersonerFilter={setPersonerFilter}
              expandedHistPersoner={expandedHistPersoner}
              setExpandedHistPersoner={setExpandedHistPersoner}
              visAlleHistPersoner={visAlleHistPersoner}
              setVisAlleHistPersoner={setVisAlleHistPersoner}
            />
          )}

          {/* ══ KRONOLOGI ══ */}
          {/* ══ HISTORY ══ */}
          {aktivTab === 'history' && (
            <VirksomhedHistorikTab
              lang={lang}
              data={data}
              historikFilter={historikFilter}
              setHistorikFilter={setHistorikFilter}
            />
          )}

          {/* ══ TINGLYSNING ══ */}
          {/* ══ TINGLYSNING ══ */}
          {aktivTab === 'liens' && (
            <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-hidden">
              {/* BIZZ-617: Brug eksisterende loadingPersonbog-key (Personbogen) */}
              {personbogLoading && <TabLoadingSpinner label={c.loadingPersonbog} />}
              <div className="px-4 py-2.5 border-b border-slate-700/30 flex items-center gap-2">
                <Scale size={15} className="text-slate-400" />
                <span className="text-sm font-semibold text-slate-200">
                  {c.registeredDocuments}
                </span>
              </div>
              <div className="divide-y divide-slate-700/20">
                {/* ── Personbogen — expandabel med rigtige data ── */}
                <div>
                  <div className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-800/30 transition-colors">
                    <button
                      onClick={() => setPersonbogRowOpen((prev) => !prev)}
                      className="flex items-center gap-3 flex-1 text-left min-w-0"
                    >
                      {/* Chevron — altid yderst til venstre */}
                      <span className="flex-shrink-0 w-4">
                        {personbogLoading ? (
                          <Loader2 size={12} className="animate-spin text-slate-500" />
                        ) : personbogRowOpen ? (
                          <ChevronDown size={13} className="text-slate-500" />
                        ) : (
                          <ChevronRight size={13} className="text-slate-500" />
                        )}
                      </span>
                      <FileText size={15} className="text-slate-500 flex-shrink-0" />
                      <span className="text-slate-200 text-sm">
                        {c.personBook}
                        <span className="text-slate-500 text-xs ml-1">
                          ({personbogLoading ? '…' : (personbogData?.length ?? 0)})
                        </span>
                      </span>
                    </button>
                    {/* Download valgte — kun synlig når der er data */}
                    {!personbogLoading && (personbogData?.length ?? 0) > 0 && (
                      <button
                        onClick={async () => {
                          for (const docId of selectedPantDocs) {
                            const url = `/api/tinglysning/dokument?uuid=${docId}`;
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = `tinglysning-${docId.slice(0, 14)}.pdf`;
                            a.click();
                            await new Promise((r) => setTimeout(r, 500));
                          }
                        }}
                        disabled={selectedPantDocs.size === 0}
                        className="ml-2 flex-shrink-0 flex items-center gap-1.5 px-3 py-1 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed border border-slate-600 rounded-lg text-slate-300 text-xs font-medium transition-all"
                      >
                        <Download size={12} />
                        {c.personbogDownloadValgte} ({selectedPantDocs.size})
                      </button>
                    )}
                  </div>
                  {/* Expandabelt indhold — personbogsdata */}
                  {personbogRowOpen && (
                    <div className="border-t border-slate-700/20" style={{ contain: 'layout' }}>
                      <PersonbogSection
                        haeftelser={personbogData}
                        loading={personbogLoading}
                        fejl={personbogFejl}
                        c={c}
                        da={lang === 'da'}
                        expandedPant={expandedPant}
                        setExpandedPant={setExpandedPant}
                        selectedPantDocs={selectedPantDocs}
                        setSelectedPantDocs={setSelectedPantDocs}
                        dokumenter={personbogDokumenter}
                      />
                    </div>
                  )}
                </div>

                {/* ── Bilbogen (BIZZ-529) — expandabel med rigtige data ── */}
                <div>
                  <div className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-800/30 transition-colors">
                    <button
                      onClick={() => setBilbogOpen((prev) => !prev)}
                      className="flex items-center gap-3 flex-1 text-left min-w-0"
                      disabled={bilbogData.length === 0 && !bilbogLoading}
                    >
                      <span className="flex-shrink-0 w-4">
                        {bilbogLoading ? (
                          <Loader2 size={12} className="animate-spin text-slate-500" />
                        ) : bilbogData.length === 0 ? (
                          <span />
                        ) : bilbogOpen ? (
                          <ChevronDown size={13} className="text-slate-500" />
                        ) : (
                          <ChevronRight size={13} className="text-slate-500" />
                        )}
                      </span>
                      <FileText
                        size={15}
                        className={bilbogData.length > 0 ? 'text-slate-500' : 'text-slate-600'}
                      />
                      <span
                        className={
                          bilbogData.length > 0
                            ? 'text-slate-200 text-sm'
                            : 'text-slate-400 text-sm'
                        }
                      >
                        {c.carBook}
                        <span className="text-slate-500 text-xs ml-1">
                          ({bilbogLoading ? '…' : bilbogData.length})
                        </span>
                      </span>
                    </button>
                  </div>
                  {bilbogOpen && bilbogData.length > 0 && (
                    <div className="border-t border-slate-700/20 bg-slate-900/30 px-4 py-3 space-y-3">
                      {bilbogFejl && <div className="text-xs text-red-400">{bilbogFejl}</div>}
                      {bilbogData.map((bil) => (
                        <div
                          key={bil.uuid}
                          className="bg-slate-800/40 border border-slate-700/40 rounded-lg p-3"
                        >
                          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
                            <span className="text-slate-100 font-medium">
                              {bil.fabrikat ?? '—'}
                            </span>
                            {bil.aargang && (
                              <span className="text-slate-400">
                                {c.bilbogAargang}: {bil.aargang}
                              </span>
                            )}
                            {bil.registreringsnummer && (
                              <span className="text-slate-400">
                                {c.bilbogRegnr}: {bil.registreringsnummer}
                              </span>
                            )}
                            {bil.stelnummer && (
                              <span className="text-slate-500 font-mono">
                                {c.bilbogStelnummer}: {bil.stelnummer}
                              </span>
                            )}
                          </div>
                          {bil.haeftelser.length === 0 ? (
                            <div className="mt-2 text-xs text-slate-500">
                              {c.bilbogIngenHaeftelser}
                            </div>
                          ) : (
                            <ul className="mt-2 space-y-2">
                              {bil.haeftelser.map((h, i) => (
                                <li
                                  key={`${bil.uuid}-${h.dokumentId ?? i}`}
                                  className="text-xs text-slate-400"
                                >
                                  <div className="flex flex-wrap items-baseline gap-x-3">
                                    <span className="text-slate-300">{h.type}</span>
                                    {h.hovedstol != null && (
                                      <span>
                                        {h.hovedstol.toLocaleString('da-DK')} {h.valuta}
                                      </span>
                                    )}
                                    {h.kreditor && (
                                      <span className="text-slate-500">
                                        {c.personbogKreditor}: {h.kreditor}
                                      </span>
                                    )}
                                    {h.tinglysningsdato && (
                                      <span className="text-slate-600">{h.tinglysningsdato}</span>
                                    )}
                                    {h.dokumentId && (
                                      <a
                                        href={`/api/tinglysning/dokument?uuid=${h.dokumentId}`}
                                        download
                                        className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300"
                                      >
                                        <Download size={10} />
                                        PDF
                                      </a>
                                    )}
                                  </div>
                                  {/* BIZZ-522: revisionshistorik pr. dokument */}
                                  {h.dokumentId && (
                                    <div className="mt-1">
                                      <PaategningTimeline dokumentId={h.dokumentId} lang={lang} />
                                    </div>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* ── Andelsbogen (BIZZ-530) — expandabel med rigtige data ── */}
                <div>
                  <div className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-800/30 transition-colors">
                    <button
                      onClick={() => setAndelsbogOpen((prev) => !prev)}
                      className="flex items-center gap-3 flex-1 text-left min-w-0"
                      disabled={andelsbogData.length === 0 && !andelsbogLoading}
                    >
                      <span className="flex-shrink-0 w-4">
                        {andelsbogLoading ? (
                          <Loader2 size={12} className="animate-spin text-slate-500" />
                        ) : andelsbogData.length === 0 ? (
                          <span />
                        ) : andelsbogOpen ? (
                          <ChevronDown size={13} className="text-slate-500" />
                        ) : (
                          <ChevronRight size={13} className="text-slate-500" />
                        )}
                      </span>
                      <FileText
                        size={15}
                        className={andelsbogData.length > 0 ? 'text-slate-500' : 'text-slate-600'}
                      />
                      <span
                        className={
                          andelsbogData.length > 0
                            ? 'text-slate-200 text-sm'
                            : 'text-slate-400 text-sm'
                        }
                      >
                        {c.cooperativeBook}
                        <span className="text-slate-500 text-xs ml-1">
                          ({andelsbogLoading ? '…' : andelsbogData.length})
                        </span>
                      </span>
                    </button>
                  </div>
                  {andelsbogOpen && andelsbogData.length > 0 && (
                    <div className="border-t border-slate-700/20 bg-slate-900/30 px-4 py-3 space-y-3">
                      {andelsbogFejl && <div className="text-xs text-red-400">{andelsbogFejl}</div>}
                      {andelsbogData.map((andel) => (
                        <div
                          key={andel.uuid}
                          className="bg-slate-800/40 border border-slate-700/40 rounded-lg p-3"
                        >
                          <div className="text-sm text-slate-100 font-medium">
                            {andel.adresse ?? '—'}
                          </div>
                          {(andel.postnr || andel.by) && (
                            <div className="text-xs text-slate-400 mt-0.5">
                              {[andel.postnr, andel.by].filter(Boolean).join(' ')}
                            </div>
                          )}
                          {andel.haeftelser.length === 0 ? (
                            <div className="mt-2 text-xs text-slate-500">
                              {c.andelsbogIngenHaeftelser}
                            </div>
                          ) : (
                            <ul className="mt-2 space-y-2">
                              {andel.haeftelser.map((h, i) => (
                                <li
                                  key={`${andel.uuid}-${h.dokumentId ?? i}`}
                                  className="text-xs text-slate-400"
                                >
                                  <div className="flex flex-wrap items-baseline gap-x-3">
                                    <span className="text-slate-300">{h.type}</span>
                                    {h.hovedstol != null && (
                                      <span>
                                        {h.hovedstol.toLocaleString('da-DK')} {h.valuta}
                                      </span>
                                    )}
                                    {h.kreditor && (
                                      <span className="text-slate-500">
                                        {c.personbogKreditor}: {h.kreditor}
                                      </span>
                                    )}
                                    {h.tinglysningsdato && (
                                      <span className="text-slate-600">{h.tinglysningsdato}</span>
                                    )}
                                    {h.dokumentId && (
                                      <a
                                        href={`/api/tinglysning/dokument?uuid=${h.dokumentId}`}
                                        download
                                        className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300"
                                      >
                                        <Download size={10} />
                                        PDF
                                      </a>
                                    )}
                                  </div>
                                  {/* BIZZ-522: revisionshistorik pr. dokument */}
                                  {h.dokumentId && (
                                    <div className="mt-1">
                                      <PaategningTimeline dokumentId={h.dokumentId} lang={lang} />
                                    </div>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/*
                Fast ejendom (BIZZ-521) — kun kreditor-sektionen vises her.
                "Ejer" er duplikeret med Ejendomme-fanen der bruger EJF som
                sandhedskilde for nuværende ejerskab; tinglysningens
                ejer-liste er historisk og forvirrer. Kreditor er
                tinglysnings-specifik (pantebreve) og hører til her.
              */}
                {(
                  [
                    { rolle: 'kreditor', rows: fastEjendomKreditor, label: c.fastEjendomKreditor },
                  ] as const
                ).map(({ rolle, rows, label }) => {
                  const open = fastEjendomOpen.has(rolle);
                  return (
                    <div key={rolle}>
                      <div className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-800/30 transition-colors">
                        <button
                          onClick={() =>
                            setFastEjendomOpen((prev) => {
                              const next = new Set(prev);
                              if (next.has(rolle)) next.delete(rolle);
                              else next.add(rolle);
                              return next;
                            })
                          }
                          className="flex items-center gap-3 flex-1 text-left min-w-0"
                          disabled={rows.length === 0 && !fastEjendomLoading}
                        >
                          <span className="flex-shrink-0 w-4">
                            {fastEjendomLoading ? (
                              <Loader2 size={12} className="animate-spin text-slate-500" />
                            ) : rows.length === 0 ? (
                              <span />
                            ) : open ? (
                              <ChevronDown size={13} className="text-slate-500" />
                            ) : (
                              <ChevronRight size={13} className="text-slate-500" />
                            )}
                          </span>
                          <FileText
                            size={15}
                            className={rows.length > 0 ? 'text-slate-500' : 'text-slate-600'}
                          />
                          <span
                            className={
                              rows.length > 0 ? 'text-slate-200 text-sm' : 'text-slate-400 text-sm'
                            }
                          >
                            {label}
                            <span className="text-slate-500 text-xs ml-1">
                              ({fastEjendomLoading ? '…' : rows.length})
                            </span>
                          </span>
                        </button>
                      </div>
                      {open && rows.length > 0 && (
                        <div className="border-t border-slate-700/20 bg-slate-900/30 px-4 py-3">
                          {fastEjendomFejl && (
                            <div className="text-xs text-red-400 mb-2">{fastEjendomFejl}</div>
                          )}
                          {/*
                          BIZZ-521 follow-up: Brug tinglysnings-specifik kort-variant.
                          PropertyOwnerCard's auto-enrichment (current ejer, vurdering)
                          er misvisende i tinglysnings-kontekst fordi vi viser
                          historiske adkomster — ikke den aktuelle ejer.
                        */}
                          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                            {(() => {
                              // De-dupliker på BFE: samler alle dokumenter for samme
                              // ejendom i ét kort, så én ejendom = ét kort (med evt.
                              // flere adkomst-typer listet).
                              const groups = new Map<
                                number,
                                { first: VirksomhedEjendomsrolle; all: VirksomhedEjendomsrolle[] }
                              >();
                              for (const r of rows) {
                                const g = groups.get(r.bfe);
                                if (g) g.all.push(r);
                                else groups.set(r.bfe, { first: r, all: [r] });
                              }
                              return Array.from(groups.values()).map(({ first, all }) => {
                                const heading =
                                  first.adresse ??
                                  first.matrikel ??
                                  `BFE ${first.bfe.toLocaleString('da-DK')}`;
                                const subLine =
                                  first.postnr && first.by
                                    ? `${first.postnr} ${first.by}`
                                    : first.adresse
                                      ? first.matrikel
                                      : first.kommune;
                                const detailHref = first.dawaId
                                  ? `/dashboard/ejendomme/${first.dawaId}`
                                  : null;
                                const adkomster = Array.from(
                                  new Set(
                                    all.map((r) => r.adkomstType).filter((x): x is string => !!x)
                                  )
                                );
                                const CardBody = (
                                  <div
                                    className={`group relative flex flex-col bg-slate-800/60 border rounded-xl overflow-hidden transition-all ${
                                      detailHref
                                        ? 'border-slate-700/50 hover:border-emerald-500/40 hover:bg-slate-800/80'
                                        : 'border-slate-700/40'
                                    }`}
                                  >
                                    <div className="h-1 flex-shrink-0 bg-gradient-to-r from-emerald-600/60 to-emerald-500/20" />
                                    <div className="p-4 flex flex-col gap-2">
                                      <div className="flex items-start gap-2">
                                        <MapPin
                                          size={14}
                                          className="mt-0.5 flex-shrink-0 text-emerald-500"
                                        />
                                        <div className="min-w-0">
                                          <p className="text-white font-medium text-sm leading-snug truncate">
                                            {heading}
                                          </p>
                                          {subLine && (
                                            <p className="text-slate-400 text-xs mt-0.5 truncate">
                                              {subLine}
                                            </p>
                                          )}
                                        </div>
                                      </div>
                                      <div className="flex flex-wrap gap-1.5">
                                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] text-slate-400 bg-slate-900/60 font-mono">
                                          BFE {first.bfe.toLocaleString('da-DK')}
                                        </span>
                                        {first.ejendomstype && (
                                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] text-slate-300 bg-slate-900/60">
                                            {first.ejendomstype}
                                          </span>
                                        )}
                                        {adkomster.map((a) => (
                                          <span
                                            key={a}
                                            className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] text-emerald-300 bg-emerald-900/30"
                                          >
                                            {c.fastEjendomAdkomst}: {a}
                                          </span>
                                        ))}
                                      </div>
                                      {/* BIZZ-570: Vis hæftelse-beløb øverst på kreditor-kort.
                                        Sum hvis flere haeftelser på samme BFE. */}
                                      {(() => {
                                        if (rolle !== 'kreditor') return null;
                                        const haeftelser = all.filter(
                                          (r) => r.haeftelseBeloeb != null && r.haeftelseBeloeb > 0
                                        );
                                        if (haeftelser.length === 0) return null;
                                        const sumBeloeb = haeftelser.reduce(
                                          (s, r) => s + (r.haeftelseBeloeb ?? 0),
                                          0
                                        );
                                        const types = Array.from(
                                          new Set(
                                            haeftelser
                                              .map((r) => r.haeftelseType)
                                              .filter((t): t is string => !!t)
                                          )
                                        );
                                        return (
                                          <div className="pt-1.5 border-t border-slate-700/30">
                                            <div className="flex items-baseline gap-2">
                                              <span className="text-amber-400 text-sm font-semibold">
                                                {sumBeloeb.toLocaleString('da-DK')} DKK
                                              </span>
                                              <span className="text-[10px] text-slate-500 uppercase tracking-wide">
                                                {lang === 'da' ? 'Hæftelse' : 'Lien'}
                                                {haeftelser.length > 1
                                                  ? ` × ${haeftelser.length}`
                                                  : ''}
                                              </span>
                                            </div>
                                            {types.length > 0 && (
                                              <p className="text-[10px] text-slate-400 mt-0.5">
                                                {types.join(' · ')}
                                              </p>
                                            )}
                                          </div>
                                        );
                                      })()}
                                      {all.some((r) => r.dokumentAlias) && (
                                        <div className="text-[10px] text-slate-500 font-mono pt-1 border-t border-slate-700/30">
                                          {all
                                            .map((r) => r.dokumentAlias)
                                            .filter((a): a is string => !!a)
                                            .slice(0, 3)
                                            .join(' · ')}
                                          {all.filter((r) => r.dokumentAlias).length > 3 && ' …'}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                );
                                return detailHref ? (
                                  <Link
                                    key={`${rolle}-${first.bfe}`}
                                    href={detailHref}
                                    className="block"
                                  >
                                    {CardBody}
                                  </Link>
                                ) : (
                                  <div key={`${rolle}-${first.bfe}`}>{CardBody}</div>
                                );
                              });
                            })()}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Dokumenter-tab er fjernet — indhold er flyttet til Regnskab- og Tinglysning-tabs */}
        </div>
      </div>
      {/* END left: main content */}

      {/* ─── Adskillelseslinie — nyheder (desktop) ─── */}
      {isDesktop && nyhedsPanelÅben && data && <div className="w-1.5 flex-shrink-0 bg-slate-800" />}

      {/* ─── Nyheder/sociale medier panel (desktop) ─── */}
      {isDesktop && nyhedsPanelÅben && data && (
        <div
          className="flex-shrink-0 self-stretch flex flex-col overflow-hidden border-l border-slate-700/50"
          style={{ width: 340 }}
        >
          {/* Panel-header */}
          <div className="flex items-center justify-between px-4 py-3 bg-slate-900 border-b border-slate-700/50 flex-shrink-0">
            <div className="flex items-center gap-2">
              <Newspaper size={14} className="text-blue-400" />
              <span className="text-white text-sm font-medium">
                {lang === 'da' ? 'Medier & links' : 'Media & links'}
              </span>
            </div>
            <button
              onClick={() => setNyhedsPanelÅben(false)}
              className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
              aria-label={lang === 'da' ? 'Luk panel' : 'Close panel'}
            >
              <X size={14} />
            </button>
          </div>
          {/* Panel-indhold: ØVERST nyheder (AI), NEDERST sociale medier */}
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5 min-h-0">
            {/* AI Artikel søgning */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Sparkles size={12} className="text-blue-400" />
                <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">
                  {lang === 'da' ? 'AI Artikel søgning' : 'AI Article Search'}
                </p>
              </div>
              <AIArticleSearchPanel
                companyData={data}
                lang={lang}
                onSocialsFound={setAiSocials}
                onAlternativesFound={setAiAlternatives}
                onThresholdFound={setConfidenceThreshold}
              />
            </div>
            {/* Sociale medier & links */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Globe size={12} className="text-slate-500" />
                <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">
                  {lang === 'da' ? 'Sociale medier & hjemmeside' : 'Social media & website'}
                </p>
              </div>
              <VerifiedLinks
                entityType="company"
                entityId={cvr}
                entityName={data.name}
                lang={lang}
                aiSocials={aiSocials}
                aiAlternatives={aiAlternatives}
                confidenceThreshold={confidenceThreshold}
              />
            </div>
          </div>
        </div>
      )}

      {/* ─── Mobil: Nyheder-overlay — fylder hele skærmen ─── */}
      {!isDesktop && mobilNyhederAaben && data && (
        <div className="fixed inset-0 z-50 flex flex-col bg-slate-950">
          {/* Overlay-header */}
          <div className="flex items-center justify-between px-4 py-3 bg-slate-900 border-b border-slate-700/50 flex-shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <Newspaper size={15} className="text-blue-400 flex-shrink-0" />
              <span className="text-white text-sm font-medium truncate">
                {lang === 'da' ? 'Medier & links' : 'Media & links'}
              </span>
            </div>
            <button
              onClick={() => setMobilNyhederAaben(false)}
              className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors flex-shrink-0"
              aria-label={lang === 'da' ? 'Luk' : 'Close'}
            >
              <X size={18} />
            </button>
          </div>
          {/* Indhold: ØVERST nyheder (AI), NEDERST sociale medier */}
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5 min-h-0">
            {/* AI Artikel søgning */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Sparkles size={12} className="text-blue-400" />
                <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">
                  {lang === 'da' ? 'AI Artikel søgning' : 'AI Article Search'}
                </p>
              </div>
              <AIArticleSearchPanel
                companyData={data}
                lang={lang}
                onSocialsFound={setAiSocials}
                onAlternativesFound={setAiAlternatives}
                onThresholdFound={setConfidenceThreshold}
              />
            </div>
            {/* Sociale medier & links */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Globe size={12} className="text-slate-500" />
                <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">
                  {lang === 'da' ? 'Sociale medier & hjemmeside' : 'Social media & website'}
                </p>
              </div>
              <VerifiedLinks
                entityType="company"
                entityId={cvr}
                entityName={data.name}
                lang={lang}
                aiSocials={aiSocials}
                aiAlternatives={aiAlternatives}
                confidenceThreshold={confidenceThreshold}
              />
            </div>
          </div>
          {/* Build-nummer — diskret footer i bunden af mobil nyheder-overlay */}
          <div className="px-4 py-2 border-t border-slate-700/30 flex-shrink-0">
            <p className="text-slate-600 text-xs">
              Build: {process.env.NEXT_PUBLIC_BUILD_ID ?? 'dev'}
            </p>
          </div>
        </div>
      )}
      {/* BIZZ-808: Opret sag-modal — virksomhed pre-populeres som kunde */}
      {opretSagOpen && data && (
        <CreateCaseModal
          initialEntity={{
            kind: 'virksomhed',
            id: String(data.vat),
            label: data.name,
          }}
          onClose={() => setOpretSagOpen(false)}
        />
      )}
    </div>
  );
}

// ─── AIArticleSearchPanel ─────────────────────────────────────────────────────

/** Et nyhedsresultat fra AI artikel søgning */
interface AIArticleResult {
  title: string;
  url: string;
  source: string;
  date?: string;
  description?: string;
}

/**
 * Konverterer en dato-streng (ISO, relativ "X days ago" etc.) til sorterbar timestamp.
 * Returnerer 0 hvis datoen ikke kan parses — disse vises sidst.
 *
 * @param dateStr - Datostreng fra API-svar
 * @returns Unix timestamp i millisekunder
 */
function parseDateForClientSort(dateStr: string | undefined): number {
  if (!dateStr) return 0;
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) return d.getTime();
  const agoMatch = dateStr.match(/(\d+)\s+(hour|day|week|month|year|time|dag|uge|m.ned|.r)/i);
  if (agoMatch) {
    const n = parseInt(agoMatch[1], 10);
    const unit = agoMatch[2].toLowerCase();
    const now = Date.now();
    if (unit.startsWith('hour') || unit.startsWith('time')) return now - n * 3_600_000;
    if (unit.startsWith('day') || unit.startsWith('dag')) return now - n * 86_400_000;
    if (unit.startsWith('week') || unit.startsWith('uge')) return now - n * 7 * 86_400_000;
    if (unit.startsWith('month') || unit.startsWith('m')) return now - n * 30 * 86_400_000;
    if (unit.startsWith('year') || unit.startsWith('.r')) return now - n * 365 * 86_400_000;
  }
  return 0;
}

/**
 * AIArticleSearchPanel — AI-drevet artikelsøgning i nyheds-sidepanelet.
 *
 * Viser tokens til rådighed og en "Søg"-knap. Når brugeren klikker,
 * hentes op til 30 seneste nyheder om virksomheden via /api/ai/article-search.
 * Viser første 5 og ekspanderer med 5 ad gangen via "Vis flere".
 * Resultater erstatter Søg-knappen. Token-forbrug trækkes fra brugerens konto.
 * Kalder onSocialsFound med AI-fundne sociale medier-URLs.
 *
 * @param companyData - CVRPublicData for den valgte virksomhed
 * @param lang - Aktivt sprog
 * @param onSocialsFound - Callback med fundne sociale medier-URLs inkl. confidence
 * @param onThresholdFound - Callback med confidence-tærskel fra ai_settings
 */
function AIArticleSearchPanel({
  companyData,
  lang,
  onSocialsFound,
  onAlternativesFound,
  onThresholdFound,
}: {
  companyData: CVRPublicData;
  lang: 'da' | 'en';
  /** Callback med primære sociale medier-URLs inkl. confidence metadata */
  onSocialsFound?: (
    socials: Record<string, { url: string; confidence: number; reason?: string }>
  ) => void;
  /** Callback med alternative links per platform inkl. confidence metadata */
  onAlternativesFound?: (
    alternatives: Record<string, Array<{ url: string; confidence: number; reason?: string }>>
  ) => void;
  /** Callback med confidence-tærskel fra ai_settings */
  onThresholdFound?: (threshold: number) => void;
}) {
  const { subscription: ctxSub, addTokenUsage, isAdmin } = useSubscription();
  const { isActive: subActive } = useSubscriptionAccess('ai');
  const [articles, setArticles] = useState<AIArticleResult[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  /** Individuelle loading-states per søge-kategori — til progressiv visning */
  const [socialsLoading, setSocialsLoading] = useState(false);
  const [articlesLoading, setArticlesLoading] = useState(false);
  /**
   * Fase for artikelsøgning:
   * - 'idle'    — ikke søgt endnu
   * - 'raw'     — Serper-resultater vist (foreløbige, Claude-verificering i gang)
   * - 'curated' — Claude har returneret kurerede resultater
   */
  const [articlesPhase, setArticlesPhase] = useState<'idle' | 'raw' | 'curated'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [tokenInfo, setTokenInfo] = useState<{ used: number; limit: number } | null>(null);
  const [tokensUsedThisSearch, setTokensUsedThisSearch] = useState(0);
  /** Antal synlige artikler — starter på 5, øges med 5 ved hvert "Vis flere"-klik */
  const [visibleCount, setVisibleCount] = useState(5);

  /** Mindst én søge-kategori er stadig i gang */
  const anyLoading = socialsLoading || articlesLoading;

  /** Opdaterer token-info fra subscription context */
  useEffect(() => {
    if (!ctxSub) {
      setTokenInfo(null);
      return;
    }
    const plan = resolvePlan(ctxSub.planId);
    if (!plan.aiEnabled) {
      setTokenInfo(null);
      return;
    }
    const limit =
      plan.aiTokensPerMonth < 0 ? -1 : plan.aiTokensPerMonth + (ctxSub.bonusTokens ?? 0);
    setTokenInfo({ used: ctxSub.tokensUsedThisMonth, limit });
  }, [ctxSub]);

  /** Bygger liste af nøglepersoner fra deltagere-array */
  const keyPersons = useMemo(() => {
    return (companyData.deltagere ?? [])
      .filter((d) => !d.erVirksomhed && d.roller.some((r) => !r.til))
      .map((d) => d.navn)
      .slice(0, 8);
  }, [companyData.deltagere]);

  /**
   * Starter AI-søgning med 2 parallelle kald (socials + articles).
   * Hvert kald opdaterer sin egen loading-state og viser resultater progressivt.
   */
  const handleSearch = useCallback(async () => {
    if (anyLoading) return;

    // Admin users bypass subscription/token gating (mirrors subActive = isAdmin || ...).
    if (ctxSub && !isAdmin) {
      const plan = resolvePlan(ctxSub.planId);
      if (!isSubscriptionFunctional(ctxSub, plan)) return;
      if (!plan.aiEnabled) return;
      const limit =
        plan.aiTokensPerMonth < 0 ? -1 : plan.aiTokensPerMonth + (ctxSub.bonusTokens ?? 0);
      if (limit > 0 && ctxSub.tokensUsedThisMonth >= limit) return;
    }

    setHasSearched(true);
    setError(null);
    setArticles([]);
    setArticlesPhase('idle');
    setVisibleCount(5);
    setSocialsLoading(true);
    setArticlesLoading(true);
    setTokensUsedThisSearch(0);

    const payload = JSON.stringify({
      companyName: companyData.name,
      cvr: String(companyData.vat),
      industry: companyData.industrydesc,
      employees: companyData.employees,
      city: companyData.city,
      keyPersons,
    });

    // ── Sociale medier (hurtigst ~2s) ──
    const socialsPromise = fetch('/api/ai/article-search/socials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    })
      .then(async (res) => {
        const json = await res.json();
        type SocialMeta = { url: string; confidence: number; reason?: string };
        const socialsWithMeta = json.socialsWithMeta as Record<string, SocialMeta> | undefined;
        if (socialsWithMeta && Object.keys(socialsWithMeta).length > 0) {
          onSocialsFound?.(socialsWithMeta);
        }
        type AltMeta = { url: string; confidence: number; reason?: string };
        const altsWithMeta = json.alternativesWithMeta as Record<string, AltMeta[]> | undefined;
        if (altsWithMeta && Object.keys(altsWithMeta).length > 0) {
          onAlternativesFound?.(altsWithMeta);
          // Gem string-URL-version til Supabase (backward compat)
          const stringAlts: Record<string, string[]> = {};
          for (const [k, arr] of Object.entries(altsWithMeta)) {
            stringAlts[k] = arr.map((a) => a.url);
          }
          fetch('/api/link-alternatives', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cvr: String(companyData.vat), alternatives: stringAlts }),
          }).catch(() => {
            /* ignore */
          });
        }
        if (typeof json.confidenceThreshold === 'number') {
          onThresholdFound?.(json.confidenceThreshold);
        }
        return (json.tokensUsed as number) ?? 0;
      })
      .catch(() => 0)
      .finally(() => setSocialsLoading(false));

    // ── Artikler — progressiv to-fase loading ──
    // Fase 1 (?phase=raw, ~2-3s): Serper-resultater vises straks uden Claude.
    // Fase 2 (?phase=ai, ~20-60s): Claude rangerer/filtrerer — erstatter raw hvis der er resultater.
    // Begge kald startes parallelt så ventetiden på fase 2 begynder straks.

    const rawArticlesPromise = fetch('/api/ai/article-search/articles?phase=raw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    })
      .then(async (res) => {
        const json = await res.json();
        const rawArticles: AIArticleResult[] = json.articles ?? [];
        if (rawArticles.length > 0) {
          // Sortér nyeste artikler øverst uanset API-rækkefølge
          const sorted = [...rawArticles].sort(
            (a, b) => parseDateForClientSort(b.date) - parseDateForClientSort(a.date)
          );
          setArticles(sorted);
          setArticlesPhase('raw');
          setVisibleCount(5);
        }
      })
      .catch(() => {
        // Stille fejl — AI-fasen fortsætter
      });

    const aiArticlesPromise = fetch('/api/ai/article-search/articles?phase=ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    })
      .then(async (res) => {
        const json = await res.json();
        if (json.error) setError(json.error);
        const aiArticles: AIArticleResult[] = json.articles ?? [];
        if (aiArticles.length > 0) {
          // Claude returnerede kuraterede resultater — erstat foreløbige
          const sorted = [...aiArticles].sort(
            (a, b) => parseDateForClientSort(b.date) - parseDateForClientSort(a.date)
          );
          setArticles(sorted);
          setVisibleCount(5);
        }
        // Sæt altid fase til curated når AI-kaldet er færdigt (selv hvis 0 resultater)
        setArticlesPhase('curated');
        return (json.tokensUsed as number) ?? 0;
      })
      .catch(() => 0)
      .finally(() => setArticlesLoading(false));

    const articlesPromise = rawArticlesPromise
      .then(() => aiArticlesPromise)
      .then((tokens) => tokens);

    // ── Vent på begge og rapportér samlet token-forbrug ──
    const [socialsTokens, articlesTokens] = await Promise.all([socialsPromise, articlesPromise]);
    const total = socialsTokens + articlesTokens;
    if (total > 0) {
      setTokensUsedThisSearch(total);
      addTokenUsage(total);
      // Server already persists tokens — removed to prevent double-counting (BIZZ-343)
      // syncTokenUsageToServer(total);
    }
  }, [
    anyLoading,
    ctxSub,
    isAdmin,
    companyData,
    keyPersons,
    addTokenUsage,
    onSocialsFound,
    onAlternativesFound,
    onThresholdFound,
    setArticlesPhase,
  ]);

  const da = lang === 'da';

  /** Locked state — ingen AI-adgang */
  if (!subActive) {
    return (
      <div className="flex flex-col items-center gap-2 py-3 text-center">
        <div className="w-8 h-8 bg-amber-500/10 rounded-lg flex items-center justify-center">
          <Lock size={14} className="text-amber-400" />
        </div>
        <p className="text-slate-500 text-xs leading-relaxed">
          {da
            ? 'AI-søgning kræver et aktivt abonnement.'
            : 'AI search requires an active subscription.'}
        </p>
      </div>
    );
  }

  /** Token-statusbar (vises over knap og resultater) */
  const tokenBar =
    tokenInfo && (tokenInfo.limit > 0 || tokenInfo.limit === -1) ? (
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[10px] text-slate-600 whitespace-nowrap">Tokens</span>
        {tokenInfo.limit === -1 ? (
          <>
            <div className="flex-1 h-1 bg-slate-800 rounded-full overflow-hidden">
              <div className="h-full rounded-full bg-purple-500 w-full" />
            </div>
            <span className="text-[10px] font-medium text-purple-400">∞</span>
          </>
        ) : (
          <>
            <div className="flex-1 h-1 bg-slate-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  tokenInfo.used / tokenInfo.limit > 0.9
                    ? 'bg-red-500'
                    : tokenInfo.used / tokenInfo.limit > 0.7
                      ? 'bg-amber-500'
                      : 'bg-blue-500'
                }`}
                style={{ width: `${Math.min(100, (tokenInfo.used / tokenInfo.limit) * 100)}%` }}
              />
            </div>
            <span
              className={`text-[10px] font-medium whitespace-nowrap ${
                tokenInfo.used / tokenInfo.limit > 0.9
                  ? 'text-red-400'
                  : tokenInfo.used / tokenInfo.limit > 0.7
                    ? 'text-amber-400'
                    : 'text-slate-500'
              }`}
            >
              {formatTokens(tokenInfo.used)}/{formatTokens(tokenInfo.limit)}
            </span>
          </>
        )}
      </div>
    ) : null;

  /** AI disclaimer — vises altid under token-bar */
  const aiDisclaimer = (
    <p className="text-xs text-slate-500 mb-3">
      ⚠️ Svar genereret af AI er ikke nødvendigvis korrekte. Verificér altid vigtig information.
    </p>
  );

  /** Go-state — søgning ikke startet endnu */
  if (!hasSearched) {
    return (
      <div>
        {tokenBar}
        {aiDisclaimer}
        <p className="text-slate-300 text-xs mb-3 leading-relaxed">
          {da
            ? `Klik for at finde op til 30 seneste danske nyheder om ${companyData.name} og link til virksomhedens sider på sociale medier.`
            : `Click to find up to 30 latest Danish news articles about ${companyData.name} and links to the company's social media pages.`}
        </p>
        <button
          onClick={handleSearch}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 border border-blue-500/60 rounded-lg text-white text-xs font-medium transition-all"
        >
          <Zap size={12} />
          {da ? 'Søg med AI' : 'Search with AI'}
        </button>
      </div>
    );
  }

  /** Progressiv resultat-state — vises når søgning er startet */
  return (
    <div>
      {tokenBar}
      {aiDisclaimer}

      {/* Aktive loading-indikatorer per kategori */}
      {anyLoading && (
        <div className="space-y-1 mb-3">
          {socialsLoading && (
            <div className="flex items-center gap-2 text-slate-400 text-xs">
              <Loader2 size={10} className="animate-spin text-blue-400 flex-shrink-0" />
              <span>{da ? 'Søger sociale medier…' : 'Searching social media…'}</span>
            </div>
          )}
          {articlesLoading && (
            <div className="flex items-center gap-2 text-slate-400 text-xs">
              <Loader2 size={10} className="animate-spin text-purple-400 flex-shrink-0" />
              <span>
                {articlesPhase === 'raw'
                  ? da
                    ? 'Bekræfter med AI…'
                    : 'Verifying with AI…'
                  : da
                    ? 'Søger artikler…'
                    : 'Searching articles…'}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Token-forbrug (vises når alle er færdige) */}
      {!anyLoading && tokensUsedThisSearch > 0 && (
        <p className="text-[10px] text-slate-600 mb-3">
          {da
            ? `Brugte ${formatTokens(tokensUsedThisSearch)} tokens`
            : `Used ${formatTokens(tokensUsedThisSearch)} tokens`}
        </p>
      )}

      {error && <p className="text-red-400 text-xs mb-2">{error}</p>}

      {/* Foreløbige resultater-badge — vises mens AI-verificering kører */}
      {articlesPhase === 'raw' && articles.length > 0 && (
        <p className="text-[10px] text-amber-500/70 mb-1.5">
          {da ? 'Foreløbige resultater — AI verificerer…' : 'Preliminary results — AI verifying…'}
        </p>
      )}

      {/* Artikler — fade-in når de ankommer */}
      {articlesLoading && articles.length === 0 ? null : articles.length === 0 &&
        !articlesLoading ? (
        <p className="text-slate-600 text-xs">
          {da
            ? 'Ingen danske medieartikler fundet for denne virksomhed.'
            : 'No Danish media articles found for this company.'}
        </p>
      ) : (
        <div
          className="space-y-2.5"
          style={{ animation: articles.length > 0 ? 'fadeIn 0.4s ease-in' : undefined }}
        >
          {articles.slice(0, visibleCount).map((a, i) => (
            <a
              key={i}
              href={a.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-start gap-2 group"
            >
              <ExternalLink
                size={10}
                className="text-slate-600 group-hover:text-blue-400 flex-shrink-0 mt-0.5"
              />
              <div className="min-w-0">
                <p className="text-slate-300 text-xs font-medium group-hover:text-blue-300 transition-colors leading-snug">
                  {a.title}
                </p>
                <p className="text-slate-600 text-[10px] mt-0.5">
                  {a.source}
                  {a.date ? ` · ${a.date}` : ''}
                </p>
                {a.description && (
                  <p className="text-slate-600 text-[10px] mt-0.5 line-clamp-2">{a.description}</p>
                )}
              </div>
            </a>
          ))}
          {visibleCount < articles.length && (
            <button
              onClick={() => setVisibleCount((c) => Math.min(c + 5, articles.length))}
              className="mt-1 flex items-center gap-1 text-[10px] text-slate-500 hover:text-blue-400 transition-colors"
            >
              <ChevronDown size={10} />
              {da
                ? `Vis flere (${articles.length - visibleCount} mere)`
                : `Show more (${articles.length - visibleCount} more)`}
            </button>
          )}
        </div>
      )}

      {/* Søg igen (vises kun når alt er færdigt) */}
      {!anyLoading && (
        <button
          onClick={handleSearch}
          className="mt-3 flex items-center gap-1.5 text-[10px] text-slate-500 hover:text-blue-400 transition-colors"
        >
          <Zap size={9} />
          {da ? 'Søg igen' : 'Search again'}
        </button>
      )}
    </div>
  );
}

// ─── Hjælpekomponenter ────────────────────────────────────────────────────────

interface InfoKortProps {
  /** Ikon vist til venstre for label */
  ikon: React.ReactNode;
  /** Label-tekst (grå, lille) */
  label: string;
  /** Værdi-tekst (hvid, fed) */
  vaerdi: string;
  /** Ekstra element efter værdien (valgfrit) */
  ekstra?: React.ReactNode;
}

/**
 * InfoKort — Lille informationskort med ikon, label og værdi.
 * Bruges i grid-layout til at vise virksomhedsnøgletal.
 *
 * @param props - Se InfoKortProps
 */
function _InfoKort({ ikon, label, vaerdi, ekstra }: InfoKortProps) {
  return (
    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        {ikon}
        <span className="text-slate-500 text-xs uppercase tracking-wide">{label}</span>
      </div>
      <div className="flex items-center">
        <p className="text-white font-medium text-sm">{vaerdi}</p>
        {ekstra}
      </div>
    </div>
  );
}

interface StamdataRaekkeProps {
  /** Label (grå) */
  label: string;
  /** Værdi (hvid) */
  vaerdi: string;
  /** Brug monospace font til værdien */
  mono?: boolean;
  /** Spænd over begge kolonner i grid */
  span2?: boolean;
}

/**
 * StamdataRaekke — Viser en label-value pair til stamdata-sektion.
 *
 * @param props - Se StamdataRaekkeProps
 */
function _StamdataRaekke({ label, vaerdi, mono, span2 }: StamdataRaekkeProps) {
  return (
    <div className={span2 ? 'sm:col-span-2' : ''}>
      <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-white text-sm ${mono ? 'font-mono' : ''}`}>{vaerdi}</p>
    </div>
  );
}

interface EmptyStateProps {
  /** Ikon over teksten */
  ikon: React.ReactNode;
  /** Beskedtekst */
  tekst: string;
}

/**
 * EmptyState — Viser et tomt-tilstands-besked med ikon.
 *
 * @param props - Se EmptyStateProps
 */
function EmptyState({ ikon, tekst }: EmptyStateProps) {
  return (
    <div className="text-center py-12">
      <div className="mx-auto mb-3 flex justify-center">{ikon}</div>
      <p className="text-slate-400 text-sm">{tekst}</p>
    </div>
  );
}

interface _PlaceholderTabProps {
  /** Ikon centreret over titel */
  ikon: React.ReactNode;
  /** Tab-overskrift */
  titel: string;
  /** Beskrivelsestekst */
  beskrivelse: string;
  /** "Kommer snart"-label */
  comingSoon: string;
}

// ─── Personbog (Tinglysning) ────────────────────────────────────────────────

/** Typekonfig for farvekodede personbog-sektioner */
const personbogSektioner: {
  key: string;
  color: string;
  bgClass: string;
  textClass: string;
  borderClass: string;
}[] = [
  {
    key: 'virksomhedspant',
    color: 'amber',
    bgClass: 'bg-amber-500/5',
    textClass: 'text-amber-400',
    borderClass: 'border-amber-500/20',
  },
  {
    key: 'loesoerepant',
    color: 'teal',
    bgClass: 'bg-teal-500/5',
    textClass: 'text-teal-400',
    borderClass: 'border-teal-500/20',
  },
  {
    key: 'fordringspant',
    color: 'cyan',
    bgClass: 'bg-cyan-500/5',
    textClass: 'text-cyan-400',
    borderClass: 'border-cyan-500/20',
  },
  {
    key: 'ejendomsforbehold',
    color: 'purple',
    bgClass: 'bg-purple-500/5',
    textClass: 'text-purple-400',
    borderClass: 'border-purple-500/20',
  },
];

/** Oversætter personbog-typenøgler til UI-labels */
function personbogTypeLabel(key: string, c: (typeof translations)['da']['company']): string {
  const map: Record<string, string> = {
    virksomhedspant: c.personbogVirksomhedspant,
    loesoerepant: c.personbogLoesoerepant,
    fordringspant: c.personbogFordringspant,
    ejendomsforbehold: c.personbogEjendomsforbehold,
  };
  return map[key] ?? key;
}

/** Oversætter pantomfang-nøgler til UI-labels */
function pantOmfangLabel(key: string, c: (typeof translations)['da']['company']): string {
  const lower = key.toLowerCase();
  if (lower.includes('varelager')) return c.personbogVarelager;
  if (lower.includes('driftsinventar') || lower.includes('driftsmateriel'))
    return c.personbogDriftsinventar;
  if (lower.includes('fordring')) return c.personbogFordringer;
  if (lower.includes('immateriel')) return c.personbogImmaterielleRettigheder;
  return key;
}

interface PersonbogSectionProps {
  haeftelser: PersonbogHaeftelse[];
  loading: boolean;
  fejl: string | null;
  c: (typeof translations)['da']['company'];
  da: boolean;
  expandedPant: Set<number>;
  setExpandedPant: React.Dispatch<React.SetStateAction<Set<number>>>;
  selectedPantDocs: Set<string>;
  setSelectedPantDocs: React.Dispatch<React.SetStateAction<Set<string>>>;
  /** BIZZ-533: Tinglyste dokumenter (vedtægter/fusioner/ejerpantebreve) */
  dokumenter?: {
    vedtaegter: PersonbogDokument[];
    fusioner: PersonbogDokument[];
    ejerpantebreve: PersonbogDokument[];
  };
}

/**
 * PersonbogSection — Viser personbogshæftelser for en virksomhed.
 * Farvekodede sektioner grupperet efter type: Virksomhedspant, Løsørepant,
 * Fordringspant, Ejendomsforbehold. Matcher tinglysning-tab-designet fra ejendomssiden.
 *
 * @param props - Se PersonbogSectionProps
 */
function PersonbogSection({
  haeftelser,
  loading,
  fejl,
  c,
  da,
  expandedPant,
  setExpandedPant,
  selectedPantDocs,
  setSelectedPantDocs,
  dokumenter,
}: PersonbogSectionProps) {
  /** Loading state — inline compact (vises inde i den ekspanderede personbog-række) */
  if (loading) {
    return (
      <div className="flex items-center gap-2 px-4 py-3">
        <Loader2 size={14} className="text-blue-400 animate-spin flex-shrink-0" />
        <p className="text-slate-400 text-xs">{c.loadingPersonbog}</p>
      </div>
    );
  }

  /** Error state — inline compact */
  if (fejl) {
    return (
      <div className="flex items-center gap-2 px-4 py-3">
        <AlertTriangle size={14} className="text-amber-400 flex-shrink-0" />
        <p className="text-slate-400 text-xs">{fejl}</p>
      </div>
    );
  }

  /** Empty state — compact single line */
  if (haeftelser.length === 0) {
    return <p className="text-slate-500 text-xs px-4 py-3 italic">{c.personbogEmpty}</p>;
  }

  /** Gruppér hæftelser efter type */
  const grouped: Record<string, PersonbogHaeftelse[]> = {};
  for (const h of haeftelser) {
    const key = h.type;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(h);
  }

  /** Selectérbare dokumenter */
  const allDocs = haeftelser.filter((h) => h.dokumentId).map((h) => h.dokumentId!);

  const toggleExpand = (idx: number) => {
    setExpandedPant((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const toggleDoc = (id: string) => {
    setSelectedPantDocs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const _toggleAllDocs = () => {
    if (selectedPantDocs.size === allDocs.length) {
      setSelectedPantDocs(new Set());
    } else {
      setSelectedPantDocs(new Set(allDocs));
    }
  };

  /** Globalt indeks over hæftelser — bruges til expand-toggle */
  let globalIdx = 0;

  return (
    <>
      {/* Kolonneoverskrifter */}
      <div className="grid grid-cols-[24px_36px_90px_1fr_100px_100px_50px_28px] gap-x-2 px-4 py-1.5 border-b border-slate-700/20">
        <span />
        <span className="text-[10px] font-medium text-slate-500 uppercase">Pri.</span>
        <span className="text-[10px] font-medium text-slate-500 uppercase">
          {da ? 'Dato' : 'Date'}
        </span>
        <span className="text-[10px] font-medium text-slate-500 uppercase">
          {da ? 'Dokument' : 'Document'}
        </span>
        <span className="text-[10px] font-medium text-slate-500 uppercase">
          {da ? 'Beløb' : 'Amount'}
        </span>
        <span className="text-[10px] font-medium text-slate-500 uppercase">Type</span>
        <span className="text-[10px] font-medium text-slate-500 uppercase">
          {da ? 'Dok.' : 'Doc.'}
        </span>
        <span />
      </div>

      {/* ── Farvekodede sektioner ── */}
      {personbogSektioner.map(({ key, bgClass, textClass, borderClass }) => {
        const items = grouped[key];
        if (!items || items.length === 0) return null;

        return (
          <div key={key}>
            {/* Sektionsheader — matcher ejendomssiden */}
            <div className={`${bgClass} px-4 py-1.5 border-b border-slate-700/20`}>
              <span className={`text-[10px] font-semibold ${textClass} uppercase tracking-wider`}>
                {personbogTypeLabel(key, c)} ({items.length})
              </span>
            </div>

            {/* Rækker */}
            {items.map((h) => {
              const idx = globalIdx++;
              const isExpanded = expandedPant.has(idx);
              return (
                <div key={idx}>
                  {/* Kollapset række — matcher ejendomssiden */}
                  <div
                    className="grid grid-cols-[24px_36px_90px_1fr_100px_100px_50px_28px] gap-x-2 px-4 py-2 hover:bg-slate-700/10 transition-colors items-center cursor-pointer border-b border-slate-700/15"
                    onClick={() => toggleExpand(idx)}
                  >
                    {isExpanded ? (
                      <ChevronDown size={12} className="text-slate-500" />
                    ) : (
                      <ChevronRight size={12} className="text-slate-500" />
                    )}
                    <span className="text-xs text-slate-400 tabular-nums">
                      {String(h.prioritet ?? '')}
                    </span>
                    <span className="text-xs text-slate-400 tabular-nums whitespace-nowrap">
                      {h.tinglysningsdato ? formatDatoKort(h.tinglysningsdato) : ''}
                    </span>
                    <div className="min-w-0">
                      <span className="text-sm text-slate-200 truncate block">
                        {personbogTypeLabel(h.type, c)}
                      </span>
                      {h.debitorer.length > 0 && (
                        <span className="text-[10px] text-slate-500 truncate block">
                          {h.debitorer.join(', ')}
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-slate-300 tabular-nums text-right">
                      {h.hovedstol != null && h.hovedstol > 0
                        ? `${h.hovedstol.toLocaleString('da-DK')} ${h.valuta}`
                        : ''}
                    </span>
                    <span className="text-xs text-slate-400 truncate">
                      {String(h.kreditor ?? '')}
                    </span>
                    <div
                      className="flex items-center gap-1.5"
                      onClick={(ev) => ev.stopPropagation()}
                    >
                      {h.dokumentId && (
                        <a
                          href={`/api/tinglysning/dokument?uuid=${h.dokumentId}`}
                          download
                          className="inline-flex items-center gap-0.5 text-xs text-blue-400 hover:text-blue-300"
                        >
                          <FileText size={11} />
                          PDF
                        </a>
                      )}
                    </div>
                    {h.dokumentId ? (
                      <label
                        className="flex items-center cursor-pointer flex-shrink-0"
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={selectedPantDocs.has(h.dokumentId)}
                          onChange={() => toggleDoc(h.dokumentId!)}
                        />
                        <span
                          className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${selectedPantDocs.has(h.dokumentId) ? 'bg-blue-500 border-blue-500' : 'bg-[#0a1020] border-slate-400'}`}
                        >
                          {selectedPantDocs.has(h.dokumentId) && (
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
                    ) : (
                      <span />
                    )}
                  </div>

                  {/* Expanderet detalje-panel — matcher ejendomssiden */}
                  {isExpanded && (
                    <div className={`px-4 pb-3 ml-10 border-l-2 ${borderClass}`}>
                      {/* Omfang-badges (virksomhedspant) */}
                      {h.pantTyper.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mb-3">
                          {h.pantTyper.map((p, pi) => (
                            <span
                              key={pi}
                              className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${bgClass} ${textClass}`}
                            >
                              {pantOmfangLabel(p, c)}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Detalje-grid */}
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2 text-xs mt-1">
                        {/* Kreditor */}
                        {h.kreditor && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {c.personbogKreditor}
                            </p>
                            <p className="text-white">
                              {h.kreditorCvr ? (
                                <Link
                                  href={`/dashboard/companies/${h.kreditorCvr}`}
                                  className="text-blue-400 hover:underline"
                                >
                                  {h.kreditor}
                                </Link>
                              ) : (
                                h.kreditor
                              )}
                            </p>
                          </div>
                        )}

                        {/* Debitor(er) */}
                        {h.debitorer.length > 0 && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {c.personbogDebitor}
                            </p>
                            {h.debitorer.map((d, di) => (
                              <p key={di} className="text-white">
                                {h.debitorCvr[di] ? (
                                  <Link
                                    href={`/dashboard/companies/${h.debitorCvr[di]}`}
                                    className="text-blue-400 hover:underline"
                                  >
                                    {d}
                                  </Link>
                                ) : (
                                  d
                                )}
                              </p>
                            ))}
                          </div>
                        )}

                        {/* Hovedstol */}
                        {h.hovedstol != null && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {c.personbogHovedstol}
                            </p>
                            <p className="text-white">
                              {h.hovedstol.toLocaleString('da-DK')} {h.valuta}
                            </p>
                          </div>
                        )}

                        {/* Rente */}
                        {h.rente != null && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {c.personbogRente}
                            </p>
                            <p className="text-white">
                              {h.rente}% {h.renteType ? `(${h.renteType})` : ''}
                            </p>
                          </div>
                        )}

                        {/* BIZZ-532: Referencerente + tillæg */}
                        {h.referenceRenteNavn && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {da ? 'Referencerente' : 'Reference rate'}
                            </p>
                            <p className="text-white">
                              {h.referenceRenteNavn}
                              {h.referenceRenteSats != null && ` (${h.referenceRenteSats}%)`}
                              {h.renteTillaeg != null && ` + ${h.renteTillaeg}%`}
                            </p>
                          </div>
                        )}

                        {/* BIZZ-532: Kreditorbetegnelse */}
                        {h.kreditorbetegnelse && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {da ? 'Kreditorbetegnelse' : 'Creditor designation'}
                            </p>
                            <p className="text-white">{h.kreditorbetegnelse}</p>
                          </div>
                        )}

                        {/* BIZZ-532: Låntype + pantebrevformular */}
                        {(h.laantype || h.pantebrevFormular) && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {da ? 'Låntype' : 'Loan type'}
                            </p>
                            <p className="text-white">
                              {[h.laantype, h.pantebrevFormular].filter(Boolean).join(' · ')}
                            </p>
                          </div>
                        )}

                        {/* Tinglysningsdato */}
                        {h.tinglysningsdato && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {c.personbogTinglysningsdato}
                            </p>
                            <p className="text-white">{formatDatoKort(h.tinglysningsdato)}</p>
                          </div>
                        )}

                        {/* Registreringsdato */}
                        {h.registreringsdato && h.registreringsdato !== h.tinglysningsdato && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {c.personbogRegistreringsdato}
                            </p>
                            <p className="text-white">{formatDatoKort(h.registreringsdato)}</p>
                          </div>
                        )}

                        {/* Tinglysningsafgift */}
                        {h.tinglysningsafgift != null && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {c.personbogTinglysningsafgift}
                            </p>
                            <p className="text-white">
                              {h.tinglysningsafgift.toLocaleString('da-DK')} DKK
                            </p>
                          </div>
                        )}

                        {/* Løbetid */}
                        {h.loebetid && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {c.personbogLoebetid}
                            </p>
                            <p className="text-white">{h.loebetid}</p>
                          </div>
                        )}

                        {/* Dokumentalias */}
                        {h.dokumentAlias && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {da ? 'Dokument' : 'Document'}
                            </p>
                            <p className="text-white text-[11px]">{h.dokumentAlias}</p>
                          </div>
                        )}
                      </div>

                      {/* Vilkår */}
                      {h.vilkaar && (
                        <div className="mt-2 pt-2 border-t border-slate-700/20">
                          <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                            {c.personbogVilkaar}
                          </p>
                          <p className="text-slate-300 text-xs mt-0.5 whitespace-pre-line">
                            {h.vilkaar}
                          </p>
                        </div>
                      )}

                      {/* Anmelder */}
                      {h.anmelderNavn && (
                        <div className="mt-2 pt-2 border-t border-slate-700/20">
                          <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                            {c.personbogAnmelder}
                          </p>
                          <p className="text-white text-xs">
                            {h.anmelderCvr ? (
                              <Link
                                href={`/dashboard/companies/${h.anmelderCvr}`}
                                className="text-blue-400 hover:underline"
                              >
                                {h.anmelderNavn}
                              </Link>
                            ) : (
                              h.anmelderNavn
                            )}
                          </p>
                        </div>
                      )}

                      {/* BIZZ-522: revisionshistorik (påtegninger) pr. dokument */}
                      {h.dokumentId && (
                        <div className="mt-2 pt-2 border-t border-slate-700/20">
                          <PaategningTimeline dokumentId={h.dokumentId} lang={da ? 'da' : 'en'} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}

      {/* Øvrige hæftelser (ukendte typer) */}
      {(() => {
        const knownKeys = personbogSektioner.map((s) => s.key);
        const oevrige = Object.entries(grouped).filter(([key]) => !knownKeys.includes(key));
        if (oevrige.length === 0) return null;

        return oevrige.map(([key, items]) => (
          <div key={key}>
            <div className="bg-slate-500/5 px-4 py-1.5 border-b border-slate-700/20">
              <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                {c.personbogOevrige}: {key} ({items.length})
              </span>
            </div>
            {items.map((h) => {
              const idx = globalIdx++;
              const isExpanded = expandedPant.has(idx);
              const docId = String(h.dokumentId ?? '');
              return (
                <div key={idx} className="border-b border-slate-700/15">
                  <div
                    className="grid grid-cols-[24px_36px_90px_1fr_100px_100px_50px_28px] gap-x-2 px-4 py-2 hover:bg-slate-700/10 transition-colors items-center cursor-pointer"
                    onClick={() => toggleExpand(idx)}
                  >
                    {isExpanded ? (
                      <ChevronDown size={12} className="text-slate-500" />
                    ) : (
                      <ChevronRight size={12} className="text-slate-500" />
                    )}
                    <span className="text-xs text-slate-400 tabular-nums">
                      {String(h.prioritet ?? '')}
                    </span>
                    <span className="text-xs text-slate-400 tabular-nums whitespace-nowrap">
                      {h.tinglysningsdato ? formatDatoKort(h.tinglysningsdato) : ''}
                    </span>
                    <span className="text-sm text-slate-200 truncate">{key}</span>
                    <span className="text-xs text-slate-300 tabular-nums text-right">
                      {h.hovedstol != null && h.hovedstol > 0
                        ? `${h.hovedstol.toLocaleString('da-DK')} ${h.valuta}`
                        : ''}
                    </span>
                    <span className="text-xs text-slate-400 truncate">
                      {String(h.kreditor ?? '')}
                    </span>
                    <div
                      className="flex items-center gap-1.5"
                      onClick={(ev) => ev.stopPropagation()}
                    >
                      {docId && (
                        <a
                          href={`/api/tinglysning/dokument?uuid=${docId}`}
                          download
                          className="inline-flex items-center gap-0.5 text-xs text-blue-400 hover:text-blue-300"
                        >
                          <FileText size={11} /> PDF
                        </a>
                      )}
                    </div>
                    {docId ? (
                      <label
                        className="flex items-center cursor-pointer flex-shrink-0"
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={selectedPantDocs.has(docId)}
                          onChange={() => toggleDoc(docId)}
                        />
                        <span
                          className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${selectedPantDocs.has(docId) ? 'bg-blue-500 border-blue-500' : 'bg-[#0a1020] border-slate-400'}`}
                        >
                          {selectedPantDocs.has(docId) && (
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
                    ) : (
                      <span />
                    )}
                  </div>
                  {isExpanded && (
                    <div className="px-4 pb-3 ml-10 border-l-2 border-slate-500/20">
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2 text-xs mt-1">
                        {h.kreditor && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {c.personbogKreditor}
                            </p>
                            <p className="text-white">{h.kreditor}</p>
                          </div>
                        )}
                        {h.hovedstol != null && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {c.personbogHovedstol}
                            </p>
                            <p className="text-white">
                              {h.hovedstol.toLocaleString('da-DK')} {h.valuta}
                            </p>
                          </div>
                        )}
                        {h.tinglysningsdato && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {c.personbogTinglysningsdato}
                            </p>
                            <p className="text-white">{formatDatoKort(h.tinglysningsdato)}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ));
      })()}

      {/* BIZZ-533: Tinglyste dokumenter (vedtægter, fusioner, ejerpantebreve) */}
      {dokumenter &&
        (dokumenter.vedtaegter.length > 0 ||
          dokumenter.fusioner.length > 0 ||
          dokumenter.ejerpantebreve.length > 0) && (
          <div className="px-4 py-3 border-t border-slate-700/20 space-y-2">
            <p className="text-slate-500 text-[10px] uppercase tracking-wider font-semibold">
              {da ? 'Øvrige tinglyste dokumenter' : 'Other registered documents'}
            </p>
            {dokumenter.vedtaegter.length > 0 && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-400">
                  {da ? 'Vedtægter' : 'Articles of association'}:
                </span>
                <span className="text-white font-medium">{dokumenter.vedtaegter.length}</span>
                <span className="text-slate-500">
                  {dokumenter.vedtaegter
                    .map((d) => d.tinglysningsdato)
                    .filter(Boolean)
                    .slice(0, 3)
                    .join(', ')}
                </span>
              </div>
            )}
            {dokumenter.fusioner.length > 0 && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-400">
                  {da ? 'Fusioner/spaltninger' : 'Mergers/demergers'}:
                </span>
                <span className="text-white font-medium">{dokumenter.fusioner.length}</span>
                <span className="text-slate-500">
                  {dokumenter.fusioner
                    .map((d) => d.tinglysningsdato)
                    .filter(Boolean)
                    .slice(0, 3)
                    .join(', ')}
                </span>
              </div>
            )}
            {dokumenter.ejerpantebreve.length > 0 && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-400">
                  {da ? 'Ejerpantebreve i løsøre' : 'Owner mortgage in chattels'}:
                </span>
                <span className="text-white font-medium">{dokumenter.ejerpantebreve.length}</span>
                <span className="text-slate-500">
                  {dokumenter.ejerpantebreve
                    .map((d) => d.tinglysningsdato)
                    .filter(Boolean)
                    .slice(0, 3)
                    .join(', ')}
                </span>
              </div>
            )}
          </div>
        )}
    </>
  );
}

// ─── PlaceholderTab ─────────────────────────────────────────────────────────

/**
 * PlaceholderTab — Placeholder for tabs der endnu ikke er implementeret.
 * Viser et ikon, titel, "kommer snart"-badge og en beskrivelsestekst.
 *
 * @param props - Se PlaceholderTabProps
 */
function _PlaceholderTab({ ikon, titel, beskrivelse, comingSoon }: _PlaceholderTabProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="mb-4">{ikon}</div>
      <h3 className="text-white text-lg font-semibold mb-2">{titel}</h3>
      <span className="inline-flex items-center px-3 py-1 rounded-full bg-blue-600/20 text-blue-400 text-xs font-medium mb-3">
        {comingSoon}
      </span>
      <p className="text-slate-400 text-sm max-w-md">{beskrivelse}</p>
    </div>
  );
}

// ─── Relationsdiagram ────────────────────────────────────────────────────────

interface RelationsDiagramProps {
  /** Virksomhedsdata til at bygge grafen */
  data: CVRPublicData;
  /** Oversættelser */
  c: (typeof translations)['da']['company'];
  /** Relaterede virksomheder (datterselskaber) */
  relatedCompanies: RelateretVirksomhed[];
  /** Om relaterede virksomheder stadig indlæses */
  relatedLoading: boolean;
  /** Callback der sender ejerkæden opad til parent-component */
  onOwnerChainResolved?: (chain: OwnerChainNode[]) => void;
  /** Hovedvirksomhedens enhedsNummer fra CVR ES (til dedup) */
  parentEnhedsNummer?: number | null;
}

/** Node-bredde for alle virksomhedsbokse (ens størrelse) */
const NODE_W_RELATIONS = 220;

/**
 * Genbrugelig virksomheds-node (boks).
 * Samme format som datterselskaber — ens størrelse overalt.
 *
 * @param label - Virksomhedsnavn
 * @param sublabel - Virksomhedsform e.l.
 * @param link - Klik-URL
 * @param ejerandel - Ejerandel-badge
 * @param isMain - Fremhævet stil for hovedvirksomheden
 */
function CompanyBox({
  label,
  sublabel,
  link,
  ejerandel,
  isMain,
}: {
  label: string;
  sublabel?: string;
  link?: string;
  ejerandel?: string | null;
  isMain?: boolean;
}) {
  const router = useRouter();
  const base = isMain
    ? 'bg-blue-600/20 border-2 border-blue-500/50'
    : 'bg-slate-800/60 border border-slate-700/40 hover:border-blue-500/40 hover:bg-slate-800/80';
  return (
    <div className="flex flex-col items-center">
      {ejerandel && (
        <span className="mb-1 px-1.5 py-0 rounded text-[8px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
          {ejerandel}
        </span>
      )}
      <button
        onClick={() => link && router.push(link)}
        className={`group flex items-center gap-2 px-3 py-2.5 rounded-xl transition cursor-pointer ${base}`}
        style={{ width: `${NODE_W_RELATIONS}px` }}
      >
        <Building2
          size={14}
          className={`shrink-0 ${isMain ? 'text-blue-400' : 'text-slate-400 group-hover:text-blue-400'}`}
        />
        <div className="text-left min-w-0 flex-1">
          <p
            className={`text-xs font-semibold truncate ${isMain ? 'text-white' : 'text-slate-200 group-hover:text-white'}`}
          >
            {label}
          </p>
          {sublabel && (
            <p className={`text-[9px] truncate ${isMain ? 'text-blue-300/60' : 'text-slate-600'}`}>
              {sublabel}
            </p>
          )}
        </div>
        {!isMain && (
          <ExternalLink size={10} className="text-slate-600 group-hover:text-slate-400 shrink-0" />
        )}
      </button>
    </div>
  );
}

/**
 * Genbrugelig person-node (lille pille).
 *
 * @param navn - Personens navn
 * @param enhedsNummer - ID for link
 * @param ejerandel - Ejerandel-badge
 */
function PersonPill({
  navn,
  enhedsNummer,
  ejerandel,
}: {
  navn: string;
  enhedsNummer: number | null;
  ejerandel?: string | null;
}) {
  const router = useRouter();
  return (
    <div className="flex flex-col items-center">
      {ejerandel && (
        <span className="mb-0.5 px-1 py-0 rounded text-[8px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
          {ejerandel}
        </span>
      )}
      <button
        onClick={() => enhedsNummer && router.push(`/dashboard/owners/${enhedsNummer}`)}
        className="group flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-800/50 border border-purple-600/20 rounded-full hover:border-purple-500/40 transition cursor-pointer"
      >
        <Users size={11} className="text-purple-400 shrink-0" />
        <span className="text-slate-300 text-[10px] font-medium truncate max-w-[130px] group-hover:text-purple-300">
          {navn}
        </span>
      </button>
    </div>
  );
}

/**
 * RelationsDiagram — Vertikalt ejerskabshierarki.
 * Viser personer øverst → holdingselskaber → datterselskaber nedad.
 * Kun ejerskabsrelationer — ingen produktionsenheder.
 *
 * @param props - Se RelationsDiagramProps
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function RelationsDiagram({
  data,
  c,
  relatedCompanies,
  relatedLoading,
  onOwnerChainResolved,
  parentEnhedsNummer,
}: RelationsDiagramProps) {
  const router = useRouter();
  const { lang } = useLanguage();

  // ── Rekursiv ejer-kæde opad (person → holding → holding → denne virksomhed) ──
  const [ownerChain, setOwnerChain] = useState<OwnerChainNode[]>([]);
  const [chainLoading, setChainLoading] = useState(false);
  const chainFetchedRef = useRef(false);

  useEffect(() => {
    if (chainFetchedRef.current) return;
    chainFetchedRef.current = true;

    const directOwners = extractOwners(data.deltagere);
    const companyOwners = directOwners.filter((o) => o.erVirksomhed && o.enhedsNummer);
    if (companyOwners.length === 0) {
      // Kun person-ejere — ingen kæde at hente
      const personChain = directOwners.map((o) => ({ ...o, cvr: null, parents: [] }));
      setOwnerChain(personChain);
      onOwnerChainResolved?.(personChain);
      return;
    }

    setChainLoading(true);
    const fetchedCache = new Map<number, { deltagere: CVRPublicData['deltagere']; cvr: number }>();

    /**
     * Henter ejere rekursivt op til maxDepth niveauer.
     * For virksomheds-ejere henter vi CVR-data via enhedsNummer for at finde CVR + ejere.
     *
     * @param ownerList - Direkte ejere at resolve
     * @param depth - Nuværende dybde
     * @param maxDepth - Max antal niveauer op
     * @returns Kæde-noder med parents + cvr
     */
    async function resolveChain(
      ownerList: ReturnType<typeof extractOwners>,
      depth: number,
      maxDepth: number
    ): Promise<OwnerChainNode[]> {
      return Promise.all(
        ownerList.map(async (o): Promise<OwnerChainNode> => {
          if (!o.erVirksomhed || !o.enhedsNummer || depth >= maxDepth) {
            return { ...o, cvr: null, parents: [] };
          }

          try {
            let cached = fetchedCache.get(o.enhedsNummer);
            if (!cached) {
              const res = await fetch(`/api/cvr-public?enhedsNummer=${o.enhedsNummer}`);
              if (res.ok) {
                const json = await res.json();
                if (!json.error && json.vat) {
                  cached = { deltagere: json.deltagere ?? [], cvr: json.vat };
                  fetchedCache.set(o.enhedsNummer, cached);
                }
              }
            }
            if (!cached) return { ...o, cvr: null, parents: [] };

            const parentOwners = extractOwners(cached.deltagere);
            const resolvedParents = await resolveChain(parentOwners, depth + 1, maxDepth);
            return { ...o, cvr: cached.cvr, parents: resolvedParents };
          } catch {
            return { ...o, cvr: null, parents: [] };
          }
        })
      );
    }

    resolveChain(directOwners, 0, 4).then((chain) => {
      setOwnerChain(chain);
      setChainLoading(false);
      onOwnerChainResolved?.(chain);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.deltagere]);

  // ── Direkte ejere (fra chain eller fallback) ──
  const owners =
    ownerChain.length > 0
      ? ownerChain
      : extractOwners(data.deltagere).map((o) => ({ ...o, cvr: null, parents: [] }));

  // ── Aktive datterselskaber sorteret efter ejerandel (højeste først) ──
  const datterselskaber = useMemo(
    () =>
      relatedCompanies
        .filter((v) => v.aktiv)
        .sort((a, b) => (b.ejerandelNum ?? 0) - (a.ejerandelNum ?? 0)),
    [relatedCompanies]
  );

  // ── Direkte datter (ejet af denne virksomhed) vs. indirekte (ejet af et datterselskab) ──
  const direkteDatter = useMemo(
    () => datterselskaber.filter((v) => !v.ejetAfCvr || v.ejetAfCvr === data.vat),
    [datterselskaber, data.vat]
  );
  const indirekteDatterMap = useMemo(() => {
    const map = new Map<number, RelateretVirksomhed[]>();
    for (const v of datterselskaber) {
      if (v.ejetAfCvr && v.ejetAfCvr !== data.vat) {
        const arr = map.get(v.ejetAfCvr) ?? [];
        arr.push(v);
        map.set(v.ejetAfCvr, arr);
      }
    }
    return map;
  }, [datterselskaber, data.vat]);

  // ── Byg ejerkæder (deduplikeret) ──

  /** Byg flad kæde fra rod til blad for ejerkæder */
  function flattenChains(nodes: OwnerChainNode[]): OwnerChainNode[][] {
    const results: OwnerChainNode[][] = [];
    for (const n of nodes) {
      if (n.parents.length > 0) {
        const parentChains = flattenChains(n.parents);
        for (const pc of parentChains) {
          results.push([...pc, n]);
        }
      } else {
        results.push([n]);
      }
    }
    return results;
  }

  /**
   * Deduplikér kæder: Fjern kæder der er helt indeholdt i en anden kæde
   * (samme sekvens af enhedsNummere). Behold unikke stier — f.eks. to
   * forskellige ejere af samme virksomhed giver to separate kæder.
   */
  function deduplicateChains(raw: OwnerChainNode[][]): OwnerChainNode[][] {
    // Lav en unik nøgle per kæde baseret på alle enhedsNummere
    const seen = new Set<string>();
    const deduped: OwnerChainNode[][] = [];
    // Sortér længste først så vi ser den mest komplette kæde først
    const sorted = [...raw].sort((a, b) => b.length - a.length);
    for (const chain of sorted) {
      const key = chain.map((n) => n.enhedsNummer ?? n.navn).join('→');
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(chain);
      }
    }
    return deduped;
  }

  const chains = deduplicateChains(flattenChains(owners));

  // ── Saml alle synlige ID'er (ejerkæder + main + direkte datter) for dedup ──

  const allVisibleIds = useMemo(() => {
    const ids = new Set<number>();
    ids.add(data.vat);
    // Tilføj hovedvirksomhedens enhedsNummer (forskellig fra CVR) for korrekt dedup
    if (parentEnhedsNummer) ids.add(parentEnhedsNummer);
    for (const chain of chains) {
      for (const n of chain) {
        if (n.enhedsNummer) ids.add(n.enhedsNummer);
        if (n.cvr) ids.add(n.cvr);
      }
    }
    for (const d of direkteDatter) {
      ids.add(d.cvr);
    }
    return ids;
  }, [chains, direkteDatter, data.vat, parentEnhedsNummer]);

  // ── Dynamisk state: expandede ejere + on-demand loaded subsidiaries ──
  const [zoom, setZoom] = useState(1);
  const [expandedOwners, setExpandedOwners] = useState<Set<string>>(new Set());
  /** CVR → loaded subsidiaries for dynamisk tilføjede virksomheder */
  const [dynSubs, setDynSubs] = useState<Map<number, RelateretVirksomhed[]>>(new Map());
  /** CVR'er der loader subsidiaries lige nu */
  const [loadingSubs, setLoadingSubs] = useState<Set<number>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef2 = useRef<HTMLDivElement>(null);

  // Auto-zoom to fit efter render — trigges af ændret antal noder (ikke loading-state)
  const autoZoomKey = `${direkteDatter.length}-${expandedOwners.size}-${dynSubs.size}`;
  useEffect(() => {
    if (!containerRef.current || !contentRef2.current) return;
    const timer = setTimeout(() => {
      const container = containerRef.current;
      const content = contentRef2.current;
      if (!container || !content) return;
      const cW = container.clientWidth - 48;
      const cH = container.clientHeight - 48;
      const sW = content.scrollWidth;
      const sH = content.scrollHeight;
      if (sW > 0 && sH > 0) {
        const fitZoom = Math.min(cW / sW, cH / sH, 1);
        if (fitZoom < 0.95) setZoom(Math.max(fitZoom, 0.3));
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [autoZoomKey]);

  // ── Ekstra ejere per datterselskab (filtreret for allerede synlige) ──

  const extraOwnersMap = useMemo(() => {
    const map = new Map<number, OwnerChainNode[]>();
    for (const d of direkteDatter) {
      const extras = (d.ejere ?? [])
        .filter((e) => {
          const id = e.enhedsNummer ?? 0;
          // Fjern den aktuelle virksomhed og alle allerede synlige
          if (e.erVirksomhed && id === data.vat) return false;
          if (allVisibleIds.has(id)) return false;
          return true;
        })
        .map(
          (e): OwnerChainNode => ({
            navn: e.navn,
            enhedsNummer: e.enhedsNummer,
            cvr: null,
            erVirksomhed: e.erVirksomhed,
            ejerandel: e.ejerandel,
            parents: [],
          })
        );
      if (extras.length > 0) map.set(d.cvr, extras);
    }
    return map;
  }, [direkteDatter, data.vat, allVisibleIds]);

  const hasContent = owners.length > 0 || datterselskaber.length > 0;

  if (!hasContent && !relatedLoading && !chainLoading) {
    return (
      <EmptyState ikon={<Briefcase size={32} className="text-slate-600" />} tekst={c.noPortfolio} />
    );
  }

  /** Toggle vis/skjul ekstra ejere for en virksomhed */
  function toggleOwnerExpand(key: string) {
    setExpandedOwners((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /**
   * Hent datterselskaber for en dynamisk tilføjet virksomhed.
   * Bruger /api/cvr-public/related endpoint.
   *
   * @param cvr - CVR-nummeret at hente datter for
   */
  async function loadSubsidiaries(cvr: number) {
    if (dynSubs.has(cvr) || loadingSubs.has(cvr)) return;
    setLoadingSubs((prev) => new Set(prev).add(cvr));
    try {
      const res = await fetch(`/api/cvr-public/related?cvr=${cvr}`);
      if (res.ok) {
        const json = await res.json();
        const subs: RelateretVirksomhed[] = json.virksomheder ?? [];
        setDynSubs((prev) =>
          new Map(prev).set(
            cvr,
            subs.filter((s) => s.aktiv)
          )
        );
      }
    } catch {
      /* stille fejl */
    }
    setLoadingSubs((prev) => {
      const n = new Set(prev);
      n.delete(cvr);
      return n;
    });
  }

  const nodeW = NODE_W_RELATIONS;

  /** Lodret streg-connector */
  function _VLine({ h = 28, color = 'rgba(100,116,139,0.4)' }: { h?: number; color?: string }) {
    return (
      <svg width="2" height={h} className="shrink-0">
        <line x1="1" y1="0" x2="1" y2={h} stroke={color} strokeWidth="1.5" />
      </svg>
    );
  }

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <h2 className="text-white font-semibold text-base flex items-center gap-2">
          <Briefcase size={16} className="text-blue-400" />
          {c.tabs.portfolio}
        </h2>
        <div className="flex items-center gap-2">
          {(chainLoading || relatedLoading) && (
            <Loader2 size={14} className="animate-spin text-slate-500" />
          )}
          <button
            onClick={() => setZoom((z) => Math.min(z + 0.15, 1.5))}
            className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-white bg-slate-800 border border-slate-700/50 rounded-lg text-xs transition"
          >
            +
          </button>
          <span className="text-slate-500 text-[10px] w-8 text-center">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={() => setZoom((z) => Math.max(z - 0.15, 0.2))}
            className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-white bg-slate-800 border border-slate-700/50 rounded-lg text-xs transition"
          >
            −
          </button>
          <button
            onClick={() => setZoom(1)}
            className="px-2 h-7 flex items-center text-slate-400 hover:text-white bg-slate-800 border border-slate-700/50 rounded-lg text-[10px] transition"
          >
            100%
          </button>
        </div>
      </div>

      {/* Diagram container med zoom */}
      <div
        ref={containerRef}
        className="bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-auto"
        style={{ maxHeight: '70vh' }}
      >
        <div
          ref={contentRef2}
          className="p-8 inline-block min-w-full"
          style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }}
        >
          <div className="flex flex-col items-center gap-0">
            {/* ── Ejerkæder ovenfor (niveau-baseret med bezier-connectors) ── */}
            {chains.length > 0 &&
              (() => {
                const chainGap = 32;
                const maxLen = Math.max(...chains.map((c) => c.length));

                // Stap 1: Byg niveauer med unikke noder
                const levels: { node: OwnerChainNode; key: string }[][] = [];
                const renderedIds = new Set<string>();
                for (let lvl = 0; lvl < maxLen; lvl++) {
                  const levelNodes: { node: OwnerChainNode; key: string }[] = [];
                  for (let ci = 0; ci < chains.length; ci++) {
                    const chain = chains[ci];
                    const idx = chain.length - (maxLen - lvl);
                    if (idx < 0 || idx >= chain.length) continue;
                    const nd = chain[idx];
                    const nk = `${nd.enhedsNummer ?? nd.navn}`;
                    if (renderedIds.has(nk)) continue;
                    renderedIds.add(nk);
                    levelNodes.push({ node: nd, key: nk });
                  }
                  if (levelNodes.length > 0) levels.push(levelNodes);
                }

                // Stap 2: Byg node→level map
                const nodeToLevel = new Map<string, number>();
                for (let li = 0; li < levels.length; li++) {
                  for (const n of levels[li]) nodeToLevel.set(n.key, li);
                }

                // Stap 3: Byg kanter (edges) mellem niveauer fra kæderne
                type ChainEdge = { parentKey: string; childKey: string; ejerandel: string | null };
                const edgesByTransition: ChainEdge[][] = [];
                for (let t = 0; t < Math.max(levels.length - 1, 0); t++) edgesByTransition.push([]);

                // Kanter fra sidste kæde-niveau til hovedvirksomhed
                const edgesToMain: { parentKey: string; ejerandel: string | null }[] = [];

                for (const chain of chains) {
                  for (let i = 0; i < chain.length - 1; i++) {
                    const pNode = chain[i];
                    const cNode = chain[i + 1];
                    const pKey = `${pNode.enhedsNummer ?? pNode.navn}`;
                    const cKey = `${cNode.enhedsNummer ?? cNode.navn}`;
                    const pLvl = nodeToLevel.get(pKey) ?? -1;
                    const cLvl = nodeToLevel.get(cKey) ?? -1;
                    if (pLvl >= 0 && cLvl >= 0 && cLvl === pLvl + 1) {
                      const arr = edgesByTransition[pLvl];
                      if (arr && !arr.some((e) => e.parentKey === pKey && e.childKey === cKey)) {
                        arr.push({ parentKey: pKey, childKey: cKey, ejerandel: pNode.ejerandel });
                      }
                    }
                  }
                  // Kant fra sidste node til main
                  const last = chain[chain.length - 1];
                  const lastKey = `${last.enhedsNummer ?? last.navn}`;
                  if (!edgesToMain.some((e) => e.parentKey === lastKey)) {
                    edgesToMain.push({ parentKey: lastKey, ejerandel: last.ejerandel });
                  }
                }

                return (
                  <>
                    {levels.map((level, li) => {
                      const levelW = level.length * nodeW + (level.length - 1) * chainGap;

                      return (
                        <div key={`cl-${li}`} className="flex flex-col items-center">
                          {/* Bezier-connectors FRA forrige niveau TIL dette */}
                          {li > 0 &&
                            edgesByTransition[li - 1] &&
                            (() => {
                              const prevLevel = levels[li - 1];
                              const prevW =
                                prevLevel.length * nodeW + (prevLevel.length - 1) * chainGap;
                              const svgW = Math.max(prevW, levelW, nodeW);
                              const svgH = 48;
                              const prevOff = (svgW - prevW) / 2;
                              const currOff = (svgW - levelW) / 2;
                              const edges = edgesByTransition[li - 1];
                              return (
                                <svg
                                  width={svgW}
                                  height={svgH}
                                  className="shrink-0"
                                  style={{ overflow: 'visible' }}
                                >
                                  {edges.map((edge, ei) => {
                                    const pi = prevLevel.findIndex((n) => n.key === edge.parentKey);
                                    const ci2 = level.findIndex((n) => n.key === edge.childKey);
                                    if (pi < 0 || ci2 < 0) return null;
                                    const sx = prevOff + pi * (nodeW + chainGap) + nodeW / 2;
                                    const ex = currOff + ci2 * (nodeW + chainGap) + nodeW / 2;
                                    const cpY = svgH * 0.55;
                                    // Midtpunkt for ejerandel-label
                                    const midX = (sx + ex) / 2;
                                    const midY = svgH * 0.42;
                                    return (
                                      <g key={ei}>
                                        <path
                                          d={`M ${sx} 0 C ${sx} ${cpY}, ${ex} ${cpY}, ${ex} ${svgH}`}
                                          fill="none"
                                          stroke="rgba(100,116,139,0.45)"
                                          strokeWidth="1.5"
                                        />
                                        {edge.ejerandel && (
                                          <>
                                            <rect
                                              x={midX - 26}
                                              y={midY - 7}
                                              width="52"
                                              height="14"
                                              rx="4"
                                              fill="rgba(16,185,129,0.08)"
                                              stroke="rgba(16,185,129,0.2)"
                                              strokeWidth="0.5"
                                            />
                                            <text
                                              x={midX}
                                              y={midY + 3}
                                              textAnchor="middle"
                                              fill="rgba(52,211,153,0.85)"
                                              fontSize="8"
                                              fontWeight="500"
                                            >
                                              {edge.ejerandel}
                                            </text>
                                          </>
                                        )}
                                      </g>
                                    );
                                  })}
                                </svg>
                              );
                            })()}
                          {/* Niveau-noder */}
                          <div className="flex justify-center" style={{ gap: `${chainGap}px` }}>
                            {level.map(({ node, key }) => {
                              const linkCvr = node.cvr ?? node.enhedsNummer;
                              return (
                                <div key={key} className="flex flex-col items-center">
                                  {node.erVirksomhed && linkCvr ? (
                                    <CompanyBox
                                      label={node.navn}
                                      link={`/dashboard/companies/${linkCvr}`}
                                    />
                                  ) : (
                                    <PersonPill navn={node.navn} enhedsNummer={node.enhedsNummer} />
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}

                    {/* Bezier fra sidste ejerkæde-niveau → hovedvirksomhed */}
                    {levels.length > 0 &&
                      (() => {
                        const lastLevel = levels[levels.length - 1];
                        const lastW = lastLevel.length * nodeW + (lastLevel.length - 1) * chainGap;
                        const svgW = Math.max(lastW, nodeW);
                        const svgH = 48;
                        const lastOff = (svgW - lastW) / 2;
                        const mainX = svgW / 2;
                        return (
                          <svg
                            width={svgW}
                            height={svgH}
                            className="shrink-0"
                            style={{ overflow: 'visible' }}
                          >
                            {edgesToMain.map((edge, ei) => {
                              const pi = lastLevel.findIndex((n) => n.key === edge.parentKey);
                              if (pi < 0) return null;
                              const sx = lastOff + pi * (nodeW + chainGap) + nodeW / 2;
                              const cpY = svgH * 0.55;
                              const midX = (sx + mainX) / 2;
                              const midY = svgH * 0.42;
                              return (
                                <g key={ei}>
                                  <path
                                    d={`M ${sx} 0 C ${sx} ${cpY}, ${mainX} ${cpY}, ${mainX} ${svgH}`}
                                    fill="none"
                                    stroke="rgba(59,130,246,0.45)"
                                    strokeWidth="1.5"
                                  />
                                  {edge.ejerandel && (
                                    <>
                                      <rect
                                        x={midX - 26}
                                        y={midY - 7}
                                        width="52"
                                        height="14"
                                        rx="4"
                                        fill="rgba(16,185,129,0.08)"
                                        stroke="rgba(16,185,129,0.2)"
                                        strokeWidth="0.5"
                                      />
                                      <text
                                        x={midX}
                                        y={midY + 3}
                                        textAnchor="middle"
                                        fill="rgba(52,211,153,0.85)"
                                        fontSize="8"
                                        fontWeight="500"
                                      >
                                        {edge.ejerandel}
                                      </text>
                                    </>
                                  )}
                                </g>
                              );
                            })}
                          </svg>
                        );
                      })()}
                  </>
                );
              })()}

            {/* ── Hovedvirksomhed ── */}
            <CompanyBox
              label={data.name}
              sublabel={`CVR ${data.vat} · ${data.companydesc ?? ''}`}
              isMain
            />

            {/* ── Bezier connectors: main → datterselskaber ── */}
            {direkteDatter.length > 0 &&
              (() => {
                const childCount = direkteDatter.length;
                const gap = 32;
                const totalW = childCount * nodeW + (childCount - 1) * gap;
                const svgH = 56;
                const _startX = totalW / 2;

                return (
                  <>
                    <svg
                      width={Math.max(totalW, nodeW)}
                      height={svgH}
                      className="shrink-0"
                      style={{ overflow: 'visible' }}
                    >
                      {direkteDatter.map((d, i) => {
                        const off = (Math.max(totalW, nodeW) - totalW) / 2;
                        const endX = off + i * (nodeW + gap) + nodeW / 2;
                        const sX = Math.max(totalW, nodeW) / 2;
                        const cpY = svgH * 0.55;
                        const midX = (sX + endX) / 2;
                        const midY = svgH * 0.42;
                        return (
                          <g key={i}>
                            <path
                              d={`M ${sX} 0 C ${sX} ${cpY}, ${endX} ${cpY}, ${endX} ${svgH}`}
                              fill="none"
                              stroke="rgba(100,116,139,0.4)"
                              strokeWidth="1.5"
                            />
                            {d.ejerandel && (
                              <>
                                <rect
                                  x={midX - 26}
                                  y={midY - 7}
                                  width="52"
                                  height="14"
                                  rx="4"
                                  fill="rgba(16,185,129,0.08)"
                                  stroke="rgba(16,185,129,0.2)"
                                  strokeWidth="0.5"
                                />
                                <text
                                  x={midX}
                                  y={midY + 3}
                                  textAnchor="middle"
                                  fill="rgba(52,211,153,0.85)"
                                  fontSize="8"
                                  fontWeight="500"
                                >
                                  {d.ejerandel}
                                </text>
                              </>
                            )}
                          </g>
                        );
                      })}
                    </svg>

                    {/* ── Datterselskaber side-by-side ── */}
                    <div className="flex items-start gap-8">
                      {direkteDatter.map((d) => {
                        const expandKey = `owners-${d.cvr}`;
                        const isExpanded = expandedOwners.has(expandKey);
                        const extras = extraOwnersMap.get(d.cvr) ?? [];
                        const dSubs = dynSubs.get(d.cvr);
                        const isLoadingSub = loadingSubs.has(d.cvr);
                        const underDatter = indirekteDatterMap.get(d.cvr) ?? [];

                        return (
                          <div key={d.cvr} className="flex flex-col items-center">
                            {/* ── Selve datterselskabet ── */}
                            <CompanyBox
                              label={d.navn}
                              sublabel={d.form ?? undefined}
                              link={`/dashboard/companies/${d.cvr}`}
                            />

                            {/* Expand-knap for medejere */}
                            {extras.length > 0 && (
                              <button
                                onClick={() => toggleOwnerExpand(expandKey)}
                                className="mt-1 flex items-center gap-1 px-2 py-0.5 text-[9px] text-slate-500 hover:text-slate-300 transition"
                              >
                                {isExpanded ? (
                                  <ChevronDown size={10} />
                                ) : (
                                  <ChevronRight size={10} />
                                )}
                                {extras.length} {lang === 'da' ? 'medejere' : 'co-owners'}
                              </button>
                            )}

                            {/* ── Medejere-panel (udfoldet UNDER datterselskabet, IKKE i tree) ── */}
                            {isExpanded && extras.length > 0 && (
                              <div className="mt-1.5 flex flex-wrap items-center justify-center gap-2 px-2 py-2 bg-slate-800/30 border border-dashed border-slate-700/30 rounded-xl max-w-xs">
                                <span className="w-full text-center text-[8px] text-slate-500 font-medium uppercase tracking-wider mb-0.5">
                                  {lang === 'da' ? 'Medejere' : 'Co-owners'}
                                </span>
                                {extras.map((eo, ei) => {
                                  const eoLink = eo.erVirksomhed
                                    ? `/dashboard/companies/${eo.cvr ?? eo.enhedsNummer}`
                                    : `/dashboard/owners/${eo.enhedsNummer}`;
                                  return (
                                    <button
                                      key={ei}
                                      onClick={() => router.push(eoLink)}
                                      className={`group flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-800/60 border rounded-lg transition cursor-pointer ${eo.erVirksomhed ? 'border-slate-700/40 hover:border-blue-500/40' : 'border-slate-700/40 hover:border-purple-500/40'}`}
                                    >
                                      {eo.erVirksomhed ? (
                                        <Building2
                                          size={10}
                                          className="text-blue-500/60 shrink-0"
                                        />
                                      ) : (
                                        <Users size={10} className="text-purple-500/60 shrink-0" />
                                      )}
                                      <span
                                        className={`text-[9px] text-slate-300 truncate max-w-[110px] ${eo.erVirksomhed ? 'group-hover:text-blue-300' : 'group-hover:text-purple-300'}`}
                                      >
                                        {eo.navn}
                                      </span>
                                      {eo.ejerandel && (
                                        <span className="text-[8px] text-emerald-400/80 ml-0.5 shrink-0">
                                          {eo.ejerandel}
                                        </span>
                                      )}
                                    </button>
                                  );
                                })}
                              </div>
                            )}

                            {/* ── Indirekte datterselskaber (fra originale data) ── */}
                            {underDatter.length > 0 &&
                              (() => {
                                const subCount = underDatter.length;
                                const subTotalW = subCount * nodeW + (subCount - 1) * 16;
                                const subSvgH = 44;
                                const subSvgW = Math.max(subTotalW, nodeW);
                                const subMainX = subSvgW / 2;
                                const subOff = (subSvgW - subTotalW) / 2;
                                return (
                                  <>
                                    <svg
                                      width={subSvgW}
                                      height={subSvgH}
                                      className="shrink-0 mt-1"
                                      style={{ overflow: 'visible' }}
                                    >
                                      {underDatter.map((sub, si) => {
                                        const endX = subOff + si * (nodeW + 16) + nodeW / 2;
                                        const cpY = subSvgH * 0.55;
                                        const midX = (subMainX + endX) / 2;
                                        const midY = subSvgH * 0.42;
                                        return (
                                          <g key={si}>
                                            <path
                                              d={`M ${subMainX} 0 C ${subMainX} ${cpY}, ${endX} ${cpY}, ${endX} ${subSvgH}`}
                                              fill="none"
                                              stroke="rgba(100,116,139,0.3)"
                                              strokeWidth="1"
                                            />
                                            {sub.ejerandel && (
                                              <>
                                                <rect
                                                  x={midX - 24}
                                                  y={midY - 6}
                                                  width="48"
                                                  height="12"
                                                  rx="3"
                                                  fill="rgba(16,185,129,0.06)"
                                                  stroke="rgba(16,185,129,0.15)"
                                                  strokeWidth="0.5"
                                                />
                                                <text
                                                  x={midX}
                                                  y={midY + 3}
                                                  textAnchor="middle"
                                                  fill="rgba(52,211,153,0.75)"
                                                  fontSize="7"
                                                  fontWeight="500"
                                                >
                                                  {sub.ejerandel}
                                                </text>
                                              </>
                                            )}
                                          </g>
                                        );
                                      })}
                                    </svg>
                                    <div className="flex items-start gap-4">
                                      {underDatter.map((sub) => (
                                        <CompanyBox
                                          key={sub.cvr}
                                          label={sub.navn}
                                          sublabel={sub.form ?? undefined}
                                          link={`/dashboard/companies/${sub.cvr}`}
                                        />
                                      ))}
                                    </div>
                                  </>
                                );
                              })()}

                            {/* ── Hent datterselskaber for dette datterselskab ── */}
                            {!dSubs && underDatter.length === 0 && (
                              <button
                                onClick={() => loadSubsidiaries(d.cvr)}
                                className="mt-1 flex items-center gap-1 px-2 py-0.5 text-[9px] text-blue-400/60 hover:text-blue-300 transition"
                              >
                                {isLoadingSub ? (
                                  <Loader2 size={9} className="animate-spin" />
                                ) : (
                                  <Plus size={9} />
                                )}
                                {lang === 'da' ? 'Hent datter' : 'Load subs'}
                              </button>
                            )}

                            {/* Dynamisk hentede datterselskaber */}
                            {dSubs &&
                              dSubs.length > 0 &&
                              (() => {
                                const filteredSubs = dSubs.filter((s) => !allVisibleIds.has(s.cvr));
                                if (filteredSubs.length === 0) return null;
                                const subCount = filteredSubs.length;
                                const subTotalW = subCount * nodeW + (subCount - 1) * 16;
                                const subSvgH = 44;
                                const subSvgW = Math.max(subTotalW, nodeW);
                                const subMainX = subSvgW / 2;
                                const subOff = (subSvgW - subTotalW) / 2;
                                return (
                                  <>
                                    <svg
                                      width={subSvgW}
                                      height={subSvgH}
                                      className="shrink-0 mt-1"
                                      style={{ overflow: 'visible' }}
                                    >
                                      {filteredSubs.map((sub, si) => {
                                        const endX = subOff + si * (nodeW + 16) + nodeW / 2;
                                        const cpY = subSvgH * 0.55;
                                        const midX = (subMainX + endX) / 2;
                                        const midY = subSvgH * 0.42;
                                        return (
                                          <g key={si}>
                                            <path
                                              d={`M ${subMainX} 0 C ${subMainX} ${cpY}, ${endX} ${cpY}, ${endX} ${subSvgH}`}
                                              fill="none"
                                              stroke="rgba(100,116,139,0.3)"
                                              strokeWidth="1"
                                            />
                                            {sub.ejerandel && (
                                              <>
                                                <rect
                                                  x={midX - 24}
                                                  y={midY - 6}
                                                  width="48"
                                                  height="12"
                                                  rx="3"
                                                  fill="rgba(16,185,129,0.06)"
                                                  stroke="rgba(16,185,129,0.15)"
                                                  strokeWidth="0.5"
                                                />
                                                <text
                                                  x={midX}
                                                  y={midY + 3}
                                                  textAnchor="middle"
                                                  fill="rgba(52,211,153,0.75)"
                                                  fontSize="7"
                                                  fontWeight="500"
                                                >
                                                  {sub.ejerandel}
                                                </text>
                                              </>
                                            )}
                                          </g>
                                        );
                                      })}
                                    </svg>
                                    <div className="flex items-start gap-4">
                                      {filteredSubs.map((sub) => (
                                        <CompanyBox
                                          key={sub.cvr}
                                          label={sub.navn}
                                          sublabel={sub.form ?? undefined}
                                          link={`/dashboard/companies/${sub.cvr}`}
                                        />
                                      ))}
                                    </div>
                                  </>
                                );
                              })()}
                          </div>
                        );
                      })}
                    </div>
                  </>
                );
              })()}
          </div>
        </div>
      </div>
    </div>
  );
}
