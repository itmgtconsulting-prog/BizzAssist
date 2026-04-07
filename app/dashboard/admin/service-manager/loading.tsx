/**
 * Loading skeleton for admin service manager (/dashboard/admin/service-manager).
 * Mirrors the deployments list + scan history + fix proposals layout.
 * Shown by Next.js App Router during server component data fetching.
 */
export default function AdminServiceManagerLoading() {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 animate-pulse">
      {/* Back link + heading + trigger button */}
      <div className="h-4 w-24 bg-slate-700/20 rounded" />
      <div className="flex items-center justify-between">
        <div className="h-8 w-52 bg-slate-800 rounded-lg" />
        <div className="h-9 w-36 bg-slate-700/30 rounded-xl" />
      </div>

      {/* Deployments card */}
      <div className="bg-white/5 border border-white/8 rounded-2xl p-6 space-y-3">
        <div className="h-5 w-40 bg-slate-700/40 rounded" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 py-2 border-b border-slate-700/10">
            <div className="w-2 h-2 rounded-full bg-slate-700/50 flex-shrink-0" />
            <div className="flex-1 space-y-1">
              <div className="h-4 w-48 bg-slate-700/30 rounded" />
              <div className="h-3 w-32 bg-slate-700/15 rounded" />
            </div>
            <div className="h-5 w-20 bg-slate-700/25 rounded-full" />
            <div className="h-3 w-24 bg-slate-700/20 rounded" />
          </div>
        ))}
      </div>

      {/* Scan history + fix proposals */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="bg-white/5 border border-white/8 rounded-2xl p-6 space-y-3">
            <div className="h-5 w-40 bg-slate-700/40 rounded" />
            {Array.from({ length: 3 }).map((_, j) => (
              <div key={j} className="bg-slate-800/40 rounded-xl p-4 space-y-2">
                <div className="h-4 w-36 bg-slate-700/40 rounded" />
                <div className="h-3 w-full bg-slate-700/20 rounded" />
                <div className="flex gap-2">
                  <div className="h-7 w-20 bg-slate-700/30 rounded-lg" />
                  <div className="h-7 w-20 bg-slate-700/25 rounded-lg" />
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
