'use client';

/**
 * Data Pivot tab — dataset selector + Perspective viewer + export.
 *
 * Renders a dropdown to pick between demo datasets (and future AI-analysis
 * results), then loads the selected data into a lazy-loaded PerspectiveViewer.
 * Part of BIZZ-1033 Analyse-page redesign.
 *
 * @module DataPivotTab
 */

import { useState, useRef, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { Download, Database, ChevronDown, Table2 } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { translations } from '@/app/lib/translations';
import type { PerspectiveViewerHandle } from './PerspectiveViewer';

// ─── Lazy-load PerspectiveViewer (WASM, browser-only) ─────────────────────────

const PerspectiveViewerLazy = dynamic(() => import('./PerspectiveViewer'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-[400px] rounded-xl border border-white/8 bg-white/3">
      <div className="flex items-center gap-2 text-sm text-slate-400">
        <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
        <span>Indlæser pivot-komponent…</span>
      </div>
    </div>
  ),
});

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single row of flat data */
type DataRow = Record<string, string | number | boolean | null>;

/** Identifier for a pre-defined demo dataset */
type DatasetId = 'portefolje' | 'regnskab';

/** Configuration for a selectable dataset */
interface DatasetOption {
  id: DatasetId;
  labelDa: string;
  labelEn: string;
  descDa: string;
  descEn: string;
  data: DataRow[];
}

/** Props for the DataPivotTab component */
interface DataPivotTabProps {
  /** Optional structured data from a completed AI analysis */
  analysisData?: DataRow[] | null;
}

// ─── Demo datasets ───────────────────────────────────────────────────────────

/**
 * Sample property portfolio data for demo/testing.
 * Simulates a typical portfolio overview with Danish property metrics.
 */
const DEMO_PORTEFOLJE: DataRow[] = [
  {
    BFE: 1234567,
    Adresse: 'Vestergade 12, 8000 Aarhus C',
    Kommune: 'Aarhus',
    Postnummer: 8000,
    Areal_m2: 245,
    Vurdering_DKK: 3_200_000,
    Grundvaerdi_DKK: 1_100_000,
    Opfoerelsesaar: 1923,
    Energimaerke: 'C',
    Type: 'Ejerlejlighed',
  },
  {
    BFE: 2345678,
    Adresse: 'Nørregade 5, 1165 København K',
    Kommune: 'København',
    Postnummer: 1165,
    Areal_m2: 120,
    Vurdering_DKK: 4_800_000,
    Grundvaerdi_DKK: 2_200_000,
    Opfoerelsesaar: 1890,
    Energimaerke: 'D',
    Type: 'Ejerlejlighed',
  },
  {
    BFE: 3456789,
    Adresse: 'Havnegade 22, 5000 Odense C',
    Kommune: 'Odense',
    Postnummer: 5000,
    Areal_m2: 380,
    Vurdering_DKK: 5_500_000,
    Grundvaerdi_DKK: 1_800_000,
    Opfoerelsesaar: 1965,
    Energimaerke: 'B',
    Type: 'Bygning',
  },
  {
    BFE: 4567890,
    Adresse: 'Algade 8, 4000 Roskilde',
    Kommune: 'Roskilde',
    Postnummer: 4000,
    Areal_m2: 195,
    Vurdering_DKK: 2_900_000,
    Grundvaerdi_DKK: 950_000,
    Opfoerelsesaar: 1955,
    Energimaerke: 'C',
    Type: 'Ejerlejlighed',
  },
  {
    BFE: 5678901,
    Adresse: 'Søndergade 14, 7100 Vejle',
    Kommune: 'Vejle',
    Postnummer: 7100,
    Areal_m2: 310,
    Vurdering_DKK: 4_100_000,
    Grundvaerdi_DKK: 1_400_000,
    Opfoerelsesaar: 1978,
    Energimaerke: 'C',
    Type: 'Bygning',
  },
  {
    BFE: 6789012,
    Adresse: 'Torvet 3, 6000 Kolding',
    Kommune: 'Kolding',
    Postnummer: 6000,
    Areal_m2: 165,
    Vurdering_DKK: 2_100_000,
    Grundvaerdi_DKK: 780_000,
    Opfoerelsesaar: 1942,
    Energimaerke: 'E',
    Type: 'Ejerlejlighed',
  },
  {
    BFE: 7890123,
    Adresse: 'Strandvejen 45, 2900 Hellerup',
    Kommune: 'Gentofte',
    Postnummer: 2900,
    Areal_m2: 420,
    Vurdering_DKK: 12_500_000,
    Grundvaerdi_DKK: 5_800_000,
    Opfoerelsesaar: 1910,
    Energimaerke: 'B',
    Type: 'SFE',
  },
  {
    BFE: 8901234,
    Adresse: 'Jernbanegade 7, 9000 Aalborg',
    Kommune: 'Aalborg',
    Postnummer: 9000,
    Areal_m2: 275,
    Vurdering_DKK: 3_600_000,
    Grundvaerdi_DKK: 1_250_000,
    Opfoerelsesaar: 1988,
    Energimaerke: 'B',
    Type: 'Ejerlejlighed',
  },
  {
    BFE: 9012345,
    Adresse: 'Brogade 19, 4600 Køge',
    Kommune: 'Køge',
    Postnummer: 4600,
    Areal_m2: 210,
    Vurdering_DKK: 2_750_000,
    Grundvaerdi_DKK: 900_000,
    Opfoerelsesaar: 1970,
    Energimaerke: 'D',
    Type: 'Ejerlejlighed',
  },
  {
    BFE: 1023456,
    Adresse: 'Havnevej 33, 3000 Helsingør',
    Kommune: 'Helsingør',
    Postnummer: 3000,
    Areal_m2: 340,
    Vurdering_DKK: 6_200_000,
    Grundvaerdi_DKK: 2_400_000,
    Opfoerelsesaar: 1935,
    Energimaerke: 'C',
    Type: 'Bygning',
  },
];

