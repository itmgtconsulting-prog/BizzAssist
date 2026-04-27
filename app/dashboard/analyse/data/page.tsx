/**
 * Data Analyse — /dashboard/analyse/data
 *
 * BIZZ-1037 (placeholder): Fremtidig Perspective pivot-tabel side.
 * BIZZ-1038 bygger AI Query Builder ovenpå.
 * BIZZ-1039 tilføjer dataset-vælger + eksport.
 */

import { Table2 } from 'lucide-react';

/**
 * Placeholder for Data Analyse (Perspective pivot-tabeller).
 */
export default function AnalyseDataPage() {
  return (
    <div className="flex-1 bg-[#0a1628] flex items-center justify-center">
      <div className="text-center max-w-md">
        <div className="p-4 bg-emerald-500/10 rounded-2xl inline-block mb-4">
          <Table2 size={32} className="text-emerald-400" />
        </div>
        <h2 className="text-xl font-bold text-white mb-2">Data Analyse</h2>
        <p className="text-slate-400 text-sm leading-relaxed">
          Pivot-tabeller og datavisualiseringer med AI-drevne forespørgsler kommer snart. Du kan
          allerede bruge AI Analyse til at stille spørgsmål om dine data.
        </p>
      </div>
    </div>
  );
}
