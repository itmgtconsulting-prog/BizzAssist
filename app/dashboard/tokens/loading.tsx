/**
 * Loading skeleton for the tokens page (/dashboard/tokens).
 * Mirrors the token-balance meter + token-pack purchase cards layout.
 * Shown by Next.js App Router during server component data fetching.
 */
export default function TokensLoading() {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 animate-pulse">
      {/* Back link + heading */}
      <div className="h-4 w-20 bg-slate-700/20 rounded" />
      <div className="space-y-1">
        <div className="h-8 w-36 bg-slate-800 rounded-lg" />
        <div className="h-4 w-64 bg-slate-800/60 rounded" />
      </div>

      {/* Token balance card */}
      <div className="bg-white/5 border border-white/8 rounded-2xl p-6 space-y-4 max-w-xl">
        <div className="h-5 w-36 bg-slate-700/40 rounded" />
        {/* Meter bar */}
        <div className="h-4 w-full bg-slate-700/20 rounded-full">
          <div className="h-4 w-2/5 bg-slate-700/50 rounded-full" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="space-y-1">
              <div className="h-3 w-28 bg-slate-700/20 rounded" />
              <div className="h-5 w-20 bg-slate-700/30 rounded" />
            </div>
          ))}
        </div>
      </div>

      {/* Token pack purchase cards */}
      <div className="h-5 w-40 bg-slate-800 rounded" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="bg-white/5 border border-white/8 rounded-2xl p-6 space-y-3">
            <div className="h-5 w-32 bg-slate-700/40 rounded" />
            <div className="h-8 w-24 bg-slate-700/30 rounded" />
            <div className="h-3 w-20 bg-slate-700/20 rounded" />
            <div className="h-9 w-full bg-slate-700/30 rounded-xl mt-2" />
          </div>
        ))}
      </div>
    </div>
  );
}
