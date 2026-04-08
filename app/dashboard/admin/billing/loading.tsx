/**
 * Loading skeleton for admin billing overview (/dashboard/admin/billing).
 * Mirrors the KPI cards + filterable billing table layout.
 * Shown by Next.js App Router during server component data fetching.
 */
export default function AdminBillingLoading() {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 animate-pulse">
      {/* Back link + heading */}
      <div className="h-4 w-24 bg-slate-700/20 rounded" />
      <div className="h-8 w-52 bg-slate-800 rounded-lg" />

      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="bg-white/5 border border-white/8 rounded-2xl p-5 space-y-2">
            <div className="h-4 w-28 bg-slate-700/30 rounded" />
            <div className="h-8 w-24 bg-slate-700/50 rounded" />
            <div className="h-3 w-20 bg-slate-700/20 rounded" />
          </div>
        ))}
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-8 w-24 bg-slate-800 rounded-xl" />
        ))}
      </div>

      {/* Billing table */}
      <div className="bg-white/5 border border-white/8 rounded-2xl overflow-hidden">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3 border-b border-slate-700/10">
            <div className="flex-1 space-y-1 min-w-0">
              <div className="h-4 w-44 bg-slate-700/30 rounded" />
              <div className="h-3 w-32 bg-slate-700/15 rounded" />
            </div>
            <div className="h-5 w-20 bg-slate-700/25 rounded-full flex-shrink-0" />
            <div className="h-5 w-16 bg-slate-700/20 rounded-full flex-shrink-0" />
            <div className="h-3 w-20 bg-slate-700/20 rounded flex-shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}
