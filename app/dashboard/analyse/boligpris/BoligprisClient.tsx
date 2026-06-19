/**
 * BoligprisClient — Interaktivt boligpris dashboard.
 *
 * BIZZ-2029: Samler KPI-cards, boligtype-filtre, prisudvikling-chart,
 * kommune-breakdown og seneste handler-tabel.
 *
 * Lazy-loader Recharts via next/dynamic (ssr: false).
 *
 * @module app/dashboard/analyse/boligpris/BoligprisClient
 */

'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import dynamic from 'next/dynamic';
import {
  TrendingUp,
  TrendingDown,
  Loader2,
  BarChart3,
  Hash,
  Ruler,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  MapPin,
  Download,
  Calendar,
  Layers,
  BedDouble,
} from 'lucide-react';

import ResizableDivider from '@/app/components/ResizableDivider';

/* Lazy-load chart + kort — kræver browser DOM */
const BoligprisChart = dynamic(() => import('./BoligprisChart'), { ssr: false });
const KommuneKort = dynamic(() => import('./KommuneKort'), { ssr: false });

/** Kort-panel bredde (default/min/max) */
const MAP_DEFAULT_WIDTH = 760;
const MAP_MIN_WIDTH = 300;
const MAP_MAX_WIDTH = 1000;

/** Sorterbare kolonner i handler-tabellen */
type HandlerSortKey = 'dato' | 'adresse' | 'boligtype' | 'areal' | 'pris' | 'm2_pris' | 'kommune';

/* ---------- Typer ---------- */

interface Tidsserie {
  maaned: string;
  antal_handler: number;
  avg_pris: number;
  avg_m2_pris: number;
}

interface Noegletal {
  antal_handler: number;
  avg_pris: number;
  avg_m2_pris: number;
  yoy_pct: number | null;
}

interface KommuneRow {
  kommune_kode: number;
  antal_handler: number;
  avg_pris: number;
  avg_m2_pris: number;
}

interface HandelRow {
  bfe_nummer: number;
  dato: string;
  pris: number;
  m2_pris: number | null;
  areal: number | null;
  boligtype: string | null;
  kommune_kode: number | null;
  adresse: string | null;
  kommune: string | null;
}

interface ApiResponse {
  tidsserier: Tidsserie[];
  noegletal: Noegletal;
  kommuneBreakdown: KommuneRow[];
  boligtypeLabels: Record<string, string>;
  handler?: HandelRow[];
  handlerTotal?: number;
}

/* ---------- Boligtype-chips ---------- */

/** Erhverv-chippens samlede kode-bundt (alle erhvervs-anvendelseskoder). */
const ERHVERV_KODE = '210,220,230,290,310,320,323,330';

const BOLIGTYPER = [
  { kode: '110,120', label: 'Enfamiliehus' },
  { kode: '130,131,132', label: 'Rækkehus' },
  { kode: '140', label: 'Etagebolig / Lejlighed' },
  { kode: ERHVERV_KODE, label: 'Erhverv' },
  { kode: '410,510,520,530,540,585,590', label: 'Fritidshus / Kolonihave' },
];

/** Under-typer for Erhverv — lader brugeren indsnævre fx kun Detailhandel/Industri. */
const ERHVERV_SUB = [
  { kode: '210', label: 'Kontor' },
  { kode: '220', label: 'Detailhandel' },
  { kode: '230', label: 'Lager' },
  { kode: '320', label: 'Industri' },
  { kode: '310', label: 'Transport' },
  { kode: '330', label: 'Landbrug' },
  { kode: '290', label: 'Øvrig erhverv' },
  { kode: '323', label: 'Kraftværk' },
];

/**
 * Bygger den flade boligtype-kodeliste til API'et. Når Erhverv-chippen er valgt
 * og der er valgt en eller flere erhvervs-undertyper, erstattes hele erhvervs-
 * bundtet med kun de valgte undertyper — ellers bruges chippens fulde kodeliste.
 *
 * @param selectedTypes - Valgte boligtype-chips (komma-separerede kode-strenge)
 * @param erhvervSub - Valgte erhvervs-undertyper (enkeltkoder)
 * @returns Komma-separeret CSV af anvendelseskoder (tom streng hvis intet valgt)
 */
function buildBoligtyperParam(selectedTypes: Set<string>, erhvervSub: Set<string>): string {
  const codes: string[] = [];
  for (const t of selectedTypes) {
    if (t === ERHVERV_KODE && erhvervSub.size > 0) {
      codes.push(...Array.from(erhvervSub));
    } else {
      codes.push(...t.split(','));
    }
  }
  return codes.join(',');
}

/* ---------- Tidsperioder ---------- */

const PERIODER = [
  { label: '1 år', months: 12 },
  { label: '3 år', months: 36 },
  { label: '5 år', months: 60 },
  { label: '10 år', months: 120 },
  { label: 'Alt', months: 0 },
];

/* ---------- Formatering ---------- */

/** Dansk talformatering. */
function fmtDkk(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)} mio.`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}t`;
  return v.toLocaleString('da-DK');
}

/** Formatér dato til dansk kort-format. */
function fmtDato(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('da-DK', { year: 'numeric', month: 'short', day: 'numeric' });
}

/* ---------- Komponent ---------- */

