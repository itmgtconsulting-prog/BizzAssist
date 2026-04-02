/**
 * Dashboard loading skeleton.
 * Shown by Next.js App Router when navigating between dashboard pages.
 * Provides instant visual feedback while the page component loads.
 */
export default function DashboardLoading() {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 animate-pulse">
      {/* Title skeleton */}
      <div>
        <div className="h-7 w-64 bg-slate-700/40 rounded-lg" />
        <div className="h-4 w-96 bg-slate-700/20 rounded-lg mt-2" />
      </div>

      {/* Quick action cards skeleton */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="bg-white/5 border border-white/8 rounded-2xl p-5 flex flex-col items-center gap-3"
          >
            <div className="w-12 h-12 rounded-xl bg-slate-700/30" />
            <div className="h-3 w-16 bg-slate-700/20 rounded" />
          </div>
        ))}
      </div>

      {/* Content sections skeleton */}
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="bg-white/5 border border-white/8 rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/8 flex items-center gap-3">
            <div className="h-4 w-32 bg-slate-700/30 rounded" />
            <div className="h-4 w-6 bg-slate-700/20 rounded-full" />
          </div>
          <div className="px-6 py-4 space-y-3">
            {Array.from({ length: 2 }).map((_, j) => (
              <div key={j} className="flex items-center gap-4">
                <div className="w-8 h-8 rounded-lg bg-slate-700/20" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 w-48 bg-slate-700/20 rounded" />
                  <div className="h-2.5 w-32 bg-slate-700/10 rounded" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
