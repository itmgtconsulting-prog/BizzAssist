/**
 * Loading skeleton for the admin section root.
 * Shown by Next.js App Router when navigating into any /dashboard/admin/* route
 * before the child route's own loading.tsx takes over.
 */
export default function AdminLoading() {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 animate-pulse">
      {/* Back link + heading */}
      <div className="h-4 w-24 bg-slate-700/20 rounded" />
      <div className="h-8 w-48 bg-slate-800 rounded-lg" />

      {/* Admin nav cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="bg-white/5 border border-white/8 rounded-2xl p-5 space-y-3">
            <div className="w-9 h-9 rounded-xl bg-slate-700/40" />
            <div className="h-5 w-32 bg-slate-700/40 rounded" />
            <div className="h-3 w-full bg-slate-700/20 rounded" />
            <div className="h-3 w-3/4 bg-slate-700/15 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}
