/**
 * Analyse landing page — /dashboard/analyse
 *
 * BIZZ-1037: Viser to kort: "AI Analyse" og "Data Analyse".
 * AI Analyse linker til den eksisterende analyse-side.
 * Data Analyse linker til den kommende Perspective-baserede pivot-tabel.
 *
 * @module app/dashboard/analyse
 */

import Link from 'next/link';
import { Sparkles, Table2 } from 'lucide-react';

/**
 * Analyse landing page med to indgange.
 */
export default function AnalyseLandingPage() {
  return (
    <div className="flex-1 bg-[#0a1628] p-8">
      <h1 className="text-2xl font-bold text-white mb-2">Analyse</h1>
      <p className="text-slate-400 text-sm mb-8">
        Analysér ejendomme, virksomheder og markedsdata med AI eller pivot-tabeller.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-3xl">
        {/* AI Analyse */}
        <Link
          href="/dashboard/analyse/ai"
          className="group bg-slate-800/40 border border-slate-700/40 hover:border-blue-500/40 rounded-2xl p-6 transition-all hover:bg-slate-800/60"
        >
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-400 group-hover:bg-blue-500/20 transition-colors">
              <Sparkles size={22} />
            </div>
            <h2 className="text-lg font-semibold text-white">AI Analyse</h2>
          </div>
          <p className="text-slate-400 text-sm leading-relaxed">
            Stil spørgsmål om ejendomme, virksomheder og markedsdata. AI&apos;en henter data fra
            alle tilgængelige kilder og præsenterer resultatet.
          </p>
        </Link>

        {/* Data Analyse */}
        <Link
          href="/dashboard/analyse/data"
          className="group bg-slate-800/40 border border-slate-700/40 hover:border-emerald-500/40 rounded-2xl p-6 transition-all hover:bg-slate-800/60"
        >
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-400 group-hover:bg-emerald-500/20 transition-colors">
              <Table2 size={22} />
            </div>
            <h2 className="text-lg font-semibold text-white">Data Analyse</h2>
          </div>
          <p className="text-slate-400 text-sm leading-relaxed">
            Udforsk datasæt med pivot-tabeller, grafer og filtre. Skriv forespørgsler på dansk og få
            strukturerede resultater.
          </p>
          {/* BIZZ-1037: "Kommer snart" fjernet — AI Query Builder er live */}
        </Link>
      </div>
    </div>
  );
}
