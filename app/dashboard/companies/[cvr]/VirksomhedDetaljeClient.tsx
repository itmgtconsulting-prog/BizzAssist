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
  Phone,
  Mail,
  Factory,
  Loader2,
  AlertTriangle,
  CheckCircle,
  XCircle,
  ExternalLink,
  Bell,
  BarChart3,
  LayoutDashboard,
  FileText,
  ArrowRightLeft,
  Home,
  Clock,
  Scale,
  Download,
  Tag,
  Shield,
  ChevronDown,
  ChevronRight,
  Percent,
  Plus,
  X,
  Newspaper,
  Globe,
  Sparkles,
  Lock,
  Zap,
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
import type { PersonbogHaeftelse, PersonbogDokument } from '@/app/api/tinglysning/personbog/route';
import type { VirksomhedEjendomsrolle } from '@/app/api/tinglysning/virksomhed/route';
import type { BilbogBil } from '@/app/api/tinglysning/bilbog/route';
import type { AndelsbogBolig } from '@/app/api/tinglysning/andelsbog/route';
import PaategningTimeline from '@/app/components/tinglysning/PaategningTimeline';
import PropertyOwnerCard from '@/app/components/ejendomme/PropertyOwnerCard';
import { saveRecentCompany } from '@/app/lib/recentCompanies';
import { recordRecentVisit } from '@/app/lib/recordRecentVisit';
import { useSubscription } from '@/app/context/SubscriptionContext';
import { useSubscriptionAccess } from '@/app/components/SubscriptionGate';
import { resolvePlan, formatTokens, isSubscriptionFunctional } from '@/app/lib/subscriptions';
import { buildDiagramGraph } from '@/app/components/diagrams/DiagramData';
import type { DiagramPropertySummary } from '@/app/components/diagrams/DiagramData';
import dynamic from 'next/dynamic';
import VerifiedLinks from '@/app/components/VerifiedLinks';
import TabLoadingSpinner from '@/app/components/TabLoadingSpinner';
/** Recharts — single dynamic import keeps recharts in one chunk */
const RegnskabChart = dynamic(() => import('./RegnskabChart'), { ssr: false });

/** Lazy-loaded diagram variants */
const DiagramForce = dynamic(() => import('@/app/components/diagrams/DiagramForce'), {
  ssr: false,
  loading: () => <div className="w-full h-96 bg-slate-800/50 rounded-xl animate-pulse" />,
});

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
  tradeHistory: <ArrowRightLeft size={12} />,
  properties: <Home size={12} />,
  companies: <Building2 size={12} />,
  financials: <CreditCard size={12} />,
  keyPersons: <Users size={12} />,
  history: <Clock size={12} />,
  liens: <Scale size={12} />,
};

