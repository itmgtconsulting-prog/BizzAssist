/**
 * Loading skeleton for admin support analytics (/dashboard/admin/analytics).
 * Mirrors the KPI row + bar chart + unmatched-questions list layout.
 * Shown by Next.js App Router during server component data fetching.
 */
export default function AdminAnalyticsLoading() {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 animate-pulse">
      {/* Back link + heading */}
      <div className="h-4 w-24 bg-slate-700/20 rounded" />
      <div className="h-8 w-56 bg-slate-800 rounded-lg" />

      {/* KPI stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-white/5 border border-white/8 rounded-2xl p-5 space-y-2">
            <div className="h-4 w-24 bg-slate-700/30 rounded" />
            <div className="h-8 w-16 bg-slate-700/50 rounded" />
          </div>
        ))}
      </div>

      {/* Bar chart placeholder */}
      <div className="bg-white/5 border border-white/8 rounded-2xl p-6 space-y-3">
        <div className="h-5 w-40 bg-slate-700/30 rounded" />
        <div className="flex items-end gap-2 h-32 pt-4">
          {[65, 40, 80, 55, 70, 35, 90, 60, 45, 75, 50, 85, 30, 65].map((h, i) => (
            <div key={i} className="flex-1 bg-slate-700/40 rounded-t" style={{ height: `${h}%` }} />
          ))}
        </div>
      </div>

      {/* Two-column lower section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="bg-white/5 border border-white/8 rounded-2xl p-6 space-y-3">
            <div className="h-5 w-44 bg-slate-700/30 rounded" />
            {Array.from({ length: 5 }).map((_, j) => (
              <div key={j} className="flex items-center gap-3">
                <div className="flex-1 h-3 bg-slate-700/20 rounded" />
                <div className="h-5 w-8 bg-slate-700/30 rounded" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
