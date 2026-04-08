'use client';

/**
 * Compare properties side-by-side.
 *
 * Users can add up to 3 properties by searching addresses.
 * Displays key data in a comparison table format.
 *
 * Data source: /api/ejendom/[id] for each property, /api/vurdering for valuations.
 */

import { useState, useCallback } from 'react';
import { Building2, Plus, X, Search, Loader2, ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useLanguage } from '@/app/context/LanguageContext';

/** Max properties that can be compared at once */
const MAX_COMPARE = 3;

/** Property data loaded for comparison */
interface CompareProperty {
  id: string;
  adresse: string;
  postnr: string;
  by: string;
  kommune: string;
  bygninger: CompareBuilding[];
  enheder: CompareUnit[];
  vurdering: CompareValuation | null;
}

/** Simplified building data for comparison */
interface CompareBuilding {
  anvendelse: string | null;
  opfoerelsesaar: number | null;
  samletAreal: number | null;
  boligAreal: number | null;
  erhvervsAreal: number | null;
  etager: number | null;
  tagMateriale: string | null;
  ydervaegMateriale: string | null;
  varmeinstallation: string | null;
}

/** Simplified unit data for comparison */
interface CompareUnit {
  anvendelse: string | null;
  samletAreal: number | null;
  vaerelser: number | null;
}

/** Simplified valuation for comparison */
interface CompareValuation {
  ejendomsvaerdi: number | null;
  grundvaerdi: number | null;
  aar: number | null;
}

/** DAWA autocomplete result */
interface DawaResult {
  tekst: string;
  adresse: {
    id: string;
    vejnavn: string;
    husnr: string;
    postnr: string;
    postnrnavn: string;
    kommunenavn?: string;
  };
}

