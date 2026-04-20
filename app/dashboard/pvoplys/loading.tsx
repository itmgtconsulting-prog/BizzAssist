/**
 * Loading skeleton for PVOplys-ruter.
 *
 * Dækker /dashboard/pvoplys og tjener som fallback for underliggende ruter
 * der ikke har egen loading.tsx. Ejendomsdetalje-ruten [fiktivtPVnummer]/
 * har sin egen, mere specifikke skeleton.
 *
 * BIZZ-603: CLAUDE.md kræver loading.tsx på alle dashboard-ruter for at
 * undgå layout-shift ved navigation og give øjeblikkelig visuel respons.
 */
export default function PVOplysIndexLoading() {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 animate-pulse">
      {/* Breadcrumb-plads */}
      <div className="h-4 w-24 bg-slate-700/20 rounded" />

      {/* Header: ikon + titel + badges */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-slate-800" />
          <div className="h-8 w-64 bg-slate-800 rounded-lg" />
        </div>
        <div className="flex gap-2 mt-2">
          <div className="h-6 w-24 bg-slate-800 rounded-full" />
          <div className="h-6 w-32 bg-slate-800 rounded-full" />
        </div>
      </div>

      {/* Info-kort */}
      <div className="bg-slate-800/40 border border-slate-700/40 rounded-2xl p-6 space-y-4 max-w-2xl">
        <div className="h-4 w-3/4 bg-slate-700/30 rounded" />
        <div className="h-4 w-1/2 bg-slate-700/30 rounded" />
        <div className="h-4 w-2/3 bg-slate-700/30 rounded" />
      </div>
    </div>
  );
}
