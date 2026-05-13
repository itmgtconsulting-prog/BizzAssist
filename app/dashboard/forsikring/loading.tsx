/**
 * Loading skeleton for /dashboard/forsikring.
 * Mirrors header + KPI-tiles + tabel-layout.
 */
export default function ForsikringLoading() {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 animate-pulse">
      {/* Heading */}
      <div className="space-y-2">
        <div className="h-8 w-48 bg-slate-800 rounded-lg" />
        <div className="h-4 w-96 bg-slate-800/60 rounded" />
      </div>

      {/* KPI tiles */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-white/5 border border-white/8 rounded-2xl p-5 space-y-2">
            <div className="h-3 w-20 bg-slate-700/30 rounded" />
            <div className="h-8 w-16 bg-slate-700/40 rounded" />
          </div>
        ))}
      </div>

      {/* Upload-zone */}
      <div className="h-32 bg-white/5 border border-dashed border-white/10 rounded-2xl" />

      {/* Tabel */}
      <div className="bg-white/5 border border-white/8 rounded-2xl">
        <div className="h-10 bg-slate-700/20" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-14 border-t border-white/5 px-4 flex items-center gap-4">
            <div className="h-4 w-32 bg-slate-700/30 rounded" />
            <div className="h-4 w-24 bg-slate-700/20 rounded" />
            <div className="h-4 w-48 bg-slate-700/20 rounded" />
            <div className="h-4 w-20 bg-slate-700/20 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}