/**
 * Sample financial key figures for demo/testing.
 * Simulates multi-year financials for 5 companies.
 */
const DEMO_REGNSKAB: DataRow[] = [
  {
    CVR: 12345678,
    Virksomhed: 'Nordic Invest A/S',
    Aar: 2023,
    Omsaetning_DKK: 45_000_000,
    Resultat_DKK: 3_200_000,
    Egenkapital_DKK: 18_500_000,
    Ansatte: 42,
    Branche: 'Investeringsvirksomhed',
  },
  {
    CVR: 12345678,
    Virksomhed: 'Nordic Invest A/S',
    Aar: 2022,
    Omsaetning_DKK: 41_000_000,
    Resultat_DKK: 2_800_000,
    Egenkapital_DKK: 15_300_000,
    Ansatte: 38,
    Branche: 'Investeringsvirksomhed',
  },
  {
    CVR: 12345678,
    Virksomhed: 'Nordic Invest A/S',
    Aar: 2021,
    Omsaetning_DKK: 38_500_000,
    Resultat_DKK: 2_100_000,
    Egenkapital_DKK: 12_500_000,
    Ansatte: 35,
    Branche: 'Investeringsvirksomhed',
  },
  {
    CVR: 23456789,
    Virksomhed: 'Dansk Ejendom ApS',
    Aar: 2023,
    Omsaetning_DKK: 12_000_000,
    Resultat_DKK: 1_500_000,
    Egenkapital_DKK: 8_200_000,
    Ansatte: 8,
    Branche: 'Ejendomsadministration',
  },
  {
    CVR: 23456789,
    Virksomhed: 'Dansk Ejendom ApS',
    Aar: 2022,
    Omsaetning_DKK: 11_200_000,
    Resultat_DKK: 1_200_000,
    Egenkapital_DKK: 6_700_000,
    Ansatte: 7,
    Branche: 'Ejendomsadministration',
  },
  {
    CVR: 23456789,
    Virksomhed: 'Dansk Ejendom ApS',
    Aar: 2021,
    Omsaetning_DKK: 10_500_000,
    Resultat_DKK: 900_000,
    Egenkapital_DKK: 5_500_000,
    Ansatte: 6,
    Branche: 'Ejendomsadministration',
  },
  {
    CVR: 34567890,
    Virksomhed: 'Byggegruppen A/S',
    Aar: 2023,
    Omsaetning_DKK: 89_000_000,
    Resultat_DKK: 5_600_000,
    Egenkapital_DKK: 32_000_000,
    Ansatte: 120,
    Branche: 'Byggeri',
  },
  {
    CVR: 34567890,
    Virksomhed: 'Byggegruppen A/S',
    Aar: 2022,
    Omsaetning_DKK: 82_000_000,
    Resultat_DKK: 4_800_000,
    Egenkapital_DKK: 26_400_000,
    Ansatte: 115,
    Branche: 'Byggeri',
  },
  {
    CVR: 34567890,
    Virksomhed: 'Byggegruppen A/S',
    Aar: 2021,
    Omsaetning_DKK: 75_000_000,
    Resultat_DKK: 3_900_000,
    Egenkapital_DKK: 21_600_000,
    Ansatte: 108,
    Branche: 'Byggeri',
  },
  {
    CVR: 45678901,
    Virksomhed: 'GreenTech Solutions ApS',
    Aar: 2023,
    Omsaetning_DKK: 22_000_000,
    Resultat_DKK: 2_400_000,
    Egenkapital_DKK: 11_000_000,
    Ansatte: 25,
    Branche: 'Cleantech',
  },
  {
    CVR: 45678901,
    Virksomhed: 'GreenTech Solutions ApS',
    Aar: 2022,
    Omsaetning_DKK: 18_000_000,
    Resultat_DKK: 1_800_000,
    Egenkapital_DKK: 8_600_000,
    Ansatte: 20,
    Branche: 'Cleantech',
  },
  {
    CVR: 45678901,
    Virksomhed: 'GreenTech Solutions ApS',
    Aar: 2021,
    Omsaetning_DKK: 14_000_000,
    Resultat_DKK: 1_100_000,
    Egenkapital_DKK: 6_800_000,
    Ansatte: 16,
    Branche: 'Cleantech',
  },
  {
    CVR: 56789012,
    Virksomhed: 'Maritime Holding A/S',
    Aar: 2023,
    Omsaetning_DKK: 156_000_000,
    Resultat_DKK: 12_000_000,
    Egenkapital_DKK: 65_000_000,
    Ansatte: 210,
    Branche: 'Shipping',
  },
  {
    CVR: 56789012,
    Virksomhed: 'Maritime Holding A/S',
    Aar: 2022,
    Omsaetning_DKK: 142_000_000,
    Resultat_DKK: 10_500_000,
    Egenkapital_DKK: 53_000_000,
    Ansatte: 195,
    Branche: 'Shipping',
  },
  {
    CVR: 56789012,
    Virksomhed: 'Maritime Holding A/S',
    Aar: 2021,
    Omsaetning_DKK: 128_000_000,
    Resultat_DKK: 8_200_000,
    Egenkapital_DKK: 42_500_000,
    Ansatte: 185,
    Branche: 'Shipping',
  },
];

