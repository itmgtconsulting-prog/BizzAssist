/**
 * Loading skeleton for admin plan configuration (/dashboard/admin/plans).
 * Mirrors the plan cards + token-pack table layout.
 * Shown by Next.js App Router during server component data fetching.
 */
export default function AdminPlansLoading() {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 animate-pulse">
      {/* Back link + heading */}
      <div className="h-4 w-24 bg-slate-700/20 rounded" />
      <div className="flex items-center justify-between">
        <div className="h-8 w-48 bg-slate-800 rounded-lg" />
        <div className="h-9 w-28 bg-slate-700/30 rounded-xl" />
      </div>

      {/* Subscription plan cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="bg-white/5 border border-white/8 rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="h-6 w-32 bg-slate-700/40 rounded" />
              <div className="w-4 h-4 bg-slate-700/30 rounded" />
            </div>
            <div className="h-7 w-20 bg-slate-700/50 rounded" />
            <div className="space-y-1.5">
              {Array.from({ length: 4 }).map((_, j) => (
                <div key={j} className="h-3 w-full bg-slate-700/15 rounded" />
              ))}
            </div>
            <div className="flex gap-2 pt-2">
              <div className="h-8 flex-1 bg-slate-700/25 rounded-xl" />
              <div className="h-8 w-8 bg-slate-700/20 rounded-xl" />
            </div>
          </div>
        ))}
      </div>

      {/* Token packs section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="h-5 w-32 bg-slate-800 rounded" />
          <div className="h-8 w-24 bg-slate-700/30 rounded-xl" />
        </div>
        <div className="bg-white/5 border border-white/8 rounded-2xl overflow-hidden">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3 border-b border-slate-700/10">
              <div className="flex-1 space-y-1">
                <div className="h-4 w-36 bg-slate-700/30 rounded" />
                <div className="h-3 w-24 bg-slate-700/15 rounded" />
              </div>
              <div className="h-4 w-16 bg-slate-700/25 rounded" />
              <div className="h-4 w-16 bg-slate-700/25 rounded" />
              <div className="flex gap-2">
                <div className="h-7 w-7 bg-slate-700/25 rounded-lg" />
                <div className="h-7 w-7 bg-slate-700/20 rounded-lg" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
