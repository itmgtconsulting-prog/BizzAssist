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

import { useState, use, useEffect, useRef, Suspense } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  Download,
  Bell,
  List,
  MapPin,
  Building2,
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
} from 'lucide-react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import PropertyMap from '@/app/components/ejendomme/PropertyMap';
import {
  getEjendomById,
  formatDKK,
  formatDato,
  type EjerstrukturNode,
} from '@/app/lib/mock/ejendomme';
import { erDawaId, type DawaAdresse, type DawaJordstykke } from '@/app/lib/dawa';
import type { EjendomApiResponse, LiveBBRBygning } from '@/app/api/ejendom/[id]/route';
import type { CVRVirksomhed, CVRResponse } from '@/app/api/cvr/route';
import type { VurderingData, VurderingResponse } from '@/app/api/vurdering/route';
import type { EjerData, EjerskabResponse } from '@/app/api/ejerskab/route';
import type { PlandataItem, PlandataResponse } from '@/app/api/plandata/route';
import type { EnergimaerkeItem, EnergimaerkeResponse } from '@/app/api/energimaerke/route';
import type { JordParcelItem, JordResponse } from '@/app/api/jord/route';
import type { HandelData, SalgshistorikResponse } from '@/app/api/salgshistorik/route';
import type {
  ForelobigVurdering,
  ForelobigVurderingResponse,
} from '@/app/api/vurdering-forelobig/route';
import type { MatrikelEjendom, MatrikelResponse } from '@/app/api/matrikel/route';
import { gemRecentEjendom } from '@/app/lib/recentEjendomme';
import { erTracked, toggleTrackEjendom } from '@/app/lib/trackedEjendomme';
import FoelgTooltip from '@/app/components/FoelgTooltip';

type Tab =
  | 'overblik'
  | 'bbr'
  | 'ejerforhold'
  | 'tinglysning'
  | 'oekonomi'
  | 'skatter'
  | 'dokumenter';

