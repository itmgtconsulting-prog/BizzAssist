/**
 * RegnskabstalTable — Regnskabsdata i tabelformat med år-kolonner.
 * BIZZ-658: Extraheret fra VirksomhedDetaljeClient.tsx.
 * @module app/dashboard/companies/[cvr]/RegnskabstalTable
 */
'use client';

import { useState, useMemo, Fragment } from 'react';
import {
  ChevronRight,
  ChevronDown,
  BarChart3,
  Download,
  CheckCircle,
  FileText,
  XCircle,
} from 'lucide-react';

import type { Regnskab } from '@/app/api/regnskab/route';
import type { RegnskabsAar } from '@/app/api/regnskab/xbrl/route';
import dynamic from 'next/dynamic';

const RegnskabChart = dynamic(() => import('./RegnskabChart'), { ssr: false });

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
export default function RegnskabstalTable({
  years,
  lang,
  regnskaber = [],
}: RegnskabstalTableProps) {
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
  /** BIZZ-560: Tracking af hvilke noter der er udfoldet (default: alle kollapsede med preview) */
  const [aabneNoter, setAabneNoter] = useState<Set<string>>(() => new Set());

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

      {/* BIZZ-560: Note-tekstblokke fra seneste regnskabsår — formål, anvendt
          regnskabspraksis, begivenheder efter balancedag, going concern.
          Hver note collapsible med kort preview. */}
      {(() => {
        const senesteNoter = visteAar.find((y) => y.noter != null)?.noter;
        if (!senesteNoter) return null;
        const noteFelter: Array<{
          key: string;
          label: string;
          value: string | null;
        }> = [
          { key: 'formaal', label: da ? 'Formål' : 'Purpose', value: senesteNoter.formaal },
          {
            key: 'regnskabspraksis',
            label: da ? 'Anvendt regnskabspraksis' : 'Accounting policies',
            value: senesteNoter.regnskabspraksis,
          },
          {
            key: 'begivenhederEfterBalancedag',
            label: da ? 'Begivenheder efter balancedag' : 'Events after reporting period',
            value: senesteNoter.begivenhederEfterBalancedag,
          },
          {
            key: 'goingConcern',
            label: da ? 'Going concern' : 'Going concern',
            value: senesteNoter.goingConcern,
          },
        ];
        const aktive = noteFelter.filter((n) => n.value && n.value.length > 0);
        if (aktive.length === 0) return null;
        return (
          <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-700/30">
              <FileText size={15} className="text-slate-400" />
              <span className="text-sm font-semibold text-slate-200">{da ? 'Noter' : 'Notes'}</span>
              <span className="text-[10px] text-slate-500">({aktive.length})</span>
            </div>
            <div className="divide-y divide-slate-700/20">
              {aktive.map((n) => {
                const isExpanded = aabneNoter.has(n.key);
                const text = n.value!;
                const erLang = text.length > 280;
                return (
                  <div key={n.key} className="p-4">
                    <button
                      type="button"
                      onClick={() =>
                        setAabneNoter((prev) => {
                          const next = new Set(prev);
                          if (next.has(n.key)) next.delete(n.key);
                          else next.add(n.key);
                          return next;
                        })
                      }
                      className="flex items-center gap-2 w-full text-left mb-2 hover:text-blue-400 transition-colors"
                      disabled={!erLang}
                    >
                      {erLang &&
                        (isExpanded ? (
                          <ChevronDown size={13} className="text-slate-500 flex-shrink-0" />
                        ) : (
                          <ChevronRight size={13} className="text-slate-500 flex-shrink-0" />
                        ))}
                      <span className="text-[10px] uppercase tracking-wider text-slate-500 font-medium">
                        {n.label}
                      </span>
                    </button>
                    <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">
                      {erLang && !isExpanded ? `${text.slice(0, 280)}…` : text}
                    </p>
                  </div>
                );
              })}
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
