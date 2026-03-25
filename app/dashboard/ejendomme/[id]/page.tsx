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
  Map,
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
import {
  dawaHentAdresse,
  dawaHentJordstykke,
  erDawaId,
  type DawaAdresse,
  type DawaJordstykke,
} from '@/app/lib/dawa';
import type {
  EjendomApiResponse,
  LiveBBRBygning,
  LiveBBREnhed,
} from '@/app/api/ejendom/[id]/route';
import type { CVRVirksomhed, CVRResponse } from '@/app/api/cvr/route';
import type { VurderingData, VurderingResponse } from '@/app/api/vurdering/route';
import type { EjerData, EjerskabResponse } from '@/app/api/ejerskab/route';
import { gemRecentEjendom } from '@/app/lib/recentEjendomme';

type Tab = 'overblik' | 'bbr' | 'ejerforhold' | 'tinglysning' | 'oekonomi' | 'dokumenter';

const tabs: { id: Tab; label: string; ikon: React.ReactNode }[] = [
  { id: 'overblik', label: 'Overblik', ikon: <Building2 size={14} /> },
  { id: 'bbr', label: 'BBR', ikon: <FileText size={14} /> },
  { id: 'ejerforhold', label: 'Ejerforhold', ikon: <Users size={14} /> },
  { id: 'tinglysning', label: 'Tinglysning', ikon: <Landmark size={14} /> },
  { id: 'oekonomi', label: 'Økonomi', ikon: <BarChart3 size={14} /> },
  { id: 'dokumenter', label: 'Dokumenter', ikon: <FileText size={14} /> },
];

