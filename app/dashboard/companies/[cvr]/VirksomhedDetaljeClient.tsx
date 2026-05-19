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

import { useState, useEffect, use, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Building2,
  Briefcase,
  Users,
  CreditCard,
  Loader2,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Bell,
  LayoutDashboard,
  ArrowRightLeft,
  Home,
  Clock,
  Scale,
  X,
  Newspaper,
  Globe,
  Sparkles,
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
import { saveRecentCompany } from '@/app/lib/recentCompanies';
import { recordRecentVisit } from '@/app/lib/recordRecentVisit';
// useSubscription, useSubscriptionAccess, resolvePlan etc. moved to AIArticleSearchPanel
// isDiagram2Enabled fjernet
import dynamic from 'next/dynamic';
import VerifiedLinks from '@/app/components/VerifiedLinks';
import DataFreshnessBadge from '@/app/components/DataFreshnessBadge';
import VirksomhedOverblikTab from './tabs/VirksomhedOverblikTab';
import VirksomhedEjendommeTab from './tabs/VirksomhedEjendommeTab';
import VirksomhedGruppeTab from './tabs/VirksomhedGruppeTab';
import VirksomhedRegnskabTab from './tabs/VirksomhedRegnskabTab';
import VirksomhedNoeglepersonerTab from './tabs/VirksomhedNoeglepersonerTab';
import VirksomhedHistorikTab from './tabs/VirksomhedHistorikTab';
import VirksomhedTinglysningTab from './tabs/VirksomhedTinglysningTab';
/** BIZZ-600: DiagramForce uses d3-force — dynamic() keeps d3-force out of initial bundle */
// prettier-ignore
/** Diagram v2 — feature-flagged, kun synlig i dev/preview */
const DiagramV2 = dynamic(() => import('@/app/components/diagrams/DiagramV2'), { ssr: false });

import {
  erTrackedCompany,
  toggleTrackCompany,
  extractOwners,
  rolleKategori,
  rolleKategoriOrdning,
} from './virksomhedDetailHelpers';
import AIArticleSearchPanel from './AIArticleSearchPanel';
import type { OwnerChainNode, PersonMedRolle } from './tabs/VirksomhedOverblikTab';

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

/** Basis-rækkefølge af tabs */
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

// ─── Types ────────────────────────────────────────────────────────────────────

interface PageProps {
  params: Promise<{ cvr: string }>;
  /** BIZZ-1160: Server-side prefetched data fra cvr_virksomhed cache */
  prefetched?: {
    navn: string | null;
    virksomhedsform: string | null;
    branche_tekst: string | null;
    status: string | null;
    ophoert: string | null;
  };
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
  /** BIZZ-919: Cache-metadata fra primær API-response */
  const [cacheFromCache, setCacheFromCache] = useState(false);
  const [cacheSyncedAt, setCacheSyncedAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** BIZZ-919: Incrementing key triggers data re-fetch */
  const [refreshKey, setRefreshKey] = useState(0);
  const [aktivTab, setAktivTab] = useState<TabId>('overview');
  /** BIZZ-1121: Lazy-mount — mount ved første klik, behold med display:none */
  const [diagram2Mounted, setDiagram2Mounted] = useState(false);
  /** Tab-rækkefølge — diagram2 fjernet, DiagramV2 erstatter det gamle diagram */
  const tabOrder = useMemo<TabId[]>(() => baseTabOrder, []);
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

  /** BIZZ-1310: Datterselskab-CVR'er fra ejerskabs-cache (supplement til CVR ES) */
  const [ejerskabDatterCvrs, setEjerskabDatterCvrs] = useState<string[]>([]);

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
  // diagramGraphStable fjernet — DiagramV2 erstatter det gamle DiagramForce
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

        // BIZZ-1170: Prefetch diagram/resolve for diagram-fanen
        // Varmer HTTP-cachen op så diagrammet er klar ved tab-klik
        fetch(
          `/api/diagram/resolve?type=company&id=${company.vat}&label=${encodeURIComponent(company.name ?? '')}`,
          { priority: 'low' as RequestPriority }
        ).catch(() => {});

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

      // BIZZ-1310: Supplement — hent datterselskab-CVR'er fra ejerskabs-cache
      // (fanger selskaber som CVR ES-søgning misser, fx holding-strukturer)
      try {
        const ejRes = await fetch(`/api/diagram/subsidiaries?cvr=${encodeURIComponent(cvr)}`, {
          signal: controller.signal,
        });
        if (ejRes.ok) {
          const ejData = await ejRes.json();
          setEjerskabDatterCvrs((ejData.cvrs ?? []) as string[]);
        }
      } catch {
        /* non-fatal */
      }
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

    /* Saml CVR-numre: hovedvirksomhed + aktive datterselskaber.
     * BIZZ-1310: Inkludér også datterselskaber fra ejerskabs-cache
     * (cvr_virksomhed_ejerskab) da CVR ES-søgning kan misse nogle. */
    const cvrList = [
      cvr,
      ...relatedCompanies.filter((v) => v.aktiv).map((v) => String(v.cvr).padStart(8, '0')),
      ...ejerskabDatterCvrs,
    ];
    const uniqueCvrs = [...new Set(cvrList)].slice(0, 50);

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
    // BIZZ-1664: ejerskabDatterCvrs tilføjet til dep-array — når ejerskabs-
    // cache loader datterselskaber ind, re-triggers ejendomme-fetchen med
    // det komplette CVR-sæt (inkl. datter-CVR'er som CVR ES missede).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aktivTab, cvr, relatedCompanies, ejerskabDatterCvrs, fetchEjendommeProgressively]);

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
          {/* ══ DIAGRAM — DiagramV2 erstatter det gamle DiagramForce ══ */}
          {data && (aktivTab === 'diagram' || diagram2Mounted) && (
            <div
              ref={() => {
                if (!diagram2Mounted) setDiagram2Mounted(true);
              }}
              style={{ display: aktivTab === 'diagram' ? 'block' : 'none' }}
            >
              <DiagramV2
                rootType="company"
                rootId={String(data.vat)}
                rootLabel={data.name ?? ''}
                lang={lang}
                onDiagramReady={(base64) => {
                  setAICtx({ diagramBase64: base64 });
                }}
              />
            </div>
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
            <VirksomhedTinglysningTab
              lang={lang}
              personbogData={personbogData}
              personbogLoading={personbogLoading}
              personbogFejl={personbogFejl}
              personbogDokumenter={personbogDokumenter}
              personbogRowOpen={personbogRowOpen}
              setPersonbogRowOpen={setPersonbogRowOpen}
              expandedPant={expandedPant}
              setExpandedPant={setExpandedPant}
              selectedPantDocs={selectedPantDocs}
              setSelectedPantDocs={setSelectedPantDocs}
              bilbogData={bilbogData}
              bilbogLoading={bilbogLoading}
              bilbogFejl={bilbogFejl}
              bilbogOpen={bilbogOpen}
              setBilbogOpen={setBilbogOpen}
              andelsbogData={andelsbogData}
              andelsbogLoading={andelsbogLoading}
              andelsbogFejl={andelsbogFejl}
              andelsbogOpen={andelsbogOpen}
              setAndelsbogOpen={setAndelsbogOpen}
              fastEjendomKreditor={fastEjendomKreditor}
              fastEjendomLoading={fastEjendomLoading}
              fastEjendomFejl={fastEjendomFejl}
              fastEjendomOpen={fastEjendomOpen}
              setFastEjendomOpen={setFastEjendomOpen}
            />
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

// AIArticleSearchPanel, RelationsDiagram, and helper components extracted to
// separate files (BIZZ-1229):
// - AIArticleSearchPanel.tsx
// - virksomhedDetailHelpers.ts
