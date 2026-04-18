/**
 * Loading skeleton for /dashboard/pvoplys/[fiktivtPVnummer].
 * Mirrors back-link → header → address block → properties table layout.
 * BIZZ-483 / BIZZ-478: konsistent med øvrige detalje-sider.
 */
export default function PVOplysDetailLoading() {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 animate-pulse">
      {/* Back link */}
      <div className="h-4 w-24 bg-slate-700/20 rounded" />

      {/* Header: icon + navn + type-badge */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-slate-800" />
          <div className="h-8 w-72 bg-slate-800 rounded-lg" />
        </div>
        <div className="flex gap-2 mt-2">
          <div className="h-6 w-28 bg-slate-800 rounded-full" />
          <div className="h-6 w-40 bg-slate-800 rounded-full" />
        </div>
      </div>

      {/* Adresse + PV-nummer kort */}
      <div className="bg-white/5 border border-white/8 rounded-2xl p-5 space-y-3">
        <div className="h-4 w-32 bg-slate-700/30 rounded" />
        <div className="h-4 w-80 bg-slate-700/20 rounded" />
        <div className="h-4 w-48 bg-slate-700/20 rounded" />
      </div>

      {/* Ejendomsliste */}
      <div className="bg-white/5 border border-white/8 rounded-2xl p-6 space-y-4">
        <div className="h-5 w-40 bg-slate-700/30 rounded" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 py-2 border-b border-slate-700/20">
            <div className="w-8 h-8 rounded-lg bg-slate-700/30 flex-shrink-0" />
            <div className="flex-1 space-y-1">
              <div className="h-4 w-56 bg-slate-700/30 rounded" />
              <div className="h-3 w-32 bg-slate-700/15 rounded" />
            </div>
            <div className="h-5 w-16 bg-slate-700/20 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