/** Energimærke baggrundfarve */
const energiColor: Record<string, string> = {
  A2020: 'bg-green-500',
  A2015: 'bg-green-400',
  A2010: 'bg-lime-400',
  B: 'bg-yellow-300',
  C: 'bg-yellow-400',
  D: 'bg-orange-400',
  E: 'bg-orange-500',
  F: 'bg-red-500',
  G: 'bg-red-700',
};

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
    <div className="bg-slate-900/50 border border-slate-700/40 rounded-xl p-3">
      <p className="text-slate-400 text-xs mb-1">{label}</p>
      <p className="text-white font-semibold text-base leading-tight">{value}</p>
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
    <div className="flex items-center justify-between mb-3">
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
  /** True mens vurderingsdata hentes */
  const [vurderingLoader, setVurderingLoader] = useState(false);

  /** Ejere fra Ejerfortegnelsen (Datafordeler) */
  const [ejere, setEjere] = useState<EjerData[] | null>(null);
  /** True mens ejerdata hentes */
  const [ejereLoader, setEjereLoader] = useState(false);
  /** True hvis Datafordeler returnerer 403 — Dataadgang-ansøgning mangler for EJF */
  const [manglerEjereAdgang, setManglerEjereAdgang] = useState(false);

  const erDAWA = erDawaId(id);

  /**
   * Henter DAWA-adresse og jordstykke.
   * Al setState sker i async then-callback — ikke synkront.
   */
  useEffect(() => {
    if (!erDAWA) return;
    setDawaStatus('loader');
    dawaHentAdresse(id).then(async (adr) => {
      if (!adr) {
        setDawaStatus('fejl');
        return;
      }
      setDawaAdresse(adr);
      const jord = await dawaHentJordstykke(adr.x, adr.y);
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

    fetch(`/api/vurdering?bfeNummer=${bfeNummer}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: VurderingResponse | null) => {
        setVurdering(data?.vurdering ?? null);
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
  }, [id, erDAWA, bbrData]);

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

    /** Første BBR-bygning (de fleste ejendomme har kun én) */
    const foersteBygning: LiveBBRBygning | null = bbrData?.bbr?.[0] ?? null;

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
              <button className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700/60 rounded-lg text-slate-300 text-sm transition-all">
                <Bell size={14} /> Følg
              </button>
            </div>

            <div className="mb-3">
              <h1 className="text-white text-xl font-bold">{adresseStreng}</h1>
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <span className="flex items-center gap-1 px-2 py-0.5 bg-slate-800 border border-slate-700/50 rounded-full text-xs text-slate-300">
                  <MapPin size={11} /> {dawaAdresse.kommunenavn} Kommune
                </span>
                {dawaJordstykke && (
                  <span className="flex items-center gap-1 px-2 py-0.5 bg-slate-800 border border-slate-700/50 rounded-full text-xs text-slate-300">
                    <Building2 size={11} /> {dawaJordstykke.matrikelnr},{' '}
                    {dawaJordstykke.ejerlav.navn}
                  </span>
                )}
                {foersteBygning?.opfoerelsesaar && (
                  <span className="px-2 py-0.5 bg-slate-800 border border-slate-700/50 rounded-full text-xs text-slate-300">
                    {foersteBygning.anvendelse} ({foersteBygning.opfoerelsesaar})
                  </span>
                )}
                <span className="flex items-center gap-1 px-2 py-0.5 bg-blue-500/10 border border-blue-500/20 rounded-full text-xs text-blue-400">
                  {bbrLoader ? 'Henter BBR…' : bbrData?.bbr ? 'BBR · Live' : 'DAWA · Live'}
                </span>
                {dawaAdresse.zone && (
                  <span
                    className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border ${
                      dawaAdresse.zone === 'Byzone'
                        ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                        : dawaAdresse.zone === 'Landzone'
                          ? 'bg-amber-500/10 border-amber-500/20 text-amber-400'
                          : dawaAdresse.zone === 'Sommerhuszone'
                            ? 'bg-orange-500/10 border-orange-500/20 text-orange-400'
                            : 'bg-slate-700/40 border-slate-600/40 text-slate-400'
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
              <div className="space-y-5">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {/* Matrikel */}
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                    <p className="text-slate-400 text-xs font-medium mb-3">
                      <span className="text-white font-bold text-base">1</span> matrikel
                    </p>
                    <div className="space-y-2">
                      <DataKort
                        label="Grundareal"
                        value={
                          dawaJordstykke
                            ? `${dawaJordstykke.areal_m2.toLocaleString('da-DK')} m²`
                            : '–'
                        }
                      />
                      <DataKort
                        label="Matrikelnr."
                        value={dawaJordstykke?.matrikelnr ?? dawaAdresse.matrikelnr ?? '–'}
                      />
                      <DataKort label="Ejerlav" value={dawaJordstykke?.ejerlav.navn ?? '–'} />
                    </div>
                  </div>

                  {/* Bygning */}
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                    <p className="text-slate-400 text-xs font-medium mb-3">
                      <span className="text-white font-bold text-base">
                        {bbrData?.bbr?.length ?? '–'}
                      </span>{' '}
                      bygning
                    </p>
                    <div className="space-y-2">
                      <DataKort
                        label="Bygningsareal"
                        value={
                          foersteBygning?.samletBygningsareal != null
                            ? `${foersteBygning.samletBygningsareal.toLocaleString('da-DK')} m²`
                            : '–'
                        }
                      />
                      <DataKort
                        label="Etager"
                        value={foersteBygning?.antalEtager?.toString() ?? '–'}
                      />
                      <DataKort
                        label="Opført"
                        value={foersteBygning?.opfoerelsesaar?.toString() ?? '–'}
                      />
                    </div>
                  </div>

                  {/* Enhed */}
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                    <p className="text-slate-400 text-xs font-medium mb-3">
                      <span className="text-white font-bold text-base">
                        {bbrData?.enheder?.length ?? '–'}
                      </span>{' '}
                      enhed
                    </p>
                    <div className="space-y-2">
                      <DataKort
                        label="Boligareal"
                        value={
                          foersteBygning?.samletBoligareal != null
                            ? `${foersteBygning.samletBoligareal.toLocaleString('da-DK')} m²`
                            : '–'
                        }
                      />
                      <DataKort
                        label="Erhvervsareal"
                        value={
                          foersteBygning?.samletErhvervsareal != null
                            ? `${foersteBygning.samletErhvervsareal.toLocaleString('da-DK')} m²`
                            : '–'
                        }
                      />
                      <DataKort
                        label="Boligenheder"
                        value={foersteBygning?.antalBoligenheder?.toString() ?? '–'}
                      />
                    </div>
                  </div>
                </div>

                {/* Adresseoplysninger fra DAWA */}
                <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                  <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-3">
                    Adresseoplysninger
                  </p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <DataKort
                      label="Postnummer"
                      value={`${dawaAdresse.postnr} ${dawaAdresse.postnrnavn}`}
                    />
                    <DataKort label="Kommune" value={dawaAdresse.kommunenavn} />
                    <DataKort label="Region" value={dawaAdresse.regionsnavn || '–'} />
                    <DataKort label="Zone" value={dawaAdresse.zone ?? '–'} />
                  </div>
                </div>

                {/* Datafordeler identifikatorer */}
                {bbrData && (
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                    <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-3">
                      Register-ID&apos;er
                    </p>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <DataKort label="DAWA UUID" value={dawaAdresse.id.slice(0, 8) + '…'} />
                      <DataKort
                        label="BFEnummer"
                        value={
                          bbrData.ejendomsrelationer?.[0]?.bfeNummer
                            ? String(bbrData.ejendomsrelationer[0].bfeNummer)
                            : bbrLoader
                              ? 'Henter…'
                              : '–'
                        }
                      />
                      <DataKort
                        label="Matrikelnr."
                        value={dawaJordstykke?.matrikelnr ?? dawaAdresse.matrikelnr ?? '–'}
                      />
                      <DataKort
                        label="Ejerlav"
                        value={dawaJordstykke?.ejerlav.navn ?? dawaAdresse.ejerlavsnavn ?? '–'}
                      />
                    </div>
                  </div>
                )}

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
                      <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">
                        Virksomheder på adressen
                      </p>
                      <span className="text-slate-500 text-xs">
                        {cvrVirksomheder.filter((v) => v.aktiv).length} aktive
                        {cvrVirksomheder.some((v) => !v.aktiv) &&
                          ` · ${cvrVirksomheder.filter((v) => !v.aktiv).length} ophørte`}
                      </span>
                    </div>
                    <div className="divide-y divide-slate-700/30">
                      {cvrVirksomheder.map((v) => (
                        <div
                          key={v.cvr}
                          className={`px-4 py-3 flex items-start justify-between gap-4 ${!v.aktiv ? 'opacity-50' : ''}`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 mb-0.5">
                              <Link
                                href={`/dashboard/companies/${v.cvr}`}
                                className="text-white text-sm font-medium hover:text-blue-400 transition-colors truncate"
                              >
                                {v.navn}
                              </Link>
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] font-semibold flex-shrink-0 ${v.aktiv ? 'bg-emerald-500/15 text-emerald-400' : 'bg-slate-700/60 text-slate-500'}`}
                              >
                                {v.aktiv ? 'AKTIV' : 'OPHØRT'}
                              </span>
                            </div>
                            <p className="text-slate-500 text-xs">
                              CVR {v.cvr}
                              {v.branche ? ` · ${v.branche}` : ''}
                            </p>
                            {v.telefon && (
                              <p className="text-slate-600 text-xs mt-0.5">{v.telefon}</p>
                            )}
                          </div>
                          <div className="text-right flex-shrink-0">
                            {v.type && (
                              <span className="px-2 py-0.5 bg-slate-700/60 rounded text-xs text-slate-300">
                                {v.type}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
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

            {/* ══ BBR ══ */}
            {aktivTab === 'bbr' && (
              <div className="space-y-4">
                {bbrLoader && (
                  <div className="flex items-center gap-3 py-8 justify-center">
                    <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                    <span className="text-slate-400 text-sm">Henter BBR-data…</span>
                  </div>
                )}

                {!bbrLoader &&
                  bbrData?.bbr &&
                  bbrData.bbr.map((byg: LiveBBRBygning, i: number) => (
                    <div
                      key={byg.id || i}
                      className="bg-slate-800/40 border border-slate-700/40 rounded-2xl p-5"
                    >
                      <div className="flex items-center justify-between mb-4">
                        <h3 className="text-white font-semibold text-sm">
                          Bygning {byg.bygningsnr ?? i + 1}
                        </h3>
                        {byg.energimaerke && (
                          <span
                            className={`px-2.5 py-0.5 rounded text-xs font-bold text-white ${
                              energiColor[byg.energimaerke] ?? 'bg-slate-600'
                            }`}
                          >
                            {byg.energimaerke}
                          </span>
                        )}
                      </div>

                      <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3 text-sm">
                        <div>
                          <p className="text-slate-500 text-xs">Opførelses­år</p>
                          <p className="text-white">{byg.opfoerelsesaar ?? '–'}</p>
                        </div>
                        <div>
                          <p className="text-slate-500 text-xs">Ombygnings­år</p>
                          <p className="text-white">{byg.ombygningsaar ?? '–'}</p>
                        </div>
                        <div>
                          <p className="text-slate-500 text-xs">Etager</p>
                          <p className="text-white">{byg.antalEtager ?? '–'}</p>
                        </div>
                        <div>
                          <p className="text-slate-500 text-xs">Bebygget areal</p>
                          <p className="text-white">
                            {byg.bebyggetAreal != null
                              ? `${byg.bebyggetAreal.toLocaleString('da-DK')} m²`
                              : '–'}
                          </p>
                        </div>
                        <div>
                          <p className="text-slate-500 text-xs">Samlet bygningsareal</p>
                          <p className="text-white">
                            {byg.samletBygningsareal != null
                              ? `${byg.samletBygningsareal.toLocaleString('da-DK')} m²`
                              : '–'}
                          </p>
                        </div>
                        <div>
                          <p className="text-slate-500 text-xs">Kælder</p>
                          <p className="text-white">
                            {byg.kaelder != null ? `${byg.kaelder} m²` : '–'}
                          </p>
                        </div>
                        <div>
                          <p className="text-slate-500 text-xs">Tagetage</p>
                          <p className="text-white">
                            {byg.tagetage != null ? `${byg.tagetage} m²` : '–'}
                          </p>
                        </div>
                        <div>
                          <p className="text-slate-500 text-xs">Boligareal</p>
                          <p className="text-white">
                            {byg.samletBoligareal != null
                              ? `${byg.samletBoligareal.toLocaleString('da-DK')} m²`
                              : '–'}
                          </p>
                        </div>
                        <div>
                          <p className="text-slate-500 text-xs">Erhvervsareal</p>
                          <p className="text-white">
                            {byg.samletErhvervsareal != null
                              ? `${byg.samletErhvervsareal.toLocaleString('da-DK')} m²`
                              : '–'}
                          </p>
                        </div>
                        <div>
                          <p className="text-slate-500 text-xs">Boligenheder</p>
                          <p className="text-white">{byg.antalBoligenheder ?? '–'}</p>
                        </div>
                        <div>
                          <p className="text-slate-500 text-xs">Erhvervsenheder</p>
                          <p className="text-white">{byg.antalErhvervsenheder ?? '–'}</p>
                        </div>
                        <div>
                          <p className="text-slate-500 text-xs">Anvendelse</p>
                          <p className="text-white">{byg.anvendelse}</p>
                        </div>
                      </div>

                      <div className="mt-4 pt-4 border-t border-slate-700/40 grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3 text-sm">
                        <div>
                          <p className="text-slate-500 text-xs">Tagmateriale</p>
                          <p className="text-white">{byg.tagmateriale}</p>
                        </div>
                        <div>
                          <p className="text-slate-500 text-xs">Ydervæg</p>
                          <p className="text-white">{byg.ydervaeg}</p>
                        </div>
                        <div>
                          <p className="text-slate-500 text-xs">Varme­installation</p>
                          <p className="text-white">{byg.varmeinstallation}</p>
                        </div>
                        <div>
                          <p className="text-slate-500 text-xs">Opvarmnings­form</p>
                          <p className="text-white">{byg.opvarmningsform}</p>
                        </div>
                        <div>
                          <p className="text-slate-500 text-xs">Vandforsyning</p>
                          <p className="text-white">{byg.vandforsyning}</p>
                        </div>
                        <div>
                          <p className="text-slate-500 text-xs">Afløbsforhold</p>
                          <p className="text-white">{byg.afloeb}</p>
                        </div>
                      </div>
                    </div>
                  ))}

                {/* BBR enheder */}
                {!bbrLoader && bbrData?.enheder && bbrData.enheder.length > 0 && (
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-2xl overflow-hidden">
                    <div className="px-4 py-3 border-b border-slate-700/40">
                      <h3 className="text-white font-semibold text-sm">
                        Enheder ({bbrData.enheder.length})
                      </h3>
                    </div>
                    <div className="divide-y divide-slate-700/30">
                      {bbrData.enheder.map((enh: LiveBBREnhed, i: number) => (
                        <div key={enh.id || i} className="px-4 py-3 grid grid-cols-4 gap-3 text-sm">
                          <div>
                            <p className="text-slate-500 text-xs">Etage / Dør</p>
                            <p className="text-white">
                              {enh.etage ? `${enh.etage}.` : '–'}
                              {enh.doer ? ` ${enh.doer}` : ''}
                            </p>
                          </div>
                          <div>
                            <p className="text-slate-500 text-xs">Areal</p>
                            <p className="text-white">
                              {enh.areal != null ? `${enh.areal} m²` : '–'}
                            </p>
                          </div>
                          <div>
                            <p className="text-slate-500 text-xs">Anvendelse</p>
                            <p className="text-white">{enh.anvendelse}</p>
                          </div>
                          <div>
                            <p className="text-slate-500 text-xs">Energimærke</p>
                            <p className="text-white">{enh.energimaerke ?? '–'}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Ingen BBR */}
                {!bbrLoader && !bbrData?.bbr && (
                  <div className="bg-orange-500/8 border border-orange-500/20 rounded-xl p-5">
                    <p className="text-orange-300 text-sm font-medium mb-1">
                      BBR-data ikke tilgængeligt
                    </p>
                    <p className="text-slate-400 text-xs leading-relaxed">
                      {bbrData?.bbrFejl ??
                        'BBR-data kræver et aktivt abonnement på BBRPublic-tjenesten på datafordeler.dk.'}
                    </p>
                    <a
                      href="https://datafordeler.dk"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-400 text-xs hover:text-blue-300 mt-2 inline-block"
                    >
                      Åbn datafordeler.dk og aktiver BBRPublic →
                    </a>
                  </div>
                )}
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
              <div className="space-y-4">
                {/* ── Ejendomsvurdering ── */}
                <div>
                  <p className="text-slate-400 text-xs font-medium uppercase tracking-wider mb-3">
                    Ejendomsvurdering · Datafordeler
                  </p>
                  {vurderingLoader ? (
                    <div className="flex items-center gap-2 text-slate-500 text-sm">
                      <div className="w-4 h-4 border-2 border-slate-600 border-t-blue-500 rounded-full animate-spin" />
                      Henter vurderingsdata…
                    </div>
                  ) : vurdering ? (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                        <p className="text-slate-400 text-xs mb-1">Ejendomsværdi</p>
                        <p className="text-white text-lg font-bold">
                          {vurdering.ejendomsvaerdi != null
                            ? `${(vurdering.ejendomsvaerdi / 1_000_000).toFixed(1)} mio. kr.`
                            : '–'}
                        </p>
                        {vurdering.aar && (
                          <p className="text-slate-500 text-xs mt-1">Vurdering {vurdering.aar}</p>
                        )}
                      </div>
                      <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                        <p className="text-slate-400 text-xs mb-1">Grundværdi</p>
                        <p className="text-white text-lg font-bold">
                          {vurdering.grundvaerdi != null
                            ? `${(vurdering.grundvaerdi / 1_000_000).toFixed(1)} mio. kr.`
                            : '–'}
                        </p>
                        {vurdering.bebyggelsesprocent != null && (
                          <p className="text-slate-500 text-xs mt-1">
                            Bebygget {vurdering.bebyggelsesprocent}%
                          </p>
                        )}
                      </div>
                      {vurdering.vurderetAreal != null && (
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                          <p className="text-slate-400 text-xs mb-1">Vurderet areal</p>
                          <p className="text-white text-base font-semibold">
                            {vurdering.vurderetAreal.toLocaleString('da-DK')} m²
                          </p>
                        </div>
                      )}
                      {vurdering.benyttelseskode && (
                        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                          <p className="text-slate-400 text-xs mb-1">Benyttelseskode</p>
                          <p className="text-white text-base font-semibold">
                            {vurdering.benyttelseskode}
                          </p>
                        </div>
                      )}
                    </div>
                  ) : !bbrData?.ejendomsrelationer?.[0]?.bfeNummer ? (
                    <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4 space-y-2">
                      <div className="flex items-center gap-2">
                        <div className="w-5 h-5 rounded-full bg-amber-500/20 flex items-center justify-center flex-shrink-0">
                          <span className="text-amber-400 text-xs font-bold">!</span>
                        </div>
                        <p className="text-amber-300 text-sm font-medium">
                          BFEnummer ikke tilgængeligt
                        </p>
                      </div>
                      <p className="text-slate-400 text-xs leading-relaxed">
                        Ejendomsvurdering kræver BFEnummer fra BBR Ejendomsrelation.
                        <br />
                        Aktivér <strong className="text-slate-300">
                          Ejendomsvurdering
                        </strong> og <strong className="text-slate-300">BBRPublic</strong> på
                        datafordeler.dk.
                      </p>
                      <a
                        href="https://datafordeler.dk/dataoversigt/ejendomme/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-blue-400 text-xs hover:text-blue-300 transition-colors"
                      >
                        Gå til datafordeler.dk → Ejendomme →
                      </a>
                    </div>
                  ) : (
                    <div className="bg-slate-800/30 border border-slate-700/40 rounded-xl p-4 text-center">
                      <BarChart3 size={24} className="text-slate-600 mx-auto mb-2" />
                      <p className="text-slate-400 text-xs">
                        Ingen vurderingsdata fundet via Datafordeler
                      </p>
                    </div>
                  )}
                </div>

                {/* ── Salgshistorik — coming soon ── */}
                <div className="bg-slate-800/20 border border-slate-700/30 rounded-xl p-4">
                  <p className="text-slate-400 text-xs font-medium uppercase tracking-wider mb-1">
                    Salgshistorik
                  </p>
                  <p className="text-slate-500 text-xs">
                    Historiske handelspriser hentes via Tinglysning.dk (backlog).
                  </p>
                </div>
              </div>
            )}

            {/* ══ DOKUMENTER ══ */}
            {aktivTab === 'dokumenter' && (
              <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl p-6 text-center">
                <FileText size={32} className="text-slate-600 mx-auto mb-3" />
                <p className="text-slate-300 text-sm font-medium mb-1">Dokumenter</p>
                <p className="text-slate-500 text-xs leading-relaxed max-w-sm mx-auto">
                  Tingbogsattester og BBR-meddelelser genereres automatisk når tinglysning- og
                  BBR-abonnement er aktiveret.
                </p>
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
          <div className="flex-shrink-0" style={{ width: kortBredde }}>
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
                bygningPunkter={bbrData?.bygningPunkter ?? undefined}
              />
            </Suspense>
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

          <button className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700/60 rounded-lg text-slate-300 text-sm transition-all">
            <Bell size={14} />
            Følg
          </button>
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
              BBR
          ══════════════════════════════════════════ */}
            {aktivTab === 'bbr' && (
              <div className="space-y-6">
                {/* Jordstykker */}
                <div>
                  <SectionTitle title="Jordstykker" />
                  {/* Stat-kort */}
                  <div className="grid grid-cols-3 gap-3 mb-3">
                    <DataKort label="Jordstykker" value={`${ejendom.jordstykker?.length ?? 1}`} />
                    <DataKort
                      label="Registreret areal"
                      value={`${ejendom.grundareal.toLocaleString('da-DK')} m²`}
                    />
                    <DataKort
                      label="Matrikelkommunekode"
                      value={ejendom.matrikelNummer.split(',')[0] ?? '—'}
                    />
                  </div>

                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                    <table className="w-full">
                      <thead>
                        <tr className="text-slate-500 text-xs border-b border-slate-700/30">
                          <th className="px-4 py-2 text-left font-medium">Matrikelnummer</th>
                          <th className="px-4 py-2 text-left font-medium">Ejerlavsnavn</th>
                          <th className="px-4 py-2 text-right font-medium">
                            <span className="flex items-center justify-end gap-1">
                              <Map size={11} />
                              Registreret areal
                            </span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {(ejendom.jordstykker ?? []).map((js, i) => (
                          <tr
                            key={i}
                            className="border-t border-slate-700/30 hover:bg-slate-700/20 transition-colors"
                          >
                            <td className="px-4 py-3 text-slate-200 text-sm font-medium">
                              {js.matrikelNummer}
                            </td>
                            <td className="px-4 py-3 text-slate-300 text-sm">{js.ejerlavsnavn}</td>
                            <td className="px-4 py-3 text-slate-300 text-sm text-right">
                              {js.registreretAreal.toLocaleString('da-DK')} m²
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Bygninger */}
                <div>
                  <SectionTitle title="Bygninger" />
                  <div className="grid grid-cols-3 gap-3 mb-3">
                    <DataKort label="Bygninger" value={`${ejendom.bygninger.length}`} />
                    <DataKort
                      label="Samlet bygningsareal"
                      value={`${ejendom.bygningsareal.toLocaleString('da-DK')} m²`}
                    />
                    <DataKort label="Opførelsesår" value={`${ejendom.opfoerelsesaar}`} />
                  </div>

                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                    <table className="w-full">
                      <thead>
                        <tr className="text-slate-500 text-xs border-b border-slate-700/30">
                          <th className="px-4 py-2 text-left font-medium">Anvendelse</th>
                          <th className="px-4 py-2 text-left font-medium">Opførelsesår</th>
                          <th className="px-4 py-2 text-right font-medium">Bebygget areal</th>
                          <th className="px-4 py-2 text-right font-medium">Samlet areal</th>
                          <th className="px-2 py-2 text-right font-medium">Energi</th>
                          <th className="px-2 py-2"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {ejendom.bygninger.map((b) => (
                          <tr
                            key={b.id}
                            className="border-t border-slate-700/30 hover:bg-slate-700/20 transition-colors"
                          >
                            <td className="px-4 py-3 text-slate-200 text-sm">{b.anvendelse}</td>
                            <td className="px-4 py-3 text-slate-300 text-sm">{b.opfoerelsesaar}</td>
                            <td className="px-4 py-3 text-slate-300 text-sm text-right">
                              {b.bygningsareal.toLocaleString('da-DK')} m²
                            </td>
                            <td className="px-4 py-3 text-slate-300 text-sm text-right">
                              {(b.bygningsareal + b.kaelder).toLocaleString('da-DK')} m²
                            </td>
                            <td className="px-2 py-3 text-right">
                              <span
                                className={`inline-flex px-1.5 py-0.5 rounded text-xs font-bold text-white ${energiColor[b.energimaerke] ?? 'bg-slate-600'}`}
                              >
                                {b.energimaerke}
                              </span>
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

                {/* Enheder */}
                <div>
                  <SectionTitle title="Enheder" />
                  <div className="grid grid-cols-3 gap-3 mb-3">
                    <DataKort
                      label="Enheder i alt"
                      value={`${ejendom.erhvervsenheder + ejendom.beboelsesenheder}`}
                    />
                    <DataKort label="Erhvervsenheder" value={`${ejendom.erhvervsenheder}`} />
                    <DataKort label="Beboelsesenheder" value={`${ejendom.beboelsesenheder}`} />
                  </div>

                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                    <table className="w-full">
                      <thead>
                        <tr className="text-slate-500 text-xs border-b border-slate-700/30">
                          <th className="px-4 py-2 text-left font-medium">Adresse</th>
                          <th className="px-4 py-2 text-left font-medium">Anvendelse</th>
                          <th className="px-4 py-2 text-right font-medium">Værelser</th>
                          <th className="px-4 py-2 text-right font-medium">Samlet areal</th>
                          <th className="px-2 py-2"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {(ejendom.enheder ?? []).map((enhed, i) => (
                          <tr
                            key={i}
                            className="border-t border-slate-700/30 hover:bg-slate-700/20 transition-colors"
                          >
                            <td className="px-4 py-3 text-slate-200 text-sm">{enhed.adresse}</td>
                            <td className="px-4 py-3 text-slate-300 text-sm">{enhed.anvendelse}</td>
                            <td className="px-4 py-3 text-slate-300 text-sm text-right">
                              {enhed.vaerelser ?? '—'}
                            </td>
                            <td className="px-4 py-3 text-slate-300 text-sm text-right">
                              {enhed.samletAreal.toLocaleString('da-DK')} m²
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

                {/* Tekniske anlæg */}
                <div>
                  <SectionTitle title="Tekniske anlæg" />
                  <div className="grid grid-cols-2 gap-3">
                    <DataKort
                      label="Tekniske anlæg"
                      value={`${ejendom.tekniskeAnlaeg ?? 0} Tekniske anlæg`}
                    />
                  </div>
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

            {/* ══════════════════════════════════════════
              DOKUMENTER
          ══════════════════════════════════════════ */}
            {aktivTab === 'dokumenter' && (
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
                    { id: 'std-8', navn: 'Ejendomsskat (fra OIS)', sub: null, link: false },
                    { id: 'std-9', navn: 'SKAT Ejendomsvurdering', sub: null, link: false },
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
                      navn: `Indskannet akt nr. ${ejendom.tingbogsattest?.aktNummer ?? '7_CO21'}`,
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

          {/* Download-bar — kun synlig på Dokumenter-tab */}
          {aktivTab === 'dokumenter' && (
            <div className="border-t border-slate-700/50 px-6 py-3 flex items-center justify-between bg-slate-900/80 backdrop-blur-sm">
              <span className="text-slate-400 text-sm">
                <span className="text-white font-semibold">{valgteDoc.size}</span> dokumenter valgt
              </span>
              <button
                disabled={valgteDoc.size === 0}
                className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed border border-slate-600 rounded-lg text-slate-300 text-sm font-medium transition-all"
              >
                Download dokumenter
                <Download size={14} />
              </button>
            </div>
          )}
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
          <div className="flex flex-shrink-0" style={{ width: kortBredde }}>
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
        )}
      </div>
    </div>
  );
}
