'use client';

/**
 * Ejendomme listeside.
 * Viser søgning, filtrering og kort over danske ejendomme.
 * Datafordeleren API integreres i Fase 2 — mock data bruges nu.
 */

import { useState, useMemo } from 'react';
import Link from 'next/link';
import {
  Search,
  SlidersHorizontal,
  MapPin,
  Building2,
  Home,
  Warehouse,
  TrendingUp,
  ChevronRight,
  X,
} from 'lucide-react';
import { mockEjendomme, formatDKK, formatDato, type Ejendom } from '@/app/lib/mock/ejendomme';

/**
 * Returnerer CSS-farve-klasser baseret på ejendomstype.
 * @param type - Ejendomstypetekst
 */
const typeColor = (type: string): string => {
  if (type.includes('Parcelhus')) return 'text-green-400 bg-green-400/10';
  if (type.includes('Beboelses')) return 'text-blue-400 bg-blue-400/10';
  if (type.includes('Industri')) return 'text-orange-400 bg-orange-400/10';
  return 'text-purple-400 bg-purple-400/10';
};

/**
 * Ikon-komponent for ejendomstype — deklareret uden for render.
 * @param type - Ejendomstypetekst
 */
function TypeIkon({ type }: { type: string }) {
  if (type.includes('Parcelhus') || type.includes('Beboelses')) return <Home size={20} />;
  if (type.includes('Industri') || type.includes('lager')) return <Warehouse size={20} />;
  return <Building2 size={20} />;
}

/**
 * Kort ejendomskort til listesiden.
 * @param ejendom - Ejendomsdata
 */
