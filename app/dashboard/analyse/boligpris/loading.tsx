/**
 * Loading skeleton for /dashboard/analyse/boligpris.
 *
 * BIZZ-2029: Matches dark theme skeleton pattern — KPI cards + chart + table.
 */
export default function BoligprisLoading() {
  return (
    <div className="flex-1 bg-[#0a1628] p-6 animate-pulse space-y-6">
      {/* Header */}
      <div className="h-7 bg-slate-700/40 rounded w-72" />
      <div className="h-4 bg-slate-700/30 rounded w-96" />

      {/* Filter chips */}
      <div className="flex gap-3">
        <div className="h-10 bg-slate-800/40 rounded-lg w-28" />
        <div className="h-10 bg-slate-800/40 rounded-lg w-28" />
        <div className="h-10 bg-slate-800/40 rounded-lg w-28" />
        <div className="h-10 bg-slate-800/40 rounded-lg w-28" />
        <div className="h-10 bg-slate-800/40 rounded-lg w-28" />
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 bg-slate-800/40 rounded-xl" />
        ))}
      </div>

      {/* Chart */}
      <div className="h-80 bg-slate-800/40 rounded-xl" />

      {/* Table */}
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-12 bg-slate-800/40 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
