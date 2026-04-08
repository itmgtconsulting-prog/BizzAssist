/**
 * Loading skeleton for admin user management (/dashboard/admin/users).
 * Mirrors the search bar + filterable user table layout.
 * Shown by Next.js App Router during server component data fetching.
 */
export default function AdminUsersLoading() {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 animate-pulse">
      {/* Back link + heading */}
      <div className="h-4 w-24 bg-slate-700/20 rounded" />
      <div className="flex items-center justify-between">
        <div className="h-8 w-52 bg-slate-800 rounded-lg" />
        <div className="h-9 w-32 bg-slate-700/30 rounded-xl" />
      </div>

      {/* Search + filter bar */}
      <div className="flex gap-3">
        <div className="flex-1 h-10 bg-slate-800 rounded-xl" />
        <div className="w-32 h-10 bg-slate-800 rounded-xl" />
      </div>

      {/* User table rows */}
      <div className="bg-white/5 border border-white/8 rounded-2xl overflow-hidden">
        {/* Table header */}
        <div className="flex items-center gap-4 px-4 py-3 border-b border-slate-700/30">
          {[48, 80, 64, 56, 40].map((w, i) => (
            <div key={i} className={`h-3 w-${w} bg-slate-700/30 rounded flex-shrink-0`} />
          ))}
        </div>
        {/* Rows */}
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-4 border-b border-slate-700/10">
            <div className="w-8 h-8 rounded-lg bg-slate-700/30 flex-shrink-0" />
            <div className="flex-1 space-y-1 min-w-0">
              <div className="h-4 w-40 bg-slate-700/30 rounded" />
              <div className="h-3 w-56 bg-slate-700/15 rounded" />
            </div>
            <div className="h-5 w-20 bg-slate-700/25 rounded-full flex-shrink-0" />
            <div className="h-5 w-16 bg-slate-700/20 rounded-full flex-shrink-0" />
            <div className="h-3 w-24 bg-slate-700/20 rounded flex-shrink-0" />
            <div className="h-7 w-20 bg-slate-700/25 rounded-lg flex-shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}