function EjendomCard({ ejendom }: { ejendom: Ejendom }) {
  const color = typeColor(ejendom.ejendomstype);

  return (
    <Link href={`/dashboard/ejendomme/${ejendom.id}`}>
      <div className="group bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/50 hover:border-blue-500/40 rounded-2xl p-5 transition-all duration-200 cursor-pointer">
        <div className="flex items-start gap-4">
          {/* Ikon */}
          <div className={`p-3 rounded-xl flex-shrink-0 ${color}`}>
            <TypeIkon type={ejendom.ejendomstype} />
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="text-white font-semibold text-sm truncate group-hover:text-blue-300 transition-colors">
                  {ejendom.adresse}
                </h3>
                <p className="text-slate-400 text-xs mt-0.5">
                  {ejendom.postnummer} {ejendom.by} · BFE {ejendom.bfe}
                </p>
              </div>
              <ChevronRight
                size={16}
                className="text-slate-600 group-hover:text-blue-400 transition-colors flex-shrink-0 mt-0.5"
              />
            </div>

            {/* Type badge */}
            <div className="mt-2">
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${color}`}>
                {ejendom.ejendomstype.split(' (')[0]}
              </span>
            </div>

            {/* Nøgletal */}
            <div className="mt-3 grid grid-cols-3 gap-3">
              <div>
                <p className="text-slate-500 text-xs">Grundareal</p>
                <p className="text-slate-200 text-sm font-medium">
                  {ejendom.grundareal.toLocaleString('da-DK')} m²
                </p>
              </div>
              <div>
                <p className="text-slate-500 text-xs">Bygningsareal</p>
                <p className="text-slate-200 text-sm font-medium">
                  {ejendom.bygningsareal.toLocaleString('da-DK')} m²
                </p>
              </div>
              <div>
                <p className="text-slate-500 text-xs">Seneste handel</p>
                <p className="text-slate-200 text-sm font-medium">
                  {formatDKK(ejendom.senesteHandel.pris).replace(' DKK', '')}
                </p>
              </div>
            </div>

            {/* Ejer + dato */}
            <div className="mt-3 flex items-center justify-between">
              <p className="text-slate-500 text-xs truncate">
                {ejendom.ejere[0]?.navn}
                {ejendom.ejere.length > 1 && ` +${ejendom.ejere.length - 1}`}
              </p>
              <div className="flex items-center gap-1 text-xs text-slate-500">
                <TrendingUp size={11} />
                <span>{formatDato(ejendom.senesteHandel.dato)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}

/** Filtre state */
interface Filtre {
  type: string;
  minM2: string;
  maxM2: string;
  postnummer: string;
}

/**
 * Ejendomme listeside med søgning, filtrering og kortvisning.
 */
export default function EjendommePage() {
  const [soeg, setSoeg] = useState('');
  const [filtrePaanel, setFiltrePaanel] = useState(false);
  const [filtre, setFiltre] = useState<Filtre>({ type: '', minM2: '', maxM2: '', postnummer: '' });

  /** Filtrerede ejendomme baseret på søgning og filtre */
  const filtrerede = useMemo(() => {
    return mockEjendomme.filter((e) => {
      const soegMatch =
        !soeg ||
        e.adresse.toLowerCase().includes(soeg.toLowerCase()) ||
        e.by.toLowerCase().includes(soeg.toLowerCase()) ||
        e.bfe.includes(soeg) ||
        e.kommune.toLowerCase().includes(soeg.toLowerCase()) ||
        e.ejere.some((ej) => ej.navn.toLowerCase().includes(soeg.toLowerCase()));

      const typeMatch =
        !filtre.type || e.ejendomstype.toLowerCase().includes(filtre.type.toLowerCase());
      const minM2Match = !filtre.minM2 || e.bygningsareal >= parseInt(filtre.minM2);
      const maxM2Match = !filtre.maxM2 || e.bygningsareal <= parseInt(filtre.maxM2);
      const postnrMatch = !filtre.postnummer || e.postnummer.startsWith(filtre.postnummer);

      return soegMatch && typeMatch && minM2Match && maxM2Match && postnrMatch;
    });
  }, [soeg, filtre]);

  const aktiveFiltre = Object.values(filtre).filter(Boolean).length;

  return (
    <div className="flex flex-col h-full">
      {/* Top */}
      <div className="px-6 pt-6 pb-4 border-b border-slate-700/50">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-white text-2xl font-bold">Ejendomme</h1>
            <p className="text-slate-400 text-sm mt-0.5">{filtrerede.length} ejendomme fundet</p>
          </div>
        </div>

        {/* Søgebar */}
        <div className="flex gap-3">
          <div className="relative flex-1">
            <Search
              size={16}
              className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              type="text"
              value={soeg}
              onChange={(e) => setSoeg(e.target.value)}
              placeholder="Søg på adresse, BFE-nummer, ejer, by eller kommune..."
              className="w-full pl-10 pr-4 py-2.5 bg-slate-800/60 border border-slate-700/60 rounded-xl text-white placeholder-slate-500 text-sm focus:outline-none focus:border-blue-500/60 focus:ring-1 focus:ring-blue-500/30 transition-all"
            />
            {soeg && (
              <button
                onClick={() => setSoeg('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
              >
                <X size={14} />
              </button>
            )}
          </div>

          <button
            onClick={() => setFiltrePaanel(!filtrePaanel)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-medium transition-all ${
              filtrePaanel || aktiveFiltre > 0
                ? 'bg-blue-600/20 border-blue-500/40 text-blue-300'
                : 'bg-slate-800/60 border-slate-700/60 text-slate-300 hover:border-slate-600'
            }`}
          >
            <SlidersHorizontal size={15} />
            Filtre
            {aktiveFiltre > 0 && (
              <span className="bg-blue-500 text-white text-xs rounded-full w-4 h-4 flex items-center justify-center">
                {aktiveFiltre}
              </span>
            )}
          </button>
        </div>

        {/* Filterpanel */}
        {filtrePaanel && (
          <div className="mt-3 p-4 bg-slate-800/40 border border-slate-700/40 rounded-xl grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="text-slate-400 text-xs mb-1 block">Ejendomstype</label>
              <select
                value={filtre.type}
                onChange={(e) => setFiltre((f) => ({ ...f, type: e.target.value }))}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              >
                <option value="">Alle typer</option>
                <option value="Parcelhus">Parcelhus</option>
                <option value="Beboelses">Beboelse</option>
                <option value="Handel">Erhverv / Kontor</option>
                <option value="Industri">Industri / Lager</option>
              </select>
            </div>
            <div>
              <label className="text-slate-400 text-xs mb-1 block">Min. m²</label>
              <input
                type="number"
                value={filtre.minM2}
                onChange={(e) => setFiltre((f) => ({ ...f, minM2: e.target.value }))}
                placeholder="0"
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="text-slate-400 text-xs mb-1 block">Max. m²</label>
              <input
                type="number"
                value={filtre.maxM2}
                onChange={(e) => setFiltre((f) => ({ ...f, maxM2: e.target.value }))}
                placeholder="99999"
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="text-slate-400 text-xs mb-1 block">Postnummer</label>
              <input
                type="text"
                value={filtre.postnummer}
                onChange={(e) => setFiltre((f) => ({ ...f, postnummer: e.target.value }))}
                placeholder="fx 2650"
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              />
            </div>
            {aktiveFiltre > 0 && (
              <div className="col-span-full flex justify-end">
                <button
                  onClick={() => setFiltre({ type: '', minM2: '', maxM2: '', postnummer: '' })}
                  className="text-slate-400 hover:text-white text-xs flex items-center gap-1"
                >
                  <X size={12} /> Ryd filtre
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Indhold */}
      <div className="flex flex-1 overflow-hidden">
        {/* Liste */}
        <div className="w-full lg:w-[480px] flex-shrink-0 overflow-y-auto px-6 py-4 space-y-3">
          {filtrerede.length === 0 ? (
            <div className="text-center py-16">
              <MapPin size={32} className="text-slate-600 mx-auto mb-3" />
              <p className="text-slate-400">Ingen ejendomme matcher din søgning</p>
              <button
                onClick={() => {
                  setSoeg('');
                  setFiltre({ type: '', minM2: '', maxM2: '', postnummer: '' });
                }}
                className="mt-3 text-blue-400 hover:text-blue-300 text-sm"
              >
                Ryd søgning
              </button>
            </div>
          ) : (
            filtrerede.map((e) => <EjendomCard key={e.id} ejendom={e} />)
          )}
        </div>

        {/* Kort — vises kun på store skærme */}
        <div className="hidden lg:flex flex-1 bg-slate-900/50 border-l border-slate-700/50 items-center justify-center relative overflow-hidden">
          <iframe
            src={`https://www.openstreetmap.org/export/embed.html?bbox=8.0,54.5,15.5,57.8&layer=mapnik&marker=55.6761,12.5683`}
            className="w-full h-full border-none opacity-80"
            title="Ejendomskort"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-slate-900/20 to-transparent pointer-events-none" />
          <div className="absolute bottom-4 left-4 bg-slate-900/90 backdrop-blur-sm border border-slate-700/50 rounded-xl px-3 py-2">
            <p className="text-slate-400 text-xs">Interaktivt kort · Fase 2</p>
            <p className="text-slate-300 text-xs font-medium">Mapbox integration kommer</p>
          </div>
        </div>
      </div>
    </div>
  );
}