/** All available demo datasets */
const DATASETS: DatasetOption[] = [
  {
    id: 'portefolje',
    labelDa: 'Portefølje-ejendomme',
    labelEn: 'Portfolio properties',
    descDa: '10 ejendomme med BFE, vurdering, areal og kommune',
    descEn: '10 properties with BFE, valuation, area and municipality',
    data: DEMO_PORTEFOLJE,
  },
  {
    id: 'regnskab',
    labelDa: 'Regnskabsnøgletal',
    labelEn: 'Financial key figures',
    descDa: '5 virksomheder × 3 år med omsætning, resultat og egenkapital',
    descEn: '5 companies × 3 years with revenue, profit and equity',
    data: DEMO_REGNSKAB,
  },
];

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Data Pivot tab content — dataset selector + Perspective viewer + export button.
 *
 * Shows a dropdown to pick between demo datasets (or AI-analysis results when
 * available), renders the selected data in an interactive pivot table, and
 * provides a CSV export button.
 *
 * @param props - DataPivotTabProps
 */
export default function DataPivotTab({ analysisData }: DataPivotTabProps) {
  const { lang } = useLanguage();
  const t = translations[lang];
  const viewerRef = useRef<PerspectiveViewerHandle>(null);

  const [selectedDataset, setSelectedDataset] = useState<DatasetId | 'analysis' | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  /** Get the label for the analysis page translations */
  const pt = t.analysisPage;

  /** Resolve the data array for the currently selected dataset */
  const resolveData = useCallback((): DataRow[] => {
    if (selectedDataset === 'analysis' && analysisData) return analysisData;
    const found = DATASETS.find((d) => d.id === selectedDataset);
    return found?.data ?? [];
  }, [selectedDataset, analysisData]);

  /** Handle dataset selection from the dropdown */
  const handleSelect = useCallback((id: DatasetId | 'analysis') => {
    setSelectedDataset(id);
    setDropdownOpen(false);
  }, []);

  /** Trigger CSV export via the viewer ref */
  const handleExport = useCallback(async () => {
    await viewerRef.current?.downloadCsv();
  }, []);

  const currentData = resolveData();
  const hasAnalysisData = analysisData && analysisData.length > 0;

  /** Get the display label for a dataset */
  const getLabel = useCallback(
    (id: DatasetId | 'analysis'): string => {
      if (id === 'analysis') return pt.pivotLatestAnalysis;
      const ds = DATASETS.find((d) => d.id === id);
      if (!ds) return id;
      return lang === 'da' ? ds.labelDa : ds.labelEn;
    },
    [lang, pt.pivotLatestAnalysis]
  );

  return (
    <div className="max-w-6xl space-y-4">
      {/* Toolbar — dataset selector + export */}
      <div className="flex items-center gap-3">
        {/* Dataset dropdown */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setDropdownOpen((p) => !p)}
            aria-haspopup="listbox"
            aria-expanded={dropdownOpen}
            className={[
              'flex items-center gap-2 rounded-xl border border-white/10 bg-white/5',
              'px-4 py-2.5 text-sm transition-colors',
              'hover:border-white/20 hover:bg-white/8',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60',
              selectedDataset ? 'text-white' : 'text-slate-400',
            ].join(' ')}
          >
            <Database size={14} className="text-slate-400" />
            <span>{selectedDataset ? getLabel(selectedDataset) : pt.pivotDataset}</span>
            <ChevronDown
              size={13}
              className={[
                'text-slate-400 transition-transform',
                dropdownOpen ? 'rotate-180' : '',
              ].join(' ')}
            />
          </button>

          {dropdownOpen && (
            <div
              role="listbox"
              className={[
                'absolute z-50 mt-1.5 w-72 rounded-2xl border border-white/10',
                'bg-[#0f172a] shadow-xl overflow-hidden',
              ].join(' ')}
            >
              {/* Analysis data option — only shown when available */}
              {hasAnalysisData && (
                <button
                  type="button"
                  role="option"
                  aria-selected={selectedDataset === 'analysis'}
                  onClick={() => handleSelect('analysis')}
                  className={[
                    'w-full text-left px-4 py-3 transition-colors',
                    'hover:bg-white/5 border-b border-white/5',
                    selectedDataset === 'analysis' ? 'bg-blue-500/10' : '',
                  ].join(' ')}
                >
                  <div className="flex items-center gap-2">
                    <Table2 size={14} className="text-blue-400 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-white">{pt.pivotLatestAnalysis}</div>
                      <div className="text-xs text-slate-400 mt-0.5">
                        {analysisData!.length} {lang === 'da' ? 'rækker' : 'rows'}
                      </div>
                    </div>
                  </div>
                </button>
              )}

              {/* Demo datasets */}
              {DATASETS.map((ds) => (
                <button
                  key={ds.id}
                  type="button"
                  role="option"
                  aria-selected={selectedDataset === ds.id}
                  onClick={() => handleSelect(ds.id)}
                  className={[
                    'w-full text-left px-4 py-3 transition-colors hover:bg-white/5',
                    selectedDataset === ds.id ? 'bg-blue-500/10' : '',
                  ].join(' ')}
                >
                  <div className="text-sm text-white">
                    {lang === 'da' ? ds.labelDa : ds.labelEn}
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    {lang === 'da' ? ds.descDa : ds.descEn}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Export button */}
        {selectedDataset && currentData.length > 0 && (
          <button
            type="button"
            onClick={handleExport}
            aria-label={pt.pivotExport}
            className={[
              'flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5',
              'px-3 py-2.5 text-xs text-slate-400 transition-colors',
              'hover:border-white/20 hover:text-white hover:bg-white/8',
            ].join(' ')}
          >
            <Download size={13} />
            <span>{pt.pivotExport}</span>
          </button>
        )}
      </div>

      {/* Perspective viewer or empty state */}
      {selectedDataset && currentData.length > 0 ? (
        <div className="h-[calc(100vh-280px)] min-h-[400px]">
          <PerspectiveViewerLazy
            ref={viewerRef}
            data={currentData}
            title={getLabel(selectedDataset)}
          />
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center h-[400px] rounded-2xl border border-white/5 bg-white/3">
          <div className="w-12 h-12 rounded-xl bg-blue-500/10 flex items-center justify-center mb-4">
            <Table2 size={22} className="text-blue-400" />
          </div>
          <div className="text-sm font-medium text-slate-300 text-center">{pt.pivotNoData}</div>
          <div className="text-xs text-slate-400 mt-2 text-center max-w-sm">{pt.pivotSubtitle}</div>
        </div>
      )}
    </div>
  );
}
