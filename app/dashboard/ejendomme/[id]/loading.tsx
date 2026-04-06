/**
 * Loading skeleton for property detail page.
 * Shown instantly by Next.js when navigating to/from a property.
 */
export default function PropertyDetailLoading() {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 animate-pulse">
      {/* Back link + header */}
      <div className="h-4 w-24 bg-slate-700/20 rounded" />
      <div>
        <div className="h-8 w-80 bg-slate-700/40 rounded-lg" />
        <div className="flex gap-2 mt-3">
          <div className="h-6 w-20 bg-slate-700/20 rounded-full" />
          <div className="h-6 w-40 bg-slate-700/20 rounded-full" />
        </div>
      </div>

      {/* Tabs skeleton */}
      <div className="flex gap-4 border-b border-slate-700/30 pb-2">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="h-4 w-20 bg-slate-700/20 rounded" />
        ))}
      </div>

      {/* Content cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-white/5 border border-white/8 rounded-2xl p-6 space-y-4">
            <div className="h-5 w-32 bg-slate-700/30 rounded" />
            <div className="space-y-2">
              <div className="h-3 w-full bg-slate-700/15 rounded" />
              <div className="h-3 w-3/4 bg-slate-700/10 rounded" />
              <div className="h-3 w-1/2 bg-slate-700/10 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
