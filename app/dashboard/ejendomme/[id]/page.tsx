'use client';

/**
 * Ejendomsdetaljeside.
 * Viser fuld information om en ejendom fordelt på tabs:
 * Overblik, BBR, Ejerforhold, Tinglysning, Økonomi, Dokumenter.
 *
 * BizzAssist forbedringer over Resights:
 * - Inline AI-analyse direkte på siden
 * - Interaktiv prishistorik-graf
 * - Krydslinks til virksomhedssider for selskabsejere
 * - Mørkt tema optimeret til professionelle brugere
 */

import { useState, use } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  Download,
  Bell,
  List,
  MapPin,
  Building2,
  Sparkles,
  ChevronRight,
  TrendingUp,
  Shield,
  FileText,
  Users,
  Landmark,
  BarChart3,
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
import { getEjendomById, formatDKK, formatDato } from '@/app/lib/mock/ejendomme';

type Tab = 'overblik' | 'bbr' | 'ejerforhold' | 'tinglysning' | 'oekonomi' | 'dokumenter';

const tabs: { id: Tab; label: string; ikon: React.ReactNode }[] = [
  { id: 'overblik', label: 'Overblik', ikon: <Building2 size={14} /> },
  { id: 'bbr', label: 'BBR', ikon: <FileText size={14} /> },
  { id: 'ejerforhold', label: 'Ejerforhold', ikon: <Users size={14} /> },
  { id: 'tinglysning', label: 'Tinglysning', ikon: <Landmark size={14} /> },
  { id: 'oekonomi', label: 'Økonomi', ikon: <BarChart3 size={14} /> },
  { id: 'dokumenter', label: 'Dokumenter', ikon: <FileText size={14} /> },
];

/** Energimærke-farve */
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
 */
function DataKort({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
      <p className="text-slate-400 text-xs mb-1">{label}</p>
      <p className="text-white font-semibold text-lg leading-tight">{value}</p>
      {sub && <p className="text-slate-500 text-xs mt-0.5">{sub}</p>}
    </div>
  );
}

/**
 * Ejendomsdetaljeside med tabs og kortvisning.
 * @param params - URL params med ejendoms-id
 */