const tabs: { id: Tab; label: string; ikon: React.ReactNode }[] = [
  { id: 'overblik', label: 'Oversigt', ikon: <Building2 size={14} /> },
  { id: 'bbr', label: 'BBR', ikon: <FileText size={14} /> },
  { id: 'ejerforhold', label: 'Ejerskab', ikon: <Users size={14} /> },
  { id: 'tinglysning', label: 'Tinglysning', ikon: <Landmark size={14} /> },
  { id: 'oekonomi', label: 'Økonomi', ikon: <BarChart3 size={14} /> },
  { id: 'skatter', label: 'SKAT', ikon: <Landmark size={14} /> },
  { id: 'dokumenter', label: 'Dokumenter', ikon: <FileText size={14} /> },
];

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
function EjerstrukturTrae({ noder }: { noder: EjerstrukturNode[] }) {
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
 */
export default function EjendomDetalje({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
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
  const [dawaAdresse, setDawaAdresse] = useState<DawaAdresse | null>(null);
  const [dawaJordstykke, setDawaJordstykke] = useState<DawaJordstykke | null>(null);
  // true = loader, false = fejl, null = idle/done
  const [dawaStatus, setDawaStatus] = useState<'loader' | 'fejl' | 'ok' | 'idle'>('idle');

  /** BBR data fra server-side API-route — null = ikke hentet / ikke tilgængeligt */
  const [bbrData, setBbrData] = useState<EjendomApiResponse | null>(null);
  /** True mens BBR-data hentes */
  const [bbrLoader, setBbrLoader] = useState(false);

  /** CVR-virksomheder registreret på adressen */
  const [cvrVirksomheder, setCvrVirksomheder] = useState<CVRVirksomhed[] | null>(null);
  /** True hvis CVR_ES_USER/PASS mangler i .env.local */
  const [cvrTokenMangler, setCvrTokenMangler] = useState(false);

  /** Ejendomsvurderingsdata fra Datafordeler — null = ikke hentet endnu */
  const [vurdering, setVurdering] = useState<VurderingData | null>(null);
  /** Alle vurderinger fra Datafordeler — bruges til historiktabel */
  const [alleVurderinger, setAlleVurderinger] = useState<VurderingData[]>([]);
  /** True mens vurderingsdata hentes */
  const [vurderingLoader, setVurderingLoader] = useState(false);
  /** True = vis fuld vurderingshistorik-tabel */
  const [visVurderingHistorik, setVisVurderingHistorik] = useState(false);

  /** Ejere fra Ejerfortegnelsen (Datafordeler) */
  const [ejere, setEjere] = useState<EjerData[] | null>(null);
  /** True mens ejerdata hentes */
  const [ejereLoader, setEjereLoader] = useState(false);
  /** True hvis Datafordeler returnerer 403 — Dataadgang-ansøgning mangler for EJF */
  const [manglerEjereAdgang, setManglerEjereAdgang] = useState(false);

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
  const [, setForelobigLoader] = useState(false);
  /** Matrikeldata fra Datafordeler MAT-registret */
  const [matrikelData, setMatrikelData] = useState<MatrikelEjendom | null>(null);
  /** True mens matrikeldata hentes */
  const [matrikelLoader, setMatrikelLoader] = useState(false);
  /** ID'er på jord-rækker der er foldet ud */
  const [expandedJord, setExpandedJord] = useState<Set<string>>(new Set());

  const erDAWA = erDawaId(id);

  /** Om ejendommen er fulgt af brugeren — synkroniseret med localStorage */
  const [erFulgt, setErFulgt] = useState(false);
  /** Vis Følg-tooltip med info om overvåget data */
  const [visFoelgTooltip, setVisFoelgTooltip] = useState(false);

  /** Indlæs tracking-tilstand ved mount og lyt efter ændringer */
  useEffect(() => {
    setErFulgt(erTracked(id));
    const handler = () => setErFulgt(erTracked(id));
    window.addEventListener('ba-tracked-changed', handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener('ba-tracked-changed', handler);
      window.removeEventListener('storage', handler);
    };
  }, [id]);

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
   * Henter DAWA-adresse og jordstykke.
   * Al setState sker i async then-callback — ikke synkront.
   */
  useEffect(() => {
    if (!erDAWA) return;
    setDawaStatus('loader');
    fetch(`/api/adresse/lookup?id=${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(async (adr: DawaAdresse | null) => {
        if (!adr) {
          setDawaStatus('fejl');
          return;
        }
        setDawaAdresse(adr);
        const jordRes = await fetch(`/api/adresse/jordstykke?lng=${adr.x}&lat=${adr.y}`);
        const jord: DawaJordstykke | null = jordRes.ok ? await jordRes.json() : null;
        setDawaJordstykke(jord);
        setDawaStatus('ok');

        // Gem besøget i "seneste sete ejendomme"-historikken
        gemRecentEjendom({
          id,
          adresse: adr.adressebetegnelse.split(',')[0],
          postnr: adr.postnr,
          by: adr.postnrnavn,
          kommune: adr.kommunenavn,
          anvendelse: null, // opdateres nedenfor når BBR-data er klar
        });
      });
  }, [id, erDAWA]);

  /**
   * Henter BBR-data fra server-side API-route når DAWA-adressen er klar.
   * Fejler stille — bbrData.bbrFejl beskriver årsagen hvis data mangler.
   */
  useEffect(() => {
    if (!erDAWA || dawaStatus !== 'ok') return;
    setBbrLoader(true);
    fetch(`/api/ejendom/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: EjendomApiResponse | null) => {
        setBbrData(data);
      })
      .catch(() => setBbrData(null))
      .finally(() => setBbrLoader(false));
  }, [id, erDAWA, dawaStatus]);

  /**
   * Henter CVR-virksomheder på adressen via /api/cvr når DAWA-adressen er klar.
   * Fejler stille — viser tom liste hvis ingen resultater eller fejl.
   */
  useEffect(() => {
    if (!erDAWA || dawaStatus !== 'ok' || !dawaAdresse) return;
    const params = new URLSearchParams({
      vejnavn: dawaAdresse.vejnavn,
      husnr: dawaAdresse.husnr,
      postnr: dawaAdresse.postnr,
    });
    fetch(`/api/cvr?${params}`)
      .then((r) => (r.ok ? r.json() : { virksomheder: [], tokenMangler: false }))
      .then((data: CVRResponse) => {
        setCvrVirksomheder(data.virksomheder);
        setCvrTokenMangler(data.tokenMangler);
      })
      .catch(() => setCvrVirksomheder([]));
  }, [id, erDAWA, dawaStatus, dawaAdresse]);

  /**
   * Henter ejendomsvurdering og ejerskabsdata fra Datafordeler når BFEnummer
   * er tilgængeligt via BBR Ejendomsrelation.
   * Kører i parallel og fejler stille ved manglende API-nøgle.
   */
  useEffect(() => {
    if (!erDAWA || !bbrData?.ejendomsrelationer?.length) return;
    const bfeNummer = bbrData.ejendomsrelationer[0]?.bfeNummer;
    if (!bfeNummer) return;

    setVurderingLoader(true);
    setEjereLoader(true);

    const kommunekode = dawaJordstykke?.kommune?.kode;
    const vurderingUrl = kommunekode
      ? `/api/vurdering?bfeNummer=${bfeNummer}&kommunekode=${kommunekode}`
      : `/api/vurdering?bfeNummer=${bfeNummer}`;

    fetch(vurderingUrl)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: VurderingResponse | null) => {
        setVurdering(data?.vurdering ?? null);
        setAlleVurderinger(data?.alle ?? []);
      })
      .catch(() => setVurdering(null))
      .finally(() => setVurderingLoader(false));

    fetch(`/api/ejerskab?bfeNummer=${bfeNummer}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: EjerskabResponse | null) => {
        setManglerEjereAdgang(data?.manglerAdgang ?? false);
        setEjere(data?.ejere ?? []);
      })
      .catch(() => setEjere([]))
      .finally(() => setEjereLoader(false));

    setSalgshistorikLoader(true);
    fetch(`/api/salgshistorik?bfeNummer=${bfeNummer}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: SalgshistorikResponse | null) => {
        setSalgshistorikManglerAdgang(data?.manglerAdgang ?? false);
        setSalgshistorik(data?.handler ?? []);
      })
      .catch(() => setSalgshistorik([]))
      .finally(() => setSalgshistorikLoader(false));
  }, [id, erDAWA, bbrData]);

  /**
   * Henter matrikeldata (jordstykker, landbrugsnotering m.m.) fra Datafordeler MAT-registret.
   * Kører når BFE-nummer er tilgængeligt via BBR Ejendomsrelation.
   */
  useEffect(() => {
    if (!erDAWA || !bbrData?.ejendomsrelationer?.length) return;
    const bfeNummer = bbrData.ejendomsrelationer[0]?.bfeNummer;
    if (!bfeNummer) return;
    setMatrikelLoader(true);
    fetch(`/api/matrikel?bfeNummer=${bfeNummer}`)
      .then((r) => r.json())
      .then((data: MatrikelResponse) => {
        if (data.matrikel) setMatrikelData(data.matrikel);
      })
      .catch(() => {})
      .finally(() => setMatrikelLoader(false));
  }, [erDAWA, bbrData]);

  /**
   * Henter forelobige ejendomsvurderinger fra Vurderingsportalen.
   * Proever foerst adgangsadresse-ID fra DAWA, derefter BFE-nummer fra BBR.
   * Disse er separate fra de endelige vurderinger fra Datafordeler.
   */
  useEffect(() => {
    if (!erDAWA) return;

    // Byg soegeparametre — brug adresseId (DAWA UUID) hvis tilgaengeligt, ellers bfeNummer
    const adresseId = dawaAdresse?.id;
    const bfeNummer = bbrData?.ejendomsrelationer?.[0]?.bfeNummer;

    if (!adresseId && !bfeNummer) return;

    const params = new URLSearchParams();
    if (adresseId) {
      params.set('adresseId', adresseId);
    }
    if (bfeNummer) {
      params.set('bfeNummer', String(bfeNummer));
    }

    setForelobigLoader(true);
    fetch(`/api/vurdering-forelobig?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: ForelobigVurderingResponse | null) => {
        setForelobige(data?.forelobige ?? []);
      })
      .catch(() => setForelobige([]))
      .finally(() => setForelobigLoader(false));
  }, [id, erDAWA, dawaAdresse, bbrData]);

  /**
   * Henter energimærkerapporter via /api/energimaerke når BFE-nummer er tilgængeligt.
   * Kræver EMO_USERNAME/PASSWORD i .env.local — fejler stille med manglerAdgang-flag.
   */
  useEffect(() => {
    if (!erDAWA || !bbrData?.ejendomsrelationer?.length) return;
    const bfeNummer = bbrData.ejendomsrelationer[0]?.bfeNummer;
    if (!bfeNummer) return;

    setEnergiLoader(true);
    fetch(`/api/energimaerke?bfeNummer=${bfeNummer}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: EnergimaerkeResponse | null) => {
        setEnergimaerker(data?.maerker ?? null);
        setEnergiManglerAdgang(data?.manglerAdgang ?? false);
        setEnergiFejl(data?.fejl ?? null);
      })
      .catch(() => setEnergiFejl('Netværksfejl ved hentning af energimærker'))
      .finally(() => setEnergiLoader(false));
  }, [id, erDAWA, bbrData]);

  /**
   * Henter jordforureningsstatus fra DkJord API når ejerlavKode + matrikelnr er tilgængelige.
   * Åbne data — kræver ingen autentificering.
   */
  useEffect(() => {
    if (!erDAWA || !bbrData?.ejendomsrelationer?.length) return;
    const rel = bbrData.ejendomsrelationer[0];
    if (!rel?.ejerlavKode || !rel?.matrikelnr) return;

    setJordLoader(true);
    setJordData(null);
    setJordIngenData(false);
    setJordFejl(null);

    fetch(
      `/api/jord?ejerlavKode=${rel.ejerlavKode}&matrikelnr=${encodeURIComponent(rel.matrikelnr)}`
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((data: JordResponse | null) => {
        setJordData(data?.items ?? null);
        setJordIngenData(data?.ingenData ?? false);
        setJordFejl(data?.fejl ?? null);
      })
      .catch(() => setJordFejl('Netværksfejl ved hentning af jordforureningsdata'))
      .finally(() => setJordLoader(false));
  }, [id, erDAWA, bbrData]);

  /**
   * Henter lokalplaner og kommuneplanrammer via /api/plandata når DAWA-adressen er klar.
   * Kræver kun adresse-UUID — koordinater hentes internt af API-routen via DAWA.
   */
  useEffect(() => {
    if (!erDAWA || dawaStatus !== 'ok') return;
    setPlandataLoader(true);
    setPlandataFejl(null);
    fetch(`/api/plandata?adresseId=${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: PlandataResponse | null) => {
        setPlandata(data?.planer ?? null);
        if (data?.fejl) setPlandataFejl(data.fejl);
      })
      .catch(() => setPlandataFejl('Netværksfejl ved hentning af plandata'))
      .finally(() => setPlandataLoader(false));
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
  /** True mens PDF-rapport genereres */
  const [rapportLoader, setRapportLoader] = useState(false);

  /**
   * Genererer og downloader en PDF-rapport med al ejendomsdata.
   * POSTer samlet data til /api/rapport og trigger browser-download af resultatet.
   */
  const handleDownloadRapport = async () => {
    if (rapportLoader) return;
    setRapportLoader(true);
    try {
      const rel = bbrData?.ejendomsrelationer?.[0];
      const adresse = dawaAdresse
        ? `${dawaAdresse.vejnavn} ${dawaAdresse.husnr}${dawaAdresse.etage ? `, ${dawaAdresse.etage}.` : ''}${dawaAdresse.dør ? ` ${dawaAdresse.dør}` : ''}, ${dawaAdresse.postnr} ${dawaAdresse.postnrnavn}`
        : (ejendom?.adresse ?? 'Ukendt adresse');

      const payload = {
        adresse,
        kommune: dawaAdresse?.kommunenavn ?? null,
        postnr: dawaAdresse?.postnr ?? null,
        by: dawaAdresse?.postnrnavn ?? null,
        bfeNummer: rel?.bfeNummer ?? null,
        matrikelnr: rel?.matrikelnr ?? null,
        ejerlavKode: rel?.ejerlavKode ?? null,
        bygninger: (bbrData?.bbr ?? []).map((b: LiveBBRBygning) => ({
          id: b.id,
          opfoerelsesaar: b.opfoerelsesaar,
          bygningsareal: b.samletBygningsareal ?? b.bebyggetAreal,
          boligareal: b.samletBoligareal,
          samletAreal: b.samletBygningsareal,
          etager: b.antalEtager,
          anvendelsestekst: b.anvendelse,
          tagmateriale: b.tagmateriale,
          ydervaeggene: b.ydervaeg,
          energimaerke: b.energimaerke,
        })),
        vurdering: vurdering
          ? {
              aar: vurdering.aar,
              ejendomsvaerdi: vurdering.ejendomsvaerdi,
              grundvaerdi: vurdering.grundvaerdi,
              estimereretGrundskyld: vurdering.estimereretGrundskyld,
              grundskyldspromille: vurdering.grundskyldspromille,
            }
          : null,
        alleVurderinger: alleVurderinger.map((v) => ({
          aar: v.aar,
          ejendomsvaerdi: v.ejendomsvaerdi,
          grundvaerdi: v.grundvaerdi,
        })),
        ejere: (ejere ?? []).map((e: EjerData) => ({
          navn: e.cvr ? `CVR ${e.cvr}` : e.ejertype === 'person' ? 'Person' : 'Ukendt',
          ejertype: e.ejertype,
          cvr: e.cvr ?? null,
          ejerandel:
            e.ejerandel_taeller != null && e.ejerandel_naevner != null
              ? { taeller: e.ejerandel_taeller, naevner: e.ejerandel_naevner }
              : null,
        })),
        salgshistorik: (salgshistorik ?? []).map((h: HandelData) => ({
          koebsaftaleDato: h.koebsaftaleDato,
          kontantKoebesum: h.kontantKoebesum,
          overdragelsesmaade: h.overdragelsesmaade,
        })),
        matrikel:
          matrikelData?.jordstykker?.map((js) => ({
            matrikelnummer: js.matrikelnummer,
            registreretAreal: js.registreretAreal,
            vejareal: js.vejareal,
            fredskov: js.fredskov,
            strandbeskyttelse: js.strandbeskyttelse,
          })) ?? [],
        plandata: (plandata ?? []).map((p: PlandataItem) => ({
          type: p.type,
          navn: p.navn,
          nummer: p.nummer,
          status: p.status,
        })),
        jordforurening: (jordData ?? []).map((j: JordParcelItem) => ({
          pollutionStatusCodeText: j.pollutionStatusText,
          locationNames: j.locationNames,
        })),
        jordIngenData,
      };

      const res = await fetch('/api/rapport', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({ fejl: 'Ukendt fejl' }))) as { fejl?: string };
        alert(`Rapport-download fejlede: ${err.fejl ?? res.statusText}`);
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download =
        res.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'rapport.pdf';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(`Rapport-download fejlede: ${err instanceof Error ? err.message : 'Ukendt fejl'}`);
    } finally {
      setRapportLoader(false);
    }
  };

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

    if (docs.length === 0) {
      alert('De valgte dokumenter har ingen direkte PDF-links der kan downloades.');
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
        const err = (await res.json().catch(() => ({ fejl: 'Ukendt fejl' }))) as { fejl?: string };
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
        alert(
          `ZIP-filen er hentet, men følgende dokumenter kunne ikke inkluderes (ikke en gyldig PDF):\n\n${liste}\n\nPrøv at åbne dem direkte i browseren.`
        );
      }
    } catch (err) {
      alert(`ZIP-download fejlede: ${err instanceof Error ? err.message : 'Ukendt fejl'}`);
    } finally {
      setZipLoader(false);
    }
  };

  const ejendom = erDAWA ? null : getEjendomById(id);

  // ── DAWA: Loading ──
  if (erDAWA && dawaStatus === 'loader') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        <p className="text-slate-400 text-sm">Henter adressedata…</p>
      </div>
    );
  }

  // ── DAWA: Fejl ──
  if (erDAWA && dawaStatus === 'fejl') {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-6">
        <MapPin size={40} className="text-slate-600 mb-4" />
        <h2 className="text-white text-xl font-semibold mb-2">Adresse ikke fundet</h2>
        <p className="text-slate-400 text-sm mb-6">Adressen kunne ikke hentes fra DAWA.</p>
        <Link
          href="/dashboard/ejendomme"
          className="text-blue-400 hover:text-blue-300 flex items-center gap-2 text-sm"
        >
          <ArrowLeft size={16} /> Tilbage til ejendomme
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
          <div className="px-6 pt-5 pb-0 border-b border-slate-700/50 bg-slate-900/30">
            <div className="flex items-center justify-between mb-3">
              <button
                onClick={() => router.push('/dashboard/ejendomme')}
                className="flex items-center gap-2 text-slate-400 hover:text-white text-sm transition-colors"
              >
                <ArrowLeft size={16} /> Ejendomme
              </button>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleDownloadRapport}
                  disabled={rapportLoader}
                  className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-wait border border-blue-500/60 rounded-lg text-white text-sm font-medium transition-all"
                  title="Download ejendomsrapport som PDF"
                >
                  {rapportLoader ? (
                    <>
                      <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                      Genererer…
                    </>
                  ) : (
                    <>
                      <Download size={14} />
                      Rapport
                    </>
                  )}
                </button>
                <div
                  className="relative"
                  onMouseEnter={() => !erFulgt && setVisFoelgTooltip(true)}
                  onMouseLeave={() => setVisFoelgTooltip(false)}
                >
                  <button
                    onClick={async () => {
                      setVisFoelgTooltip(false);
                      const postnr = dawaAdresse?.postnr ?? '';
                      const by = dawaAdresse?.postnrnavn ?? '';
                      const kommune =
                        dawaAdresse?.kommunenavn ?? dawaJordstykke?.kommune.navn ?? '';
                      const anvendelse = bbrData?.bbr?.[0]?.anvendelse ?? null;
                      const nyTilstand = toggleTrackEjendom({
                        id,
                        adresse: adresseStreng,
                        postnr,
                        by,
                        kommune,
                        anvendelse,
                      });
                      setErFulgt(nyTilstand);
                      window.dispatchEvent(new Event('ba-tracked-changed'));
                      try {
                        if (nyTilstand) {
                          await fetch('/api/tracked', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              entity_id: id,
                              label: adresseStreng,
                              entity_data: { postnr, by, kommune, anvendelse },
                            }),
                          });
                        } else {
                          await fetch(`/api/tracked?id=${encodeURIComponent(id)}`, {
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
                    {erFulgt ? 'Følger' : 'Følg'}
                  </button>
                  <FoelgTooltip lang="da" visible={visFoelgTooltip} />
                </div>
              </div>
            </div>

            <div className="mb-3">
              <h1 className="text-white text-xl font-bold">{adresseStreng}</h1>
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <span className="flex items-center gap-1 px-2 py-0.5 bg-slate-800 border border-slate-700/50 rounded-full text-xs text-slate-300">
                  <MapPin size={11} />
                  {(dawaAdresse.kommunenavn || null) ?? dawaJordstykke?.kommune.navn ?? '–'}
                </span>
                {dawaJordstykke && (
                  <span className="flex items-center gap-1 px-2 py-0.5 bg-slate-800 border border-slate-700/50 rounded-full text-xs text-slate-300">
                    <Building2 size={11} /> {dawaJordstykke.matrikelnr},{' '}
                    {dawaJordstykke.ejerlav.navn}
                  </span>
                )}
                {(dawaAdresse.zone === 'Byzone' ||
                  dawaAdresse.zone === 'Landzone' ||
                  dawaAdresse.zone === 'Sommerhuszone') && (
                  <span
                    className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border ${
                      dawaAdresse.zone === 'Byzone'
                        ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                        : dawaAdresse.zone === 'Landzone'
                          ? 'bg-amber-500/10 border-amber-500/20 text-amber-400'
                          : 'bg-orange-500/10 border-orange-500/20 text-orange-400'
                    }`}
                  >
                    {dawaAdresse.zone}
                  </span>
                )}
              </div>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 -mb-px">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setAktivTab(tab.id)}
                  className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-all whitespace-nowrap ${
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

          <div className="flex-1 overflow-y-auto px-6 py-5">
            {/* ══ OVERBLIK ══ */}
            {aktivTab === 'overblik' && (
              <div className="space-y-2">
                {/* 2-spalte layout: ejendomsdata (venstre) + økonomi (højre) */}
                <div className="grid grid-cols-2 gap-2">
                  {/* ─── Rad 1: Matrikel (v) + Ejendomsvurdering (h)
                       CSS grid sikrer automatisk ens højde på disse to bokse ─── */}

                  {/* Matrikel */}
                  {(() => {
                    // Grundareal: brug DAWA jordstykke → VUR vurderet areal som fallback
                    const grundareal =
                      (dawaJordstykke?.areal_m2 || null) ?? vurdering?.vurderetAreal ?? null;
                    const bygAreal =
                      bbrData?.bbr?.reduce((s, b) => s + (b.bebyggetAreal ?? 0), 0) ?? 0;
                    // Bebyggelsesprocent: fra VUR hvis tilgængeligt, ellers beregnet
                    const bebyggPct =
                      vurdering?.bebyggelsesprocent != null
                        ? vurdering.bebyggelsesprocent
                        : grundareal && bygAreal
                          ? Math.round((bygAreal / grundareal) * 100)
                          : null;
                    // Kommunenavn: DAWA → jordstykke som fallback
                    const kommunenavn =
                      (dawaAdresse.kommunenavn || null) ?? dawaJordstykke?.kommune.navn ?? null;
                    return (
                      <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-2.5">
                        <div className="flex items-baseline justify-between mb-1.5">
                          <div className="flex items-baseline gap-1">
                            <span className="text-white font-bold text-lg">1</span>
                            <span className="text-slate-400 text-xs">matrikel</span>
                          </div>
                          {bebyggPct !== null && (
                            <span className="text-slate-400 text-xs font-medium">
                              {bebyggPct}% bebygget
                            </span>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                          <div>
                            <p className="text-slate-500 text-xs leading-none mb-0.5">Grundareal</p>
                            <p className="text-white text-sm font-medium">
                              {grundareal ? `${grundareal.toLocaleString('da-DK')} m²` : '–'}
                            </p>
                          </div>
                          <div>
                            <p className="text-slate-500 text-xs leading-none mb-0.5">
                              Matrikelnr.
                            </p>
                            <p className="text-white text-sm font-medium">
                              {dawaJordstykke?.matrikelnr ?? dawaAdresse.matrikelnr ?? '–'}
                            </p>
                          </div>
                          <div>
                            <p className="text-slate-500 text-xs leading-none mb-0.5">Ejerlav</p>
                            <p className="text-white text-sm truncate">
                              {dawaJordstykke?.ejerlav.navn ?? '–'}
                            </p>
                          </div>
                          <div>
                            <p className="text-slate-500 text-xs leading-none mb-0.5">Kommune</p>
                            <p className="text-white text-sm">{kommunenavn ?? '–'}</p>
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  {/* Ejendomsvurdering */}
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-2.5">
                    <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-1.5 flex items-center gap-2">
                      <span>Ejendomsvurdering</span>
                      {vurdering?.erNytSystem && (
                        <span className="px-1.5 py-0.5 bg-blue-500/10 border border-blue-500/20 rounded text-[10px] text-blue-400 font-medium normal-case tracking-normal">
                          NY
                        </span>
                      )}
                    </p>
                    {vurderingLoader ? (
                      <div className="flex items-center gap-2 text-slate-500 text-xs">
                        <div className="w-3 h-3 border border-slate-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                        Henter vurdering…
                      </div>
                    ) : vurdering ? (
                      <div className="space-y-2">
                        {/* Ejendomsværdi + Grundværdi side om side */}
                        <div className="grid grid-cols-2 gap-x-3">
                          <div>
                            <p className="text-slate-500 text-xs leading-none mb-0.5">
                              Ejendomsværdi
                              {vurdering.aar && (
                                <span className="ml-1 text-slate-600">({vurdering.aar})</span>
                              )}
                            </p>
                            <p className="text-white text-base font-bold">
                              {vurdering.ejendomsvaerdi
                                ? formatDKK(vurdering.ejendomsvaerdi)
                                : 'Fastsættes ikke'}
                            </p>
                            {vurdering.afgiftspligtigEjendomsvaerdi !== null &&
                              vurdering.afgiftspligtigEjendomsvaerdi !==
                                vurdering.ejendomsvaerdi && (
                                <p className="text-slate-500 text-xs mt-0.5">
                                  Afgiftspligtig:{' '}
                                  {formatDKK(vurdering.afgiftspligtigEjendomsvaerdi)}
                                </p>
                              )}
                          </div>
                          <div>
                            <p className="text-slate-500 text-xs leading-none mb-0.5">
                              Grundværdi
                              {vurdering.aar && (
                                <span className="ml-1 text-slate-600">({vurdering.aar})</span>
                              )}
                            </p>
                            <p className="text-white text-sm font-medium">
                              {vurdering.grundvaerdi ? formatDKK(vurdering.grundvaerdi) : '–'}
                            </p>
                            {vurdering.afgiftspligtigGrundvaerdi !== null &&
                              vurdering.afgiftspligtigGrundvaerdi !== vurdering.grundvaerdi && (
                                <p className="text-slate-500 text-xs mt-0.5">
                                  Afgiftspligtig: {formatDKK(vurdering.afgiftspligtigGrundvaerdi)}
                                </p>
                              )}
                          </div>
                        </div>
                        {/* Vurderet areal + Grundskyld side om side */}
                        <div className="grid grid-cols-2 gap-x-3 pt-1.5 border-t border-slate-700/30">
                          <div>
                            <p className="text-slate-500 text-xs leading-none mb-0.5">
                              Vurderet areal
                            </p>
                            <p className="text-white text-sm font-medium">
                              {vurdering.vurderetAreal
                                ? `${vurdering.vurderetAreal.toLocaleString('da-DK')} m²`
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
                                    Grundskyld
                                    <span className="text-slate-600 ml-1">
                                      ({nyesteFrl!.vurderingsaar})
                                    </span>
                                  </p>
                                  <p className="text-white text-sm font-medium flex items-center gap-1">
                                    {formatDKK(faktiskGrundskyld)}
                                    <span className="text-slate-500 text-xs">/ år</span>
                                  </p>
                                </div>
                              );
                            }
                            if (vurdering.estimereretGrundskyld !== null) {
                              return (
                                <div>
                                  <p className="text-slate-500 text-xs leading-none mb-0.5">
                                    Est. grundskyld
                                    {vurdering.grundskyldspromille !== null && (
                                      <span className="text-slate-600 ml-1">
                                        ({vurdering.grundskyldspromille}‰)
                                      </span>
                                    )}
                                  </p>
                                  <p className="text-white text-sm font-medium">
                                    {formatDKK(vurdering.estimereretGrundskyld)}
                                    <span className="text-slate-500 text-xs ml-1">/ år</span>
                                  </p>
                                </div>
                              );
                            }
                            return null;
                          })()}
                        </div>
                      </div>
                    ) : (
                      <p className="text-slate-500 text-xs">
                        {bbrLoader || !bbrData
                          ? 'Afventer BBR-data…'
                          : !bbrData.ejendomsrelationer?.[0]?.bfeNummer
                            ? 'BFEnummer ikke fundet'
                            : 'Ingen vurderingsdata'}
                      </p>
                    )}

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
                              FORELØBIG
                            </span>
                          </div>
                          <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                            <div>
                              <p className="text-slate-500 text-xs leading-none mb-0.5">
                                Ejendomsværdi
                                <span className="ml-1 text-slate-600">
                                  ({nyesteForelobig.vurderingsaar})
                                </span>
                              </p>
                              <p className="text-amber-200 text-sm font-medium">
                                {nyesteForelobig.ejendomsvaerdi
                                  ? formatDKK(nyesteForelobig.ejendomsvaerdi)
                                  : 'Fastsættes ikke'}
                              </p>
                            </div>
                            <div>
                              <p className="text-slate-500 text-xs leading-none mb-0.5">
                                Grundværdi
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

                  {/* Bygninger — ekskluder nedrevne/historiske */}
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
                          <span className="text-slate-400 text-xs">bygninger</span>
                        </div>
                        <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                          <div>
                            <p className="text-slate-500 text-xs leading-none mb-0.5">
                              Bygningsareal
                            </p>
                            <p className="text-white text-sm font-medium">
                              {totAreal ? `${totAreal.toLocaleString('da-DK')} m²` : '–'}
                            </p>
                          </div>
                          <div>
                            <p className="text-slate-500 text-xs leading-none mb-0.5">
                              Beboelsesareal
                            </p>
                            <p className="text-white text-sm font-medium">
                              {boligAreal ? `${boligAreal.toLocaleString('da-DK')} m²` : '0 m²'}
                            </p>
                          </div>
                          <div>
                            <p className="text-slate-500 text-xs leading-none mb-0.5">
                              Erhvervsareal
                            </p>
                            <p className="text-white text-sm font-medium">
                              {erhvAreal ? `${erhvAreal.toLocaleString('da-DK')} m²` : '–'}
                            </p>
                          </div>
                          <div>
                            <p className="text-slate-500 text-xs leading-none mb-0.5">Kælder</p>
                            <p className="text-white text-sm font-medium">
                              {kaelder ? `${kaelder.toLocaleString('da-DK')} m²` : '0 m²'}
                            </p>
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  {/* Enheder */}
                  {(() => {
                    const enheder = bbrData?.enheder ?? [];
                    const boligEnh = enheder.filter((e) => (e.arealBolig ?? 0) > 0).length;
                    const erhvEnh = enheder.filter((e) => (e.arealErhverv ?? 0) > 0).length;
                    const totAreal = enheder.reduce((s, e) => s + (e.areal ?? 0), 0);
                    return (
                      <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-2.5 self-start">
                        <div className="flex items-baseline gap-1 mb-1.5">
                          <span className="text-white font-bold text-lg">
                            {bbrLoader ? '…' : enheder.length || '–'}
                          </span>
                          <span className="text-slate-400 text-xs">enheder</span>
                        </div>
                        <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                          <div>
                            <p className="text-slate-500 text-xs leading-none mb-0.5">
                              Beboelsesenheder
                            </p>
                            <p className="text-white text-sm font-medium">{boligEnh}</p>
                          </div>
                          <div>
                            <p className="text-slate-500 text-xs leading-none mb-0.5">
                              Erhvervsenheder
                            </p>
                            <p className="text-white text-sm font-medium">{erhvEnh}</p>
                          </div>
                          <div className="col-span-2">
                            <p className="text-slate-500 text-xs leading-none mb-0.5">
                              Samlet enhedsareal
                            </p>
                            <p className="text-white text-sm font-medium">
                              {totAreal ? `${totAreal.toLocaleString('da-DK')} m²` : '–'}
                            </p>
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </div>

                {/* Virksomheder på adressen — CVR OpenData */}
                {cvrTokenMangler ? (
                  <div className="bg-amber-500/8 border border-amber-500/20 rounded-xl p-4">
                    <p className="text-amber-300 text-xs font-medium uppercase tracking-wide mb-2">
                      Virksomheder på adressen
                    </p>
                    <p className="text-slate-400 text-sm mb-3">
                      CVR-opslag kræver gratis adgang til Erhvervsstyrelsens CVR OpenData.
                    </p>
                    <ol className="text-slate-400 text-xs space-y-1 list-decimal list-inside leading-relaxed">
                      <li>
                        Gå til{' '}
                        <span className="text-blue-400 font-medium">
                          datacvr.virk.dk/data/login
                        </span>{' '}
                        → opret gratis bruger
                      </li>
                      <li>
                        Tilføj til <code className="bg-slate-800 px-1 rounded">.env.local</code>:
                      </li>
                    </ol>
                    <code className="block bg-slate-900 rounded-lg px-3 py-2 mt-2 text-xs text-emerald-400 font-mono">
                      CVR_ES_USER=din@email.dk{'\n'}CVR_ES_PASS=dit_password
                    </code>
                    <p className="text-slate-500 text-xs mt-2">Genstart dev-serveren bagefter.</p>
                  </div>
                ) : cvrVirksomheder === null ? (
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                    <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-2">
                      Virksomheder på adressen
                    </p>
                    <div className="flex items-center gap-2 text-slate-500 text-sm">
                      <div className="w-3.5 h-3.5 border border-slate-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                      Henter CVR-data…
                    </div>
                  </div>
                ) : cvrVirksomheder.length > 0 ? (
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                    <div className="px-4 py-3 border-b border-slate-700/40 flex items-center justify-between">
                      <p className="text-slate-200 text-sm font-semibold">
                        Virksomheder på adressen
                      </p>
                      <span className="text-slate-500 text-xs">
                        {cvrVirksomheder.filter((v) => v.aktiv).length} aktive
                        {cvrVirksomheder.some((v) => !v.aktiv) &&
                          ` · ${cvrVirksomheder.filter((v) => !v.aktiv).length} ophørte`}
                      </span>
                    </div>
                    {/* Tabelheader */}
                    <div className="grid grid-cols-[1fr_1fr_120px_72px] px-4 py-2 text-slate-500 text-xs font-medium border-b border-slate-700/30">
                      <span>Virksomhed</span>
                      <span>Industri</span>
                      <span className="text-right">Periode</span>
                      <span className="text-right">Ansatte</span>
                    </div>
                    <div className="divide-y divide-slate-700/20">
                      {cvrVirksomheder.map((v) => {
                        // Beregn relativ tid fra aktivFra
                        const periode = (() => {
                          if (!v.aktivFra) return '–';
                          const fra = new Date(v.aktivFra);
                          const nu = new Date();
                          const mdr =
                            (nu.getFullYear() - fra.getFullYear()) * 12 +
                            (nu.getMonth() - fra.getMonth());
                          if (mdr < 1) return 'Under 1 md.';
                          if (mdr < 12) return `${mdr} md. til nu`;
                          return `${Math.floor(mdr / 12)} år til nu`;
                        })();
                        return (
                          <div
                            key={v.cvr}
                            className={`grid grid-cols-[1fr_1fr_120px_72px] px-4 py-3 items-center gap-2 hover:bg-slate-700/10 transition-colors ${!v.aktiv ? 'opacity-50' : ''}`}
                          >
                            {/* Virksomhed */}
                            <div className="min-w-0 flex items-center gap-2">
                              <div
                                className={`w-2 h-2 rounded-full flex-shrink-0 ${v.aktiv ? 'bg-emerald-400' : 'bg-slate-500'}`}
                              />
                              <div className="min-w-0">
                                <Link
                                  href={`/dashboard/companies/${v.cvr}`}
                                  className="text-slate-200 text-sm font-medium hover:text-blue-400 transition-colors truncate block"
                                >
                                  {v.navn}
                                </Link>
                                <p className="text-slate-500 text-xs truncate">{v.adresse}</p>
                              </div>
                            </div>
                            {/* Industri */}
                            <span className="text-slate-400 text-xs truncate pr-2">
                              {v.branche ?? '–'}
                            </span>
                            {/* Periode */}
                            <span className="text-slate-400 text-xs text-right">{periode}</span>
                            {/* Ansatte */}
                            <span className="text-slate-300 text-sm text-right font-medium">
                              {v.ansatte ?? '–'}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                    <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-1">
                      Virksomheder på adressen
                    </p>
                    <p className="text-slate-500 text-sm">
                      Ingen CVR-registrerede virksomheder fundet på denne adresse.
                    </p>
                  </div>
                )}

                {/* BBR-fejlbesked */}
                {bbrData?.bbrFejl && (
                  <div className="bg-orange-500/8 border border-orange-500/20 rounded-xl p-4 flex items-start gap-3">
                    <div className="w-5 h-5 rounded-full bg-orange-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <span className="text-orange-400 text-xs">!</span>
                    </div>
                    <div>
                      <p className="text-orange-300 text-sm font-medium">BBR-data utilgængeligt</p>
                      <p className="text-slate-400 text-xs mt-1">{bbrData.bbrFejl}</p>
                      <a
                        href="https://datafordeler.dk"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 text-xs hover:text-blue-300 mt-1 inline-block"
                      >
                        Åbn datafordeler.dk →
                      </a>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ══ BBR ══ — Live data, collapsible rækker */}
            {aktivTab === 'bbr' && (
              <div className="space-y-3">
                {bbrData?.bbrFejl && (
                  <div className="p-3 bg-orange-500/10 border border-orange-500/20 rounded-lg">
                    <p className="text-orange-300 text-sm">BBR: {bbrData.bbrFejl}</p>
                  </div>
                )}

                {/* Information */}
                <div>
                  <SectionTitle title="Information" />
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
                                {grundareal.toLocaleString('da-DK')} m²
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
                  return (
                    <div>
                      <SectionTitle title="Bygninger" />
                      <div className="grid grid-cols-4 gap-2 mb-2">
                        <DataKort
                          label="Bygninger"
                          value={bbrLoader ? '…' : `${bygninger.length}`}
                        />
                        <DataKort
                          label="Bygningsareal"
                          value={totAreal ? `${totAreal.toLocaleString('da-DK')} m²` : '–'}
                        />
                        <DataKort
                          label="Beboelsesareal"
                          value={boligAreal ? `${boligAreal.toLocaleString('da-DK')} m²` : '0 m²'}
                        />
                        <DataKort
                          label="Erhvervsareal"
                          value={erhvAreal ? `${erhvAreal.toLocaleString('da-DK')} m²` : '–'}
                        />
                      </div>
                      {bbrLoader ? (
                        <div className="text-slate-500 text-sm text-center py-3">
                          Henter bygningsdata…
                        </div>
                      ) : bygninger.length === 0 ? (
                        <div className="text-slate-500 text-sm text-center py-3">
                          Ingen aktive bygninger tilgængeligt
                        </div>
                      ) : (
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                          {/* Kolonneheader: ▶ | Byg# | Anvendelse | Opf.år | Bebygget | Samlet | Geo | Status */}
                          <div className="grid grid-cols-[28px_40px_1fr_68px_96px_96px_52px_90px] px-3 py-2 text-slate-500 text-xs font-medium border-b border-slate-700/30">
                            <span />
                            <span className="text-center">Nr.</span>
                            <span>Anvendelse</span>
                            <span className="text-right">Opf. år</span>
                            <span className="text-right">Bebygget</span>
                            <span className="text-right">Samlet</span>
                            <span className="text-center">Geodata</span>
                            <span className="text-center">Status</span>
                          </div>
                          {bygninger.map((b, i) => {
                            const rowId = b.id || String(i);
                            const aaben = expandedBygninger.has(rowId);
                            const detaljer: [string, string][] = (
                              [
                                ['Ydervæg', b.ydervaeg || null],
                                ['Tagmateriale', b.tagmateriale || null],
                                ['Varmeinstallation', b.varmeinstallation || null],
                                ['Opvarmningsform', b.opvarmningsform || null],
                                ['Vandforsyning', b.vandforsyning || null],
                                ['Afløb', b.afloeb || null],
                                ['Etager', b.antalEtager != null ? `${b.antalEtager}` : null],
                                [
                                  'Boligareal',
                                  b.samletBoligareal
                                    ? `${b.samletBoligareal.toLocaleString('da-DK')} m²`
                                    : null,
                                ],
                                [
                                  'Erhvervsareal',
                                  b.samletErhvervsareal
                                    ? `${b.samletErhvervsareal.toLocaleString('da-DK')} m²`
                                    : null,
                                ],
                                [
                                  'Ombygningsår',
                                  b.ombygningsaar != null ? `${b.ombygningsaar}` : null,
                                ],
                                ['Fredning', b.fredning || null],
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
                                      aaben ? next.delete(rowId) : next.add(rowId);
                                      return next;
                                    })
                                  }
                                  className="w-full grid grid-cols-[28px_40px_1fr_68px_96px_96px_52px_90px] px-3 py-1.5 text-sm hover:bg-slate-700/20 transition-colors text-left items-center"
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
                                  <span className="text-slate-200 truncate pr-2">
                                    {b.anvendelse || '–'}
                                  </span>
                                  <span className="text-slate-400 text-right">
                                    {b.opfoerelsesaar ?? '–'}
                                  </span>
                                  <span className="text-slate-300 text-right">
                                    {b.bebyggetAreal
                                      ? `${b.bebyggetAreal.toLocaleString('da-DK')} m²`
                                      : '–'}
                                  </span>
                                  <span className="text-slate-300 text-right">
                                    {b.samletBygningsareal
                                      ? `${b.samletBygningsareal.toLocaleString('da-DK')} m²`
                                      : '–'}
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
                                      <span className="text-emerald-400 text-xs">Opført</span>
                                    ) : b.status === 'Projekteret bygning' ? (
                                      <span className="text-amber-400 text-xs">Projekteret</span>
                                    ) : b.status === 'Bygning under opførelse' ? (
                                      <span className="text-amber-400 text-xs">
                                        Under opførelse
                                      </span>
                                    ) : b.status === 'Midlertidig opførelse' ? (
                                      <span className="text-amber-400 text-xs">Midlertidig</span>
                                    ) : b.status === 'Kondemneret' ? (
                                      <span className="text-red-400 text-xs">Kondemneret</span>
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
                      <SectionTitle title="Enheder" />
                      <div className="grid grid-cols-4 gap-2 mb-2">
                        <DataKort
                          label="Enheder i alt"
                          value={bbrLoader ? '…' : `${enheder.length}`}
                        />
                        <DataKort label="Beboelsesenheder" value={`${boligEnh}`} />
                        <DataKort label="Erhvervsenheder" value={`${erhvEnh}`} />
                        <DataKort
                          label="Samlet areal"
                          value={totAreal ? `${totAreal.toLocaleString('da-DK')} m²` : '–'}
                        />
                      </div>
                      {bbrLoader ? (
                        <div className="text-slate-500 text-sm text-center py-3">
                          Henter enhedsdata…
                        </div>
                      ) : enheder.length === 0 ? (
                        <div className="text-slate-500 text-sm text-center py-3">
                          Ingen enheder tilgængeligt
                        </div>
                      ) : (
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                          {/* Kolonneheader: ▶ | Byg.nr | Anvendelse | Areal | Værelser */}
                          <div className="grid grid-cols-[28px_44px_1fr_96px_72px] px-3 py-2 text-slate-500 text-xs font-medium border-b border-slate-700/30">
                            <span />
                            <span className="text-center">Byg.</span>
                            <span>Anvendelse</span>
                            <span className="text-right">Areal</span>
                            <span className="text-right">Værelser</span>
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
                                ['Adresse', e.adressebetegnelse || null],
                                ['Etage', e.etage || null],
                                ['Dør', e.doer || null],
                                ['Status', e.status || null],
                                [
                                  'Boligareal',
                                  e.arealBolig
                                    ? `${e.arealBolig.toLocaleString('da-DK')} m²`
                                    : null,
                                ],
                                [
                                  'Erhvervsareal',
                                  e.arealErhverv
                                    ? `${e.arealErhverv.toLocaleString('da-DK')} m²`
                                    : null,
                                ],
                                [
                                  'Varmeinstallation',
                                  e.varmeinstallation !== '–' ? e.varmeinstallation : null,
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
                                    setExpandedEnheder((prev) => {
                                      const next = new Set(prev);
                                      aaben ? next.delete(rowId) : next.add(rowId);
                                      return next;
                                    })
                                  }
                                  className="w-full grid grid-cols-[28px_44px_1fr_96px_72px] px-3 py-1.5 text-sm hover:bg-slate-700/20 transition-colors text-left items-center"
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
                                    {e.areal ? `${e.areal.toLocaleString('da-DK')} m²` : '–'}
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
                      BBR-data ikke tilgængeligt
                    </p>
                    <p className="text-slate-400 text-xs leading-relaxed">
                      {bbrData?.bbrFejl ??
                        'BBR-data kræver et aktivt abonnement på BBRPublic-tjenesten på datafordeler.dk.'}
                    </p>
                  </div>
                )}

                {/* ── Matrikeloplysninger (Datafordeler MAT) ── */}
                <div className="mt-5">
                  <SectionTitle title="Matrikeloplysninger" />
                  {matrikelLoader ? (
                    <div className="flex items-center gap-2 text-slate-500 text-sm py-4">
                      <div className="w-4 h-4 border-2 border-slate-600 border-t-blue-500 rounded-full animate-spin" />
                      Henter matrikeldata…
                    </div>
                  ) : matrikelData ? (
                    <div className="space-y-3">
                      {/* Ejendomsinfo */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        {matrikelData.landbrugsnotering && (
                          <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3">
                            <p className="text-slate-400 text-xs mb-0.5">Landbrugsnotering</p>
                            <p className="text-white text-sm font-medium">
                              {matrikelData.landbrugsnotering}
                            </p>
                          </div>
                        )}
                        {matrikelData.opdeltIEjerlejligheder && (
                          <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3">
                            <p className="text-slate-400 text-xs mb-0.5">Ejerlejligheder</p>
                            <p className="text-white text-sm font-medium">
                              Opdelt i ejerlejligheder
                            </p>
                          </div>
                        )}
                        {matrikelData.erFaelleslod && (
                          <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3">
                            <p className="text-slate-400 text-xs mb-0.5">Fælleslod</p>
                            <p className="text-white text-sm font-medium">Ja</p>
                          </div>
                        )}
                        {matrikelData.udskiltVej && (
                          <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3">
                            <p className="text-slate-400 text-xs mb-0.5">Udskilt vej</p>
                            <p className="text-white text-sm font-medium">Ja</p>
                          </div>
                        )}
                      </div>

                      {/* Jordstykker tabel */}
                      {matrikelData.jordstykker.length > 0 && (
                        <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-hidden">
                          <div className="px-4 py-2.5 border-b border-slate-700/30">
                            <p className="text-slate-300 text-xs font-semibold uppercase tracking-wider">
                              Jordstykker ({matrikelData.jordstykker.length})
                            </p>
                          </div>
                          <div className="divide-y divide-slate-700/20">
                            {matrikelData.jordstykker.map((js) => (
                              <div
                                key={js.id}
                                className="px-4 py-2.5 grid grid-cols-[1fr_100px_80px_auto] gap-3 items-center"
                              >
                                <div>
                                  <p className="text-white text-sm font-medium">
                                    Matr.nr. {js.matrikelnummer}
                                    {js.ejerlavskode && (
                                      <span className="text-slate-500 text-xs ml-2">
                                        Ejerlav {js.ejerlavskode}
                                      </span>
                                    )}
                                  </p>
                                  {js.ejerlavsnavn && (
                                    <p className="text-slate-500 text-xs">{js.ejerlavsnavn}</p>
                                  )}
                                </div>
                                <p className="text-slate-300 text-sm tabular-nums text-right">
                                  {js.registreretAreal != null
                                    ? `${js.registreretAreal.toLocaleString('da-DK')} m²`
                                    : '–'}
                                </p>
                                <p className="text-slate-500 text-xs text-right">
                                  {js.vejareal != null && js.vejareal > 0
                                    ? `Vej: ${js.vejareal.toLocaleString('da-DK')} m²`
                                    : ''}
                                </p>
                                <div className="flex gap-1.5 flex-wrap justify-end">
                                  {js.fredskov === true && (
                                    <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-green-900/50 text-green-400 border border-green-800/40">
                                      Fredskov
                                    </span>
                                  )}
                                  {js.strandbeskyttelse === true && (
                                    <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-blue-900/50 text-blue-400 border border-blue-800/40">
                                      Strandbeskyttelse
                                    </span>
                                  )}
                                  {js.klitfredning === true && (
                                    <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-amber-900/50 text-amber-400 border border-amber-800/40">
                                      Klitfredning
                                    </span>
                                  )}
                                  {js.jordrente === true && (
                                    <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-purple-900/50 text-purple-400 border border-purple-800/40">
                                      Jordrente
                                    </span>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="bg-slate-800/30 border border-slate-700/40 rounded-xl p-4 text-center">
                      <p className="text-slate-500 text-xs">Ingen matrikeldata fundet</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ══ EJERFORHOLD ══ */}
            {aktivTab === 'ejerforhold' && (
              <div className="space-y-4">
                {/* ── Ejere fra Ejerfortegnelsen ── */}
                <div>
                  <p className="text-slate-400 text-xs font-medium uppercase tracking-wider mb-3">
                    Ejerfortegnelsen · Datafordeler
                  </p>
                  {ejereLoader ? (
                    <div className="flex items-center gap-2 text-slate-500 text-sm">
                      <div className="w-4 h-4 border-2 border-slate-600 border-t-blue-500 rounded-full animate-spin" />
                      Henter ejerdata…
                    </div>
                  ) : !bbrData?.ejendomsrelationer?.[0]?.bfeNummer ? (
                    <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4 space-y-3">
                      <div className="flex items-center gap-2">
                        <div className="w-5 h-5 rounded-full bg-amber-500/20 flex items-center justify-center flex-shrink-0">
                          <span className="text-amber-400 text-xs font-bold">!</span>
                        </div>
                        <p className="text-amber-300 text-sm font-medium">
                          BFEnummer ikke tilgængeligt
                        </p>
                      </div>
                      <p className="text-slate-400 text-xs leading-relaxed">
                        {!bbrData
                          ? 'BBR-data mangler — DATAFORDELER_API_KEY er sandsynligvis ikke sat i .env.local'
                          : bbrData.ejendomsrelationer === null
                            ? 'BBR Ejendomsrelation-forespørgslen fejlede — tjenesten er muligvis ikke aktiveret'
                            : 'Ingen Ejendomsrelation fundet for denne adresse'}
                      </p>
                      <div className="space-y-1.5 text-xs text-slate-400">
                        <p className="font-medium text-slate-300">
                          Tjek disse 3 punkter på datafordeler.dk:
                        </p>
                        <div className="flex items-center gap-2">
                          <span
                            className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] flex-shrink-0 ${bbrData?.bbr ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-700 text-slate-500'}`}
                          >
                            {bbrData?.bbr ? '✓' : '○'}
                          </span>
                          <span className={bbrData?.bbr ? 'text-emerald-400' : ''}>
                            BBRPublic — aktiveret i Datafordeler bruger
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="w-4 h-4 rounded-full bg-slate-700 text-slate-500 flex items-center justify-center text-[10px] flex-shrink-0">
                            ○
                          </span>
                          <span>EjendomBeliggenhedsadresse — aktiveret under Ejerfortegnelsen</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="w-4 h-4 rounded-full bg-slate-700 text-slate-500 flex items-center justify-center text-[10px] flex-shrink-0">
                            ○
                          </span>
                          <span>Ejendomsvurdering — aktiveret under HentEjendomsvurdering</span>
                        </div>
                      </div>
                      <a
                        href="https://datafordeler.dk/dataoversigt/ejendomme/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-blue-400 text-xs hover:text-blue-300 transition-colors"
                      >
                        Gå til datafordeler.dk → Ejendomme →
                      </a>
                    </div>
                  ) : manglerEjereAdgang ? (
                    <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4 space-y-2">
                      <div className="flex items-center gap-2">
                        <div className="w-5 h-5 rounded-full bg-amber-500/20 flex items-center justify-center flex-shrink-0">
                          <span className="text-amber-400 text-xs font-bold">!</span>
                        </div>
                        <p className="text-amber-300 text-sm font-medium">
                          Dataadgang mangler — Ejerfortegnelsen (EJF)
                        </p>
                      </div>
                      <p className="text-slate-400 text-xs leading-relaxed">
                        OAuth-token er gyldigt, men adgang til EJF kræver en godkendt
                        Dataadgang-ansøgning hos Geodatastyrelsen.
                      </p>
                      <a
                        href="https://datafordeler.dk/vejledning/brugeradgang/anmodning-om-adgang/ejerfortegnelsen-ejf/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-blue-400 text-xs hover:text-blue-300 transition-colors"
                      >
                        Ansøg om adgang til EJF på datafordeler.dk →
                      </a>
                    </div>
                  ) : ejere && ejere.length > 0 ? (
                    <div className="space-y-2">
                      {ejere.map((ejer, i) => {
                        /** Beregn ejerandel i procent fra brøk */
                        const ejerandelPct =
                          ejer.ejerandel_taeller != null && ejer.ejerandel_naevner
                            ? Math.round((ejer.ejerandel_taeller / ejer.ejerandel_naevner) * 100)
                            : null;
                        return (
                          <div
                            key={i}
                            className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  <span
                                    className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                                      ejer.ejertype === 'selskab'
                                        ? 'bg-blue-500/15 text-blue-400 border border-blue-500/25'
                                        : 'bg-purple-500/15 text-purple-400 border border-purple-500/25'
                                    }`}
                                  >
                                    {ejer.ejertype === 'selskab' ? 'Selskab' : 'Person'}
                                  </span>
                                </div>
                                {ejer.cvr ? (
                                  <Link
                                    href={`/dashboard/companies/${ejer.cvr}`}
                                    className="text-blue-400 hover:text-blue-300 text-xs transition-colors"
                                  >
                                    CVR {ejer.cvr} →
                                  </Link>
                                ) : (
                                  <p className="text-slate-400 text-sm">Privat person</p>
                                )}
                                {ejer.virkningFra && (
                                  <p className="text-slate-500 text-xs mt-1">
                                    Ejer siden{' '}
                                    {new Date(ejer.virkningFra).toLocaleDateString('da-DK')}
                                  </p>
                                )}
                              </div>
                              {ejerandelPct != null && (
                                <span className="text-white text-sm font-semibold flex-shrink-0">
                                  {ejerandelPct}%
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                      {bbrData?.ejendomsrelationer?.[0]?.bfeNummer && (
                        <p className="text-slate-600 text-xs text-right">
                          BFE {bbrData.ejendomsrelationer[0].bfeNummer}
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="bg-slate-800/30 border border-slate-700/40 rounded-xl p-4 text-center">
                      <Users size={24} className="text-slate-600 mx-auto mb-2" />
                      <p className="text-slate-400 text-xs">
                        Ingen ejerdata fundet via Datafordeler
                      </p>
                    </div>
                  )}
                </div>

                {/* ── Tinglysning — coming soon ── */}
                <div className="bg-slate-800/20 border border-slate-700/30 rounded-xl p-4">
                  <p className="text-slate-400 text-xs font-medium uppercase tracking-wider mb-1">
                    Tinglysning
                  </p>
                  <p className="text-slate-500 text-xs">
                    Historiske adkomster og skøder kræver adgang til Tinglysning.dk REST API
                    (backlog).
                  </p>
                </div>
              </div>
            )}

            {/* ══ TINGLYSNING ══ */}
            {aktivTab === 'tinglysning' && (
              <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl p-6 text-center">
                <Landmark size={32} className="text-slate-600 mx-auto mb-3" />
                <p className="text-slate-300 text-sm font-medium mb-1">Tinglysning</p>
                <p className="text-slate-500 text-xs leading-relaxed max-w-sm mx-auto">
                  Hæftelser, pantegæld og servitutter hentes via Tinglysning.dk. Kræver abonnement
                  på tingbogsattest-tjenesten.
                </p>
              </div>
            )}

            {/* ══ ØKONOMI ══ */}
            {aktivTab === 'oekonomi' && (
              <div className="space-y-5">
                {/* ── Ejendomsvurdering ── */}
                <div>
                  <SectionTitle title="Ejendomsvurdering" />
                  {vurderingLoader ? (
                    <div className="flex items-center gap-2 text-slate-500 text-sm py-4">
                      <div className="w-4 h-4 border-2 border-slate-600 border-t-blue-500 rounded-full animate-spin" />
                      Henter vurderingsdata…
                    </div>
                  ) : vurdering ? (
                    <>
                      {/* Aktuelle tal */}
                      <div className="grid grid-cols-3 gap-3 mb-3">
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                          <p className="text-slate-400 text-xs mb-1">
                            Ejendomsværdi
                            {vurdering.aar && (
                              <span className="ml-1 text-slate-500">({vurdering.aar})</span>
                            )}
                          </p>
                          <p className="text-white text-lg font-bold">
                            {vurdering.ejendomsvaerdi != null
                              ? formatDKK(vurdering.ejendomsvaerdi)
                              : 'Fastsættes ikke'}
                          </p>
                        </div>
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                          <p className="text-slate-400 text-xs mb-1">Grundværdi</p>
                          <p className="text-white text-lg font-bold">
                            {vurdering.grundvaerdi != null ? formatDKK(vurdering.grundvaerdi) : '–'}
                          </p>
                        </div>
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                          <p className="text-slate-400 text-xs mb-1">Grundareal</p>
                          <p className="text-white text-lg font-bold">
                            {vurdering.vurderetAreal != null
                              ? `${vurdering.vurderetAreal.toLocaleString('da-DK')} m²`
                              : '–'}
                          </p>
                        </div>
                      </div>

                      {/* Vurderingshistorik — collapsible tabel med forelobige prepended */}
                      {(alleVurderinger.length > 1 || forelobige.length > 0) && (
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                          <button
                            onClick={() => setVisVurderingHistorik((v) => !v)}
                            className="w-full flex items-center gap-2 px-4 py-3 hover:bg-slate-700/20 transition-colors"
                          >
                            <ChevronRight
                              size={14}
                              className={`text-slate-500 transition-transform flex-shrink-0 ${visVurderingHistorik ? 'rotate-90' : ''}`}
                            />
                            <span className="text-slate-300 text-sm font-medium">
                              Vurderingshistorik
                            </span>
                            {forelobige.length > 0 && (
                              <span className="px-1.5 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded text-[10px] text-amber-400 font-medium">
                                {forelobige.length} FORELOBIG{forelobige.length > 1 ? 'E' : ''}
                              </span>
                            )}
                          </button>
                          {visVurderingHistorik && (
                            <>
                              {/* Header */}
                              <div className="grid grid-cols-[140px_1fr_1fr_100px] px-4 py-2 text-slate-500 text-xs font-medium border-t border-slate-700/30 bg-slate-900/30">
                                <span>Aar</span>
                                <span>Ejendomsvaerdi</span>
                                <span>Grundvaerdi</span>
                                <span className="text-right">Grundareal</span>
                              </div>

                              {/* Forelobige vurderinger — prepended med amber badge */}
                              {forelobige.map((fv, i) => (
                                <div
                                  key={`forelobig-${fv.vurderingsaar}-${i}`}
                                  className="grid grid-cols-[140px_1fr_1fr_100px] px-4 py-2.5 text-sm border-t border-amber-500/10 bg-amber-500/[0.02] hover:bg-amber-500/5 items-center"
                                >
                                  <div className="flex items-center gap-2">
                                    <span className="text-amber-200 font-medium">
                                      {fv.vurderingsaar}
                                    </span>
                                    <span className="px-1.5 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded text-[10px] text-amber-400 font-medium">
                                      FORELOBIG
                                    </span>
                                  </div>
                                  <span className="text-amber-200/80">
                                    {fv.ejendomsvaerdi
                                      ? formatDKK(fv.ejendomsvaerdi)
                                      : 'Fastsaettes ikke'}
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
                                    className="grid grid-cols-[140px_1fr_1fr_100px] px-4 py-2.5 text-sm border-t border-slate-700/20 hover:bg-slate-700/10 items-center"
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
                                        : 'Fastsaettes ikke'}
                                    </span>
                                    <span className="text-slate-300">
                                      {v.grundvaerdi != null ? formatDKK(v.grundvaerdi) : '0 DKK'}
                                    </span>
                                    <span className="text-slate-400 text-right">
                                      {v.vurderetAreal != null
                                        ? `${v.vurderetAreal.toLocaleString('da-DK')} m²`
                                        : '–'}
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
                      <p className="text-amber-300 text-sm font-medium mb-1">
                        BFEnummer ikke tilgængeligt
                      </p>
                      <p className="text-slate-400 text-xs">
                        Ejendomsvurdering kræver BFEnummer fra BBR Ejendomsrelation.
                      </p>
                    </div>
                  ) : (
                    <div className="bg-slate-800/30 border border-slate-700/40 rounded-xl p-4 text-center">
                      <p className="text-slate-500 text-xs">Ingen vurderingsdata fundet</p>
                    </div>
                  )}
                </div>

                {/* ── Salgshistorik (EJF Datafordeler) ── */}
                <div>
                  <SectionTitle title="Salgshistorik" />
                  {salgshistorikLoader ? (
                    <div className="bg-slate-800/20 border border-slate-700/30 rounded-xl p-5 text-center">
                      <p className="text-slate-500 text-xs animate-pulse">Henter salgshistorik…</p>
                    </div>
                  ) : salgshistorikManglerAdgang ? (
                    <div className="bg-slate-800/20 border border-slate-700/30 rounded-xl p-5 text-center space-y-2">
                      <TrendingUp size={22} className="text-slate-600 mx-auto" />
                      <p className="text-slate-400 text-sm font-medium">
                        Adgang afventer godkendelse
                      </p>
                      <p className="text-slate-500 text-xs max-w-sm mx-auto leading-relaxed">
                        Salgshistorik kræver EJF-adgang fra Geodatastyrelsen via datafordeler.dk.
                      </p>
                    </div>
                  ) : salgshistorik && salgshistorik.length > 0 ? (
                    <div className="bg-slate-800/20 border border-slate-700/30 rounded-xl overflow-hidden">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-slate-700/30 text-slate-500 text-xs uppercase tracking-wider">
                            <th className="text-left px-4 py-2.5 font-medium">Dato</th>
                            <th className="text-left px-4 py-2.5 font-medium">Type</th>
                            <th className="text-right px-4 py-2.5 font-medium">Købesum</th>
                            <th className="text-right px-4 py-2.5 font-medium">Kontant</th>
                          </tr>
                        </thead>
                        <tbody>
                          {salgshistorik.map((h, i) => {
                            const dato = h.koebsaftaleDato ?? h.overtagelsesdato;
                            return (
                              <tr
                                key={i}
                                className="border-b border-slate-700/20 last:border-0 hover:bg-white/[0.02] transition-colors"
                              >
                                <td className="px-4 py-2.5 text-slate-300 tabular-nums">
                                  {dato
                                    ? new Date(dato).toLocaleDateString('da-DK', {
                                        year: 'numeric',
                                        month: 'short',
                                        day: 'numeric',
                                      })
                                    : '—'}
                                </td>
                                <td className="px-4 py-2.5">
                                  <span
                                    className={`text-xs px-2 py-0.5 rounded-full ${
                                      h.overdragelsesmaade?.toLowerCase().includes('frit')
                                        ? 'text-emerald-400 bg-emerald-500/10 border border-emerald-500/20'
                                        : h.overdragelsesmaade?.toLowerCase().includes('tvang')
                                          ? 'text-red-400 bg-red-500/10 border border-red-500/20'
                                          : 'text-slate-400 bg-slate-500/10 border border-slate-500/20'
                                    }`}
                                  >
                                    {h.overdragelsesmaade ?? '—'}
                                  </span>
                                </td>
                                <td className="px-4 py-2.5 text-right text-white font-medium tabular-nums">
                                  {h.samletKoebesum != null
                                    ? `${h.samletKoebesum.toLocaleString('da-DK')} kr.`
                                    : '—'}
                                </td>
                                <td className="px-4 py-2.5 text-right text-slate-400 tabular-nums">
                                  {h.kontantKoebesum != null
                                    ? `${h.kontantKoebesum.toLocaleString('da-DK')} kr.`
                                    : '—'}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="bg-slate-800/20 border border-slate-700/30 rounded-xl p-5 text-center">
                      <p className="text-slate-500 text-xs">
                        Ingen handler registreret for denne ejendom
                      </p>
                    </div>
                  )}
                </div>

                {/* ── Udbudshistorik — coming soon ── */}
                <div>
                  <SectionTitle title="Udbudshistorik" />
                  <div className="bg-slate-800/20 border border-slate-700/30 rounded-xl p-5 text-center space-y-2">
                    <List size={22} className="text-slate-600 mx-auto" />
                    <p className="text-slate-400 text-sm font-medium">Udbudspriser og status</p>
                    <p className="text-slate-500 text-xs max-w-sm mx-auto leading-relaxed">
                      Udbudshistorik med prisændringer og handelstyper kræver
                      markedsdata-integration (backlog).
                    </p>
                  </div>
                </div>

                {/* ── Lignende handler — coming soon ── */}
                <div>
                  <SectionTitle title="Lignende handler" />
                  <div className="bg-slate-800/20 border border-slate-700/30 rounded-xl p-5 text-center space-y-2">
                    <MapPin size={22} className="text-slate-600 mx-auto" />
                    <p className="text-slate-400 text-sm font-medium">
                      Sammenlignelige handler i området
                    </p>
                    <p className="text-slate-500 text-xs max-w-sm mx-auto leading-relaxed">
                      Kvadratmeterpriser og handler for lignende ejendomme kræver
                      markedsdata-integration (backlog).
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* ══ SKAT ══ */}
            {aktivTab === 'skatter' && (
              <div className="space-y-5">
                {/* ── Ejendomsskatter — baseret på foreløbige + estimerede data ── */}
                <div>
                  <SectionTitle title="Ejendomsskatter" />

                  {(() => {
                    /** Nyeste foreløbig vurdering (typisk 2024) */
                    const nyeste = forelobige.length > 0 ? forelobige[0] : null;

                    if (!nyeste && !vurdering?.estimereretGrundskyld) {
                      return (
                        <div className="bg-slate-800/20 border border-slate-700/30 rounded-xl p-5 text-center">
                          <p className="text-slate-500 text-xs">Ingen skattedata tilgængelig</p>
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
                        {/* ── Nuværende beskatning (nyeste foreløbige) ── */}
                        {nyeste && (
                          <div>
                            <p className="text-slate-300 text-sm font-semibold mb-2">
                              Nuværende beskatning ({nyeste.vurderingsaar + 1})
                            </p>
                            <div className="grid grid-cols-2 gap-3">
                              {/* Grundskyld */}
                              <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                                <p className="text-white text-lg font-bold flex items-center gap-1.5">
                                  {effektivGrundskyld > 0 ? formatDKK(effektivGrundskyld) : '–'}
                                  <span className="text-slate-500 text-xs font-normal">DKK</span>
                                </p>
                                <p className="text-slate-500 text-xs mt-0.5">
                                  Grundskyld til kommunen
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
                                  <p className="text-slate-500 text-xs mt-0.5">Ejendomsværdiskat</p>
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
                                        Kolonihavehuse ikke må bruges til helårsbeboelse og er
                                        derfor undtaget ejendomsværdiskat jf. kolonihavelovens § 2.
                                        <span className="absolute right-full top-1/2 -translate-y-1/2 border-4 border-transparent border-r-slate-700" />
                                      </span>
                                    </span>
                                  </p>
                                  <p className="text-slate-500 text-xs mt-0.5">
                                    Ejendomsværdiskat (fritaget)
                                  </p>
                                </div>
                              )}
                            </div>

                            {/* Totale skat */}
                            {(visEjendomsskat || erKolonihave) && (
                              <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 mt-3">
                                <p className="text-white text-lg font-bold">
                                  {formatDKK(effektivGrundskyld + effektivEjendomsskat)}
                                  <span className="text-slate-500 text-xs font-normal ml-1">
                                    DKK
                                  </span>
                                </p>
                                <p className="text-slate-500 text-xs mt-0.5">
                                  Totale skat{' '}
                                  {erKolonihave
                                    ? '(kun grundskyld — ejendomsværdiskat fritaget)'
                                    : '(grundskyld + ejendomsværdiskat)'}
                                </p>
                              </div>
                            )}
                          </div>
                        )}

                        {/* ── Fallback: kun estimeret grundskyld fra Datafordeler ── */}
                        {!nyeste && vurdering?.estimereretGrundskyld != null && (
                          <div className="grid grid-cols-2 gap-3">
                            <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                              <p className="text-white text-lg font-bold">
                                {formatDKK(vurdering.estimereretGrundskyld)}
                                <span className="text-slate-500 text-xs font-normal ml-1">DKK</span>
                              </p>
                              <p className="text-slate-500 text-xs mt-0.5">
                                Est. grundskyld
                                {vurdering.grundskyldspromille !== null && (
                                  <span className="text-slate-600 ml-1">
                                    ({vurdering.grundskyldspromille}‰)
                                  </span>
                                )}
                              </p>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}

            {/* ══ DOKUMENTER ══ */}
            {aktivTab === 'dokumenter' && (
              <div className="space-y-2">
                {/* ── Dokumenter (samlet kort) ── */}
                <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-hidden">
                  {/* Kort-header */}
                  <div className="px-4 py-2.5 border-b border-slate-700/30 flex items-center gap-2">
                    <FileText size={15} className="text-slate-400" />
                    <span className="text-sm font-semibold text-slate-200">Dokumenter</span>
                    {(plandataLoader || energiLoader || jordLoader) && (
                      <span className="ml-2 text-xs text-slate-500 animate-pulse">Henter…</span>
                    )}
                    {/* Download-knap — højrestillet */}
                    <button
                      onClick={handleDownloadZip}
                      disabled={valgteDoc.size === 0 || zipLoader}
                      className="ml-auto flex items-center gap-1.5 px-3 py-1 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed border border-slate-600 rounded-lg text-slate-300 text-xs font-medium transition-all"
                      title={
                        valgteDoc.size === 0
                          ? 'Vælg dokumenter med checkboks for at downloade'
                          : `Download ${valgteDoc.size} valgte som ZIP`
                      }
                    >
                      {zipLoader ? (
                        <>
                          <span className="w-3 h-3 border border-slate-400 border-t-transparent rounded-full animate-spin" />
                          Henter…
                        </>
                      ) : (
                        <>
                          <Download size={12} />
                          Download valgte ({valgteDoc.size})
                        </>
                      )}
                    </button>
                  </div>

                  {/* ── Stamdokumenter subsection ── */}
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
                        ? new Date(iso).toLocaleDateString('da-DK', {
                            day: 'numeric',
                            month: 'long',
                            year: 'numeric',
                          })
                        : null;

                    const jordDetaljer = jordItem
                      ? [
                          jordItem.pollutionStatusText && {
                            label: 'Kortlægningsstatus',
                            value: `${jordItem.pollutionStatusCodeValue} — ${jordItem.pollutionStatusText}`,
                          },
                          jordItem.pollutionNuanceStatus.length > 0 && {
                            label: 'Nuancering',
                            value: jordItem.pollutionNuanceStatus.join(', '),
                          },
                          jordItem.locationReferences.length > 0 && {
                            label: 'Lokationsreference',
                            value: jordItem.locationReferences.join(', '),
                          },
                          jordItem.locationNames.length > 0 && {
                            label: 'Lokation',
                            value: jordItem.locationNames[0],
                          },
                          jordItem.locationNames.length > 1 && {
                            label: 'Øvrige lokationer',
                            value: jordItem.locationNames.slice(1).join(' · '),
                          },
                          formatDato(jordItem.recalculationDate) && {
                            label: 'Genvurderingsdato',
                            value: formatDato(jordItem.recalculationDate)!,
                          },
                          formatDato(jordItem.modifiedDate) && {
                            label: 'Senest ændret',
                            value: formatDato(jordItem.modifiedDate)!,
                          },
                          {
                            label: 'Matrikel',
                            value: `${jordItem.landParcelIdentifier} (ejerlav ${jordItem.cadastralDistrictIdentifier})`,
                          },
                          jordItem.regionNavn && { label: 'Region', value: jordItem.regionNavn },
                          jordItem.municipalityCode && {
                            label: 'Kommunekode',
                            value: String(jordItem.municipalityCode),
                          },
                          jordItem.housingStatementIndicator && {
                            label: 'Boligudtalelse',
                            value: 'Ja',
                          },
                        ].filter((r): r is { label: string; value: string } => Boolean(r))
                      : [];

                    const jordErUdvidet = jordItem ? expandedJord.has(jordItem.id) : false;

                    return (
                      <div className="border-b border-slate-700/30">
                        {/* Kolonneheader — identisk med plan-tabellen */}
                        <div className="grid grid-cols-[28px_72px_1fr_120px_80px] gap-x-3 px-4 py-1.5 border-b border-slate-700/20">
                          <span />
                          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                            År
                          </span>
                          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                            Dokument
                          </span>
                          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                            Status
                          </span>
                          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                            Dok.
                          </span>
                        </div>

                        {/* BBR-meddelelse */}
                        <div className="grid grid-cols-[28px_72px_1fr_120px_80px] gap-x-3 px-4 py-2 border-b border-slate-700/15 hover:bg-slate-700/10 transition-colors items-start">
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
                            <span className="text-sm text-slate-200">BBR-meddelelse</span>
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
                            className="grid grid-cols-[28px_72px_1fr_120px_80px] gap-x-3 px-4 py-2 hover:bg-slate-700/10 transition-colors cursor-pointer items-start"
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
                              <span className="text-sm text-slate-200">Jordforureningsattest</span>
                              {jordLoader && (
                                <p className="text-xs text-slate-500 mt-0.5 animate-pulse">
                                  Henter…
                                </p>
                              )}
                            </div>
                            {/* Status — alignet med plan-status kolonnen */}
                            <div className="self-start">
                              {!jordLoader && jordIngenData && (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-500/15 text-emerald-400">
                                  Ikke kortlagt
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
                            <div className="grid grid-cols-[28px_72px_1fr_120px_80px] gap-x-3 px-4 py-2 border-b border-slate-700/15 hover:bg-slate-700/10 transition-colors items-start">
                              <span />
                              <span className="text-sm text-slate-300 tabular-nums">—</span>
                              <div>
                                <span className="text-sm text-slate-200">Matrikelkort</span>
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
                          <div className="grid grid-cols-[28px_72px_1fr_120px_80px] gap-x-3 px-4 py-2 border-b border-slate-700/15 hover:bg-slate-700/10 transition-colors items-start">
                            <span />
                            <span className="text-sm text-slate-300 tabular-nums">—</span>
                            <div>
                              <span className="text-sm text-slate-200">
                                Slots- og Kulturstyrelsen
                              </span>
                              <p className="text-xs text-slate-500 mt-0.5">Fredet bygning</p>
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
                        Ingen planer fundet for denne adresse
                      </div>
                    )}

                    {plandata && plandata.length > 0 && (
                      <div>
                        {/* Header */}
                        <div className="grid grid-cols-[28px_72px_1fr_120px_80px] gap-x-3 px-4 py-2 border-b border-slate-700/20">
                          <span />
                          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                            År
                          </span>
                          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                            Type
                          </span>
                          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                            Status
                          </span>
                          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                            Dok.
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
                            d.anvendelse && { label: 'Generel anvendelse', value: d.anvendelse },
                            d.delnr && { label: 'Delområdenummer', value: d.delnr },
                            d.bebygpct && {
                              label: 'Maks. bebyggelsesprocent',
                              value: `${d.bebygpct} %`,
                            },
                            d.maxetager && {
                              label: 'Maks. antal etager',
                              value: String(d.maxetager),
                            },
                            d.maxbygnhjd && {
                              label: 'Maks. bygningshøjde',
                              value: `${d.maxbygnhjd} m`,
                            },
                            d.minuds && {
                              label: 'Min. grundstørrelse ved udstykning',
                              value: `${d.minuds.toLocaleString('da-DK')} m²`,
                            },
                            d.datoforsl && { label: 'Forslagsdato', value: d.datoforsl },
                            d.datovedt && { label: 'Vedtagelsesdato', value: d.datovedt },
                            d.datoikraft && { label: 'Dato trådt i kraft', value: d.datoikraft },
                            d.datostart && { label: 'Startdato', value: d.datostart },
                            d.datoslut && { label: 'Slutdato', value: d.datoslut },
                          ].filter((r): r is { label: string; value: string } => Boolean(r));

                          return (
                            <div
                              key={rowKey}
                              className="border-b border-slate-700/15 last:border-b-0"
                            >
                              {/* Hoved-række */}
                              <div
                                className="grid grid-cols-[28px_72px_1fr_120px_80px] gap-x-3 px-4 py-2 hover:bg-slate-700/10 transition-colors cursor-pointer items-start"
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
                                      Ingen yderligere detaljer tilgængelige
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

                  {/* ── Energimærker subsection ── */}
                  <div>
                    <div className="px-4 py-2 flex items-center gap-2">
                      <span className="text-sm leading-none">⚡</span>
                      <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                        Energimærkerapporter
                      </span>
                    </div>

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
                          Ingen energimærker registreret for denne ejendom
                        </div>
                      )}

                    {energimaerker && energimaerker.length > 0 && (
                      <div>
                        <div className="grid grid-cols-[56px_1fr_100px_130px_80px] gap-x-3 px-4 py-1.5 border-b border-slate-700/20">
                          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                            Klasse
                          </span>
                          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                            Adresse
                          </span>
                          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                            Status
                          </span>
                          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                            Gyldig til
                          </span>
                          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                            Rapport
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
                          return (
                            <div
                              key={m.serialId}
                              className="grid grid-cols-[56px_1fr_100px_130px_80px] gap-x-3 px-4 py-2 border-b border-slate-700/15 hover:bg-slate-700/10 transition-colors items-center"
                            >
                              <span
                                style={klasseStyle}
                                className="inline-flex items-center justify-center w-7 h-7 rounded-md text-xs font-bold"
                              >
                                {m.klasse}
                              </span>
                              <div>
                                <p className="text-sm text-slate-200">{m.adresse ?? '—'}</p>
                                {m.bygninger.length > 0 && (
                                  <p className="text-xs text-slate-500 mt-0.5">
                                    {m.bygninger.length === 1
                                      ? `Bygning ${m.bygninger[0].bygningsnr}`
                                      : `${m.bygninger.length} bygninger`}
                                    {m.bygninger[0]?.opfoerelsesaar != null &&
                                      ` · ${m.bygninger[0].opfoerelsesaar}`}
                                  </p>
                                )}
                              </div>
                              <span
                                className={`inline-flex items-center self-start px-2 py-0.5 rounded text-xs font-medium ${statusKlasse}`}
                              >
                                {m.status ?? '—'}
                              </span>
                              <span
                                className={`text-sm tabular-nums ${m.status === 'Ugyldig' ? 'text-red-400' : 'text-slate-300'}`}
                              >
                                {m.udloeber ?? '—'}
                              </span>
                              <div>
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
        {visKort && (
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
        {visKort && (
          <div className="relative flex-shrink-0 self-stretch" style={{ width: kortBredde }}>
            {/* Åbn på fuldt kort — navigerer til /dashboard/kort?ejendom=<id> */}
            <Link
              href={`/dashboard/kort?ejendom=${id}`}
              className="absolute top-3 right-3 z-20 flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-900/90 hover:bg-slate-800 border border-slate-700 rounded-lg text-slate-300 text-xs font-medium shadow-lg transition-all"
              title="Åbn på fuldt kort"
            >
              <MapIcon size={12} />
              Fuldt kort
            </Link>
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
                  onAdresseValgt={(newId) => router.push(`/dashboard/ejendomme/${newId}`)}
                  bygningPunkter={
                    bbrData?.bygningPunkter
                      ? bbrData.bygningPunkter.filter(
                          (p) =>
                            p.status !== 'Nedrevet/slettet' &&
                            p.status !== 'Bygning nedrevet' &&
                            p.status !== 'Bygning bortfaldet'
                        )
                      : undefined
                  }
                />
              </Suspense>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Mock: Ejendom ikke fundet ──
  if (!ejendom) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-6">
        <MapPin size={40} className="text-slate-600 mb-4" />
        <h2 className="text-white text-xl font-semibold mb-2">Ejendom ikke fundet</h2>
        <p className="text-slate-400 text-sm mb-6">BFE-nummeret eksisterer ikke i systemet.</p>
        <Link
          href="/dashboard/ejendomme"
          className="text-blue-400 hover:text-blue-300 flex items-center gap-2 text-sm"
        >
          <ArrowLeft size={16} /> Tilbage til ejendomme
        </Link>
      </div>
    );
  }

  /** Prishistorik tilpasset til Recharts */
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
      <div className="px-6 pt-5 pb-0 border-b border-slate-700/50 bg-slate-900/30">
        {/* Tilbage + handlinger */}
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-2 text-slate-400 hover:text-white text-sm transition-colors"
          >
            <ArrowLeft size={16} />
            Ejendomme
          </button>

          <div
            className="relative"
            onMouseEnter={() => !erFulgt && setVisFoelgTooltip(true)}
            onMouseLeave={() => setVisFoelgTooltip(false)}
          >
            <button
              onClick={async () => {
                setVisFoelgTooltip(false);
                if (!ejendom) return;
                const adresse = `${ejendom.adresse}, ${ejendom.postnummer} ${ejendom.by}`;
                const nyTilstand = toggleTrackEjendom({
                  id,
                  adresse,
                  postnr: ejendom.postnummer,
                  by: ejendom.by,
                  kommune: ejendom.kommune,
                  anvendelse: null,
                });
                setErFulgt(nyTilstand);
                window.dispatchEvent(new Event('ba-tracked-changed'));
                try {
                  if (nyTilstand) {
                    await fetch('/api/tracked', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        entity_id: id,
                        label: adresse,
                        entity_data: {
                          postnr: ejendom.postnummer,
                          by: ejendom.by,
                          kommune: ejendom.kommune,
                          anvendelse: null,
                        },
                      }),
                    });
                  } else {
                    await fetch(`/api/tracked?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
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
              {erFulgt ? 'Følger' : 'Følg'}
            </button>
            <FoelgTooltip lang="da" visible={visFoelgTooltip} />
          </div>
        </div>

        {/* Adresse + meta */}
        <div className="mb-3">
          <h1 className="text-white text-xl font-bold">
            {ejendom.adresse}, {ejendom.postnummer} {ejendom.by}
          </h1>
          <div className="flex items-center gap-3 mt-1 text-slate-400 text-xs">
            <span>BFE: {ejendom.bfe}</span>
            <span>·</span>
            <span>ESR: {ejendom.esr}</span>
          </div>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
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
        <div className="flex gap-1 -mb-px">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setAktivTab(tab.id)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-all whitespace-nowrap ${
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
          <div className="flex-1 overflow-y-auto px-6 py-5">
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
                      matrikel
                    </p>
                    <div className="space-y-2">
                      <DataKort
                        label="Grundareal"
                        value={`${ejendom.grundareal.toLocaleString('da-DK')} m²`}
                      />
                      <DataKort
                        label="Bebyggelsesprocent"
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
                      bygning
                    </p>
                    <div className="space-y-2">
                      <DataKort
                        label="Bygningsareal"
                        value={`${ejendom.bygningsareal.toLocaleString('da-DK')} m²`}
                      />
                      <DataKort label="Kælder" value={`${ejendom.kaelder} m²`} />
                      <DataKort label="Udnyttet tagetage" value="0 m²" />
                    </div>
                  </div>

                  {/* Enhed */}
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                    <p className="text-slate-400 text-xs font-medium mb-3">
                      <span className="text-white font-bold text-base">
                        {ejendom.erhvervsenheder + ejendom.beboelsesenheder}
                      </span>{' '}
                      enhed
                    </p>
                    <div className="space-y-2">
                      {ejendom.beboelsesareal > 0 && (
                        <DataKort label="Beboelsesareal" value={`${ejendom.beboelsesareal} m²`} />
                      )}
                      <DataKort
                        label="Erhvervsareal"
                        value={`${ejendom.erhvervsareal.toLocaleString('da-DK')} m²`}
                      />
                      <DataKort label="Erhvervsenheder" value={`${ejendom.erhvervsenheder}`} />
                    </div>
                  </div>
                </div>

                {/* Ejer + Seneste handel */}
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

                  {/* Seneste handel */}
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                    <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-3">
                      Seneste handel
                    </p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <p className="text-white text-2xl font-bold">
                          {formatDKK(ejendom.senesteHandel.pris)}
                        </p>
                        <p className="text-slate-500 text-xs mt-0.5">
                          {formatDato(ejendom.senesteHandel.dato)}
                        </p>
                      </div>
                      <div className="flex flex-col justify-center">
                        <p className="text-slate-400 text-xs">Pris/m²</p>
                        <p className="text-slate-200 font-semibold">
                          {ejendom.senesteHandel.prisPerM2.toLocaleString('da-DK')} DKK
                        </p>
                      </div>
                      <div>
                        <p className="text-slate-400 text-xs">Ejendomsværdi</p>
                        <p className="text-slate-200 font-semibold text-sm">
                          {formatDKK(ejendom.ejendomsvaerdi)}
                        </p>
                      </div>
                      <div>
                        <p className="text-slate-400 text-xs">Grundskyld</p>
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
                      <h3 className="text-white font-semibold text-sm">Virksomheder på adressen</h3>
                      <span className="text-slate-500 text-xs">
                        {ejendom.virksomhederPaaAdressen.length} virksomheder
                      </span>
                    </div>
                    <table className="w-full">
                      <thead>
                        <tr className="text-slate-500 text-xs border-b border-slate-700/30">
                          <th className="px-4 py-2 text-left font-medium">Virksomhed</th>
                          <th className="px-4 py-2 text-left font-medium">Industri</th>
                          <th className="px-4 py-2 text-left font-medium">Periode</th>
                          <th className="px-4 py-2 text-right font-medium">Ansatte</th>
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

                {/* Miljøindikatorer */}
                <div>
                  <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-3">
                    Miljøindikatorer
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
                        <button className="text-slate-600 hover:text-slate-400 ml-2 flex-shrink-0">
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
                {/* BBR-fejlbesked */}
                {bbrData?.bbrFejl && (
                  <div className="p-3 bg-orange-500/10 border border-orange-500/20 rounded-lg">
                    <p className="text-orange-300 text-sm">BBR: {bbrData.bbrFejl}</p>
                  </div>
                )}

                {/* Jordstykker */}
                <div>
                  <SectionTitle title="Jordstykker" />
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <DataKort label="Matrikler" value="1" />
                    <DataKort
                      label="Grundareal"
                      value={
                        dawaJordstykke
                          ? `${dawaJordstykke.areal_m2.toLocaleString('da-DK')} m²`
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
                          {dawaJordstykke.areal_m2.toLocaleString('da-DK')} m²
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
                  return (
                    <div>
                      <SectionTitle title="Bygninger" />
                      <div className="grid grid-cols-4 gap-2 mb-2">
                        <DataKort
                          label="Bygninger"
                          value={bbrLoader ? '…' : `${bygninger.length}`}
                        />
                        <DataKort
                          label="Bygningsareal"
                          value={totAreal ? `${totAreal.toLocaleString('da-DK')} m²` : '–'}
                        />
                        <DataKort
                          label="Beboelsesareal"
                          value={boligAreal ? `${boligAreal.toLocaleString('da-DK')} m²` : '0 m²'}
                        />
                        <DataKort
                          label="Erhvervsareal"
                          value={erhvAreal ? `${erhvAreal.toLocaleString('da-DK')} m²` : '–'}
                        />
                      </div>

                      {bbrLoader ? (
                        <div className="text-slate-500 text-sm text-center py-3">
                          Henter bygningsdata…
                        </div>
                      ) : bygninger.length === 0 ? (
                        <div className="text-slate-500 text-sm text-center py-3">
                          Ingen bygningsdata tilgængeligt
                        </div>
                      ) : (
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                          {/* Kolonneheader */}
                          <div className="grid grid-cols-[1fr_72px_100px_100px_28px] px-4 py-2 text-slate-500 text-xs font-medium border-b border-slate-700/30">
                            <span>Anvendelse</span>
                            <span className="text-right">Opf. år</span>
                            <span className="text-right">Bebygget</span>
                            <span className="text-right">Samlet</span>
                            <span />
                          </div>
                          {bygninger.map((b) => {
                            const aaben = expandedBygninger.has(b.id);
                            const detaljer: [string, string | null][] = [
                              ['Ydervæg', b.ydervaeg || null],
                              ['Tagmateriale', b.tagmateriale || null],
                              ['Varmeinstallation', b.varmeinstallation || null],
                              ['Opvarmningsform', b.opvarmningsform || null],
                              ['Vandforsyning', b.vandforsyning || null],
                              ['Afløb', b.afloeb || null],
                              ['Etager', b.antalEtager != null ? `${b.antalEtager}` : null],
                              [
                                'Boligareal',
                                b.samletBoligareal
                                  ? `${b.samletBoligareal.toLocaleString('da-DK')} m²`
                                  : null,
                              ],
                              [
                                'Erhvervsareal',
                                b.samletErhvervsareal
                                  ? `${b.samletErhvervsareal.toLocaleString('da-DK')} m²`
                                  : null,
                              ],
                              [
                                'Ombygningsår',
                                b.ombygningsaar != null ? `${b.ombygningsaar}` : null,
                              ],
                              ['Fredning', b.fredning || null],
                              ['Status', b.status || null],
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
                                      aaben ? next.delete(b.id) : next.add(b.id);
                                      return next;
                                    })
                                  }
                                  className="w-full grid grid-cols-[1fr_72px_100px_100px_28px] px-4 py-3 text-sm hover:bg-slate-700/20 transition-colors text-left items-center"
                                >
                                  <span className="text-slate-200 truncate pr-2">
                                    {b.anvendelse || '–'}
                                  </span>
                                  <span className="text-slate-400 text-right">
                                    {b.opfoerelsesaar ?? '–'}
                                  </span>
                                  <span className="text-slate-300 text-right">
                                    {b.bebyggetAreal
                                      ? `${b.bebyggetAreal.toLocaleString('da-DK')} m²`
                                      : '–'}
                                  </span>
                                  <span className="text-slate-300 text-right">
                                    {b.samletBygningsareal
                                      ? `${b.samletBygningsareal.toLocaleString('da-DK')} m²`
                                      : '–'}
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
                      <SectionTitle title="Enheder" />
                      <div className="grid grid-cols-4 gap-2 mb-2">
                        <DataKort
                          label="Enheder i alt"
                          value={bbrLoader ? '…' : `${enheder.length}`}
                        />
                        <DataKort label="Beboelsesenheder" value={`${boligEnh}`} />
                        <DataKort label="Erhvervsenheder" value={`${erhvEnh}`} />
                        <DataKort
                          label="Samlet areal"
                          value={totAreal ? `${totAreal.toLocaleString('da-DK')} m²` : '–'}
                        />
                      </div>

                      {bbrLoader ? (
                        <div className="text-slate-500 text-sm text-center py-3">
                          Henter enhedsdata…
                        </div>
                      ) : enheder.length === 0 ? (
                        <div className="text-slate-500 text-sm text-center py-3">
                          Ingen enheder tilgængeligt
                        </div>
                      ) : (
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                          <div className="grid grid-cols-[1fr_90px_72px_28px] px-4 py-2 text-slate-500 text-xs font-medium border-b border-slate-700/30">
                            <span>Anvendelse</span>
                            <span className="text-right">Areal</span>
                            <span className="text-right">Værelser</span>
                            <span />
                          </div>
                          {enheder.map((e) => {
                            const aaben = expandedEnheder.has(e.id);
                            const detaljer: [string, string | null][] = [
                              ['Etage', e.etage || null],
                              [
                                'Boligareal',
                                e.arealBolig ? `${e.arealBolig.toLocaleString('da-DK')} m²` : null,
                              ],
                              [
                                'Erhvervsareal',
                                e.arealErhverv
                                  ? `${e.arealErhverv.toLocaleString('da-DK')} m²`
                                  : null,
                              ],
                              ['Energimærke', e.energimaerke || null],
                              ['Varmeinstallation', e.varmeinstallation || null],
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
                                      aaben ? next.delete(e.id) : next.add(e.id);
                                      return next;
                                    })
                                  }
                                  className="w-full grid grid-cols-[1fr_90px_72px_28px] px-4 py-3 text-sm hover:bg-slate-700/20 transition-colors text-left items-center"
                                >
                                  <span className="text-slate-200 truncate pr-2">
                                    {e.anvendelse || '–'}
                                  </span>
                                  <span className="text-slate-300 text-right">
                                    {e.areal ? `${e.areal.toLocaleString('da-DK')} m²` : '–'}
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
                  <SectionTitle title="Matrikeloplysninger" />
                  {matrikelLoader ? (
                    <div className="flex items-center gap-2 text-slate-500 text-sm py-4">
                      <div className="w-4 h-4 border-2 border-slate-600 border-t-blue-500 rounded-full animate-spin" />
                      Henter matrikeldata…
                    </div>
                  ) : matrikelData ? (
                    <div className="space-y-3">
                      {/* Ejendomsinfo */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        {matrikelData.landbrugsnotering && (
                          <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3">
                            <p className="text-slate-400 text-xs mb-0.5">Landbrugsnotering</p>
                            <p className="text-white text-sm font-medium">
                              {matrikelData.landbrugsnotering}
                            </p>
                          </div>
                        )}
                        {matrikelData.opdeltIEjerlejligheder && (
                          <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3">
                            <p className="text-slate-400 text-xs mb-0.5">Ejerlejligheder</p>
                            <p className="text-white text-sm font-medium">
                              Opdelt i ejerlejligheder
                            </p>
                          </div>
                        )}
                        {matrikelData.erFaelleslod && (
                          <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3">
                            <p className="text-slate-400 text-xs mb-0.5">Fælleslod</p>
                            <p className="text-white text-sm font-medium">Ja</p>
                          </div>
                        )}
                        {matrikelData.udskiltVej && (
                          <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3">
                            <p className="text-slate-400 text-xs mb-0.5">Udskilt vej</p>
                            <p className="text-white text-sm font-medium">Ja</p>
                          </div>
                        )}
                      </div>

                      {/* Jordstykker tabel */}
                      {matrikelData.jordstykker.length > 0 && (
                        <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-hidden">
                          <div className="px-4 py-2.5 border-b border-slate-700/30">
                            <p className="text-slate-300 text-xs font-semibold uppercase tracking-wider">
                              Jordstykker ({matrikelData.jordstykker.length})
                            </p>
                          </div>
                          <div className="divide-y divide-slate-700/20">
                            {matrikelData.jordstykker.map((js) => (
                              <div
                                key={js.id}
                                className="px-4 py-2.5 grid grid-cols-[1fr_100px_80px_auto] gap-3 items-center"
                              >
                                <div>
                                  <p className="text-white text-sm font-medium">
                                    Matr.nr. {js.matrikelnummer}
                                    {js.ejerlavskode && (
                                      <span className="text-slate-500 text-xs ml-2">
                                        Ejerlav {js.ejerlavskode}
                                      </span>
                                    )}
                                  </p>
                                  {js.ejerlavsnavn && (
                                    <p className="text-slate-500 text-xs">{js.ejerlavsnavn}</p>
                                  )}
                                </div>
                                <p className="text-slate-300 text-sm tabular-nums text-right">
                                  {js.registreretAreal != null
                                    ? `${js.registreretAreal.toLocaleString('da-DK')} m²`
                                    : '–'}
                                </p>
                                <p className="text-slate-500 text-xs text-right">
                                  {js.vejareal != null && js.vejareal > 0
                                    ? `Vej: ${js.vejareal.toLocaleString('da-DK')} m²`
                                    : ''}
                                </p>
                                <div className="flex gap-1.5 flex-wrap justify-end">
                                  {js.fredskov === true && (
                                    <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-green-900/50 text-green-400 border border-green-800/40">
                                      Fredskov
                                    </span>
                                  )}
                                  {js.strandbeskyttelse === true && (
                                    <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-blue-900/50 text-blue-400 border border-blue-800/40">
                                      Strandbeskyttelse
                                    </span>
                                  )}
                                  {js.klitfredning === true && (
                                    <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-amber-900/50 text-amber-400 border border-amber-800/40">
                                      Klitfredning
                                    </span>
                                  )}
                                  {js.jordrente === true && (
                                    <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-purple-900/50 text-purple-400 border border-purple-800/40">
                                      Jordrente
                                    </span>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="bg-slate-800/30 border border-slate-700/40 rounded-xl p-4 text-center">
                      <p className="text-slate-500 text-xs">Ingen matrikeldata fundet</p>
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
                {/* Ejer-kort */}
                {ejendom.ejerDetaljer && (
                  <div>
                    <SectionTitle title="Ejer" />
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
                              Primær kontakt
                            </span>
                            {ejendom.ejerDetaljer.reklamebeskyttet && (
                              <span className="px-2 py-0.5 bg-orange-500/10 border border-orange-500/20 rounded-full text-xs text-orange-300">
                                Reklamebeskyttet
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
                            label: 'Overtagelsesdato',
                            value: formatDato(ejendom.ejerDetaljer.overtagelsesdato),
                          },
                          { label: 'Ejertype', value: ejendom.ejerDetaljer.ejertype },
                          { label: 'Branchenavn', value: ejendom.ejerDetaljer.branche },
                          {
                            label: 'Telefon',
                            value: ejendom.ejerDetaljer.telefon,
                            ikon: <Phone size={11} className="text-slate-500" />,
                          },
                          {
                            label: 'E-mail',
                            value: ejendom.ejerDetaljer.email,
                            ikon: <Mail size={11} className="text-slate-500" />,
                          },
                          {
                            label: 'Tegningsregel',
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

                {/* Ejerstruktur */}
                {ejendom.ejerstruktur && ejendom.ejerstruktur.length > 0 && (
                  <div>
                    <SectionTitle title="Ejerstruktur" />
                    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                      <EjerstrukturTrae noder={ejendom.ejerstruktur} />
                    </div>
                  </div>
                )}

                {/* Nøgletal */}
                {ejendom.ejerDetaljer && (
                  <div>
                    <SectionTitle
                      title={`Nøgletal ${ejendom.ejerDetaljer.noegletal.aar} for ${ejendom.ejerDetaljer.navn}`}
                    />
                    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                      <div className="px-4 py-2 border-b border-slate-700/30">
                        <p className="text-slate-400 text-xs font-medium">Resultatopgørelse</p>
                      </div>
                      <table className="w-full">
                        <tbody>
                          <tr className="border-b border-slate-700/30 hover:bg-slate-700/20">
                            <td className="px-4 py-3 text-slate-300 text-sm">Resultat før skat</td>
                            <td className="px-4 py-3 text-right">
                              <span
                                className={`text-sm font-semibold ${ejendom.ejerDetaljer.noegletal.resultatFoerSkat >= 0 ? 'text-green-400' : 'text-red-400'}`}
                              >
                                {formatDKK(ejendom.ejerDetaljer.noegletal.resultatFoerSkat)}
                              </span>
                            </td>
                          </tr>
                          <tr className="hover:bg-slate-700/20">
                            <td className="px-4 py-3 text-slate-300 text-sm">Resultat</td>
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
                      Nuværende ejere
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
                                {ejer.type === 'selskab' ? `CVR ${ejer.cvr}` : 'Privatperson'} ·
                                Erhvervet {formatDato(ejer.erhvervsdato)}
                              </p>
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="text-white font-bold text-lg">{ejer.ejerandel}%</p>
                            <p className="text-slate-500 text-xs">ejerandel</p>
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
                    <SectionTitle title="Tingbogsattest" onDownload={() => undefined} />
                    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                      <div className="grid grid-cols-2 gap-4 mb-4">
                        <div>
                          <p className="text-slate-500 text-xs mb-1">BFE-nr.</p>
                          <p className="text-white font-semibold text-sm">{ejendom.bfe}</p>
                        </div>
                        <div>
                          <p className="text-slate-500 text-xs mb-1">Matrikler</p>
                          {ejendom.tingbogsattest.matrikler.map((m, i) => (
                            <p key={i} className="text-white text-sm font-medium">
                              {m.matrikelNummer}{' '}
                              <span className="text-slate-400 font-normal">
                                ({m.areal.toLocaleString('da-DK')} m²){' '}
                              </span>
                              <span className="text-slate-500 text-xs">{m.registreringsdato}</span>
                            </p>
                          ))}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-700/60 rounded-lg text-slate-300 text-xs hover:bg-slate-700/40 transition-colors">
                          Akt nr. {ejendom.tingbogsattest.aktNummer}
                        </button>
                        <button className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 rounded-lg text-white text-xs font-medium transition-colors">
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
                    <SectionTitle title="Adkomsthaver" />
                    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                      <table className="w-full">
                        <thead>
                          <tr className="text-slate-500 text-xs border-b border-slate-700/30">
                            <th className="px-4 py-2 text-left font-medium">Adkomsthaver</th>
                            <th className="px-4 py-2 text-left font-medium">Type</th>
                            <th className="px-4 py-2 text-right font-medium">Beløb</th>
                            <th className="px-4 py-2 text-right font-medium">Dato</th>
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
                              <button className="text-slate-600 hover:text-slate-300 transition-colors">
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
                    <SectionTitle title="Historiske adkomster" />
                    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                      <table className="w-full">
                        <thead>
                          <tr className="text-slate-500 text-xs border-b border-slate-700/30">
                            <th className="px-4 py-2 text-left font-medium">Adkomsthaver</th>
                            <th className="px-4 py-2 text-left font-medium">Type</th>
                            <th className="px-4 py-2 text-right font-medium">Beløb</th>
                            <th className="px-4 py-2 text-right font-medium">Dato</th>
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
                                <button className="text-slate-600 hover:text-slate-300 transition-colors">
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
                  <SectionTitle title="Hæftelser" />
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                    <table className="w-full">
                      <thead>
                        <tr className="text-slate-500 text-xs border-b border-slate-700/30">
                          <th className="px-4 py-2 text-left font-medium">Prioritet</th>
                          <th className="px-4 py-2 text-left font-medium">Kreditor</th>
                          <th className="px-4 py-2 text-left font-medium">Debitor</th>
                          <th className="px-4 py-2 text-left font-medium">Type</th>
                          <th className="px-4 py-2 text-right font-medium">Hovedstol</th>
                          <th className="px-4 py-2 text-right font-medium">Dato</th>
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
                              <button className="text-slate-600 hover:text-slate-300 transition-colors">
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
                    hæftelser
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
                    label="Ejendomsværdi"
                    value={formatDKK(ejendom.ejendomsvaerdi)}
                    sub="Seneste vurdering"
                  />
                  <DataKort
                    label="Grundværdi"
                    value={formatDKK(ejendom.grundvaerdi)}
                    sub="Seneste vurdering"
                  />
                  <DataKort label="Skat i alt" value={formatDKK(ejendom.skat)} sub="Årlig" />
                  <DataKort label="Grundskyld" value={formatDKK(ejendom.grundskyld)} sub="Årlig" />
                </div>

                {/* Prishistorik graf */}
                <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-slate-200 text-sm font-semibold">Prishistorik</p>
                    <div className="flex items-center gap-1 text-slate-400 text-xs">
                      <TrendingUp size={12} />
                      <span>mio. DKK</span>
                    </div>
                  </div>
                  <ResponsiveContainer width="100%" height={200}>
                    <AreaChart data={prisData}>
                      <defs>
                        <linearGradient id="prisGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis
                        dataKey="dato"
                        tick={{ fill: '#64748b', fontSize: 12 }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        tick={{ fill: '#64748b', fontSize: 12 }}
                        axisLine={false}
                        tickLine={false}
                        tickFormatter={(v: number) => `${v}M`}
                      />
                      <Tooltip
                        contentStyle={{
                          background: '#0f172a',
                          border: '1px solid #1e293b',
                          borderRadius: '12px',
                          color: '#fff',
                        }}
                        formatter={
                          ((value: number | string) => [`${value} mio. DKK`, 'Pris']) as Parameters<
                            typeof Tooltip
                          >[0]['formatter']
                        }
                      />
                      <Area
                        type="monotone"
                        dataKey="pris"
                        stroke="#3b82f6"
                        strokeWidth={2}
                        fill="url(#prisGradient)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>

                {/* Salgshistorik */}
                <div>
                  <SectionTitle title="Salgshistorik" onDownload={() => undefined} />
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                    <table className="w-full">
                      <thead>
                        <tr className="text-slate-500 text-xs border-b border-slate-700/30">
                          <th className="px-4 py-2 text-left font-medium">Køber</th>
                          <th className="px-4 py-2 text-left font-medium">Type</th>
                          <th className="px-4 py-2 text-right font-medium">Andel</th>
                          <th className="px-4 py-2 text-right font-medium">Pris</th>
                          <th className="px-4 py-2 text-right font-medium">Dato</th>
                          <th className="px-2 py-2"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {(
                          ejendom.salgshistorik ??
                          ejendom.handelHistorik.map((h) => ({
                            koebere: [
                              {
                                navn: h.koeberType === 'selskab' ? 'Selskab' : 'Privatperson',
                                andel: 100 as number | undefined,
                              },
                            ],
                            handelstype: 'Skøde',
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

                {/* Udbudshistorik */}
                <div>
                  <SectionTitle title="Udbudshistorik" />
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                    <table className="w-full">
                      <thead>
                        <tr className="text-slate-500 text-xs border-b border-slate-700/30">
                          <th className="px-4 py-2 text-left font-medium">Status</th>
                          <th className="px-4 py-2 text-right font-medium">Prisændring</th>
                          <th className="px-4 py-2 text-right font-medium">Pris</th>
                          <th className="px-4 py-2 text-right font-medium">Dato</th>
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
                                    {u.prisaendring.toLocaleString('da-DK')} DKK
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
                              Ingen udbudshistorik registreret
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {/* (det separate checklist-panel er fjernet — checkboxe sidder nu direkte ved PDF-ikonerne i dokumenttabellen ovenfor) */}
            {aktivTab === 'dokumenter' && false && (
              <div className="space-y-4 pb-4">
                {/* ── Stamdokumenter ── */}
                <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-700/40 flex items-center justify-between">
                    <h3 className="text-white font-semibold text-sm">Stamdokumenter</h3>
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
                    <h3 className="text-white font-semibold text-sm">Tinglysning</h3>
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
                      navn: 'Adkomster inkl. påtegninger og bilag',
                      link: false,
                      expandable: true,
                    },
                    {
                      id: 'tgl-4',
                      navn: 'Hæftelser inkl. påtegninger og bilag',
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
                    <span className="text-slate-500 text-sm italic">
                      Servitutter: Ejendommen har ingen elektroniske servitutdokumenter at
                      downloade...
                    </span>
                    <FileText size={13} className="text-slate-700 ml-auto" />
                  </div>
                </div>

                {/* ── Planer ── */}
                <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-700/40 flex items-center justify-between">
                    <h3 className="text-white font-semibold text-sm">Planer</h3>
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
                      sub: 'LP 110 — Erhvervsområde Risbjerg',
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
        {visKort && (
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
        {visKort && (
          <div className="relative flex-shrink-0 self-stretch" style={{ width: kortBredde }}>
            <div className="absolute inset-0">
              <Suspense
                fallback={
                  <div className="w-full h-full flex flex-col items-center justify-center bg-slate-900 gap-3">
                    <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                    <p className="text-slate-500 text-xs">Indlæser kort…</p>
                  </div>
                }
              >
                <PropertyMap
                  lat={ejendom.lat}
                  lng={ejendom.lng}
                  adresse={`${ejendom.adresse}, ${ejendom.postnummer} ${ejendom.by}`}
                  visMatrikel={true}
                  onAdresseValgt={(id) => router.push(`/dashboard/ejendomme/${id}`)}
                  bygningPunkter={bbrData?.bygningPunkter ?? undefined}
                />
              </Suspense>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