export default function ComparePageClient() {
  const { lang } = useLanguage();
  const da = lang === 'da';

  const [properties, setProperties] = useState<CompareProperty[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<DawaResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);

  /** Labels for comparison rows */
  const labels = da
    ? {
        address: 'Adresse',
        postalCity: 'Postnr / By',
        municipality: 'Kommune',
        buildYear: 'Opførelsesår',
        totalArea: 'Samlet areal (m²)',
        livingArea: 'Boligareal (m²)',
        commercialArea: 'Erhvervsareal (m²)',
        floors: 'Etager',
        roof: 'Tagmateriale',
        walls: 'Ydervægge',
        heating: 'Varmeinstallation',
        units: 'Antal enheder',
        rooms: 'Værelser (total)',
        propertyValue: 'Ejendomsværdi',
        landValue: 'Grundværdi',
        valuationYear: 'Vurderingsår',
        addProperty: 'Tilføj ejendom',
        searchPlaceholder: 'Søg adresse…',
        title: 'Sammenlign ejendomme',
        subtitle: 'Sammenlign op til 3 ejendomme side om side.',
        noProperties: 'Tilføj ejendomme for at starte sammenligning.',
        loadingProperty: 'Henter data…',
        back: 'Tilbage',
      }
    : {
        address: 'Address',
        postalCity: 'Postal code / City',
        municipality: 'Municipality',
        buildYear: 'Year built',
        totalArea: 'Total area (m²)',
        livingArea: 'Living area (m²)',
        commercialArea: 'Commercial area (m²)',
        floors: 'Floors',
        roof: 'Roof material',
        walls: 'Exterior walls',
        heating: 'Heating',
        units: 'Number of units',
        rooms: 'Rooms (total)',
        propertyValue: 'Property value',
        landValue: 'Land value',
        valuationYear: 'Valuation year',
        addProperty: 'Add property',
        searchPlaceholder: 'Search address…',
        title: 'Compare properties',
        subtitle: 'Compare up to 3 properties side by side.',
        noProperties: 'Add properties to start comparing.',
        loadingProperty: 'Loading data…',
        back: 'Back',
      };

  /** Search DAWA for addresses */
  const onSearch = useCallback(async (q: string) => {
    setSearchQuery(q);
    if (q.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      const res = await fetch(`/api/adresse/autocomplete?q=${encodeURIComponent(q)}&type=adresse`);
      if (res.ok) {
        const data = await res.json();
        setSearchResults(Array.isArray(data) ? data.slice(0, 8) : []);
      }
    } catch {
      setSearchResults([]);
    }
    setSearching(false);
  }, []);

  /** Load property data and add to comparison */
  const addProperty = useCallback(
    async (result: DawaResult) => {
      const id = result.adresse.id;
      // Prevent duplicates
      if (properties.some((p) => p.id === id)) {
        setSearchQuery('');
        setSearchResults([]);
        return;
      }

      setSearchQuery('');
      setSearchResults([]);
      setLoading(id);

      try {
        // Fetch BBR data
        const ejendomRes = await fetch(`/api/ejendom/${id}`);
        const ejendomData = ejendomRes.ok ? await ejendomRes.json() : null;

        // Fetch valuation
        const vurRes = await fetch(`/api/vurdering?adresseId=${id}`);
        const vurData = vurRes.ok ? await vurRes.json() : null;

        const prop: CompareProperty = {
          id,
          adresse: result.tekst,
          postnr: result.adresse.postnr,
          by: result.adresse.postnrnavn,
          kommune: result.adresse.kommunenavn ?? '',
          bygninger: (ejendomData?.bbr ?? []).map((b: Record<string, unknown>) => ({
            anvendelse: b.anvendelse ?? null,
            opfoerelsesaar: b.opfoerelsesaar ?? null,
            samletAreal: b.samletAreal ?? null,
            boligAreal: b.boligAreal ?? null,
            erhvervsAreal: b.erhvervsAreal ?? null,
            etager: b.etager ?? null,
            tagMateriale: b.tagMateriale ?? null,
            ydervaegMateriale: b.ydervaegMateriale ?? null,
            varmeinstallation: b.varmeinstallation ?? null,
          })),
          enheder: (ejendomData?.enheder ?? []).map((u: Record<string, unknown>) => ({
            anvendelse: u.anvendelse ?? null,
            samletAreal: u.samletAreal ?? null,
            vaerelser: u.vaerelser ?? null,
          })),
          vurdering: vurData?.vurderinger?.[0]
            ? {
                ejendomsvaerdi: vurData.vurderinger[0].ejendomsvaerdi ?? null,
                grundvaerdi: vurData.vurderinger[0].grundvaerdi ?? null,
                aar: vurData.vurderinger[0].aar ?? null,
              }
            : null,
        };

        setProperties((prev) => [...prev, prop]);
      } catch {
        // silently fail
      }
      setLoading(null);
    },
    [properties]
  );

  /** Remove a property from comparison */
  const removeProperty = useCallback((id: string) => {
    setProperties((prev) => prev.filter((p) => p.id !== id));
  }, []);

  /** Format currency */
  const fmt = (n: number | null) => (n != null ? n.toLocaleString('da-DK') + ' kr' : '—');

  /** Get primary building data (first building) */
  const getPrimary = (p: CompareProperty) => p.bygninger[0] ?? null;

  /** Comparison row data */
  const rows: { label: string; values: (string | number | null)[] }[] =
    properties.length > 0
      ? [
          { label: labels.address, values: properties.map((p) => p.adresse) },
          { label: labels.postalCity, values: properties.map((p) => `${p.postnr} ${p.by}`) },
          { label: labels.municipality, values: properties.map((p) => p.kommune) },
          {
            label: labels.buildYear,
            values: properties.map((p) => getPrimary(p)?.opfoerelsesaar ?? '—'),
          },
          {
            label: labels.totalArea,
            values: properties.map((p) => getPrimary(p)?.samletAreal ?? '—'),
          },
          {
            label: labels.livingArea,
            values: properties.map((p) => getPrimary(p)?.boligAreal ?? '—'),
          },
          {
            label: labels.commercialArea,
            values: properties.map((p) => getPrimary(p)?.erhvervsAreal ?? '—'),
          },
          {
            label: labels.floors,
            values: properties.map((p) => getPrimary(p)?.etager ?? '—'),
          },
          {
            label: labels.roof,
            values: properties.map((p) => getPrimary(p)?.tagMateriale ?? '—'),
          },
          {
            label: labels.walls,
            values: properties.map((p) => getPrimary(p)?.ydervaegMateriale ?? '—'),
          },
          {
            label: labels.heating,
            values: properties.map((p) => getPrimary(p)?.varmeinstallation ?? '—'),
          },
          {
            label: labels.units,
            values: properties.map((p) => p.enheder.length),
          },
          {
            label: labels.rooms,
            values: properties.map(
              (p) => p.enheder.reduce((sum, u) => sum + (u.vaerelser ?? 0), 0) || '—'
            ),
          },
          {
            label: labels.propertyValue,
            values: properties.map((p) => fmt(p.vurdering?.ejendomsvaerdi ?? null)),
          },
          {
            label: labels.landValue,
            values: properties.map((p) => fmt(p.vurdering?.grundvaerdi ?? null)),
          },
          {
            label: labels.valuationYear,
            values: properties.map((p) => p.vurdering?.aar ?? '—'),
          },
        ]
      : [];

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <Link href="/dashboard" className="text-slate-500 hover:text-white transition-colors">
              <ArrowLeft size={18} />
            </Link>
            <h1 className="text-2xl font-bold text-white">{labels.title}</h1>
          </div>
          <p className="text-slate-400 text-sm ml-8">{labels.subtitle}</p>
        </div>
      </div>

      {/* Add property search */}
      {properties.length < MAX_COMPARE && (
        <div className="relative max-w-md">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none"
            size={16}
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={labels.searchPlaceholder}
            className="w-full pl-10 pr-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-blue-500/60 transition-colors"
          />
          {searching && (
            <Loader2
              size={14}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-blue-400 animate-spin"
            />
          )}
          {/* Search results dropdown */}
          {searchResults.length > 0 && (
            <div className="absolute top-full mt-1 left-0 right-0 bg-slate-900 border border-slate-700/60 rounded-xl shadow-2xl overflow-hidden z-50 max-h-64 overflow-y-auto">
              {searchResults.map((r, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => addProperty(r)}
                  className="w-full text-left px-4 py-2.5 hover:bg-white/5 transition-colors flex items-center gap-3"
                >
                  <Building2 size={14} className="text-emerald-400 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm text-white truncate">{r.tekst}</p>
                    <p className="text-xs text-slate-500">
                      {r.adresse.postnr} {r.adresse.postnrnavn}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Loading indicator */}
      {loading && (
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <Loader2 size={14} className="animate-spin text-blue-400" />
          {labels.loadingProperty}
        </div>
      )}

      {/* Empty state */}
      {properties.length === 0 && !loading && (
        <div className="text-center py-20">
          <div className="w-16 h-16 bg-emerald-500/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Plus size={28} className="text-emerald-400" />
          </div>
          <p className="text-slate-400">{labels.noProperties}</p>
        </div>
      )}

      {/* Comparison table */}
      {properties.length > 0 && (
        <div className="bg-white/5 border border-white/8 rounded-2xl overflow-hidden">
          {/* Property headers with remove buttons */}
          <div
            className="grid border-b border-white/8"
            style={{ gridTemplateColumns: `200px repeat(${properties.length}, 1fr)` }}
          >
            <div className="px-4 py-3 bg-white/3" />
            {properties.map((p) => (
              <div
                key={p.id}
                className="px-4 py-3 border-l border-white/8 bg-white/3 flex items-start justify-between gap-2"
              >
                <div className="min-w-0">
                  <Link
                    href={`/dashboard/ejendomme/${p.id}`}
                    className="text-sm font-medium text-blue-400 hover:text-blue-300 truncate block"
                  >
                    {p.adresse}
                  </Link>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {p.postnr} {p.by}
                  </p>
                </div>
                <button
                  onClick={() => removeProperty(p.id)}
                  className="text-slate-600 hover:text-red-400 transition-colors shrink-0 mt-0.5"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>

          {/* Data rows */}
          {rows.map((row, i) => (
            <div
              key={row.label}
              className={`grid ${i % 2 === 0 ? 'bg-white/[0.02]' : ''}`}
              style={{ gridTemplateColumns: `200px repeat(${properties.length}, 1fr)` }}
            >
              <div className="px-4 py-2.5 text-xs font-medium text-slate-400">{row.label}</div>
              {row.values.map((val, j) => (
                <div key={j} className="px-4 py-2.5 border-l border-white/5 text-sm text-slate-300">
                  {val != null ? String(val) : '—'}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