/** Rækkefølge af tabs */
const tabOrder: TabId[] = [
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
const historikTypeConfig: Record<string, { icon: React.ReactNode; color: string }> = {
  navn: { icon: <Tag size={14} />, color: 'text-blue-400' },
  adresse: { icon: <MapPin size={14} />, color: 'text-emerald-400' },
  form: { icon: <Briefcase size={14} />, color: 'text-purple-400' },
  status: { icon: <CheckCircle size={14} />, color: 'text-amber-400' },
  branche: { icon: <Factory size={14} />, color: 'text-cyan-400' },
  ejerskab: { icon: <Shield size={14} />, color: 'text-orange-400' },
  fusion: { icon: <ArrowRightLeft size={14} />, color: 'text-rose-400' },
  spaltning: { icon: <ArrowRightLeft size={14} />, color: 'text-pink-400' },
};

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
  const [aktivTab, setAktivTab] = useState<TabId>('overview');
  const [erFulgt, setErFulgt] = useState(false);

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

        // Gem i seneste besøgte — kun ved faktisk åbning af detaljesiden
        saveRecentCompany({
          cvr: company.vat,
          name: company.name,
          industry: company.industrydesc,
          address: company.address,
          zipcode: company.zipcode,
          city: company.city,
          active: !company.enddate,
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
  }, [cvr, lang]);

  /**
   * Sæt AI-kontekst når virksomhedsdata er loadet.
   * AI-assistenten kan dermed bruge CVR-nummeret direkte i tool-kald.
   */
  useEffect(() => {
    if (!data) return;
    setAICtx({
      cvrNummer: String(data.vat),
      virksomhedNavn: data.name,
    });
  }, [data, setAICtx]);

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
   */
  useEffect(() => {
    if (aktivTab !== 'properties') return;
    if (ejendommeData.length === 0) return;

    // Find BFE'er der mangler enriched data
    const missing = ejendommeData.filter((e) => !preEnrichedByBfe.has(e.bfeNummer));
    if (missing.length === 0) return;

    const controller = new AbortController();
    const bfes = missing.map((e) => e.bfeNummer).join(',');
    const dawaIds = missing.map((e) => e.dawaId ?? '').join(',');

    fetch(`/api/ejendomme-by-owner/enrich-batch?bfes=${bfes}&dawaIds=${dawaIds}`, {
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
  }, [aktivTab, ejendommeData, preEnrichedByBfe]);

  /**
   * Trigger progressiv ejendomshentning når properties-tab aktiveres eller CVR-sæt ændres.
   * Kører igen når relatedCompanies ændres (datterselskaber loader ind).
   */
  useEffect(() => {
    if (aktivTab !== 'properties' && aktivTab !== 'diagram') return;

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

  /** Læsbar kategori-label */
  const kategoriLabel = (kat: string): string => {
    const da = lang === 'da';
    const map: Record<string, string> = {
      EJER: da ? 'Ejere' : 'Owners',
      BESTYRELSE: da ? 'Bestyrelse' : 'Board',
      STIFTER: da ? 'Stiftere' : 'Founders',
      REVISION: da ? 'Revision' : 'Auditors',
      DIREKTION: da ? 'Direktion' : 'Management',
      ANDET: da ? 'Øvrige' : 'Other',
    };
    return map[kat] ?? kat;
  };

  /** Kategori-ikon */
  const kategoriIkon = (kat: string): React.ReactNode => {
    const map: Record<string, React.ReactNode> = {
      EJER: <Shield size={16} className="text-emerald-400" />,
      BESTYRELSE: <Users size={16} className="text-blue-400" />,
      STIFTER: <Tag size={16} className="text-purple-400" />,
      REVISION: <CheckCircle size={16} className="text-amber-400" />,
      DIREKTION: <Briefcase size={16} className="text-cyan-400" />,
      ANDET: <Users size={16} className="text-slate-400" />,
    };
    return map[kat] ?? <Users size={16} className="text-slate-400" />;
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

  /** Sorteret historik — nyeste først */
  const sortedHistorik = [...(data.historik ?? [])].sort(
    (a, b) => new Date(b.fra).getTime() - new Date(a.fra).getTime()
  );

  /** Historik grupperet efter type */
  const historikByType = sortedHistorik.reduce<Record<string, typeof sortedHistorik>>((acc, h) => {
    if (!acc[h.type]) acc[h.type] = [];
    acc[h.type].push(h);
    return acc;
  }, {});

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
          {aktivTab === 'overview' && (
            <div className="space-y-4">
              {/* ── Sektionsfiltre (Kronologi-stil: Alle eller én valgt) ── */}
              {(() => {
                const harGruppe =
                  relatedCompanies.filter((v) => v.aktiv).length > 0 ||
                  ownerChainShared.some((o) => o.erVirksomhed);
                const filterChips: [string, string, React.ReactNode, string, string][] = [
                  [
                    'info',
                    'Info',
                    <Building2 key="i" size={12} />,
                    'text-blue-400',
                    'bg-blue-600/30 border-blue-500/50 text-blue-300',
                  ],
                  ...(harGruppe
                    ? [
                        [
                          'gruppe',
                          lang === 'da' ? 'Gruppe Info' : 'Group Info',
                          <Building2 key="g" size={12} />,
                          'text-indigo-400',
                          'bg-indigo-600/30 border-indigo-500/50 text-indigo-300',
                        ] as [string, string, React.ReactNode, string, string],
                      ]
                    : []),
                  [
                    'pe',
                    lang === 'da' ? 'P-enheder' : 'Prod. Units',
                    <Factory key="p" size={12} />,
                    'text-cyan-400',
                    'bg-cyan-600/30 border-cyan-500/50 text-cyan-300',
                  ],
                ];
                return (
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => setOversigtFilter(null)}
                      className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all border ${
                        oversigtFilter === null
                          ? 'bg-white/10 border-white/30 text-white'
                          : 'bg-slate-800/50 border-slate-700/40 text-slate-400 hover:text-slate-200 hover:border-slate-600'
                      }`}
                    >
                      <LayoutDashboard size={12} />
                      {lang === 'da' ? 'Alle' : 'All'}
                    </button>
                    {filterChips.map(([key, label, icon, color, activeClass]) => (
                      <button
                        key={key}
                        onClick={() => setOversigtFilter(oversigtFilter === key ? null : key)}
                        className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all border ${
                          oversigtFilter === key
                            ? activeClass
                            : 'bg-slate-800/50 border-slate-700/40 text-slate-400 hover:text-slate-200 hover:border-slate-600'
                        }`}
                      >
                        <span className={oversigtFilter === key ? '' : color}>{icon}</span>
                        {label}
                      </button>
                    ))}
                  </div>
                );
              })()}

              {/* ── Layout: Info (venstre) + Gruppe (højre) — fuld bredde hvis ingen gruppe ── */}
              <div
                className={`grid grid-cols-1 ${relatedCompanies.filter((v) => v.aktiv).length > 0 ? 'lg:grid-cols-2' : ''} gap-4`}
              >
                {/* ═══ KOLONNE 1: Info ═══ */}
                {(oversigtFilter === null || oversigtFilter === 'info') &&
                  (() => {
                    const aktiveEjere = personerByKategori['EJER']?.aktive ?? [];
                    const aktiveDirektion = personerByKategori['DIREKTION']?.aktive ?? [];
                    const aktiveRevision = personerByKategori['REVISION']?.aktive ?? [];
                    return (
                      <section className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-5">
                        {/* Overskrift med branchekode */}
                        <h2 className="text-white font-semibold text-sm flex items-center gap-2">
                          <Building2 size={15} className="text-blue-400" />
                          Info
                        </h2>
                        {data.industrydesc && (
                          <p className="text-slate-400 text-xs mt-1">
                            {data.industrycode ? `${data.industrycode} — ` : ''}
                            {data.industrydesc}
                          </p>
                        )}
                        {/* BIZZ-512: Sekundære brancher (bibranche1/2/3). For holdinger
                            og blandede virksomheder er bibrancherne ofte mere retvisende
                            end hovedbranchen alene. */}
                        {data.secondaryIndustries && data.secondaryIndustries.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1 mb-3">
                            {data.secondaryIndustries.map((b, i) => (
                              <span
                                key={i}
                                className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-slate-700/40 border border-slate-600/40 text-slate-300"
                                title={
                                  b.code != null ? `${b.code} — ${b.desc ?? '—'}` : (b.desc ?? '')
                                }
                              >
                                {b.code != null && (
                                  <span className="text-slate-500 mr-1">{b.code}</span>
                                )}
                                {b.desc ?? '—'}
                              </span>
                            ))}
                          </div>
                        )}
                        {!data.industrydesc &&
                          !(data.secondaryIndustries && data.secondaryIndustries.length > 0) && (
                            <div className="mb-3" />
                          )}

                        {/* ── Stamdata — 2-kolonne grid, label over værdi ── */}
                        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                              {c.founded}
                            </p>
                            <p className="text-white text-sm font-medium">
                              {data.stiftet ?? data.startdate ?? '—'}
                            </p>
                          </div>
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                              {c.employees}
                            </p>
                            <p className="text-white text-sm font-medium">
                              {data.employees ?? '—'}
                            </p>
                          </div>
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                              {c.registeredCapital}
                            </p>
                            <p className="text-white text-sm font-medium">
                              {data.registreretKapital
                                ? `${data.registreretKapital.vaerdi.toLocaleString('da-DK')} ${data.registreretKapital.valuta}`
                                : '—'}
                            </p>
                          </div>
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                              {c.municipality}
                            </p>
                            <p className="text-white text-sm font-medium">{data.kommune ?? '—'}</p>
                          </div>
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                              {c.accountingYear}
                            </p>
                            <p className="text-white text-sm font-medium">
                              {data.regnskabsaar
                                ? `${String(data.regnskabsaar.startDag).padStart(2, '0')}/${String(data.regnskabsaar.startMaaned).padStart(2, '0')} – ${String(data.regnskabsaar.slutDag).padStart(2, '0')}/${String(data.regnskabsaar.slutMaaned).padStart(2, '0')}`
                                : '—'}
                            </p>
                          </div>
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                              {c.adProtected}
                            </p>
                            <p className="text-white text-sm font-medium">
                              {data.reklamebeskyttet ? 'Ja' : 'Nej'}
                            </p>
                          </div>
                          {data.enddate && (
                            <div className="col-span-2">
                              <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                                {c.endDate}
                              </p>
                              <p className="text-red-400 text-sm font-medium">{data.enddate}</p>
                            </div>
                          )}
                          {data.senesteVedtaegtsdato && (
                            <div>
                              <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                                {lang === 'da' ? 'Seneste vedtægtsdato' : 'Latest articles date'}
                              </p>
                              <p className="text-white text-sm font-medium">
                                {data.senesteVedtaegtsdato}
                              </p>
                            </div>
                          )}
                          {data.foersteRegnskabsperiode && (
                            <div>
                              <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                                {lang === 'da'
                                  ? 'Første regnskabsperiode'
                                  : 'First accounting period'}
                              </p>
                              <p className="text-white text-sm font-medium">
                                {data.foersteRegnskabsperiode.start} –{' '}
                                {data.foersteRegnskabsperiode.slut}
                              </p>
                            </div>
                          )}
                          {data.statusTekst && (
                            <div>
                              <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                                {lang === 'da' ? 'Virksomhedsstatus' : 'Company status'}
                              </p>
                              <p className="text-white text-sm font-medium">{data.statusTekst}</p>
                            </div>
                          )}
                          {/* BIZZ-520: P-enheder count */}
                          {data.productionunits && data.productionunits.length > 0 && (
                            <div>
                              <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                                {lang === 'da' ? 'Produktionsenheder' : 'Production units'}
                              </p>
                              <p className="text-white text-sm font-medium">
                                {data.productionunits.filter((p) => p.active).length}
                                {data.productionunits.some((p) => !p.active) && (
                                  <span className="text-slate-500 text-xs ml-1">
                                    ({data.productionunits.length}{' '}
                                    {lang === 'da' ? 'i alt' : 'total'})
                                  </span>
                                )}
                              </p>
                            </div>
                          )}
                          {/* BIZZ-520: sidstOpdateret — CVR data freshness */}
                          {data.sidstOpdateret && (
                            <div className="col-span-2">
                              <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                                {lang === 'da' ? 'Data opdateret' : 'Data updated'}
                              </p>
                              <p className="text-slate-400 text-xs">
                                {new Date(data.sidstOpdateret).toLocaleDateString(
                                  lang === 'da' ? 'da-DK' : 'en-GB',
                                  { year: 'numeric', month: 'long', day: 'numeric' }
                                )}
                              </p>
                            </div>
                          )}
                        </div>

                        {/* BIZZ-513: Beskæftigelseshistorik */}
                        {data.aarsbeskaeftigelse && data.aarsbeskaeftigelse.length > 0 && (
                          <div className="mt-4 pt-3 border-t border-slate-700/30">
                            <p className="text-slate-500 text-[10px] uppercase tracking-wider font-medium mb-2">
                              {lang === 'da' ? 'Beskæftigelseshistorik' : 'Employment history'}
                            </p>
                            <div className="grid grid-cols-[auto_1fr_1fr] gap-x-4 gap-y-1 text-xs">
                              <span className="text-slate-500 font-medium">
                                {lang === 'da' ? 'År' : 'Year'}
                              </span>
                              <span className="text-slate-500 font-medium text-right">
                                {lang === 'da' ? 'Ansatte' : 'Employees'}
                              </span>
                              <span className="text-slate-500 font-medium text-right">
                                {lang === 'da' ? 'Årsværk' : 'FTE'}
                              </span>
                              {data.aarsbeskaeftigelse.slice(0, 8).map((a, idx) => (
                                <Fragment key={a.aar ?? idx}>
                                  <span className="text-slate-400 tabular-nums">{a.aar}</span>
                                  <span className="text-white text-right tabular-nums">
                                    {a.antalAnsatte ?? '—'}
                                  </span>
                                  <span className="text-slate-300 text-right tabular-nums">
                                    {a.antalAarsvaerk ?? '—'}
                                  </span>
                                </Fragment>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* ── Ledelse, Ejere & Kontakt — 2-kolonne grid ── */}
                        <div className="mt-4 pt-3 border-t border-slate-700/30 grid grid-cols-1 sm:grid-cols-2 gap-4">
                          {/* Ejere */}
                          {aktiveEjere.length > 0 && (
                            <div>
                              <p className="text-slate-500 text-[10px] uppercase tracking-wider font-medium mb-1.5">
                                {lang === 'da' ? 'Ejere' : 'Owners'}
                              </p>
                              <ul className="space-y-1.5">
                                {aktiveEjere.map((e, i) => (
                                  <li key={i} className="flex items-center justify-between gap-2">
                                    {e.deltager.enhedsNummer ? (
                                      <Link
                                        href={
                                          e.deltager.erVirksomhed
                                            ? `/dashboard/companies/${e.deltager.enhedsNummer}`
                                            : `/dashboard/owners/${e.deltager.enhedsNummer}`
                                        }
                                        className={`text-white text-sm truncate transition-colors ${e.deltager.erVirksomhed ? 'hover:text-blue-300' : 'hover:text-purple-300'}`}
                                      >
                                        {e.deltager.navn}
                                      </Link>
                                    ) : (
                                      <span className="text-white text-sm truncate">
                                        {e.deltager.navn}
                                      </span>
                                    )}
                                    {e.rolle.ejerandel && (
                                      <span className="shrink-0 text-[10px] font-medium text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded">
                                        {e.rolle.ejerandel}
                                      </span>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}

                          {/* Direktion */}
                          {aktiveDirektion.length > 0 && (
                            <div>
                              <p className="text-slate-500 text-[10px] uppercase tracking-wider font-medium mb-1.5">
                                {lang === 'da' ? 'Direktion' : 'Management'}
                              </p>
                              <ul className="space-y-1">
                                {aktiveDirektion.map((e, i) => (
                                  <li key={i} className="text-sm truncate">
                                    {e.deltager.enhedsNummer ? (
                                      <Link
                                        href={
                                          e.deltager.erVirksomhed
                                            ? `/dashboard/companies/${e.deltager.enhedsNummer}`
                                            : `/dashboard/owners/${e.deltager.enhedsNummer}`
                                        }
                                        className={`text-white transition-colors ${e.deltager.erVirksomhed ? 'hover:text-blue-300' : 'hover:text-purple-300'}`}
                                      >
                                        {e.deltager.navn}
                                      </Link>
                                    ) : (
                                      <span className="text-white">{e.deltager.navn}</span>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}

                          {/* Revision */}
                          {aktiveRevision.length > 0 && (
                            <div>
                              <p className="text-slate-500 text-[10px] uppercase tracking-wider font-medium mb-1.5">
                                {lang === 'da' ? 'Revision' : 'Auditor'}
                              </p>
                              <ul className="space-y-1">
                                {aktiveRevision.map((e, i) => (
                                  <li key={i} className="text-sm truncate">
                                    {e.deltager.enhedsNummer ? (
                                      <Link
                                        href={
                                          e.deltager.erVirksomhed
                                            ? `/dashboard/companies/${e.deltager.enhedsNummer}`
                                            : `/dashboard/owners/${e.deltager.enhedsNummer}`
                                        }
                                        className={`text-white transition-colors ${e.deltager.erVirksomhed ? 'hover:text-blue-300' : 'hover:text-purple-300'}`}
                                      >
                                        {e.deltager.navn}
                                      </Link>
                                    ) : (
                                      <span className="text-white">{e.deltager.navn}</span>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}

                          {/* Kontakt */}
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase tracking-wider font-medium mb-1.5">
                              {c.contact}
                            </p>
                            <div className="space-y-1">
                              <p className="text-white text-sm flex items-center gap-1.5">
                                <MapPin size={12} className="text-slate-500 shrink-0" />
                                {data.address}
                                {data.addressco ? `, ${data.addressco}` : ''}, {data.zipcode}{' '}
                                {data.city}
                              </p>
                              {data.phone && (
                                <p className="text-white text-sm flex items-center gap-1.5">
                                  <Phone size={12} className="text-slate-500 shrink-0" />
                                  {data.phone}
                                </p>
                              )}
                              {data.email && (
                                <p className="text-white text-sm flex items-center gap-1.5">
                                  <Mail size={12} className="text-slate-500 shrink-0" />
                                  {data.email}
                                </p>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* ── Tegningsregel + Formål — 2-kolonne grid ── */}
                        {(data.tegningsregel || data.formaal) && (
                          <div className="mt-3 pt-3 border-t border-slate-700/30 grid grid-cols-1 sm:grid-cols-2 gap-4">
                            {data.tegningsregel && (
                              <div>
                                <p className="text-slate-500 text-[10px] uppercase tracking-wider mb-0.5">
                                  {c.signingRule}
                                </p>
                                <p className="text-slate-300 text-xs leading-relaxed">
                                  {data.tegningsregel}
                                </p>
                              </div>
                            )}
                            {data.formaal && (
                              <div>
                                <p className="text-slate-500 text-[10px] uppercase tracking-wider mb-0.5">
                                  {c.purpose}
                                </p>
                                <p className="text-slate-300 text-xs leading-relaxed">
                                  {data.formaal}
                                </p>
                              </div>
                            )}
                          </div>
                        )}
                      </section>
                    );
                  })()}

                {/* ═══ KOLONNE 2: Gruppe Info + Gruppeøkonomi ═══ */}
                <div className="flex flex-col gap-4">
                  {/* Gruppe Info */}
                  {(oversigtFilter === null || oversigtFilter === 'gruppe') &&
                    (() => {
                      const aktive = relatedCompanies.filter((v) => v.aktiv);
                      const totalAnsatte =
                        aktive.reduce((sum, v) => {
                          const n = v.ansatte ? parseInt(v.ansatte.replace(/\D/g, ''), 10) : 0;
                          return sum + (isNaN(n) ? 0 : n);
                        }, 0) +
                        (data.employees
                          ? parseInt(String(data.employees).replace(/\D/g, ''), 10) || 0
                          : 0);
                      const totalPenheder =
                        aktive.reduce((sum, v) => sum + v.antalPenheder, 0) +
                        (data.productionunits?.length ?? 0);
                      const totalDatter = aktive.length;
                      const fmtNum = (n: number) => n.toLocaleString('da-DK');

                      return relatedLoading ? (
                        // BIZZ-478: Ensartet blå TabLoadingSpinner.
                        <TabLoadingSpinner label={c.loading} />
                      ) : aktive.length > 0 ? (
                        <section className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-5">
                          <h2 className="text-white font-semibold text-sm mb-3 flex items-center gap-2">
                            <Building2 size={15} className="text-indigo-400" />
                            {lang === 'da' ? 'Gruppe Info' : 'Group Info'}
                          </h2>
                          <div className="grid grid-cols-2 gap-3">
                            <div className="bg-slate-900/50 rounded-lg p-3 text-center">
                              <p className="text-xl font-bold text-white">{totalDatter + 1}</p>
                              <p className="text-slate-500 text-[10px] mt-0.5">
                                {lang === 'da' ? 'Virksomheder' : 'Companies'}
                              </p>
                            </div>
                            <div className="bg-slate-900/50 rounded-lg p-3 text-center">
                              <p className="text-xl font-bold text-white">{fmtNum(totalAnsatte)}</p>
                              <p className="text-slate-500 text-[10px] mt-0.5">
                                {lang === 'da' ? 'Ansatte' : 'Employees'}
                              </p>
                            </div>
                            <div className="bg-slate-900/50 rounded-lg p-3 text-center">
                              <p className="text-xl font-bold text-white">
                                {fmtNum(totalPenheder)}
                              </p>
                              <p className="text-slate-500 text-[10px] mt-0.5">
                                P-{lang === 'da' ? 'enheder' : 'units'}
                              </p>
                            </div>
                            <div className="bg-slate-900/50 rounded-lg p-3 text-center">
                              <p className="text-xl font-bold text-white">{totalDatter}</p>
                              <p className="text-slate-500 text-[10px] mt-0.5">
                                {lang === 'da' ? 'Datterselskaber' : 'Subsidiaries'}
                              </p>
                            </div>
                          </div>
                        </section>
                      ) : null;
                    })()}

                  {/* BIZZ-406: Regnskabs-nøgletal for seneste år */}
                  {(oversigtFilter === null || oversigtFilter === 'gruppe') &&
                    (() => {
                      if (xbrlLoading)
                        return (
                          <section className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-5 animate-pulse">
                            <div className="h-4 bg-slate-700/50 rounded w-32 mb-3" />
                            <div className="grid grid-cols-3 gap-3">
                              <div className="h-10 bg-slate-700/30 rounded" />
                              <div className="h-10 bg-slate-700/30 rounded" />
                              <div className="h-10 bg-slate-700/30 rounded" />
                            </div>
                          </section>
                        );
                      if (!xbrlData || xbrlData.length === 0) return null;
                      const seneste = xbrlData[0];
                      const r = seneste.resultat;
                      const b = seneste.balance;
                      const hasData =
                        r.bruttofortjeneste != null ||
                        r.resultatFoerSkat != null ||
                        b.egenkapital != null;
                      if (!hasData) return null;
                      // BIZZ-459: XBRL-route normaliserer nu alle monetære
                      // felter til T DKK (tusinder) før udlevering. Label
                      // matcher kilden.
                      const fmtDKK = (v: number | null | undefined) =>
                        v != null
                          ? v.toLocaleString('da-DK', { maximumFractionDigits: 0 }) + ' T DKK'
                          : '–';
                      return (
                        <section className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-5">
                          <h3 className="text-white font-semibold text-sm mb-3">
                            {lang === 'da' ? 'Nøgletal' : 'Key Figures'}
                            <span className="text-slate-500 text-xs font-normal ml-2">
                              ({seneste.aar})
                            </span>
                          </h3>
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                            {r.bruttofortjeneste != null && (
                              <div>
                                <p className="text-slate-500 text-xs">
                                  {lang === 'da' ? 'Bruttofortjeneste' : 'Gross profit'}
                                </p>
                                <p
                                  className={`text-sm font-semibold ${(r.bruttofortjeneste ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}
                                >
                                  {fmtDKK(r.bruttofortjeneste)}
                                </p>
                              </div>
                            )}
                            {r.resultatFoerSkat != null && (
                              <div>
                                <p className="text-slate-500 text-xs">
                                  {lang === 'da' ? 'Resultat før skat' : 'Profit before tax'}
                                </p>
                                <p
                                  className={`text-sm font-semibold ${(r.resultatFoerSkat ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}
                                >
                                  {fmtDKK(r.resultatFoerSkat)}
                                </p>
                              </div>
                            )}
                            {b.egenkapital != null && (
                              <div>
                                <p className="text-slate-500 text-xs">
                                  {lang === 'da' ? 'Egenkapital' : 'Equity'}
                                </p>
                                <p
                                  className={`text-sm font-semibold ${(b.egenkapital ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}
                                >
                                  {fmtDKK(b.egenkapital)}
                                </p>
                              </div>
                            )}
                          </div>
                        </section>
                      );
                    })()}
                </div>
              </div>

              {/* ── P-enheder — fuld bredde under kolonnerne ── */}
              {(oversigtFilter === null || oversigtFilter === 'pe') && (
                <section className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-5">
                  <h2 className="text-white font-semibold text-sm mb-3 flex items-center gap-2">
                    <Factory size={15} className="text-cyan-400" />
                    {c.productionUnits}{' '}
                    {data.productionunits ? `(${data.productionunits.length})` : ''}
                  </h2>
                  {data.productionunits && data.productionunits.length > 0 ? (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-slate-500 text-xs uppercase tracking-wide border-b border-slate-700/40">
                            <th className="pb-2 pr-4">{c.pNumber}</th>
                            <th className="pb-2 pr-4">{c.name}</th>
                            <th className="pb-2 pr-4">{c.address}</th>
                            <th className="pb-2 pr-4">{c.industry}</th>
                            {/* BIZZ-514: Ansatte-kolonne per P-enhed */}
                            <th className="pb-2 pr-4">{c.employeesShort}</th>
                            <th className="pb-2">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.productionunits.map((pu) => (
                            <tr key={pu.pno} className="border-b border-slate-700/20 text-white">
                              <td className="py-2 pr-4 text-slate-400 font-mono text-xs">
                                {pu.pno}
                                {/* BIZZ-514: Hoved-P-enhed markering */}
                                {pu.main && (
                                  <span
                                    className="ml-1.5 text-[9px] px-1 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30"
                                    title={
                                      lang === 'da'
                                        ? 'Hovedproduktionsenhed'
                                        : 'Main production unit'
                                    }
                                  >
                                    {lang === 'da' ? 'Hoved' : 'Main'}
                                  </span>
                                )}
                              </td>
                              <td className="py-2 pr-4">{pu.name}</td>
                              <td className="py-2 pr-4 text-slate-300 text-xs">
                                {pu.address}, {pu.zipcode} {pu.city}
                              </td>
                              <td className="py-2 pr-4 text-slate-400 text-xs">
                                <div className="flex flex-col gap-0.5">
                                  <span>{pu.industrydesc ?? '—'}</span>
                                  {/* BIZZ-514: Bibrancher per P-enhed som små tags under hovedbranchen */}
                                  {pu.secondaryIndustries && pu.secondaryIndustries.length > 0 && (
                                    <div className="flex flex-wrap gap-0.5">
                                      {pu.secondaryIndustries.map((b, i) => (
                                        <span
                                          key={i}
                                          className="text-[9px] px-1 py-0.5 rounded bg-slate-700/40 border border-slate-600/40 text-slate-400"
                                          title={
                                            b.code != null
                                              ? `${b.code} — ${b.desc ?? '—'}`
                                              : (b.desc ?? '')
                                          }
                                        >
                                          {b.desc ?? '—'}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </td>
                              <td className="py-2 pr-4 text-slate-300 text-xs tabular-nums">
                                {pu.employees ?? '—'}
                              </td>
                              <td className="py-2">
                                <span
                                  className={`px-2 py-0.5 rounded text-xs font-medium ${pu.active !== false ? 'bg-emerald-600/20 text-emerald-400' : 'bg-red-600/20 text-red-400'}`}
                                >
                                  {pu.active !== false ? c.active : c.ceased}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <EmptyState
                      ikon={<MapPin size={32} className="text-slate-600" />}
                      tekst={c.noProductionUnits}
                    />
                  )}
                </section>
              )}
            </div>
          )}

          {/* ══ RELATIONSDIAGRAM (Force Graph — original) ══ */}
          {aktivTab === 'diagram' && <DiagramForce graph={diagramGraphStable} lang={lang} />}

          {/* ══ EJENDOMME (inkl. ejendomshandler) ══ */}
          {aktivTab === 'properties' && (
            <div className="space-y-4">
              {(ejendommeLoading || ejendommeLoadingMore) && <TabLoadingSpinner />}
              {/* BIZZ-441: Filter chips removed — only property portfolio shown */}

              {/* ── Ejendomme-portefølje sektion ── */}
              {
                <div className="space-y-4">
                  {/* Indledende spinner — BIZZ-478: ensartet blå TabLoadingSpinner */}
                  {ejendommeLoading && ejendommeData.length === 0 && (
                    <TabLoadingSpinner
                      label={
                        lang === 'da' ? 'Henter ejendomsportefølje…' : 'Loading property portfolio…'
                      }
                    />
                  )}

                  {/* Mangler nøgle / adgang */}
                  {ejendommeFetchComplete && ejendommeManglerNoegle && (
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                      <Home size={36} className="text-slate-600 mb-3" />
                      <p className="text-slate-400 text-sm max-w-sm">
                        {lang === 'da'
                          ? 'Ejendomsopslag kræver Datafordeler OAuth-nøgler (DATAFORDELER_OAUTH_CLIENT_ID / CLIENT_SECRET).'
                          : 'Property lookup requires Datafordeler OAuth keys (DATAFORDELER_OAUTH_CLIENT_ID / CLIENT_SECRET).'}
                      </p>
                    </div>
                  )}
                  {ejendommeFetchComplete && ejendommeManglerAdgang && (
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                      <Home size={36} className="text-slate-600 mb-3" />
                      <p className="text-slate-400 text-sm max-w-sm">
                        {lang === 'da'
                          ? 'Adgang til Ejerfortegnelsen (EJF) er ikke godkendt endnu. Ansøg om Dataadgang på datafordeler.dk.'
                          : 'Access to the Danish land registry (EJF) has not been approved yet. Apply for Dataadgang at datafordeler.dk.'}
                      </p>
                    </div>
                  )}

                  {/* Ejendomme grid */}
                  {ejendommeData.length > 0 && (
                    <>
                      <div className="flex items-center justify-between">
                        <p className="text-slate-400 text-sm">
                          {ejendommeLoadingMore
                            ? lang === 'da'
                              ? `Indlæser… (${ejendommeData.length} af ${ejendommeTotalBfe} ejendomme)`
                              : `Loading… (${ejendommeData.length} of ${ejendommeTotalBfe} properties)`
                            : lang === 'da'
                              ? `${ejendommeData.length} ejendom${ejendommeData.length !== 1 ? 'me' : ''} fundet`
                              : `${ejendommeData.length} propert${ejendommeData.length !== 1 ? 'ies' : 'y'} found`}
                        </p>
                        {relatedCompanies.length > 0 && (
                          <span className="text-slate-500 text-xs">
                            {lang === 'da'
                              ? `Inkl. ${relatedCompanies.filter((v) => v.aktiv).length} datterselskab${relatedCompanies.filter((v) => v.aktiv).length !== 1 ? 'er' : ''}`
                              : `Incl. ${relatedCompanies.filter((v) => v.aktiv).length} subsidiar${relatedCompanies.filter((v) => v.aktiv).length !== 1 ? 'ies' : 'y'}`}
                          </span>
                        )}
                      </div>

                      {/* BIZZ-456: Gruppér ejendomme efter ejer-CVR i koncernhierarki.
                          BIZZ-455: Separat fold-ud for solgte ejendomme. */}
                      {(() => {
                        // Build concern hierarchy order: main CVR first, then active subsidiaries
                        const cvrOrder: number[] = [data.vat];
                        const seenCvr = new Set<number>([data.vat]);
                        for (const rv of relatedCompanies.filter((v) => v.aktiv)) {
                          if (!seenCvr.has(rv.cvr)) {
                            cvrOrder.push(rv.cvr);
                            seenCvr.add(rv.cvr);
                          }
                        }
                        const nameByCvr = new Map<number, string>();
                        nameByCvr.set(data.vat, data.name);
                        for (const rv of relatedCompanies) nameByCvr.set(rv.cvr, rv.navn);

                        // Split into active and sold
                        const aktive = ejendommeData.filter((e) => e.aktiv !== false);
                        const solgte = ejendommeData.filter((e) => e.aktiv === false);

                        // Group active by ownerCvr (normalized to number)
                        const groupedActive = new Map<number, typeof aktive>();
                        for (const e of aktive) {
                          const cvrNum = parseInt(e.ownerCvr, 10);
                          if (!groupedActive.has(cvrNum)) groupedActive.set(cvrNum, []);
                          groupedActive.get(cvrNum)!.push(e);
                        }
                        // Catch any ownerCvrs not in cvrOrder (e.g. person-owned)
                        for (const cvr of groupedActive.keys()) {
                          if (!seenCvr.has(cvr)) {
                            cvrOrder.push(cvr);
                            seenCvr.add(cvr);
                          }
                        }

                        return (
                          <>
                            {cvrOrder.map((cvr) => {
                              const props = groupedActive.get(cvr);
                              if (!props || props.length === 0) return null;
                              const name = nameByCvr.get(cvr) ?? `CVR ${cvr}`;
                              const isMain = cvr === data.vat;
                              return (
                                <div key={cvr} className="space-y-2">
                                  <Link
                                    href={`/dashboard/companies/${cvr}`}
                                    className="inline-flex items-center gap-2 group"
                                  >
                                    <Building2
                                      size={14}
                                      className="text-slate-500 group-hover:text-blue-400 transition-colors"
                                    />
                                    <h3 className="text-sm font-semibold text-slate-200 group-hover:text-blue-400 transition-colors">
                                      {name}
                                    </h3>
                                    <span className="text-[10px] text-slate-500 font-mono">
                                      CVR {cvr}
                                    </span>
                                    <span className="text-[10px] text-slate-500">
                                      · {props.length}{' '}
                                      {lang === 'da'
                                        ? props.length === 1
                                          ? 'ejendom'
                                          : 'ejendomme'
                                        : props.length === 1
                                          ? 'property'
                                          : 'properties'}
                                    </span>
                                    {isMain && (
                                      <span className="text-[9px] px-1.5 py-0.5 bg-blue-500/15 border border-blue-500/30 rounded text-blue-400 font-medium">
                                        {lang === 'da' ? 'Moder' : 'Parent'}
                                      </span>
                                    )}
                                  </Link>
                                  {/* BIZZ-461: Gruppér ejendomme der deler adresse (typisk
                                      ejerlejligheder i samme bygning) under en kompleks-header.
                                      Kun grupper med 2+ ejendomme får header — single-ejendomme
                                      vises som før. */}
                                  {(() => {
                                    type EjType = (typeof props)[number];
                                    const groups = new Map<string, EjType[]>();
                                    const order: string[] = [];
                                    for (const ej of props) {
                                      // Key = adresse + postnr; tom adresse = unikt fallback per BFE
                                      const key = ej.adresse
                                        ? `${ej.adresse}|${ej.postnr ?? ''}`
                                        : `bfe-${ej.bfeNummer}`;
                                      if (!groups.has(key)) {
                                        groups.set(key, []);
                                        order.push(key);
                                      }
                                      groups.get(key)!.push(ej);
                                    }
                                    // BIZZ-569: Saml ALLE single-properties (ikke-kompleks)
                                    // i ÉN delt grid så de flow'er horisontalt på desktop.
                                    // Tidligere fik hver enkelt sit eget grid-wrapper hvilket
                                    // tvang dem til at stack vertikalt selv på brede skærme.
                                    // Bumpet bredde til lg:3 og xl:4 kolonner per spec.
                                    const singleEjendomme = order
                                      .filter((k) => groups.get(k)!.length === 1)
                                      .map((k) => groups.get(k)![0]);
                                    const komplekser = order.filter(
                                      (k) => groups.get(k)!.length > 1
                                    );
                                    return (
                                      <div className="space-y-4">
                                        {singleEjendomme.length > 0 && (
                                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                                            {singleEjendomme.map((ej) => (
                                              <PropertyOwnerCard
                                                key={ej.bfeNummer}
                                                ejendom={ej}
                                                showOwner={false}
                                                lang={lang}
                                                preEnriched={
                                                  preEnrichedByBfe.get(ej.bfeNummer) ?? null
                                                }
                                              />
                                            ))}
                                          </div>
                                        )}
                                        {komplekser.map((key) => {
                                          const grp = groups.get(key)!;
                                          // Kompleks: header + indented grid
                                          return (
                                            <div
                                              key={key}
                                              className="border-l-2 border-emerald-500/30 pl-3"
                                            >
                                              <div className="flex items-center gap-2 mb-1.5">
                                                <Building2
                                                  size={12}
                                                  className="text-emerald-400/70"
                                                />
                                                <span className="text-xs font-medium text-slate-300">
                                                  {grp[0].adresse}
                                                  {grp[0].postnr ? `, ${grp[0].postnr}` : ''}
                                                </span>
                                                <span className="text-[10px] text-emerald-400/70 px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20">
                                                  {lang === 'da'
                                                    ? `Kompleks · ${grp.length} ejerlejligheder`
                                                    : `Complex · ${grp.length} units`}
                                                </span>
                                              </div>
                                              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                                                {grp.map((ej) => (
                                                  <PropertyOwnerCard
                                                    key={ej.bfeNummer}
                                                    ejendom={ej}
                                                    showOwner={false}
                                                    lang={lang}
                                                    preEnriched={
                                                      preEnrichedByBfe.get(ej.bfeNummer) ?? null
                                                    }
                                                  />
                                                ))}
                                              </div>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    );
                                  })()}
                                </div>
                              );
                            })}
                            {/* Fold-out for sold properties — grouped by historical owner */}
                            {solgte.length > 0 && (
                              <div className="pt-4 border-t border-slate-700/30">
                                <button
                                  type="button"
                                  onClick={() => setVisSolgte((v) => !v)}
                                  className="flex items-center gap-2 text-xs text-slate-400 hover:text-slate-200 transition-colors"
                                >
                                  {visSolgte ? (
                                    <ChevronDown size={14} />
                                  ) : (
                                    <ChevronRight size={14} />
                                  )}
                                  {lang === 'da'
                                    ? `${visSolgte ? 'Skjul' : 'Vis'} ${solgte.length} tidligere ejendom${solgte.length !== 1 ? 'me' : ''}`
                                    : `${visSolgte ? 'Hide' : 'Show'} ${solgte.length} former propert${solgte.length !== 1 ? 'ies' : 'y'}`}
                                </button>
                                {visSolgte &&
                                  (() => {
                                    // Group sold properties by historical owner (same ownerCvr logic)
                                    const groupedSold = new Map<number, typeof solgte>();
                                    for (const e of solgte) {
                                      const cvrNum = parseInt(e.ownerCvr, 10);
                                      if (!groupedSold.has(cvrNum)) groupedSold.set(cvrNum, []);
                                      groupedSold.get(cvrNum)!.push(e);
                                    }
                                    // Include sold-only CVRs not already in cvrOrder
                                    const soldCvrOrder = [...cvrOrder];
                                    for (const cvr of groupedSold.keys()) {
                                      if (!soldCvrOrder.includes(cvr)) soldCvrOrder.push(cvr);
                                    }
                                    return (
                                      <div className="space-y-4 mt-3">
                                        {soldCvrOrder.map((cvr) => {
                                          const props = groupedSold.get(cvr);
                                          if (!props || props.length === 0) return null;
                                          const name = nameByCvr.get(cvr) ?? `CVR ${cvr}`;
                                          return (
                                            <div key={cvr} className="space-y-2">
                                              <Link
                                                href={`/dashboard/companies/${cvr}`}
                                                className="inline-flex items-center gap-2 group"
                                              >
                                                <Building2
                                                  size={14}
                                                  className="text-slate-500 group-hover:text-blue-400 transition-colors"
                                                />
                                                <h3 className="text-sm font-semibold text-slate-400 group-hover:text-blue-400 transition-colors">
                                                  {name}
                                                </h3>
                                                <span className="text-[10px] text-slate-500 font-mono">
                                                  CVR {cvr}
                                                </span>
                                                <span className="text-[10px] text-slate-500">
                                                  · {props.length}{' '}
                                                  {lang === 'da'
                                                    ? props.length === 1
                                                      ? 'tidligere ejendom'
                                                      : 'tidligere ejendomme'
                                                    : props.length === 1
                                                      ? 'former property'
                                                      : 'former properties'}
                                                </span>
                                              </Link>
                                              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                                                {props.map((ej) => (
                                                  <PropertyOwnerCard
                                                    key={ej.bfeNummer}
                                                    ejendom={ej}
                                                    showOwner={false}
                                                    lang={lang}
                                                    preEnriched={
                                                      preEnrichedByBfe.get(ej.bfeNummer) ?? null
                                                    }
                                                  />
                                                ))}
                                              </div>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    );
                                  })()}
                              </div>
                            )}
                          </>
                        );
                      })()}

                      {ejendommeLoadingMore && (
                        <div className="flex items-center justify-center gap-2 py-4 text-slate-500 text-sm">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          {lang === 'da' ? `Indlæser flere ejendomme…` : `Loading more properties…`}
                        </div>
                      )}
                    </>
                  )}

                  {/* Ingen ejendomme */}
                  {ejendommeFetchComplete &&
                    !ejendommeManglerNoegle &&
                    !ejendommeManglerAdgang &&
                    ejendommeData.length === 0 && (
                      <div className="flex flex-col items-center justify-center py-12 text-center">
                        <Home size={36} className="text-slate-600 mb-3" />
                        <p className="text-slate-400 text-sm">
                          {lang === 'da'
                            ? 'Ingen registrerede ejendomme fundet for denne virksomhed eller dens koncern.'
                            : 'No registered properties found for this company or its group.'}
                        </p>
                      </div>
                    )}
                </div>
              }

              {/* BIZZ-441: Ejendomshandler sektion removed — only property portfolio shown */}
              {false && (
                <div className="space-y-4">
                  {handlerLoading ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="w-6 h-6 text-blue-500 animate-spin" />
                      <span className="ml-2 text-slate-400 text-sm">
                        {lang === 'da' ? 'Henter ejendomshandler…' : 'Loading property trades…'}
                      </span>
                    </div>
                  ) : ejendomshandler.length > 0 ? (
                    <>
                      {/* Summary cards */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 text-center">
                          <p className="text-xl font-bold text-white">{ejendomshandler.length}</p>
                          <p className="text-slate-500 text-[10px] mt-0.5">
                            {lang === 'da' ? 'Handler i alt' : 'Total trades'}
                          </p>
                        </div>
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 text-center">
                          <p className="text-xl font-bold text-emerald-400">
                            {ejendomshandler.filter((h) => h.rolle === 'koeber').length}
                          </p>
                          <p className="text-slate-500 text-[10px] mt-0.5">
                            {lang === 'da' ? 'Køb' : 'Purchases'}
                          </p>
                        </div>
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 text-center">
                          <p className="text-xl font-bold text-rose-400">
                            {ejendomshandler.filter((h) => h.rolle === 'saelger').length}
                          </p>
                          <p className="text-slate-500 text-[10px] mt-0.5">
                            {lang === 'da' ? 'Salg' : 'Sales'}
                          </p>
                        </div>
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 text-center">
                          <p className="text-xl font-bold text-white">
                            {new Set(ejendomshandler.map((h) => h.bfeNummer)).size}
                          </p>
                          <p className="text-slate-500 text-[10px] mt-0.5">
                            {lang === 'da' ? 'Ejendomme' : 'Properties'}
                          </p>
                        </div>
                      </div>

                      {/* Trade table */}
                      <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-hidden">
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-left text-slate-500 text-xs uppercase tracking-wide border-b border-slate-700/30">
                                <th className="px-4 py-2.5 whitespace-nowrap">
                                  {lang === 'da' ? 'Dato' : 'Date'}
                                </th>
                                <th className="px-4 py-2.5 whitespace-nowrap">
                                  {lang === 'da' ? 'Type' : 'Type'}
                                </th>
                                <th className="px-4 py-2.5 whitespace-nowrap">
                                  {lang === 'da' ? 'Rolle' : 'Role'}
                                </th>
                                <th className="px-4 py-2.5 whitespace-nowrap">{c.address}</th>
                                <th className="px-4 py-2.5 whitespace-nowrap text-right">
                                  {lang === 'da' ? 'Kontantpris' : 'Cash price'}
                                </th>
                                <th className="px-4 py-2.5 whitespace-nowrap text-right">
                                  {c.totalPrice}
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {ejendomshandler.map((h, i) => {
                                const dato = h.koebsaftaleDato ?? h.overtagelsesdato ?? '—';
                                const fmtDato = dato !== '—' ? dato.slice(0, 10) : '—';
                                const fmtPris = (n: number | null) => {
                                  if (n == null) return '—';
                                  if (Math.abs(n) >= 1_000_000)
                                    return `${(n / 1_000_000).toFixed(1).replace('.', ',')} mio kr`;
                                  return `${n.toLocaleString('da-DK')} kr`;
                                };
                                const adr = h.adresse
                                  ? `${h.adresse}${h.postnr ? `, ${h.postnr}` : ''}${h.by ? ` ${h.by}` : ''}`
                                  : `BFE ${h.bfeNummer}`;

                                return (
                                  <tr
                                    key={i}
                                    className="border-b border-slate-700/20 hover:bg-slate-800/30 transition-colors"
                                  >
                                    <td className="px-4 py-2.5 text-white font-mono text-xs whitespace-nowrap">
                                      {fmtDato}
                                    </td>
                                    <td className="px-4 py-2.5 text-slate-300 text-xs whitespace-nowrap">
                                      {h.overdragelsesmaade ?? '—'}
                                    </td>
                                    <td className="px-4 py-2.5 whitespace-nowrap">
                                      {h.rolle === 'koeber' ? (
                                        <span className="text-[10px] font-medium bg-emerald-500/15 text-emerald-400 px-2 py-0.5 rounded-full">
                                          {lang === 'da' ? 'Køber' : 'Buyer'}
                                        </span>
                                      ) : h.rolle === 'saelger' ? (
                                        <span className="text-[10px] font-medium bg-rose-500/15 text-rose-400 px-2 py-0.5 rounded-full">
                                          {lang === 'da' ? 'Sælger' : 'Seller'}
                                        </span>
                                      ) : (
                                        <span className="text-[10px] font-medium bg-slate-500/15 text-slate-400 px-2 py-0.5 rounded-full">
                                          —
                                        </span>
                                      )}
                                    </td>
                                    <td
                                      className="px-4 py-2.5 text-white text-xs max-w-[250px] truncate"
                                      title={adr}
                                    >
                                      {adr}
                                    </td>
                                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                                      <span
                                        className={`text-sm font-medium ${h.kontantKoebesum != null ? 'text-white' : 'text-slate-600'}`}
                                      >
                                        {fmtPris(h.kontantKoebesum)}
                                      </span>
                                    </td>
                                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                                      <span
                                        className={`text-sm font-medium ${h.samletKoebesum != null ? 'text-white' : 'text-slate-600'}`}
                                      >
                                        {fmtPris(h.samletKoebesum)}
                                      </span>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </>
                  ) : handlerManglerAdgang ? (
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                      <Shield size={32} className="text-amber-500/60 mb-3" />
                      <p className="text-slate-300 text-sm font-medium mb-1">
                        {lang === 'da'
                          ? 'Afventer EJF-adgang fra Datafordeler'
                          : 'Awaiting EJF access from Datafordeler'}
                      </p>
                      <p className="text-slate-500 text-xs max-w-md">
                        {lang === 'da'
                          ? 'Ejendomshandler kræver godkendt Dataadgang til Ejerfortegnelsen (EJF) hos Geodatastyrelsen. Ansøgningen er indsendt.'
                          : 'Property trades require approved data access to EJF from the Danish Geodata Agency. The application has been submitted.'}
                      </p>
                    </div>
                  ) : !handlerLoading ? (
                    <EmptyState
                      ikon={<ArrowRightLeft size={32} className="text-slate-600" />}
                      tekst={c.noTradesFound}
                    />
                  ) : null}
                </div>
              )}

              {/* BIZZ-409: Historiske ejendomme (solgte) — hidden with handler section */}
              {false &&
                !handlerLoading &&
                (() => {
                  const solgte = ejendomshandler.filter((h) => h.rolle === 'saelger' && h.adresse);
                  if (solgte.length === 0) return null;
                  const da = lang === 'da';
                  return (
                    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                      <div className="px-4 py-2.5 border-b border-slate-700/40">
                        <p className="text-slate-200 text-xs font-semibold">
                          {da ? 'Historiske ejendomme (solgte)' : 'Historical properties (sold)'}
                          <span className="text-slate-500 font-normal ml-2">({solgte.length})</span>
                        </p>
                      </div>
                      <div className="divide-y divide-slate-700/20">
                        {solgte.slice(0, 20).map((h, i) => (
                          <div
                            key={`sold-${h.bfeNummer ?? i}`}
                            className="px-4 py-2 flex items-center justify-between text-sm"
                          >
                            <div>
                              <p className="text-slate-300 text-xs">{h.adresse}</p>
                              <p className="text-slate-500 text-[10px]">
                                {h.overtagelsesdato
                                  ? new Date(h.overtagelsesdato).toLocaleDateString('da-DK', {
                                      day: 'numeric',
                                      month: 'short',
                                      year: 'numeric',
                                    })
                                  : '–'}
                                {h.overdragelsesmaade ? ` · ${h.overdragelsesmaade}` : ''}
                              </p>
                            </div>
                            {h.kontantKoebesum != null && h.kontantKoebesum > 0 && (
                              <span className="text-slate-400 text-xs font-medium">
                                {h.kontantKoebesum.toLocaleString('da-DK')} DKK
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
            </div>
          )}

          {/* ══ GRUPPE ══ */}
          {aktivTab === 'companies' && (
            <div className="space-y-4">
              {/* Loading */}
              {relatedLoading && <TabLoadingSpinner />}

              {/* Gruppe-hierarki */}
              {!relatedLoading &&
                data &&
                (() => {
                  /** Aktive relaterede virksomheder (ophørte filtreres fra) */
                  const aktive = relatedCompanies.filter((v) => v.aktiv);
                  /**
                   * BIZZ-475: Historiske (ophørte/solgte) datterselskaber. Vises
                   * kun når brugeren toggler "Vis historik" — beholdes som flad
                   * liste for at undgå at rode gruppestrukturen til.
                   */
                  const historiske = relatedCompanies.filter((v) => !v.aktiv);
                  /** Rod-virksomheder (ejet direkte af den valgte, eller ingen anden ejer på listen) */
                  const rodVirksomheder = aktive.filter((v) => v.ejetAfCvr == null);
                  /** Børn grupperet efter ejer-CVR */
                  const boernMap = new Map<number, typeof aktive>();
                  for (const v of aktive) {
                    if (v.ejetAfCvr != null) {
                      const arr = boernMap.get(v.ejetAfCvr) ?? [];
                      arr.push(v);
                      boernMap.set(v.ejetAfCvr, arr);
                    }
                  }

                  /** Formatér tal med tusindtalsseparator */
                  const fmtNum = (n: number | null) => {
                    if (n == null) return '–';
                    return n.toLocaleString('da-DK');
                  };
                  /** Formatér tal i tusinder/millioner */
                  const fmtKr = (n: number | null) => {
                    if (n == null) return '–';
                    const abs = Math.abs(n);
                    if (abs >= 1_000_000)
                      return `${(n / 1_000_000).toFixed(1).replace('.', ',')} mio`;
                    if (abs >= 1_000) return `${Math.round(n / 1_000)} t.kr`;
                    return fmtNum(n);
                  };

                  /** Find ejerandel — direkte fra queried company, eller fra overliggende virksomhed */
                  const findEjerandel = (rel: (typeof aktive)[0]): string | null => {
                    // Direkte ejerandel fra den forespurgte virksomhed
                    if (rel.ejerandel) return rel.ejerandel;
                    // Find ejerandel fra parent-virksomheden (ejetAfCvr) via ejere-listen
                    if (rel.ejetAfCvr != null) {
                      // Find parent-virksomhedens navn
                      const parent = aktive.find((a) => a.cvr === rel.ejetAfCvr);
                      const parentNavn = parent?.navn ?? data.name;
                      // Match ejer-entry med samme navn som parent
                      const parentEjer = rel.ejere.find(
                        (e) => e.erVirksomhed && e.navn === parentNavn
                      );
                      if (parentEjer?.ejerandel) return parentEjer.ejerandel;
                    }
                    return null;
                  };

                  const renderCard = (rel: (typeof aktive)[0], depth: number) => {
                    const fin = gruppeFinans.get(rel.cvr);
                    const visEjerandel = findEjerandel(rel);
                    return (
                      <button
                        key={rel.cvr}
                        onClick={() => router.push(`/dashboard/companies/${rel.cvr}`)}
                        className={`w-full bg-[#0f1729] border border-slate-700/50 rounded-xl px-4 py-3.5 text-left hover:border-blue-500/40 hover:bg-[#131d36] transition-all group ${depth > 0 ? 'border-l-2 border-l-blue-500/30' : ''}`}
                      >
                        {/* Øverste linje: Navn + badges */}
                        <div className="flex items-center gap-2 mb-3">
                          <Building2
                            size={15}
                            className="text-slate-500 group-hover:text-blue-400 shrink-0 transition-colors"
                          />
                          <span className="text-white text-sm font-semibold truncate group-hover:text-blue-300 transition-colors">
                            {rel.navn}
                          </span>
                          {visEjerandel && (
                            <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/20">
                              {visEjerandel}
                            </span>
                          )}
                          {rel.aktiv ? (
                            <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                              {lang === 'da' ? 'Aktiv' : 'Active'}
                            </span>
                          ) : (
                            <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-red-500/15 text-red-400 border border-red-500/20">
                              {lang === 'da' ? 'Ophørt' : 'Dissolved'}
                            </span>
                          )}
                          <ExternalLink
                            size={12}
                            className="ml-auto text-slate-600 group-hover:text-blue-400 shrink-0 transition-colors"
                          />
                        </div>

                        {/* 3 sektioner med vertikale dividers — proportional bredde */}
                        <div className="flex items-stretch gap-0 rounded-lg bg-[#0a1020]/60 border border-slate-700/30">
                          {/* Sektion 1: Stamdata */}
                          <div className="flex-[3] min-w-0 px-3.5 py-2.5">
                            <div className="text-[10px] text-slate-500/80 font-medium uppercase tracking-wider mb-1.5">
                              Stamdata
                            </div>
                            <div className="text-xs text-slate-300">
                              CVR {rel.cvr} · {rel.form ?? ''}
                            </div>
                            {rel.branche && (
                              <div className="text-[11px] text-slate-400 truncate mt-0.5">
                                {rel.branche}
                              </div>
                            )}
                            {rel.adresse && (
                              <div className="text-[11px] text-slate-500 truncate mt-0.5">
                                {rel.adresse}
                                {rel.postnr ? `, ${rel.postnr}` : ''}
                                {rel.by ? ` ${rel.by}` : ''}
                              </div>
                            )}
                            {rel.direktoer && (
                              <div className="text-[11px] text-slate-400 truncate mt-0.5">
                                Dir. {rel.direktoer}
                              </div>
                            )}
                          </div>

                          {/* Vertikal divider */}
                          <div className="w-px bg-slate-700/40 self-stretch my-2" />

                          {/* Sektion 2: Organisation */}
                          <div className="flex-[2] min-w-0 px-3.5 py-2.5">
                            <div className="text-[10px] text-slate-500/80 font-medium uppercase tracking-wider mb-1.5">
                              Organisation
                            </div>
                            <div className="space-y-1">
                              <div className="flex justify-between text-[11px]">
                                <span className="text-slate-500">Ansatte</span>
                                <span className="text-slate-300 font-medium tabular-nums">
                                  {rel.ansatte ?? '–'}
                                </span>
                              </div>
                              <div className="flex justify-between text-[11px]">
                                <span className="text-slate-500">P-enheder</span>
                                <span className="text-slate-300 font-medium tabular-nums">
                                  {rel.antalPenheder}
                                </span>
                              </div>
                              <div className="flex justify-between text-[11px]">
                                <span className="text-slate-500">Datterselskaber</span>
                                <span className="text-slate-300 font-medium tabular-nums">
                                  {rel.antalDatterselskaber}
                                </span>
                              </div>
                            </div>
                          </div>

                          {/* Vertikal divider */}
                          <div className="w-px bg-slate-700/40 self-stretch my-2" />

                          {/* Sektion 3: Regnskab */}
                          <div className="flex-[2] min-w-0 px-3.5 py-2.5">
                            <div className="text-[10px] text-slate-500/80 font-medium uppercase tracking-wider mb-1.5">
                              Regnskab
                              {gruppeFinansLoading && !fin && (
                                <Loader2 size={8} className="inline ml-1 animate-spin" />
                              )}
                            </div>
                            <div className="space-y-1">
                              <div className="flex justify-between text-[11px]">
                                <span className="text-slate-500">Brutto</span>
                                <span
                                  className={`font-medium tabular-nums ${fin?.brutto != null ? (fin.brutto >= 0 ? 'text-emerald-400' : 'text-red-400') : 'text-slate-500'}`}
                                >
                                  {fin ? fmtKr(fin.brutto) : '–'}
                                </span>
                              </div>
                              <div className="flex justify-between text-[11px]">
                                <span className="text-slate-500">Balance</span>
                                <span className="font-medium tabular-nums text-slate-300">
                                  {fin ? fmtKr(fin.balance) : '–'}
                                </span>
                              </div>
                              <div className="flex justify-between text-[11px]">
                                <span className="text-slate-500">Egenkapital</span>
                                <span
                                  className={`font-medium tabular-nums ${fin?.egenkapital != null ? (fin.egenkapital >= 0 ? 'text-emerald-400' : 'text-red-400') : 'text-slate-500'}`}
                                >
                                  {fin ? fmtKr(fin.egenkapital) : '–'}
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  };

                  // Udtræk modervirksomheder fra ejerkæden
                  const parentCompanies: {
                    navn: string;
                    cvr: number | null;
                    enhedsNummer: number | null;
                    ejerandel: string | null;
                  }[] = [];
                  const seenParentIds = new Set<number>();
                  function collectParentCompanies(nodes: OwnerChainNode[]) {
                    for (const n of nodes) {
                      if (n.erVirksomhed) {
                        const id = n.cvr ?? n.enhedsNummer ?? 0;
                        if (id && !seenParentIds.has(id) && id !== data!.vat) {
                          seenParentIds.add(id);
                          parentCompanies.push({
                            navn: n.navn,
                            cvr: n.cvr,
                            enhedsNummer: n.enhedsNummer,
                            ejerandel: n.ejerandel,
                          });
                        }
                      }
                      if (n.parents.length > 0) collectParentCompanies(n.parents);
                    }
                  }
                  collectParentCompanies(ownerChainShared);

                  const _totalRelateret = aktive.length + parentCompanies.length;

                  return (
                    <>
                      {/* Modervirksomheder (opad i strukturen) — collapsed by default */}
                      {parentCompanies.length > 0 && (
                        <>
                          <button
                            type="button"
                            onClick={() => setParentSectionOpen((prev) => !prev)}
                            className="flex items-center gap-2 w-full group cursor-pointer"
                          >
                            <ChevronDown
                              size={14}
                              className={`text-slate-400 group-hover:text-slate-300 transition-all duration-200 shrink-0 ${parentSectionOpen ? '' : '-rotate-90'}`}
                            />
                            <span className="text-sm text-slate-300 group-hover:text-slate-200 font-medium transition-colors whitespace-nowrap">
                              {lang === 'da'
                                ? `${parentCompanies.length} modervirksomhed${parentCompanies.length > 1 ? 'er' : ''}`
                                : `${parentCompanies.length} parent compan${parentCompanies.length > 1 ? 'ies' : 'y'}`}
                            </span>
                            <div className="h-px flex-1 bg-slate-700 group-hover:bg-slate-600 transition-colors" />
                          </button>
                          {parentSectionOpen && (
                            <div className="grid gap-3">
                              {parentCompanies.map((pc) => {
                                const linkCvr = pc.cvr ?? pc.enhedsNummer;
                                const detail = linkCvr ? parentCompanyDetails.get(linkCvr) : null;

                                // Brug detaljeret kort hvis data er hentet, ellers vis simpelt kort med loading
                                if (detail) {
                                  return (
                                    <div key={linkCvr} className="relative">
                                      {/* Moderselskab-badge overlay */}
                                      <div className="absolute top-2 right-12 z-10">
                                        <span className="px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-indigo-500/15 text-indigo-400 border border-indigo-500/20">
                                          {lang === 'da' ? 'Moderselskab' : 'Parent'}
                                        </span>
                                      </div>
                                      {renderCard(detail, 0)}
                                    </div>
                                  );
                                }

                                // Fallback: simpelt kort mens data loader
                                return (
                                  <button
                                    key={linkCvr}
                                    onClick={() =>
                                      linkCvr && router.push(`/dashboard/companies/${linkCvr}`)
                                    }
                                    className="w-full bg-[#0f1729] border border-slate-700/50 rounded-xl px-4 py-3.5 text-left hover:border-blue-500/40 hover:bg-[#131d36] transition-all group"
                                  >
                                    <div className="flex items-center gap-2">
                                      <Building2
                                        size={15}
                                        className="text-slate-500 group-hover:text-blue-400 shrink-0 transition-colors"
                                      />
                                      <span className="text-white text-sm font-semibold truncate group-hover:text-blue-300 transition-colors">
                                        {pc.navn}
                                      </span>
                                      {pc.ejerandel && (
                                        <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/20">
                                          {pc.ejerandel}
                                        </span>
                                      )}
                                      <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-indigo-500/15 text-indigo-400 border border-indigo-500/20">
                                        {lang === 'da' ? 'Moderselskab' : 'Parent'}
                                      </span>
                                      <Loader2
                                        size={12}
                                        className="ml-auto text-slate-500 animate-spin shrink-0"
                                      />
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </>
                      )}

                      {/* Parent card — den valgte virksomhed (same 3-section layout) */}
                      {(() => {
                        const selFin =
                          gruppeFinans.get(data.vat) ??
                          (xbrlData && xbrlData.length > 0
                            ? {
                                brutto: xbrlData[0].resultat?.bruttofortjeneste ?? null,
                                balance: xbrlData[0].balance?.aktiverIAlt ?? null,
                                egenkapital: xbrlData[0].balance?.egenkapital ?? null,
                              }
                            : null);
                        const selPenheder = (data.productionunits ?? []).filter(
                          (p) => p.active
                        ).length;
                        const selDirektør = (data.deltagere ?? []).find((d) =>
                          d.roller.some(
                            (r) => r.rolle.toUpperCase().includes('DIREKTION') && !r.til
                          )
                        );
                        return (
                          <div className="w-full bg-[#131d36] border border-blue-500/30 rounded-xl px-4 py-3.5">
                            {/* Øverste linje: Navn + badges */}
                            <div className="flex items-center gap-2 mb-3">
                              <Building2 size={15} className="text-blue-400 shrink-0" />
                              <span className="text-white text-sm font-semibold truncate">
                                {data.name}
                              </span>
                              <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-blue-500/20 text-blue-300 border border-blue-500/30">
                                {lang === 'da' ? 'Valgt' : 'Selected'}
                              </span>
                              {!data.enddate ? (
                                <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                                  {lang === 'da' ? 'Aktiv' : 'Active'}
                                </span>
                              ) : (
                                <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-red-500/15 text-red-400 border border-red-500/20">
                                  {lang === 'da' ? 'Ophørt' : 'Dissolved'}
                                </span>
                              )}
                            </div>

                            {/* 3 sektioner med vertikale dividers */}
                            <div className="flex items-stretch gap-0 rounded-lg bg-[#0a1020]/60 border border-blue-500/20">
                              {/* Sektion 1: Stamdata */}
                              <div className="flex-[3] min-w-0 px-3.5 py-2.5">
                                <div className="text-[10px] text-slate-500/80 font-medium uppercase tracking-wider mb-1.5">
                                  Stamdata
                                </div>
                                <div className="text-xs text-slate-300">
                                  CVR {data.vat} · {data.companydesc ?? ''}
                                </div>
                                {data.industrydesc && (
                                  <div className="text-[11px] text-slate-400 truncate mt-0.5">
                                    {data.industrydesc}
                                  </div>
                                )}
                                {data.address && (
                                  <div className="text-[11px] text-slate-500 truncate mt-0.5">
                                    {data.address}, {data.zipcode} {data.city}
                                  </div>
                                )}
                                {selDirektør && (
                                  <div className="text-[11px] text-slate-400 truncate mt-0.5">
                                    Dir. {selDirektør.navn}
                                  </div>
                                )}
                              </div>

                              {/* Vertikal divider */}
                              <div className="w-px bg-slate-700/40 self-stretch my-2" />

                              {/* Sektion 2: Organisation */}
                              <div className="flex-[2] min-w-0 px-3.5 py-2.5">
                                <div className="text-[10px] text-slate-500/80 font-medium uppercase tracking-wider mb-1.5">
                                  Organisation
                                </div>
                                <div className="space-y-1">
                                  <div className="flex justify-between text-[11px]">
                                    <span className="text-slate-500">Ansatte</span>
                                    <span className="text-slate-300 font-medium tabular-nums">
                                      {data.employees ?? '–'}
                                    </span>
                                  </div>
                                  <div className="flex justify-between text-[11px]">
                                    <span className="text-slate-500">P-enheder</span>
                                    <span className="text-slate-300 font-medium tabular-nums">
                                      {selPenheder}
                                    </span>
                                  </div>
                                  <div className="flex justify-between text-[11px]">
                                    <span className="text-slate-500">Datterselskaber</span>
                                    <span className="text-slate-300 font-medium tabular-nums">
                                      {aktive.length}
                                    </span>
                                  </div>
                                </div>
                              </div>

                              {/* Vertikal divider */}
                              <div className="w-px bg-slate-700/40 self-stretch my-2" />

                              {/* Sektion 3: Regnskab */}
                              <div className="flex-[2] min-w-0 px-3.5 py-2.5">
                                <div className="text-[10px] text-slate-500/80 font-medium uppercase tracking-wider mb-1.5">
                                  Regnskab
                                  {!selFin && xbrlLoading && (
                                    <Loader2 size={8} className="inline ml-1 animate-spin" />
                                  )}
                                </div>
                                <div className="space-y-1">
                                  <div className="flex justify-between text-[11px]">
                                    <span className="text-slate-500">Brutto</span>
                                    <span
                                      className={`font-medium tabular-nums ${selFin?.brutto != null ? (selFin.brutto >= 0 ? 'text-emerald-400' : 'text-red-400') : 'text-slate-500'}`}
                                    >
                                      {selFin ? fmtKr(selFin.brutto) : '–'}
                                    </span>
                                  </div>
                                  <div className="flex justify-between text-[11px]">
                                    <span className="text-slate-500">Balance</span>
                                    <span className="font-medium tabular-nums text-slate-300">
                                      {selFin ? fmtKr(selFin.balance) : '–'}
                                    </span>
                                  </div>
                                  <div className="flex justify-between text-[11px]">
                                    <span className="text-slate-500">Egenkapital</span>
                                    <span
                                      className={`font-medium tabular-nums ${selFin?.egenkapital != null ? (selFin.egenkapital >= 0 ? 'text-emerald-400' : 'text-red-400') : 'text-slate-500'}`}
                                    >
                                      {selFin ? fmtKr(selFin.egenkapital) : '–'}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })()}

                      {/* Datterselskaber — collapsible */}
                      {aktive.length > 0 && (
                        <>
                          <button
                            type="button"
                            onClick={() => setChildSectionOpen((prev) => !prev)}
                            className="flex items-center gap-2 w-full group cursor-pointer pt-2"
                          >
                            <ChevronDown
                              size={14}
                              className={`text-slate-400 group-hover:text-slate-300 transition-all duration-200 shrink-0 ${childSectionOpen ? '' : '-rotate-90'}`}
                            />
                            <span className="text-sm text-slate-300 group-hover:text-slate-200 font-medium transition-colors whitespace-nowrap">
                              {lang === 'da'
                                ? `${aktive.length} datterselskab${aktive.length > 1 ? 'er' : ''}`
                                : `${aktive.length} subsidiar${aktive.length > 1 ? 'ies' : 'y'}`}
                            </span>
                            <div className="h-px flex-1 bg-slate-700 group-hover:bg-slate-600 transition-colors" />
                          </button>
                          {childSectionOpen && (
                            <div className="grid gap-3">
                              {(() => {
                                /** Renderer en virksomhed og dens børn rekursivt */
                                const renderTree = (
                                  virk: (typeof aktive)[0],
                                  depth: number
                                ): React.ReactNode => (
                                  <div
                                    key={virk.cvr}
                                    style={
                                      depth > 0 ? { paddingLeft: `${depth * 32}px` } : undefined
                                    }
                                  >
                                    {renderCard(virk, depth)}
                                    {boernMap.has(virk.cvr) && (
                                      <div className="grid gap-2 mt-2">
                                        {boernMap
                                          .get(virk.cvr)!
                                          .map((child) => renderTree(child, depth + 1))}
                                      </div>
                                    )}
                                  </div>
                                );
                                return rodVirksomheder.map((rel) => renderTree(rel, 0));
                              })()}
                            </div>
                          )}
                        </>
                      )}

                      {/* BIZZ-475: Historiske datterselskaber — toggle-drevet */}
                      {historiske.length > 0 && (
                        <div className="pt-2">
                          <button
                            type="button"
                            onClick={() => setVisHistorik((prev) => !prev)}
                            className="flex items-center gap-2 w-full group cursor-pointer"
                            aria-expanded={visHistorik}
                          >
                            <ChevronDown
                              size={14}
                              className={`text-slate-500 group-hover:text-slate-400 transition-all duration-200 shrink-0 ${visHistorik ? '' : '-rotate-90'}`}
                            />
                            <span className="text-sm text-slate-400 group-hover:text-slate-300 font-medium transition-colors whitespace-nowrap">
                              {lang === 'da'
                                ? `Vis historik (${historiske.length} ophørt${historiske.length > 1 ? 'e' : ''})`
                                : `Show history (${historiske.length} dissolved)`}
                            </span>
                            <div className="h-px flex-1 bg-slate-700/60 group-hover:bg-slate-600 transition-colors" />
                          </button>
                          {visHistorik && (
                            <div className="grid gap-3 mt-2 opacity-75">
                              {historiske.map((rel) => renderCard(rel, 0))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* No related companies */}
                      {aktive.length === 0 && historiske.length === 0 && (
                        <div className="text-center py-8">
                          <Building2 size={32} className="mx-auto text-slate-600 mb-2" />
                          <p className="text-slate-500 text-sm">{c.noCompanies}</p>
                        </div>
                      )}
                    </>
                  );
                })()}
            </div>
          )}

          {/* ══ REGNSKAB ══ */}
          {aktivTab === 'financials' && (
            <div className="space-y-4">
              {/* Første batch loader */}
              {(xbrlLoading || xbrlLoadingMore || regnskabLoading) && <TabLoadingSpinner />}

              {/* Data — vises så snart første batch er klar */}
              {!xbrlLoading && xbrlData && xbrlData.length > 0 && (
                <RegnskabstalTable years={xbrlData} lang={lang} regnskaber={regnskaber ?? []} />
              )}

              {/* Progressiv loading-indikator for efterfølgende batches */}
              {xbrlLoadingMore && (
                <div className="flex items-center justify-center gap-2 py-3">
                  <Loader2 size={14} className="animate-spin text-blue-400" />
                  <span className="text-slate-400 text-xs">
                    {lang === 'da' ? 'Henter flere regnskaber…' : 'Loading more financials…'}
                  </span>
                </div>
              )}

              {/* Empty / fallback — kun når BÅDE xbrl OG PDF-regnskaber er tomme */}
              {!xbrlLoading &&
                !xbrlLoadingMore &&
                (!xbrlData || xbrlData.length === 0) &&
                !regnskabLoading &&
                (!regnskaber || regnskaber.length === 0) && (
                  <EmptyState
                    ikon={<BarChart3 size={32} className="text-slate-600" />}
                    tekst={c.noFinancials}
                  />
                )}

              {/* ── Årsregnskaber (PDF / XBRL downloads) — vises kun når der er data eller loading ── */}
              {(regnskabLoading || (regnskaber && regnskaber.length > 0)) && (
                <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-hidden overflow-x-auto">
                  <div className="px-4 py-2.5 border-b border-slate-700/30 flex items-center gap-2">
                    <BarChart3 size={15} className="text-slate-400" />
                    <span className="text-sm font-semibold text-slate-200">{c.annualReports}</span>
                    {regnskabLoading && (
                      <span className="ml-2 text-xs text-slate-500 animate-pulse">{c.loading}</span>
                    )}
                    <button
                      onClick={async () => {
                        // valgteDoc indeholder direkte dokumentUrl-strenge — ingen lookup nødvendig
                        // Sequential anchor-click — undgår popup-blokering ved window.open i loop
                        for (const url of valgteDoc) {
                          const a = document.createElement('a');
                          a.href = url;
                          a.target = '_blank';
                          a.rel = 'noopener noreferrer';
                          document.body.appendChild(a);
                          a.click();
                          document.body.removeChild(a);
                          await new Promise((r) => setTimeout(r, 400));
                        }
                      }}
                      disabled={valgteDoc.size === 0}
                      className="ml-auto flex items-center gap-1.5 px-3 py-1 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed border border-slate-600 rounded-lg text-slate-300 text-xs font-medium transition-all"
                      title={
                        valgteDoc.size === 0
                          ? c.selectDocsToDownload
                          : `${c.downloadSelected} (${valgteDoc.size})`
                      }
                    >
                      <Download size={12} />
                      {c.downloadSelected} ({valgteDoc.size})
                    </button>
                  </div>
                  <div className="min-w-[420px] grid grid-cols-[28px_60px_1fr_80px] gap-x-3 px-4 py-1.5 border-b border-slate-700/20">
                    <span />
                    <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                      {lang === 'da' ? 'År' : 'Year'}
                    </span>
                    <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                      {lang === 'da' ? 'Dokument' : 'Document'}
                    </span>
                    <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                      {lang === 'da' ? 'Dok.' : 'Doc.'}
                    </span>
                  </div>
                  {regnskabLoading && (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />
                    </div>
                  )}
                  {!regnskabLoading && regnskaber && regnskaber.length > 0 ? (
                    <div className="divide-y divide-slate-700/15">
                      {(visAlleRegnskaber ? regnskaber : regnskaber.slice(0, 3)).map((regnsk) => {
                        const pdfDok = regnsk.dokumenter?.find((d) =>
                          d.dokumentMimeType?.includes('pdf')
                        );
                        const xbrlDok = regnsk.dokumenter?.find(
                          (d) =>
                            d.dokumentType?.toLowerCase().includes('xbrl') ||
                            d.dokumentMimeType?.includes('xml')
                        );
                        const year = regnsk.periodeSlut
                          ? new Date(regnsk.periodeSlut).getFullYear()
                          : null;
                        const label = year
                          ? `${lang === 'da' ? 'Årsrapport' : 'Annual Report'} ${year}`
                          : `${lang === 'da' ? 'Årsrapport' : 'Annual Report'} (${regnsk.sagsNummer})`;
                        return (
                          <div
                            key={regnsk.sagsNummer}
                            className="min-w-[420px] grid grid-cols-[28px_60px_1fr_80px] gap-x-3 px-4 py-2 hover:bg-slate-700/10 transition-colors items-start"
                          >
                            <span />
                            <span className="text-sm text-slate-300 tabular-nums">
                              {year ?? '—'}
                            </span>
                            <div className="min-w-0">
                              <p className="text-sm text-slate-200 truncate">{label}</p>
                              <p className="text-xs text-slate-500 mt-0.5">
                                {regnsk.periodeStart ?? '?'} — {regnsk.periodeSlut ?? '?'}
                              </p>
                            </div>
                            <div className="flex flex-col gap-1 self-start">
                              {pdfDok && (
                                <div className="flex items-center justify-between w-full">
                                  <a
                                    href={pdfDok.dokumentUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                                  >
                                    <FileText size={11} />
                                    PDF
                                  </a>
                                  <label className="flex items-center cursor-pointer flex-shrink-0 ml-2">
                                    <input
                                      type="checkbox"
                                      className="sr-only"
                                      checked={valgteDoc.has(pdfDok.dokumentUrl)}
                                      onChange={() => toggleDoc(pdfDok.dokumentUrl)}
                                    />
                                    <span
                                      className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${valgteDoc.has(pdfDok.dokumentUrl) ? 'bg-blue-500 border-blue-500' : 'bg-[#0a1020] border-slate-400'}`}
                                    >
                                      {valgteDoc.has(pdfDok.dokumentUrl) && (
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
                                </div>
                              )}
                              {xbrlDok && (
                                <div className="flex items-center justify-between w-full">
                                  <a
                                    href={xbrlDok.dokumentUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 text-xs text-amber-400/80 hover:text-amber-300 transition-colors"
                                  >
                                    <FileText size={11} />
                                    XBRL
                                  </a>
                                  <label className="flex items-center cursor-pointer flex-shrink-0 ml-2">
                                    <input
                                      type="checkbox"
                                      className="sr-only"
                                      checked={valgteDoc.has(xbrlDok.dokumentUrl)}
                                      onChange={() => toggleDoc(xbrlDok.dokumentUrl)}
                                    />
                                    <span
                                      className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${valgteDoc.has(xbrlDok.dokumentUrl) ? 'bg-blue-500 border-blue-500' : 'bg-[#0a1020] border-slate-400'}`}
                                    >
                                      {valgteDoc.has(xbrlDok.dokumentUrl) && (
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
                                </div>
                              )}
                              {!pdfDok && !xbrlDok && (
                                <span className="text-slate-600 text-xs">—</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                      {regnskaber.length > 3 && (
                        <button
                          onClick={() => setVisAlleRegnskaber((prev) => !prev)}
                          className="w-full px-4 py-2 text-xs text-blue-400 hover:text-blue-300 hover:bg-slate-700/10 transition-colors text-center"
                        >
                          {visAlleRegnskaber
                            ? lang === 'da'
                              ? 'Vis færre'
                              : 'Show less'
                            : lang === 'da'
                              ? `Vis alle ${regnskaber.length} regnskaber`
                              : `Show all ${regnskaber.length} reports`}
                        </button>
                      )}
                    </div>
                  ) : (
                    !regnskabLoading && (
                      <div className="px-4 py-6 text-center">
                        <p className="text-slate-500 text-sm">{c.noFinancials}</p>
                      </div>
                    )
                  )}
                </div>
              )}
            </div>
          )}

          {/* ══ NØGLEPERSONER ══ */}
          {aktivTab === 'keyPersons' && (
            <div className="space-y-4">
              {sorteredeKategorier.length > 0 ? (
                <>
                  {/* Filter-chips */}
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => setPersonerFilter(null)}
                      className={`px-3 py-1 rounded-full text-xs font-medium transition-all border ${
                        personerFilter === null
                          ? 'bg-blue-600/30 border-blue-500/50 text-blue-300'
                          : 'bg-slate-800/50 border-slate-700/40 text-slate-400 hover:text-slate-200 hover:border-slate-600'
                      }`}
                    >
                      {lang === 'da' ? 'Alle' : 'All'}
                    </button>
                    {sorteredeKategorier.map((kat) => {
                      const { aktive, historiske } = personerByKategori[kat];
                      const isActive = personerFilter === kat;
                      return (
                        <button
                          key={kat}
                          onClick={() => setPersonerFilter(isActive ? null : kat)}
                          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all border ${
                            isActive
                              ? 'bg-blue-600/30 border-blue-500/50 text-blue-300'
                              : 'bg-slate-800/50 border-slate-700/40 text-slate-400 hover:text-slate-200 hover:border-slate-600'
                          }`}
                        >
                          {kategoriIkon(kat)}
                          {kategoriLabel(kat)} ({aktive.length + historiske.length})
                        </button>
                      );
                    })}
                  </div>

                  {sorteredeKategorier
                    .filter((k) => personerFilter === null || personerFilter === k)
                    .map((kat) => {
                      const { aktive, historiske } = personerByKategori[kat];
                      const erUdfoldet = expandedHistPersoner.has(kat);
                      const totalAktive = aktive.length;
                      const totalHistoriske = historiske.length;

                      /** Renderer en person-række */
                      const renderPerson = (
                        entry: PersonMedRolle,
                        idx: number,
                        dimmed: boolean
                      ) => {
                        const { deltager: person, rolle: r } = entry;
                        const initialer = person.navn
                          .split(' ')
                          .map((n) => n[0])
                          .slice(0, 2)
                          .join('')
                          .toUpperCase();

                        return (
                          <li
                            key={`${person.enhedsNummer ?? idx}-${r.rolle}-${r.fra}`}
                            className={`flex items-center justify-between gap-3 text-sm bg-slate-900/50 rounded-lg px-4 py-3 hover:bg-slate-800/60 transition-colors ${
                              person.enhedsNummer ? 'cursor-pointer' : ''
                            } group ${dimmed ? 'opacity-60' : ''}`}
                            onClick={() => {
                              if (person.enhedsNummer) {
                                if (person.erVirksomhed) {
                                  router.push(`/dashboard/companies/${person.enhedsNummer}`);
                                } else {
                                  router.push(`/dashboard/owners/${person.enhedsNummer}`);
                                }
                              }
                            }}
                          >
                            <div className="flex items-center gap-3 min-w-0 flex-1">
                              {/* Avatar — blå for virksomheder, slate for personer */}
                              <span
                                className={`w-7 h-7 rounded-full text-xs font-medium flex items-center justify-center flex-shrink-0 ${
                                  person.erVirksomhed
                                    ? 'bg-blue-600/30 text-blue-400'
                                    : 'bg-slate-700/50 text-slate-300'
                                }`}
                              >
                                {person.erVirksomhed ? <Building2 size={13} /> : initialer}
                              </span>
                              {/* Navn + periode */}
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <span
                                    className={`truncate text-white transition-colors ${person.erVirksomhed ? 'group-hover:text-blue-300' : 'group-hover:text-purple-300'}`}
                                  >
                                    {person.navn}
                                  </span>
                                  {person.enhedsNummer && (
                                    <ExternalLink
                                      size={11}
                                      className={`transition-colors flex-shrink-0 ${person.erVirksomhed ? 'text-slate-600 group-hover:text-blue-400' : 'text-slate-600 group-hover:text-purple-400'}`}
                                    />
                                  )}
                                </div>
                                <p className="text-xs text-slate-500 mt-0.5">
                                  {r.fra ? formatDatoKort(r.fra) : '?'} —{' '}
                                  {r.til ? formatDatoKort(r.til) : lang === 'da' ? 'nu' : 'present'}
                                  {r.rolle && (
                                    <span className="ml-2 text-slate-600">({r.rolle})</span>
                                  )}
                                </p>
                              </div>
                            </div>
                            {/* Ejerandel + stemmeret badges */}
                            <div className="flex items-center gap-1.5 flex-shrink-0">
                              {r.ejerandel != null && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-emerald-500/15 text-emerald-400">
                                  <Percent size={10} />
                                  {r.ejerandel} {lang === 'da' ? 'ejerandel' : 'ownership'}
                                </span>
                              )}
                              {r.stemmeandel != null && r.stemmeandel !== r.ejerandel && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-blue-500/15 text-blue-400">
                                  {r.stemmeandel} {lang === 'da' ? 'stemmer' : 'votes'}
                                </span>
                              )}
                              {r.bemærkning && (
                                <span className="px-2 py-0.5 rounded text-xs font-medium bg-slate-700/50 text-slate-300">
                                  {r.bemærkning}
                                </span>
                              )}
                            </div>
                          </li>
                        );
                      };

                      return (
                        <section
                          key={kat}
                          className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-5"
                        >
                          {/* Sektion-header */}
                          <h2 className="text-white font-semibold text-base mb-3 flex items-center gap-2">
                            {kategoriIkon(kat)}
                            {kategoriLabel(kat)}
                            <span className="text-slate-500 font-normal text-sm ml-1">
                              ({totalAktive}
                              {totalHistoriske > 0
                                ? ` + ${totalHistoriske} ${lang === 'da' ? 'historiske' : 'historical'}`
                                : ''}
                              )
                            </span>
                          </h2>

                          {/* Aktive deltagere */}
                          {totalAktive > 0 && (
                            <ul className="space-y-2">
                              {aktive.map((entry, i) => renderPerson(entry, i, false))}
                            </ul>
                          )}

                          {/* Historiske deltagere — collapsible med "vis flere" */}
                          {totalHistoriske > 0 &&
                            (() => {
                              const INITIAL_HIST = 5;
                              const visAlle = visAlleHistPersoner.has(kat);
                              const vistHistoriske = visAlle
                                ? historiske
                                : historiske.slice(0, INITIAL_HIST);
                              const skjulteAntal = totalHistoriske - INITIAL_HIST;
                              return (
                                <div className={totalAktive > 0 ? 'mt-3' : ''}>
                                  <button
                                    onClick={() =>
                                      setExpandedHistPersoner((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(kat)) next.delete(kat);
                                        else next.add(kat);
                                        return next;
                                      })
                                    }
                                    className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors mb-2"
                                  >
                                    {erUdfoldet ? (
                                      <ChevronDown size={13} />
                                    ) : (
                                      <ChevronRight size={13} />
                                    )}
                                    {lang === 'da'
                                      ? `${totalHistoriske} historiske`
                                      : `${totalHistoriske} historical`}
                                  </button>
                                  {erUdfoldet && (
                                    <>
                                      <ul className="space-y-2">
                                        {vistHistoriske.map((entry, i) =>
                                          renderPerson(entry, i, true)
                                        )}
                                      </ul>
                                      {!visAlle && skjulteAntal > 0 && (
                                        <button
                                          onClick={() =>
                                            setVisAlleHistPersoner((prev) => {
                                              const next = new Set(prev);
                                              next.add(kat);
                                              return next;
                                            })
                                          }
                                          className="mt-2 flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                                        >
                                          <ChevronDown size={12} />
                                          {lang === 'da'
                                            ? `Vis ${skjulteAntal} flere historiske`
                                            : `Show ${skjulteAntal} more historical`}
                                        </button>
                                      )}
                                    </>
                                  )}
                                </div>
                              );
                            })()}

                          {/* Ingen aktive, men har historiske */}
                          {totalAktive === 0 && !erUdfoldet && (
                            <p className="text-slate-500 text-sm">
                              {lang === 'da' ? 'Ingen aktive' : 'No active members'}
                            </p>
                          )}
                        </section>
                      );
                    })}
                </>
              ) : (
                <EmptyState
                  ikon={<Users size={32} className="text-slate-600" />}
                  tekst={c.noKeyPersons}
                />
              )}
            </div>
          )}

          {/* ══ KRONOLOGI ══ */}
          {aktivTab === 'history' && (
            <div className="space-y-4">
              {sortedHistorik.length > 0 ? (
                <>
                  {/* Filter-chips */}
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => setHistorikFilter(null)}
                      className={`px-3 py-1 rounded-full text-xs font-medium transition-all border ${
                        historikFilter === null
                          ? 'bg-blue-600/30 border-blue-500/50 text-blue-300'
                          : 'bg-slate-800/50 border-slate-700/40 text-slate-400 hover:text-slate-200 hover:border-slate-600'
                      }`}
                    >
                      {lang === 'da' ? 'Alle' : 'All'} ({sortedHistorik.length})
                    </button>
                    {Object.entries(historikByType).map(([type, entries]) => {
                      const config = historikTypeConfig[type] ?? {
                        icon: <Clock size={11} />,
                        color: 'text-slate-400',
                      };
                      const isActive = historikFilter === type;
                      return (
                        <button
                          key={type}
                          onClick={() => setHistorikFilter(isActive ? null : type)}
                          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all border ${
                            isActive
                              ? 'bg-blue-600/30 border-blue-500/50 text-blue-300'
                              : 'bg-slate-800/50 border-slate-700/40 text-slate-400 hover:text-slate-200 hover:border-slate-600'
                          }`}
                        >
                          <span className={config.color}>{config.icon}</span>
                          {type.charAt(0).toUpperCase() + type.slice(1)} ({entries.length})
                        </button>
                      );
                    })}
                  </div>

                  {/* Filtrerede sektioner */}
                  {Object.entries(historikByType)
                    .filter(([type]) => historikFilter === null || historikFilter === type)
                    .map(([type, entries]) => {
                      const config = historikTypeConfig[type] ?? {
                        icon: <Clock size={14} />,
                        color: 'text-slate-400',
                      };
                      return (
                        <section
                          key={type}
                          className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-6"
                        >
                          <h2 className="text-white font-semibold text-base mb-4 flex items-center gap-2">
                            <span className={config.color}>{config.icon}</span>
                            {type.charAt(0).toUpperCase() + type.slice(1)} ({entries.length})
                          </h2>
                          <div className="relative">
                            {/* Timeline line */}
                            <div className="absolute left-3 top-0 bottom-0 w-px bg-slate-700/40" />
                            <ul className="space-y-3">
                              {entries.map((entry, i) => (
                                <li key={i} className="relative pl-8">
                                  {/* Timeline dot */}
                                  <div
                                    className={`absolute left-1.5 top-2.5 w-3 h-3 rounded-full border-2 border-slate-700 ${
                                      entry.til === null ? 'bg-blue-500' : 'bg-slate-600'
                                    }`}
                                  />
                                  <div className="bg-slate-900/50 rounded-lg p-3 border border-slate-700/30">
                                    <p className="text-white text-sm font-medium">{entry.vaerdi}</p>
                                    <p className="text-slate-500 text-xs mt-1">
                                      {c.period}: {entry.fra}
                                      {entry.til
                                        ? ` — ${entry.til}`
                                        : ` — ${lang === 'da' ? 'nu' : 'present'}`}
                                    </p>
                                    {/* BIZZ-516: Modpart-link for fusion/spaltning — link til owners-siden
                                        hvor enhedsNummer kan slås op (fælles namespace for virksomheder og
                                        personer i CVR). Giver brugeren en direkte genvej til modparten. */}
                                    {(entry.type === 'fusion' || entry.type === 'spaltning') &&
                                      entry.modpartEnhedsNummer && (
                                        <Link
                                          href={`/dashboard/owners/${entry.modpartEnhedsNummer}`}
                                          className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 mt-2 transition-colors"
                                        >
                                          <ExternalLink size={10} />
                                          {lang === 'da' ? 'Se modpart' : 'View counterparty'}{' '}
                                          <span className="font-mono text-slate-500">
                                            (#{entry.modpartEnhedsNummer})
                                          </span>
                                        </Link>
                                      )}
                                  </div>
                                </li>
                              ))}
                            </ul>
                          </div>
                        </section>
                      );
                    })}
                </>
              ) : (
                <EmptyState
                  ikon={<Clock size={32} className="text-slate-600" />}
                  tekst={c.noHistory}
                />
              )}
            </div>
          )}

          {/* ══ TINGLYSNING ══ */}
          {aktivTab === 'liens' && (
            <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-hidden">
              {personbogLoading && <TabLoadingSpinner />}
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

// ─── RegnskabstalTable ───────────────────────────────────────────────────────

interface RegnskabstalTableProps {
  /** Regnskabsår sorteret nyeste først */
  years: RegnskabsAar[];
  /** Sprog */
  lang: 'da' | 'en';
  /** Regnskaber med PDF-links fra ES */
  regnskaber?: Regnskab[];
}

/** Række-definition for regnskabstabellen */
type FinRow = {
  /** Unik ID brugt som chart-key */
  id: string;
  label: string;
  getValue: (y: RegnskabsAar) => number | null;
  bold?: boolean;
  isPercent?: boolean;
};

/** Farve-palette til graf-linjer */
const CHART_COLORS = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#06b6d4',
  '#ec4899',
  '#84cc16',
];

/**
 * RegnskabstalTable — Viser regnskabsdata i et tabelformat med år-kolonner.
 * Tre sektioner: Resultatopgørelse, Balance, Beregnede Nøgletal.
 * Viser %-ændring, 5 år default med expand, og interaktiv graf.
 *
 * @param props - Se RegnskabstalTableProps
 */
function RegnskabstalTable({ years, lang, regnskaber = [] }: RegnskabstalTableProps) {
  const da = lang === 'da';
  const [visAlleAar, setVisAlleAar] = useState(false);
  /** Default graf: Bruttofortjeneste, Årets resultat, Egenkapital */
  const [chartRows, setChartRows] = useState<Set<string>>(
    () => new Set(['r-brutto', 'r-aaret', 'b-egenkap'])
  );
  /** Balance og Nøgletal sammenklappet som default — Resultatopgørelse åben */
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    () =>
      new Set([
        da ? 'Balance' : 'Balance Sheet',
        da ? 'Pengestrømme' : 'Cash Flow',
        da ? 'Nøgletal' : 'Key Ratios',
      ])
  );

  /** Viste år — 5 default, alle hvis udfoldet */
  const visteAar = visAlleAar ? years : years.slice(0, 5);

  /**
   * Map fra år → download URL for regnskabsrapporten.
   * Prioritet: PDF > XHTML (åbnes i browser) > ZIP.
   */
  const pdfPerAar = useMemo(() => {
    const map = new Map<number, string>();
    for (const r of regnskaber) {
      if (!r.periodeSlut) continue;
      const aar = new Date(r.periodeSlut).getFullYear();
      if (map.has(aar)) continue; // Nyeste først (ES sorterer desc)
      const dok =
        r.dokumenter.find((d) => d.dokumentMimeType === 'application/pdf') ??
        r.dokumenter.find((d) => d.dokumentMimeType?.includes('xhtml')) ??
        r.dokumenter.find((d) => d.dokumentMimeType === 'application/zip');
      if (dok?.dokumentUrl) map.set(aar, dok.dokumentUrl);
    }
    return map;
  }, [regnskaber]);

  /** Formaterer et tal med tusindtalsseparator */
  const fmt = (val: number | null): string => {
    if (val == null) return '—';
    return val.toLocaleString('da-DK');
  };

  /** Beregner %-ændring mellem to værdier */
  const pctChange = (current: number | null, previous: number | null): number | null => {
    if (current == null || previous == null || previous === 0) return null;
    return ((current - previous) / Math.abs(previous)) * 100;
  };

  /** Badge for %-ændring */
  const PctBadge = ({ pct }: { pct: number | null }) => {
    if (pct == null) return null;
    const rounded = Math.round(pct);
    const isPositive = rounded > 0;
    const isNeg = rounded < 0;
    return (
      <span
        className={`text-[10px] font-medium px-1 py-0.5 rounded ${
          isPositive
            ? 'bg-emerald-500/15 text-emerald-400'
            : isNeg
              ? 'bg-red-500/15 text-red-400'
              : 'bg-slate-700/40 text-slate-400'
        }`}
      >
        {isPositive ? '+' : ''}
        {rounded}%
      </span>
    );
  };

  /** Toggle en række i grafen */
  const toggleChart = (id: string) => {
    setChartRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ── Sektion-definitioner ──

  const resultatRows: FinRow[] = [
    {
      id: 'r-omsaetning',
      label: da ? 'Omsætning' : 'Revenue',
      getValue: (y) => y.resultat.omsaetning,
    },
    {
      id: 'r-brutto',
      label: da ? 'Bruttofortjeneste' : 'Gross Profit',
      getValue: (y) => y.resultat.bruttofortjeneste,
      bold: true,
    },
    {
      id: 'r-personal',
      label: da ? 'Personaleomkostninger' : 'Staff Costs',
      getValue: (y) => y.resultat.personaleomkostninger,
    },
    {
      id: 'r-ekstern',
      label: da ? 'Eksterne omkostninger' : 'External Expenses',
      getValue: (y) => y.resultat.eksterneOmkostninger,
    },
    {
      id: 'r-afskriv',
      label: da ? 'Afskrivninger' : 'Depreciation',
      getValue: (y) => y.resultat.afskrivninger,
    },
    {
      id: 'r-finind',
      label: da ? 'Finansielle indtægter' : 'Finance Income',
      getValue: (y) => y.resultat.finansielleIndtaegter,
    },
    {
      id: 'r-finomk',
      label: da ? 'Finansielle omkostninger' : 'Finance Costs',
      getValue: (y) => y.resultat.finansielleOmkostninger,
    },
    {
      id: 'r-foerskat',
      label: da ? 'Resultat før skat' : 'Profit Before Tax',
      getValue: (y) => y.resultat.resultatFoerSkat,
      bold: true,
    },
    { id: 'r-skat', label: da ? 'Skat' : 'Tax', getValue: (y) => y.resultat.skatAfAaretsResultat },
    {
      id: 'r-aaret',
      label: da ? 'Årets resultat' : 'Net Profit',
      getValue: (y) => y.resultat.aaretsResultat,
      bold: true,
    },
  ];

  const balanceRows: FinRow[] = [
    {
      id: 'b-anlaeg',
      label: da ? 'Anlægsaktiver' : 'Non-current Assets',
      getValue: (y) => y.balance.anlaegsaktiverIAlt,
    },
    {
      id: 'b-grunde',
      label: da ? 'Grunde og bygninger' : 'Land & Buildings',
      getValue: (y) => y.balance.grundeOgBygninger,
    },
    {
      id: 'b-materiel',
      label: da ? 'Materielle anlægsaktiver' : 'Property, Plant & Equip.',
      getValue: (y) => y.balance.materielleAnlaeg,
    },
    {
      id: 'b-invest',
      label: da ? 'Investeringsejendomme' : 'Investment Property',
      getValue: (y) => y.balance.investeringsejendomme,
    },
    {
      id: 'b-omsaet',
      label: da ? 'Omsætningsaktiver' : 'Current Assets',
      getValue: (y) => y.balance.omsaetningsaktiverIAlt,
    },
    {
      id: 'b-vaerdi',
      label: da ? 'Værdipapirer' : 'Securities',
      getValue: (y) => y.balance.vaerdipapirer,
    },
    {
      id: 'b-likvid',
      label: da ? 'Likvide beholdninger' : 'Cash',
      getValue: (y) => y.balance.likvideBeholdninger,
    },
    {
      id: 'b-aktiver',
      label: da ? 'Aktiver i alt' : 'Total Assets',
      getValue: (y) => y.balance.aktiverIAlt,
      bold: true,
    },
    {
      id: 'b-kapital',
      label: da ? 'Selskabskapital' : 'Share Capital',
      getValue: (y) => y.balance.selskabskapital,
    },
    {
      id: 'b-overfoert',
      label: da ? 'Overført resultat' : 'Retained Earnings',
      getValue: (y) => y.balance.overfoertResultat,
    },
    {
      id: 'b-egenkap',
      label: da ? 'Egenkapital' : 'Equity',
      getValue: (y) => y.balance.egenkapital,
      bold: true,
    },
    {
      id: 'b-langfrist',
      label: da ? 'Langfristet gæld' : 'Long-term Debt',
      getValue: (y) => y.balance.langfristetGaeld,
    },
    {
      id: 'b-kortfrist',
      label: da ? 'Kortfristet gæld' : 'Short-term Debt',
      getValue: (y) => y.balance.kortfristetGaeld,
    },
    {
      id: 'b-gaeld',
      label: da ? 'Gældsforpligtelser i alt' : 'Total Liabilities',
      getValue: (y) => y.balance.gaeldsforpligtelserIAlt,
      bold: true,
    },
  ];

  const noegletalsRows: FinRow[] = [
    // ── Rentabilitet ──
    {
      id: 'n-afkast',
      label: da ? 'Afkastningsgrad (ROA)' : 'Return on Assets (ROA)',
      getValue: (y) => y.noegletal.afkastningsgrad,
      isPercent: true,
    },
    {
      id: 'n-egenfor',
      label: da ? 'Egenkapitalforrentning (ROE)' : 'Return on Equity (ROE)',
      getValue: (y) => y.noegletal.egenkapitalensForrentning,
      isPercent: true,
    },
    { id: 'n-roic', label: 'ROIC', getValue: (y) => y.noegletal.roic, isPercent: true },
    {
      id: 'n-overskud',
      label: da ? 'Overskudsgrad' : 'Profit Margin',
      getValue: (y) => y.noegletal.overskudsgrad,
      isPercent: true,
    },
    {
      id: 'n-ebit',
      label: 'EBIT-margin',
      getValue: (y) => y.noegletal.ebitMargin,
      isPercent: true,
    },
    {
      id: 'n-brutto',
      label: da ? 'Bruttomargin' : 'Gross Margin',
      getValue: (y) => y.noegletal.bruttomargin,
      isPercent: true,
    },
    // ── Likviditet ──
    {
      id: 'n-likvid',
      label: da ? 'Likviditetsgrad' : 'Current Ratio',
      getValue: (y) => y.noegletal.likviditetsgrad,
      isPercent: true,
    },
    // ── Kapitalstruktur ──
    {
      id: 'n-solid',
      label: da ? 'Soliditetsgrad' : 'Equity Ratio',
      getValue: (y) => y.noegletal.soliditetsgrad,
      isPercent: true,
    },
    {
      id: 'n-gearing',
      label: da ? 'Finansiel gearing' : 'Financial Gearing',
      getValue: (y) => y.noegletal.finansielGearing,
    },
    {
      id: 'n-nettogaeld',
      label: da ? 'Nettogæld' : 'Net Debt',
      getValue: (y) => y.noegletal.nettoGaeld,
    },
    // ── Effektivitet ──
    {
      id: 'n-aktivomsh',
      label: da ? 'Aktivernes oms.hastighed' : 'Asset Turnover',
      getValue: (y) => y.noegletal.aktivernesOmsaetningshastighed,
    },
    {
      id: 'n-omsansat',
      label: da ? 'Omsætning pr. ansat' : 'Revenue per Employee',
      getValue: (y) => y.noegletal.omsaetningPrAnsat,
    },
    {
      id: 'n-resansat',
      label: da ? 'Resultat pr. ansat' : 'Profit per Employee',
      getValue: (y) => y.noegletal.resultatPrAnsat,
    },
    {
      id: 'n-ansatte',
      label: da ? 'Antal ansatte' : 'Employees',
      getValue: (y) => y.noegletal.antalAnsatte,
    },
  ];

  /**
   * BIZZ-517a: Pengestrømsopgørelse-rækker.
   * Skjules på sektionsniveau hvis ingen af de viste år har pengestrøm-data
   * (typisk fordi små regnskabsklasse B-selskaber ikke aflægger en).
   */
  const pengestromRows: FinRow[] = [
    {
      id: 'p-drift',
      label: da ? 'Drift' : 'Operating',
      getValue: (y) => y.pengestroemme?.fraDrift ?? null,
      bold: true,
    },
    {
      id: 'p-invest',
      label: da ? 'Investering' : 'Investing',
      getValue: (y) => y.pengestroemme?.fraInvestering ?? null,
    },
    {
      id: 'p-finans',
      label: da ? 'Finansiering' : 'Financing',
      getValue: (y) => y.pengestroemme?.fraFinansiering ?? null,
    },
    {
      id: 'p-forskyd',
      label: da ? 'Årets forskydning' : 'Net Change',
      getValue: (y) => y.pengestroemme?.aaretsForskydning ?? null,
      bold: true,
    },
    {
      id: 'p-primo',
      label: da ? 'Likvider primo' : 'Cash Beginning of Period',
      getValue: (y) => y.pengestroemme?.likviderPrimo ?? null,
    },
    {
      id: 'p-ultimo',
      label: da ? 'Likvider ultimo' : 'Cash End of Period',
      getValue: (y) => y.pengestroemme?.likviderUltimo ?? null,
    },
  ];
  /** True hvis mindst ét år har pengestrøm-data — skjuler sektion ellers */
  const harPengestrom = visteAar.some((y) => y.pengestroemme != null);

  /** Alle rækker samlet — bruges til chart-opslag */
  const alleRows = [...resultatRows, ...balanceRows, ...noegletalsRows, ...pengestromRows];

  /** Bygger chart data — kun år hvor mindst én valgt række har data */
  const chartData = [...years]
    .reverse()
    .reduce<Record<string, number | string | null>[]>((acc, y) => {
      const point: Record<string, number | string | null> = { aar: y.aar };
      let hasValue = false;
      for (const id of chartRows) {
        const row = alleRows.find((r) => r.id === id);
        if (row) {
          const val = row.getValue(y);
          point[id] = val;
          if (val != null) hasValue = true;
        }
      }
      if (hasValue) acc.push(point);
      return acc;
    }, []);

  /** Toggle en sektion åben/lukket */
  const toggleSection = (title: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });
  };

  /** Renderer en sektion (resultat/balance/nøgletal) */
  const renderSection = (title: string, rows: FinRow[]) => {
    // Filtrer rækker der har mindst én værdi
    const activeRows = rows.filter((row) => years.some((y) => row.getValue(y) != null));
    if (activeRows.length === 0) return null;

    const isCollapsed = collapsedSections.has(title);

    return (
      <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-hidden">
        {/* Sektion-header — klikbar for at folde sammen */}
        <button
          onClick={() => toggleSection(title)}
          className="w-full px-4 py-2.5 border-b border-slate-700/30 flex items-center gap-2 hover:bg-slate-700/10 transition-colors cursor-pointer"
        >
          {isCollapsed ? (
            <ChevronRight size={15} className="text-slate-400" />
          ) : (
            <ChevronDown size={15} className="text-slate-400" />
          )}
          <BarChart3 size={15} className="text-slate-400" />
          <span className="text-sm font-semibold text-slate-200">{title}</span>
          {!rows[0]?.isPercent && <span className="text-xs text-slate-500 ml-1">(T DKK)</span>}
        </button>

        {/* Tabel — skjult hvis sammenklappet */}
        {!isCollapsed && (
          <div className="overflow-x-auto">
            <div className="min-w-[600px]">
              {/* Kolonne-header med årstal */}
              <div
                className="grid px-4 py-1.5 border-b border-slate-700/20"
                style={{
                  gridTemplateColumns: `28px 180px repeat(${visteAar.length}, minmax(110px, 1fr))`,
                }}
              >
                <span />
                <span />
                {visteAar.map((y) => {
                  const pdfUrl = pdfPerAar.get(y.aar);
                  return (
                    <div key={y.aar} className="flex items-center justify-end gap-1">
                      {pdfUrl && (
                        <a
                          href={pdfUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-slate-500 hover:text-blue-400 transition-colors"
                          title={
                            da
                              ? `Download ${y.aar} regnskab (PDF)`
                              : `Download ${y.aar} report (PDF)`
                          }
                        >
                          <Download size={11} />
                        </a>
                      )}
                      <span className="text-[11px] font-semibold text-blue-400 tabular-nums">
                        {y.aar}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Datarækker */}
              {activeRows.map((row) => {
                const isCharted = chartRows.has(row.id);
                const chartIdx = Array.from(chartRows).indexOf(row.id);
                const color =
                  chartIdx >= 0 ? CHART_COLORS[chartIdx % CHART_COLORS.length] : undefined;

                return (
                  <div
                    key={row.id}
                    className="grid px-4 py-1.5 border-b border-slate-700/10 hover:bg-slate-700/10 transition-colors items-center"
                    style={{
                      gridTemplateColumns: `28px 180px repeat(${visteAar.length}, minmax(110px, 1fr))`,
                    }}
                  >
                    {/* Checkbox til graf */}
                    <label className="flex items-center cursor-pointer flex-shrink-0">
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={isCharted}
                        onChange={() => toggleChart(row.id)}
                      />
                      <span
                        className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${!isCharted ? 'border-slate-500 bg-[#0a1020]' : ''}`}
                        style={
                          isCharted ? { backgroundColor: color, borderColor: color } : undefined
                        }
                      >
                        {isCharted && (
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
                    {/* Label */}
                    <span
                      className={`text-xs truncate cursor-pointer ${row.bold ? 'text-white font-semibold' : 'text-slate-300'} ${isCharted ? 'underline decoration-dotted' : ''}`}
                      style={isCharted ? { textDecorationColor: color } : undefined}
                      onClick={() => toggleChart(row.id)}
                    >
                      {row.label}
                    </span>
                    {/* Værdier per år — badge + tal i én celle, tæt sammen */}
                    {visteAar.map((y, idx) => {
                      const val = row.getValue(y);
                      const prevYear = visteAar[idx + 1];
                      const prevVal = prevYear ? row.getValue(prevYear) : null;
                      const pct = pctChange(val, prevVal);
                      const isNeg = val != null && val < 0;

                      return (
                        <div key={y.aar} className="flex items-center justify-end gap-1">
                          {/* %-badge — fast bredde så de flugter vertikalt */}
                          <span className="w-[46px] flex-shrink-0 flex items-center justify-end">
                            {prevVal != null && <PctBadge pct={pct} />}
                          </span>
                          {/* Tal */}
                          <span
                            className={`text-xs tabular-nums text-right ${
                              row.bold ? 'font-semibold' : 'font-normal'
                            } ${isNeg ? 'text-red-400' : 'text-slate-200'}`}
                          >
                            {row.isPercent ? (val != null ? `${val}%` : '—') : fmt(val)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* Global "Vis alle år" knap — kun synlig når mindst én sektion er åben */}
      {years.length > 5 && collapsedSections.size < 3 && (
        <div className="flex justify-end">
          <button
            onClick={() => setVisAlleAar((prev) => !prev)}
            className="text-xs text-blue-400 hover:text-blue-300 transition-colors flex items-center gap-1"
          >
            {visAlleAar ? (
              <>
                <ChevronDown size={13} />
                {da ? 'Vis færre år' : 'Show fewer years'}
              </>
            ) : (
              <>
                <ChevronRight size={13} />
                {da ? `Vis alle ${years.length} år` : `Show all ${years.length} years`}
              </>
            )}
          </button>
        </div>
      )}

      {renderSection(da ? 'Resultatopgørelse' : 'Income Statement', resultatRows)}
      {renderSection(da ? 'Balance' : 'Balance Sheet', balanceRows)}
      {/* BIZZ-517a: Pengestrømsopgørelse — vises kun hvis selskabet har aflagt en */}
      {harPengestrom && renderSection(da ? 'Pengestrømme' : 'Cash Flow', pengestromRows)}
      {renderSection(da ? 'Nøgletal' : 'Key Ratios', noegletalsRows)}

      {/* BIZZ-559: Revisor + revisionspåtegning fra seneste regnskabsår.
          Skjules hvis ingen revisor-info findes (revision fravalgt). */}
      {(() => {
        const senesteRevisor = visteAar.find((y) => y.revisor != null)?.revisor;
        if (!senesteRevisor) return null;
        return (
          <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700/30">
              <div className="flex items-center gap-2">
                <CheckCircle size={15} className="text-amber-400" />
                <span className="text-sm font-semibold text-slate-200">
                  {da ? 'Revisor' : 'Auditor'}
                </span>
              </div>
              {senesteRevisor.harForbehold ? (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/30">
                  {da
                    ? `Forbehold: ${senesteRevisor.forbeholdType}`
                    : `Modified: ${senesteRevisor.forbeholdType}`}
                </span>
              ) : (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                  {da ? 'Ren konklusion' : 'Unmodified opinion'}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 p-4">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                  {da ? 'Revisionsfirma' : 'Audit firm'}
                </p>
                <p className="text-sm text-slate-200">
                  {senesteRevisor.firmaCvr ? (
                    <a
                      href={`/dashboard/companies/${senesteRevisor.firmaCvr}`}
                      className="text-blue-400 hover:underline"
                    >
                      {senesteRevisor.firmanavn ?? `CVR ${senesteRevisor.firmaCvr}`}
                    </a>
                  ) : (
                    (senesteRevisor.firmanavn ?? '—')
                  )}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                  {da ? 'Revisor' : 'Auditor'}
                </p>
                <p className="text-sm text-slate-200">{senesteRevisor.revisorNavn ?? '—'}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                  {da ? 'Underskriftssted' : 'Signed at'}
                </p>
                <p className="text-sm text-slate-200">{senesteRevisor.signaturSted ?? '—'}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                  {da ? 'Underskriftsdato' : 'Signed date'}
                </p>
                <p className="text-sm text-slate-200">{senesteRevisor.signaturDato ?? '—'}</p>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Graf — vises nederst når mindst én række er valgt */}
      {chartRows.size > 0 && (
        <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-hidden p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <BarChart3 size={15} className="text-slate-400" />
              <span className="text-sm font-semibold text-slate-200">
                {da ? 'Udvikling' : 'Trend'}
              </span>
            </div>
          </div>
          {/* Legend */}
          <div className="flex flex-wrap gap-3 mb-3">
            {Array.from(chartRows).map((id, idx) => {
              const row = alleRows.find((r) => r.id === id);
              if (!row) return null;
              const color = CHART_COLORS[idx % CHART_COLORS.length];
              return (
                <button
                  key={id}
                  onClick={() => toggleChart(id)}
                  className="inline-flex items-center gap-1.5 text-xs text-slate-300 hover:text-white transition-colors"
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: color }}
                  />
                  {row.label}
                  <XCircle size={11} className="text-slate-500 hover:text-red-400" />
                </button>
              );
            })}
          </div>
          {/* SVG chart — Recharts */}
          <div className="h-64">
            <RegnskabChart
              chartData={chartData}
              chartRowIds={Array.from(chartRows)}
              alleRows={alleRows}
              colors={CHART_COLORS}
            />
          </div>
        </div>
      )}
    </div>
  );
}