/**
 * BoligprisClient — dashboard med filtre, KPI, chart og handler-tabel.
 *
 * @returns React element
 */
export default function BoligprisClient(): React.ReactElement {
  /* --- State --- */
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [selectedErhvervSub, setSelectedErhvervSub] = useState<Set<string>>(new Set());
  const [selectedKommuner, setSelectedKommuner] = useState<Set<number>>(new Set());
  const [periodeIdx, setPeriodeIdx] = useState(0);
  const [customFra, setCustomFra] = useState('');
  const [customTil, setCustomTil] = useState('');
  const [postnr, setPostnr] = useState('');
  const [arealMin, setArealMin] = useState('');
  const [arealMax, setArealMax] = useState('');
  const [byggearMin, setByggearMin] = useState('');
  const [byggearMax, setByggearMax] = useState('');
  // BIZZ-2070: etager/værelser-filtre (data backfillet via BBR v2-pipeline)
  const [etagerMin, setEtagerMin] = useState('');
  const [etagerMax, setEtagerMax] = useState('');
  const [vaerelserMin, setVaerelserMin] = useState('');
  const [vaerelserMax, setVaerelserMax] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [handlerPage, setHandlerPage] = useState(0);
  const [handlerPageSize, setHandlerPageSize] = useState(50);
  const [mapWidth, setMapWidth] = useState(MAP_DEFAULT_WIDTH);
  const [kommuneNavne, setKommuneNavne] = useState<Record<number, string>>({});
  const [sortKey, setSortKey] = useState<HandlerSortKey>('dato');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [exporting, setExporting] = useState(false);

  /* --- Dato-beregning: brugerdefineret interval har forrang over preset ---
     BIZZ-2180: et ENKELT brugersat datofelt skal også virke. Tidligere krævede
     customActive BEGGE felter, så fx kun en startdato (uden slutdato) blev
     stiltiende ignoreret og preset-perioden brugt — brugeren oplevede at
     dato-ændringer "ikke virkede". Nu overstyrer hvert sat felt sin side af
     preset-intervallet uafhængigt. */
  const customActive = customFra !== '' || customTil !== '';
  const { fra, til } = useMemo(() => {
    const now = new Date();
    const tilStr = now.toISOString().slice(0, 10);
    const months = PERIODER[periodeIdx].months;
    // Preset-baseline for den/de side(r) brugeren IKKE har sat manuelt.
    const presetFra =
      months === 0
        ? '2000-01-01'
        : new Date(now.getFullYear(), now.getMonth() - months, 1).toISOString().slice(0, 10);
    return {
      fra: customFra || presetFra,
      til: customTil || tilStr,
    };
  }, [periodeIdx, customFra, customTil]);

  /* --- Dynamiske side-størrelser til "Vis"-dropdownen ---
     Standard-trin tilbydes kun når de er mindre end det totale antal handler,
     og der tilføjes altid en "Alle (N)"-mulighed (capped til 20000, som er
     route'ens hårde loft for handler-eksport). Dermed slipper brugeren for at
     paginere gennem fx 745 Valby-handler manuelt. */
  const pageSizeOptions = useMemo(() => {
    const total = data?.handlerTotal ?? 0;
    const alle = Math.min(total, 20000);
    const opts = [10, 50, 100, 250, 500, 1000].filter((s) => s < alle);
    return { opts, alle };
  }, [data?.handlerTotal]);

  /* --- Fetch data --- */
  const fetchData = useCallback(
    async (includeHandler = true, offset = 0, limit = 50) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        params.set('fra', fra);
        params.set('til', til);
        if (selectedTypes.size > 0) {
          params.set('boligtyper', buildBoligtyperParam(selectedTypes, selectedErhvervSub));
        }
        if (selectedKommuner.size > 0) {
          params.set('kommuner', Array.from(selectedKommuner).join(','));
        }
        if (postnr.trim()) {
          params.set('postnumre', postnr.trim());
        }
        if (arealMin) params.set('areal_min', arealMin);
        if (arealMax) params.set('areal_max', arealMax);
        if (byggearMin) params.set('byggear_min', byggearMin);
        if (byggearMax) params.set('byggear_max', byggearMax);
        if (etagerMin) params.set('etager_min', etagerMin);
        if (etagerMax) params.set('etager_max', etagerMax);
        if (vaerelserMin) params.set('vaerelser_min', vaerelserMin);
        if (vaerelserMax) params.set('vaerelser_max', vaerelserMax);
        if (includeHandler) {
          params.set('handler', 'true');
          params.set('limit', String(limit));
          params.set('offset', String(offset));
        }

        const res = await fetch(`/api/analyse/boligpris?${params.toString()}`);
        if (!res.ok) {
          if (res.status === 401) throw new Error('Ikke logget ind');
          if (res.status === 403) throw new Error('Ingen adgang til dette modul');
          throw new Error('Kunne ikke hente data');
        }
        const json: ApiResponse = await res.json();
        setData(json);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Ukendt fejl');
      } finally {
        setLoading(false);
      }
    },
    [
      fra,
      til,
      selectedTypes,
      selectedErhvervSub,
      selectedKommuner,
      postnr,
      arealMin,
      arealMax,
      byggearMin,
      byggearMax,
      etagerMin,
      etagerMax,
      vaerelserMin,
      vaerelserMax,
    ]
  );

  /* Auto-fetch ved filter-ændring (debounced for postnr-input) */
  useEffect(() => {
    const timer = setTimeout(
      () => {
        setHandlerPage(0);
        fetchData(true, 0, handlerPageSize);
      },
      postnr ? 500 : 0
    );
    return () => clearTimeout(timer);
  }, [fetchData, handlerPageSize, postnr]);

  /* Kommune-navne hentes direkte fra GeoJSON ved mount — UAFHÆNGIGT af om
     WebGL-kortet rendrer. Tidligere kom navnene kun via KommuneKort's
     onNamesLoaded (map.on('load')), så hvis kortet ikke kunne tegnes (fx WebGL
     deaktiveret i browseren) faldt "Top kommuner" tilbage til at vise rå
     kommune-koder i stedet for navne. */
  useEffect(() => {
    let cancelled = false;
    fetch('/geo/kommuner.geojson')
      .then((r) => (r.ok ? r.json() : null))
      .then((geojson) => {
        if (cancelled || !geojson?.features) return;
        const navne: Record<number, string> = {};
        for (const f of geojson.features) {
          navne[Number(f.properties.kode)] = f.properties.navn;
        }
        setKommuneNavne(navne);
      })
      .catch(() => {
        /* Stille fallback — tabellen viser koder hvis GeoJSON ikke kan hentes. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* --- Toggle kommune (fra kort) --- */
  const toggleKommune = useCallback((kode: number) => {
    setSelectedKommuner((prev) => {
      const next = new Set(prev);
      if (next.has(kode)) next.delete(kode);
      else next.add(kode);
      return next;
    });
  }, []);

  /* --- Toggle boligtype chip --- */
  const toggleType = useCallback((kode: string) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(kode)) next.delete(kode);
      else next.add(kode);
      return next;
    });
    // Erhverv-chippen nulstiller sit under-filter når den slås til/fra.
    if (kode === ERHVERV_KODE) setSelectedErhvervSub(new Set());
  }, []);

  /* --- Toggle erhvervs-undertype --- */
  const toggleErhvervSub = useCallback((kode: string) => {
    setSelectedErhvervSub((prev) => {
      const next = new Set(prev);
      if (next.has(kode)) next.delete(kode);
      else next.add(kode);
      return next;
    });
  }, []);

  /* --- Handler paginering --- */
  const handlePageChange = useCallback(
    (newPage: number) => {
      setHandlerPage(newPage);
      fetchData(true, newPage * handlerPageSize, handlerPageSize);
    },
    [fetchData, handlerPageSize]
  );

  // Handler vises ufiltreret — KPI (MV) og handler (ejerskifte_historik) bruger
  // forskellige datakilder med forskellig BBR-type-coverage. Client-side filter
  // gav 0 resultater for mange kombinationer og skabte mere forvirring.
  const filteredHandler = data?.handler;

  /* --- Sortering af handler-tabel (default dato faldende; klikbare overskrifter) --- */
  const sortedHandler = useMemo(() => {
    if (!filteredHandler) return filteredHandler;
    const dir = sortDir === 'asc' ? 1 : -1;
    // Numeriske kolonner sammenlignes som tal, øvrige som streng/dato
    const numeric: Set<HandlerSortKey> = new Set(['areal', 'pris', 'm2_pris']);
    return [...filteredHandler].sort((a, b) => {
      if (sortKey === 'dato') {
        return (
          ((a.dato ?? '') < (b.dato ?? '') ? -1 : (a.dato ?? '') > (b.dato ?? '') ? 1 : 0) * dir
        );
      }
      if (numeric.has(sortKey)) {
        const av = Number(a[sortKey]) || 0;
        const bv = Number(b[sortKey]) || 0;
        return (av - bv) * dir;
      }
      const av = String(a[sortKey] ?? '');
      const bv = String(b[sortKey] ?? '');
      return av.localeCompare(bv, 'da-DK') * dir;
    });
  }, [filteredHandler, sortKey, sortDir]);

  /* --- Skift sortering: samme kolonne vender retning, ny kolonne nulstiller --- */
  const toggleSort = useCallback((key: HandlerSortKey) => {
    setSortKey((prevKey) => {
      if (prevKey === key) {
        // Samme kolonne: vend retning
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return prevKey;
      }
      // Ny kolonne: dato/tal starter faldende, tekst stigende
      setSortDir(
        key === 'dato' || key === 'areal' || key === 'pris' || key === 'm2_pris' ? 'desc' : 'asc'
      );
      return key;
    });
  }, []);

  /* --- Excel-eksport (CSV med semikolon + UTF-8 BOM) --- */
  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      // Hent ALLE matchende rækker (op til 20000) så eksporterede linjer matcher
      // de aktive filtre — ingen række-markering, hele resultatet eksporteres.
      const params = new URLSearchParams();
      params.set('fra', fra);
      params.set('til', til);
      if (selectedTypes.size > 0)
        params.set('boligtyper', buildBoligtyperParam(selectedTypes, selectedErhvervSub));
      if (selectedKommuner.size > 0) params.set('kommuner', Array.from(selectedKommuner).join(','));
      if (postnr.trim()) params.set('postnumre', postnr.trim());
      if (arealMin) params.set('areal_min', arealMin);
      if (arealMax) params.set('areal_max', arealMax);
      if (byggearMin) params.set('byggear_min', byggearMin);
      if (byggearMax) params.set('byggear_max', byggearMax);
      if (etagerMin) params.set('etager_min', etagerMin);
      if (etagerMax) params.set('etager_max', etagerMax);
      if (vaerelserMin) params.set('vaerelser_min', vaerelserMin);
      if (vaerelserMax) params.set('vaerelser_max', vaerelserMax);
      params.set('handler', 'true');
      params.set('export', 'true');
      const res = await fetch(`/api/analyse/boligpris?${params.toString()}`);
      if (!res.ok) throw new Error('Eksport fejlede');
      const json: ApiResponse = await res.json();
      const rows: HandelRow[] = json.handler ?? [];

      // Byg CSV — semikolon-separeret, UTF-8 BOM (Excel-kompatibel dansk)
      const esc = (v: string | number | null): string => {
        const s = v === null || v === undefined ? '' : String(v);
        return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = [
        'Dato',
        'Adresse',
        'Type',
        'Areal (m²)',
        'Pris (kr)',
        'm²-pris (kr)',
        'Kommune',
        'BFE',
      ];
      const lines = [header.join(';')];
      for (const h of rows) {
        lines.push(
          [
            esc(h.dato ?? ''),
            esc(h.adresse ?? ''),
            esc(h.boligtype ?? ''),
            esc(h.areal ?? ''),
            esc(h.pris ?? ''),
            esc(h.m2_pris ?? ''),
            esc(h.kommune ?? ''),
            esc(h.bfe_nummer ?? ''),
          ].join(';')
        );
      }
      const csv = '\uFEFF' + lines.join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `boligpris-handler-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Eksport fejlede');
    } finally {
      setExporting(false);
    }
  }, [
    fra,
    til,
    selectedTypes,
    selectedErhvervSub,
    selectedKommuner,
    postnr,
    arealMin,
    arealMax,
    byggearMin,
    byggearMax,
    etagerMin,
    etagerMax,
    vaerelserMin,
    vaerelserMax,
  ]);

  return (
    <div className="flex-1 bg-[#0a1628] min-h-screen">
      {/* Header */}
      <div className="px-6 pt-6 pb-2">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <TrendingUp className="w-6 h-6 text-emerald-400" />
          Ejendomspris Dashboard
        </h1>
        <p className="text-slate-400 mt-1">
          Prisudvikling og gennemsnitspriser pr. kommune — baseret på registrerede bolighandler
        </p>
      </div>

      {/* Split layout: venstre data + højre kort */}
      <div className="flex items-stretch" style={{ height: 'calc(100vh - 140px)' }}>
        {/* VENSTRE: Data-panel */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-32 space-y-6">
          {/* Filtre: boligtype chips + periode */}
          <div className="flex flex-wrap items-center gap-3">
            {/* Boligtype chips */}
            <div className="flex flex-wrap gap-2">
              {BOLIGTYPER.map((bt) => (
                <button
                  key={bt.kode}
                  onClick={() => toggleType(bt.kode)}
                  aria-pressed={selectedTypes.has(bt.kode)}
                  className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                    selectedTypes.has(bt.kode)
                      ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40'
                      : 'bg-slate-800/60 text-slate-300 hover:bg-slate-700/60'
                  }`}
                >
                  {bt.label}
                </button>
              ))}
            </div>

            {/* Separator */}
            <div className="w-px h-8 bg-slate-700/50" />

            {/* Periode-knapper */}
            <div className="flex gap-1">
              {PERIODER.map((p, idx) => (
                <button
                  key={p.label}
                  onClick={() => {
                    setPeriodeIdx(idx);
                    // Preset rydder et evt. brugerdefineret interval.
                    setCustomFra('');
                    setCustomTil('');
                  }}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    periodeIdx === idx && !customActive
                      ? 'bg-blue-500/20 text-blue-300 ring-1 ring-blue-500/40'
                      : 'bg-slate-800/60 text-slate-300 hover:bg-slate-700/60'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {/* Brugerdefineret dato-interval — vinder over preset når begge er sat */}
            <div
              className={`flex items-center gap-1.5 text-xs rounded-lg px-2 py-1 transition-colors ${
                customActive ? 'ring-1 ring-blue-500/40 bg-blue-500/10' : ''
              }`}
            >
              <Calendar className="w-3.5 h-3.5 text-slate-400" />
              <input
                type="date"
                value={customFra}
                max={customTil || undefined}
                onChange={(e) => setCustomFra(e.target.value)}
                className="bg-slate-800/60 border border-slate-700/50 rounded-lg px-2 py-1.5 text-sm text-slate-200 [color-scheme:dark] w-36"
                aria-label="Fra-dato (brugerdefineret interval)"
              />
              <span className="text-slate-400">–</span>
              <input
                type="date"
                value={customTil}
                min={customFra || undefined}
                onChange={(e) => setCustomTil(e.target.value)}
                className="bg-slate-800/60 border border-slate-700/50 rounded-lg px-2 py-1.5 text-sm text-slate-200 [color-scheme:dark] w-36"
                aria-label="Til-dato (brugerdefineret interval)"
              />
              {customActive && (
                <button
                  onClick={() => {
                    setCustomFra('');
                    setCustomTil('');
                  }}
                  className="text-slate-400 hover:text-slate-200 transition-colors px-1"
                  aria-label="Ryd brugerdefineret dato-interval"
                >
                  ✕
                </button>
              )}
            </div>

            {/* Separator */}
            <div className="w-px h-8 bg-slate-700/50" />

            {/* Kommune-filter tags — én pr. valgt kommune */}
            {Array.from(selectedKommuner).map((kode) => (
              <button
                key={kode}
                onClick={() => {
                  setSelectedKommuner((prev) => {
                    const next = new Set(prev);
                    next.delete(kode);
                    return next;
                  });
                }}
                className="px-3 py-1.5 rounded-full text-sm font-medium bg-blue-500/20 text-blue-300 ring-1 ring-blue-500/40 hover:bg-blue-500/30 transition-colors"
              >
                {kommuneNavne[kode] ?? kode} ✕
              </button>
            ))}

            {/* Postnr-filter */}
            <div className="flex items-center gap-2">
              <MapPin className="w-4 h-4 text-slate-400" />
              <input
                type="text"
                value={postnr}
                onChange={(e) => setPostnr(e.target.value)}
                placeholder="Postnr (fx 2100,2200)"
                className="bg-slate-800/60 border border-slate-700/50 rounded-lg px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-500 w-44"
                aria-label="Filtrer på postnummer"
              />
            </div>

            {/* BBR-filtre: areal + byggeår */}
            <div className="w-px h-8 bg-slate-700/50" />
            <div className="flex items-center gap-1.5 text-xs">
              <Ruler className="w-3.5 h-3.5 text-slate-400" />
              <input
                type="number"
                value={arealMin}
                onChange={(e) => setArealMin(e.target.value)}
                placeholder="m² min"
                className="bg-slate-800/60 border border-slate-700/50 rounded-lg px-2 py-1.5 text-sm text-slate-200 placeholder:text-slate-500 w-20"
                aria-label="Minimum boligareal"
              />
              <span className="text-slate-500">–</span>
              <input
                type="number"
                value={arealMax}
                onChange={(e) => setArealMax(e.target.value)}
                placeholder="m² max"
                className="bg-slate-800/60 border border-slate-700/50 rounded-lg px-2 py-1.5 text-sm text-slate-200 placeholder:text-slate-500 w-20"
                aria-label="Maksimum boligareal"
              />
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <Hash className="w-3.5 h-3.5 text-slate-400" />
              <input
                type="number"
                value={byggearMin}
                onChange={(e) => setByggearMin(e.target.value)}
                placeholder="Byggeår fra"
                className="bg-slate-800/60 border border-slate-700/50 rounded-lg px-2 py-1.5 text-sm text-slate-200 placeholder:text-slate-500 w-24"
                aria-label="Minimum byggeår"
              />
              <span className="text-slate-500">–</span>
              <input
                type="number"
                value={byggearMax}
                onChange={(e) => setByggearMax(e.target.value)}
                placeholder="Byggeår til"
                className="bg-slate-800/60 border border-slate-700/50 rounded-lg px-2 py-1.5 text-sm text-slate-200 placeholder:text-slate-500 w-24"
                aria-label="Maksimum byggeår"
              />
            </div>
            {/* BIZZ-2070: etager + værelser filtre */}
            <div className="flex items-center gap-1.5 text-xs">
              <Layers className="w-3.5 h-3.5 text-slate-400" />
              <input
                type="number"
                value={etagerMin}
                onChange={(e) => setEtagerMin(e.target.value)}
                placeholder="Etager min"
                className="bg-slate-800/60 border border-slate-700/50 rounded-lg px-2 py-1.5 text-sm text-slate-200 placeholder:text-slate-500 w-24"
                aria-label="Minimum antal etager"
              />
              <span className="text-slate-500">–</span>
              <input
                type="number"
                value={etagerMax}
                onChange={(e) => setEtagerMax(e.target.value)}
                placeholder="Etager max"
                className="bg-slate-800/60 border border-slate-700/50 rounded-lg px-2 py-1.5 text-sm text-slate-200 placeholder:text-slate-500 w-24"
                aria-label="Maksimum antal etager"
              />
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <BedDouble className="w-3.5 h-3.5 text-slate-400" />
              <input
                type="number"
                value={vaerelserMin}
                onChange={(e) => setVaerelserMin(e.target.value)}
                placeholder="Værelser min"
                className="bg-slate-800/60 border border-slate-700/50 rounded-lg px-2 py-1.5 text-sm text-slate-200 placeholder:text-slate-500 w-28"
                aria-label="Minimum antal værelser"
              />
              <span className="text-slate-500">–</span>
              <input
                type="number"
                value={vaerelserMax}
                onChange={(e) => setVaerelserMax(e.target.value)}
                placeholder="Værelser max"
                className="bg-slate-800/60 border border-slate-700/50 rounded-lg px-2 py-1.5 text-sm text-slate-200 placeholder:text-slate-500 w-28"
                aria-label="Maksimum antal værelser"
              />
            </div>
          </div>

          {/* Erhverv-underfilter — vises kun når Erhverv-chippen er valgt.
              Lader brugeren indsnævre til fx kun Detailhandel eller Industri. */}
          {selectedTypes.has(ERHVERV_KODE) && (
            <div className="flex flex-wrap items-center gap-2 -mt-2">
              <span className="text-xs font-medium text-slate-400">Erhverv:</span>
              {ERHVERV_SUB.map((s) => (
                <button
                  key={s.kode}
                  onClick={() => toggleErhvervSub(s.kode)}
                  aria-pressed={selectedErhvervSub.has(s.kode)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                    selectedErhvervSub.has(s.kode)
                      ? 'bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/40'
                      : 'bg-slate-800/60 text-slate-300 hover:bg-slate-700/60'
                  }`}
                >
                  {s.label}
                </button>
              ))}
              {selectedErhvervSub.size > 0 && (
                <button
                  onClick={() => setSelectedErhvervSub(new Set())}
                  className="text-xs text-slate-400 hover:text-slate-200 transition-colors px-1"
                  aria-label="Ryd erhvervs-underfilter"
                >
                  Ryd
                </button>
              )}
            </div>
          )}

          {/* Loading / Error */}
          {loading && !data && (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-8 h-8 animate-spin text-blue-400" />
              <span className="ml-3 text-slate-300">Henter prisdata…</span>
            </div>
          )}

          {/* Opdaterings-indikator ved filter-ændring (synlig i venstre datapanel,
              ikke skjult bag kortet) — viser tydeligt at dashboardet "tænker". */}
          {loading && data && (
            <div
              className="flex items-center gap-2.5 rounded-lg bg-blue-500/10 border border-blue-500/30 px-4 py-2.5"
              role="status"
              aria-live="polite"
            >
              <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
              <span className="text-sm font-medium text-blue-200">Opdaterer resultater…</span>
            </div>
          )}

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-red-300">
              {error}
            </div>
          )}

          {/* Resultater — dæmpes mens nye data hentes, så det er tydeligt at
              de viste tal er ved at blive opdateret. */}
          {data && (
            <div
              className={`space-y-6 transition-opacity duration-200 ${
                loading ? 'opacity-50' : 'opacity-100'
              }`}
            >
              {/* KPI Cards */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <KpiCard
                  icon={<Hash className="w-5 h-5" />}
                  label="Antal handler"
                  value={data.noegletal.antal_handler.toLocaleString('da-DK')}
                  color="blue"
                />
                <KpiCard
                  icon={<span className="text-sm font-bold">kr</span>}
                  label="Gns. pris"
                  value={`${fmtDkk(data.noegletal.avg_pris)} kr.`}
                  color="emerald"
                />
                <KpiCard
                  icon={<Ruler className="w-5 h-5" />}
                  label="Gns. m²-pris"
                  value={`${data.noegletal.avg_m2_pris.toLocaleString('da-DK')} kr/m²`}
                  color="amber"
                />
                <KpiCard
                  icon={
                    data.noegletal.yoy_pct !== null && data.noegletal.yoy_pct >= 0 ? (
                      <TrendingUp className="w-5 h-5" />
                    ) : (
                      <TrendingDown className="w-5 h-5" />
                    )
                  }
                  label="Ændring YoY"
                  value={
                    data.noegletal.yoy_pct !== null
                      ? `${data.noegletal.yoy_pct > 0 ? '+' : ''}${data.noegletal.yoy_pct}%`
                      : '–'
                  }
                  color={
                    data.noegletal.yoy_pct !== null && data.noegletal.yoy_pct >= 0
                      ? 'emerald'
                      : 'red'
                  }
                />
              </div>

              {/* Prisudvikling chart */}
              <div className="bg-slate-800/40 rounded-xl p-6">
                <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                  <BarChart3 className="w-5 h-5 text-blue-400" />
                  Prisudvikling
                </h2>
                {data.tidsserier.length > 0 ? (
                  <BoligprisChart tidsserier={data.tidsserier} />
                ) : (
                  <p className="text-slate-400 py-10 text-center">Ingen data for valgte filtre</p>
                )}
              </div>

              {/* Kommune-breakdown tabel (top 15) */}
              {data.kommuneBreakdown.length > 0 && (
                <div className="bg-slate-800/40 rounded-xl p-6">
                  <h2 className="text-lg font-semibold text-white mb-4">Top kommuner</h2>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-slate-400 border-b border-slate-700/50">
                          <th className="text-left py-2 pr-4">Kommune</th>
                          <th className="text-right py-2 px-4">Handler</th>
                          <th className="text-right py-2 px-4">Gns. pris</th>
                          <th className="text-right py-2 pl-4">Gns. m²-pris</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.kommuneBreakdown.slice(0, 15).map((k) => (
                          <tr
                            key={k.kommune_kode}
                            className="border-b border-slate-700/20 hover:bg-slate-700/20"
                          >
                            <td className="py-2 pr-4 text-slate-200">
                              {kommuneNavne[k.kommune_kode] ?? k.kommune_kode}
                            </td>
                            <td className="py-2 px-4 text-right text-slate-300">
                              {k.antal_handler.toLocaleString('da-DK')}
                            </td>
                            <td className="py-2 px-4 text-right text-slate-300">
                              {fmtDkk(k.avg_pris)} kr.
                            </td>
                            <td className="py-2 pl-4 text-right text-slate-300">
                              {k.avg_m2_pris.toLocaleString('da-DK')} kr/m²
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Seneste handler */}
              {data.handler && (
                <div className="bg-slate-800/40 rounded-xl p-6">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <h2 className="text-lg font-semibold text-white">Seneste handler</h2>
                      {data.handlerTotal !== undefined && (
                        <span className="text-xs text-slate-400 bg-slate-700/40 px-2 py-0.5 rounded-full">
                          {data.handlerTotal.toLocaleString('da-DK')} i alt
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleExport}
                        disabled={exporting || !data.handlerTotal}
                        className="flex items-center gap-1.5 bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40 text-sm font-medium rounded-lg px-3 py-1 hover:bg-emerald-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        aria-label="Eksportér handler til Excel"
                      >
                        {exporting ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Download className="w-4 h-4" />
                        )}
                        Eksportér alle til Excel
                      </button>
                      <span className="text-sm text-slate-400">Vis:</span>
                      <select
                        value={
                          pageSizeOptions.alle > 0 && handlerPageSize > pageSizeOptions.alle
                            ? pageSizeOptions.alle
                            : handlerPageSize
                        }
                        onChange={(e) => {
                          setHandlerPageSize(Number(e.target.value));
                          setHandlerPage(0);
                        }}
                        className="bg-slate-700/60 text-slate-200 text-sm rounded-lg px-2 py-1 border border-slate-600/50"
                        aria-label="Antal handler per side"
                      >
                        {pageSizeOptions.opts.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                        {pageSizeOptions.alle > 0 && (
                          <option value={pageSizeOptions.alle}>
                            Alle ({pageSizeOptions.alle.toLocaleString('da-DK')})
                          </option>
                        )}
                      </select>
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-slate-400 border-b border-slate-700/50">
                          <SortHeader
                            label="Dato"
                            sortKey="dato"
                            align="left"
                            className="pr-4"
                            activeKey={sortKey}
                            dir={sortDir}
                            onSort={toggleSort}
                          />
                          <SortHeader
                            label="Adresse"
                            sortKey="adresse"
                            align="left"
                            className="px-4"
                            activeKey={sortKey}
                            dir={sortDir}
                            onSort={toggleSort}
                          />
                          <SortHeader
                            label="Type"
                            sortKey="boligtype"
                            align="left"
                            className="px-4"
                            activeKey={sortKey}
                            dir={sortDir}
                            onSort={toggleSort}
                          />
                          <SortHeader
                            label="Areal"
                            sortKey="areal"
                            align="right"
                            className="px-4"
                            activeKey={sortKey}
                            dir={sortDir}
                            onSort={toggleSort}
                          />
                          <SortHeader
                            label="Pris"
                            sortKey="pris"
                            align="right"
                            className="px-4"
                            activeKey={sortKey}
                            dir={sortDir}
                            onSort={toggleSort}
                          />
                          <SortHeader
                            label="m²-pris"
                            sortKey="m2_pris"
                            align="right"
                            className="px-4"
                            activeKey={sortKey}
                            dir={sortDir}
                            onSort={toggleSort}
                          />
                          <SortHeader
                            label="Kommune"
                            sortKey="kommune"
                            align="left"
                            className="pl-4"
                            activeKey={sortKey}
                            dir={sortDir}
                            onSort={toggleSort}
                          />
                        </tr>
                      </thead>
                      <tbody>
                        {(sortedHandler ?? []).map((h, idx) => {
                          return (
                            <tr
                              key={`${h.bfe_nummer}-${idx}`}
                              className="border-b border-slate-700/20 hover:bg-slate-700/20 cursor-pointer"
                              onClick={() =>
                                window.open(`/dashboard/ejendomme/${h.bfe_nummer}`, '_blank')
                              }
                              role="link"
                              tabIndex={0}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter')
                                  window.open(`/dashboard/ejendomme/${h.bfe_nummer}`, '_blank');
                              }}
                            >
                              <td className="py-2 pr-4 text-slate-300 whitespace-nowrap">
                                {h.dato ? fmtDato(h.dato) : '–'}
                              </td>
                              <td className="py-2 px-4 text-slate-200 max-w-[250px] truncate">
                                {h.adresse ?? '–'}
                              </td>
                              <td className="py-2 px-4 text-slate-300">{h.boligtype ?? '–'}</td>
                              <td className="py-2 px-4 text-right text-slate-300">
                                {h.areal ? `${h.areal} m²` : '–'}
                              </td>
                              <td className="py-2 px-4 text-right text-slate-200 font-medium">
                                {fmtDkk(h.pris)} kr.
                              </td>
                              <td className="py-2 px-4 text-right text-slate-300">
                                {h.m2_pris ? `${h.m2_pris.toLocaleString('da-DK')} kr/m²` : '–'}
                              </td>
                              <td className="py-2 pl-4 text-slate-300">{h.kommune ?? '–'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Paginering — sticky så den altid er synlig */}
                  {data.handlerTotal !== undefined && data.handlerTotal > handlerPageSize && (
                    <div className="flex items-center justify-between mt-4 pt-4 pb-2 border-t border-slate-700/30 sticky bottom-0 bg-[#0a1628]">
                      <span className="text-sm text-slate-400">
                        {handlerPage * handlerPageSize + 1}–
                        {Math.min((handlerPage + 1) * handlerPageSize, data.handlerTotal)} af{' '}
                        {data.handlerTotal.toLocaleString('da-DK')}
                      </span>
                      <div className="flex gap-2">
                        <button
                          onClick={() => handlePageChange(handlerPage - 1)}
                          disabled={handlerPage === 0}
                          className="p-1.5 rounded-lg bg-slate-700/40 text-slate-300 hover:bg-slate-600/40 disabled:opacity-30 disabled:cursor-not-allowed"
                          aria-label="Forrige side"
                        >
                          <ChevronLeft className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handlePageChange(handlerPage + 1)}
                          disabled={(handlerPage + 1) * handlerPageSize >= data.handlerTotal}
                          className="p-1.5 rounded-lg bg-slate-700/40 text-slate-300 hover:bg-slate-600/40 disabled:opacity-30 disabled:cursor-not-allowed"
                          aria-label="Næste side"
                        >
                          <ChevronRight className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Resizable divider */}
        <ResizableDivider
          width={mapWidth}
          minWidth={MAP_MIN_WIDTH}
          maxWidth={MAP_MAX_WIDTH}
          onChange={setMapWidth}
          ariaLabel="Juster kort-panel bredde"
        />

        {/* HØJRE: Kommune-kort */}
        <div className="flex-shrink-0 relative" style={{ width: mapWidth }}>
          <div className="absolute inset-0">
            {data ? (
              <KommuneKort
                kommuneBreakdown={data.kommuneBreakdown}
                selectedKommuner={selectedKommuner}
                onToggleKommune={toggleKommune}
                onNamesLoaded={setKommuneNavne}
              />
            ) : (
              <div className="w-full h-full bg-slate-800/20 flex items-center justify-center">
                <span className="text-slate-400 text-sm">Kort indlæses…</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- KPI Card ---------- */

/** Props for KpiCard. */
interface KpiCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: 'blue' | 'emerald' | 'amber' | 'red';
}

const COLOR_MAP: Record<string, string> = {
  blue: 'text-blue-400 bg-blue-500/10',
  emerald: 'text-emerald-400 bg-emerald-500/10',
  amber: 'text-amber-400 bg-amber-500/10',
  red: 'text-red-400 bg-red-500/10',
};

/**
 * KPI summary card med ikon og farvet accent.
 *
 * @param props - Ikon, label, formateret værdi og farve
 */
function KpiCard({ icon, label, value, color }: KpiCardProps) {
  const cls = COLOR_MAP[color] ?? COLOR_MAP.blue;
  return (
    <div className="bg-slate-800/40 rounded-xl p-4 flex items-start gap-3">
      <div className={`p-2 rounded-lg ${cls}`}>{icon}</div>
      <div>
        <p className="text-slate-400 text-xs uppercase tracking-wider">{label}</p>
        <p className="text-white text-lg font-semibold mt-0.5">{value}</p>
      </div>
    </div>
  );
}

/* ---------- Sorterbar kolonne-overskrift ---------- */

/** Props for SortHeader. */
interface SortHeaderProps {
  label: string;
  sortKey: HandlerSortKey;
  align: 'left' | 'right';
  className?: string;
  activeKey: HandlerSortKey;
  dir: 'asc' | 'desc';
  onSort: (key: HandlerSortKey) => void;
}

/**
 * Klikbar tabel-overskrift der sorterer handler-tabellen på den angivne kolonne.
 * Viser pil-ikon for aktiv sortering og dobbeltpil for inaktive kolonner.
 *
 * @param props - Label, sorteringsnøgle, justering og aktuel sorteringstilstand
 * @returns th-element med sorteringsknap
 */
function SortHeader({ label, sortKey, align, className, activeKey, dir, onSort }: SortHeaderProps) {
  const active = activeKey === sortKey;
  const justify = align === 'right' ? 'justify-end' : 'justify-start';
  const textAlign = align === 'right' ? 'text-right' : 'text-left';
  return (
    <th
      className={`${textAlign} py-2 ${className ?? ''}`}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`flex items-center gap-1 ${justify} w-full font-medium transition-colors hover:text-slate-200 ${active ? 'text-slate-200' : 'text-slate-400'}`}
        aria-label={`Sortér efter ${label}`}
      >
        {align === 'right' && <SortIcon active={active} dir={dir} />}
        {label}
        {align === 'left' && <SortIcon active={active} dir={dir} />}
      </button>
    </th>
  );
}

/**
 * Sorterings-indikator: aktiv kolonne viser op/ned-pil, inaktiv viser dobbeltpil.
 *
 * @param props - Om kolonnen er aktiv og sorteringsretning
 * @returns Lucide-ikon
 */
function SortIcon({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) {
  if (!active) return <ChevronsUpDown className="w-3.5 h-3.5 opacity-50" />;
  return dir === 'asc' ? (
    <ChevronUp className="w-3.5 h-3.5" />
  ) : (
    <ChevronDown className="w-3.5 h-3.5" />
  );
}