export default function EjendomDetalje({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [aktivTab, setAktivTab] = useState<Tab>('overblik');

  const ejendom = getEjendomById(id);

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

  /** Prishistorik tilpasset til recharts */
  const prisData = ejendom.handelHistorik
    .slice()
    .reverse()
    .map((h) => ({
      dato: new Date(h.dato).getFullYear().toString(),
      pris: Math.round(h.pris / 1000000),
      prisPerM2: h.prisPerM2,
    }));

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
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

          <div className="flex items-center gap-2">
            {/* AI Analysér — BizzAssist eksklusiv feature */}
            <button className="flex items-center gap-2 px-3 py-1.5 bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/30 rounded-lg text-blue-300 text-sm font-medium transition-all">
              <Sparkles size={14} />
              AI Analysér
            </button>
            <button className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700/60 rounded-lg text-slate-300 text-sm transition-all">
              <Download size={14} />
              Rapport
            </button>
            <button className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700/60 rounded-lg text-slate-300 text-sm transition-all">
              <Bell size={14} />
              Følg
            </button>
            <button className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700/60 rounded-lg text-slate-300 text-sm transition-all">
              <List size={14} />
              Liste
            </button>
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

      {/* Indhold + kort */}
      <div className="flex flex-1 overflow-hidden">
        {/* Tab indhold — scrollbar til venstre */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* ─── OVERBLIK ─── */}
          {aktivTab === 'overblik' && (
            <div className="space-y-5">
              {/* Matrikel + Bygning + Enheder */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 space-y-3">
                  <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">
                    Matrikel
                  </p>
                  <DataKort
                    label="Grundareal"
                    value={`${ejendom.grundareal.toLocaleString('da-DK')} m²`}
                  />
                  <DataKort label="Bebyggelsesprocent" value={`${ejendom.bebyggelsesprocent}%`} />
                  <p className="text-slate-500 text-xs">
                    {ejendom.ejere.length > 0 ? `${ejendom.ejere.length} matrikel` : '—'}
                  </p>
                </div>
                <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 space-y-3">
                  <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">
                    Bygning
                  </p>
                  <DataKort
                    label="Bygningsareal"
                    value={`${ejendom.bygningsareal.toLocaleString('da-DK')} m²`}
                  />
                  <DataKort label="Kælder" value={`${ejendom.kaelder} m²`} />
                  <DataKort label="Udnyttet tagetage" value="0 m²" />
                </div>
                <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 space-y-3">
                  <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">
                    Enheder
                  </p>
                  <DataKort label="Beboelsesareal" value={`${ejendom.beboelsesareal} m²`} />
                  <DataKort
                    label="Erhvervsareal"
                    value={`${ejendom.erhvervsareal.toLocaleString('da-DK')} m²`}
                  />
                  <DataKort label="Erhvervsenheder" value={`${ejendom.erhvervsenheder}`} />
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

          {/* ─── BBR ─── */}
          {aktivTab === 'bbr' && (
            <div className="space-y-4">
              {ejendom.bygninger.map((b) => (
                <div key={b.id} className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-white font-semibold">Bygning 1 — {b.anvendelse}</h3>
                    <div
                      className={`px-2 py-0.5 rounded-lg text-xs font-bold text-white ${energiColor[b.energimaerke] ?? 'bg-slate-600'}`}
                    >
                      {b.energimaerke}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {[
                      { label: 'Opførelsesår', value: b.opfoerelsesaar.toString() },
                      { label: 'Etager', value: `${b.etager}` },
                      { label: 'Bygningsareal', value: `${b.bygningsareal} m²` },
                      { label: 'Kælder', value: `${b.kaelder} m²` },
                      { label: 'Tagetage', value: `${b.tagetage} m²` },
                      { label: 'Beboelsesenheder', value: `${b.boligenheder}` },
                      { label: 'Erhvervsenheder', value: `${b.erhvervsenheder}` },
                      { label: 'Beboelsesareal', value: `${b.beboelsesareal} m²` },
                      { label: 'Erhvervsareal', value: `${b.erhvervsareal} m²` },
                    ].map((d) => (
                      <DataKort key={d.label} label={d.label} value={d.value} />
                    ))}
                  </div>

                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                    <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-3">
                      Tekniske installationer
                    </p>
                    <div className="grid grid-cols-2 gap-y-3">
                      {[
                        { label: 'Tagmateriale', value: b.tagmateriale },
                        { label: 'Ydervægge', value: b.ydervaeggene },
                        { label: 'Varmeinstallation', value: b.varmeinstallation },
                        { label: 'Opvarmningsform', value: b.opvarmningsmaade },
                        { label: 'Vandforsyning', value: b.vandforsyning },
                        { label: 'Afløb', value: b.afloebsforhold },
                      ].map((d) => (
                        <div key={d.label}>
                          <p className="text-slate-500 text-xs">{d.label}</p>
                          <p className="text-slate-200 text-sm">{d.value}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ─── EJERFORHOLD ─── */}
          {aktivTab === 'ejerforhold' && (
            <div className="space-y-4">
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

              <div className="flex items-start gap-2 p-3 bg-blue-500/5 border border-blue-500/20 rounded-xl">
                <Info size={14} className="text-blue-400 mt-0.5 flex-shrink-0" />
                <p className="text-slate-400 text-xs">
                  Ejerhistorik og tinglysningsdata hentes fra Datafordeleren i Fase 2. Klik på et
                  selskabsnavn for at gå til virksomhedsprofilen.
                </p>
              </div>
            </div>
          )}

          {/* ─── TINGLYSNING ─── */}
          {aktivTab === 'tinglysning' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between mb-2">
                <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">
                  {ejendom.haeftelser.length} tinglyste dokumenter
                </p>
                <p className="text-slate-500 text-xs">
                  Aktive: {ejendom.haeftelser.filter((h) => h.status === 'aktiv').length}
                </p>
              </div>

              {ejendom.haeftelser.map((h) => (
                <div
                  key={h.id}
                  className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3">
                      <div
                        className={`p-2 rounded-lg ${h.status === 'aktiv' ? 'bg-blue-500/10' : 'bg-slate-700/50'}`}
                      >
                        <Shield
                          size={14}
                          className={h.status === 'aktiv' ? 'text-blue-400' : 'text-slate-500'}
                        />
                      </div>
                      <div>
                        <p className="text-white text-sm font-medium capitalize">{h.type}</p>
                        <p className="text-slate-400 text-xs">{h.kreditor}</p>
                        <p className="text-slate-500 text-xs mt-1">
                          Tinglyst {formatDato(h.tinglysningsdato)}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      {h.beloeb && (
                        <p className="text-white font-semibold text-sm">{formatDKK(h.beloeb)}</p>
                      )}
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full ${
                          h.status === 'aktiv'
                            ? 'bg-green-500/10 text-green-400'
                            : 'bg-slate-700 text-slate-400'
                        }`}
                      >
                        {h.status}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ─── ØKONOMI ─── */}
          {aktivTab === 'oekonomi' && (
            <div className="space-y-5">
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
                      tickFormatter={(v) => `${v}M`}
                    />
                    <Tooltip
                      contentStyle={{
                        background: '#0f172a',
                        border: '1px solid #1e293b',
                        borderRadius: '12px',
                        color: '#fff',
                      }}
                      formatter={(value) => [`${value} mio. DKK`, 'Pris']}
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

              {/* Handelstabel */}
              <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-700/40">
                  <p className="text-slate-200 text-sm font-semibold">Handelshistorik</p>
                </div>
                <table className="w-full">
                  <thead>
                    <tr className="text-slate-500 text-xs">
                      <th className="px-4 py-2 text-left font-medium">Dato</th>
                      <th className="px-4 py-2 text-right font-medium">Pris</th>
                      <th className="px-4 py-2 text-right font-medium">DKK/m²</th>
                      <th className="px-4 py-2 text-right font-medium">Køber</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ejendom.handelHistorik.map((h, i) => (
                      <tr
                        key={i}
                        className="border-t border-slate-700/30 hover:bg-slate-700/20 transition-colors"
                      >
                        <td className="px-4 py-3 text-slate-300 text-sm">{formatDato(h.dato)}</td>
                        <td className="px-4 py-3 text-white text-sm font-semibold text-right">
                          {formatDKK(h.pris)}
                        </td>
                        <td className="px-4 py-3 text-slate-300 text-sm text-right">
                          {h.prisPerM2.toLocaleString('da-DK')}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full ${
                              h.koeberType === 'selskab'
                                ? 'bg-blue-500/10 text-blue-400'
                                : 'bg-slate-700 text-slate-400'
                            }`}
                          >
                            {h.koeberType === 'selskab' ? 'Selskab' : 'Person'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ─── DOKUMENTER ─── */}
          {aktivTab === 'dokumenter' && (
            <div className="space-y-3">
              {ejendom.haeftelser.map((h) => (
                <div
                  key={h.id}
                  className="flex items-center justify-between p-4 bg-slate-800/40 border border-slate-700/40 rounded-xl hover:border-slate-600/60 transition-colors group cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-slate-700/50 rounded-lg">
                      <FileText size={15} className="text-slate-400" />
                    </div>
                    <div>
                      <p className="text-slate-200 text-sm font-medium">{h.dokument}</p>
                      <p className="text-slate-500 text-xs">
                        {formatDato(h.tinglysningsdato)} · {h.kreditor}
                      </p>
                    </div>
                  </div>
                  <Download
                    size={15}
                    className="text-slate-600 group-hover:text-slate-300 transition-colors"
                  />
                </div>
              ))}

              <div className="flex items-start gap-2 p-3 bg-blue-500/5 border border-blue-500/20 rounded-xl mt-4">
                <Info size={14} className="text-blue-400 mt-0.5 flex-shrink-0" />
                <p className="text-slate-400 text-xs">
                  Dokumenthentning fra tinglysning.dk integreres i Fase 2. BBR-meddelelse tilføjes
                  via Datafordeleren.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Kortpanel — højre side */}
        <div className="hidden xl:flex w-[380px] flex-shrink-0 flex-col border-l border-slate-700/50">
          {/* Luftfoto */}
          <div className="flex-1 bg-slate-900 relative overflow-hidden">
            <iframe
              src={`https://www.openstreetmap.org/export/embed.html?bbox=${ejendom.lng - 0.005},${ejendom.lat - 0.003},${ejendom.lng + 0.005},${ejendom.lat + 0.003}&layer=mapnik&marker=${ejendom.lat},${ejendom.lng}`}
              className="w-full h-full border-none opacity-80"
              title="Ejendomskort"
            />
            <div className="absolute top-3 right-3">
              <button className="px-2 py-1 bg-slate-900/90 backdrop-blur-sm border border-slate-700/50 rounded-lg text-slate-300 text-xs">
                Luftfoto →
              </button>
            </div>
          </div>
          {/* Matrikelkort placeholder */}
          <div className="h-[180px] bg-slate-900/80 border-t border-slate-700/50 flex items-center justify-center">
            <div className="text-center">
              <MapPin size={20} className="text-slate-600 mx-auto mb-2" />
              <p className="text-slate-500 text-xs">Matrikelkort</p>
              <p className="text-slate-600 text-xs">WFS integration · Fase 2</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
