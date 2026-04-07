/**
 * Loading skeleton for the settings page (/dashboard/settings).
 * Mirrors the tab bar + settings card layout (Følger, Sikkerhed, Abonnement, Data).
 * Shown by Next.js App Router during server component data fetching.
 */
export default function SettingsLoading() {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 animate-pulse">
      {/* Back link + heading */}
      <div className="h-4 w-20 bg-slate-700/20 rounded" />
      <div className="h-8 w-48 bg-slate-800 rounded-lg" />

      {/* Tab bar */}
      <div className="flex gap-6 border-b border-slate-700/30 pb-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-4 w-24 bg-slate-700/20 rounded" />
        ))}
      </div>

      {/* Subscription plan cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="bg-white/5 border border-white/8 rounded-2xl p-6 space-y-3">
            <div className="h-5 w-32 bg-slate-700/40 rounded" />
            <div className="h-8 w-20 bg-slate-700/30 rounded" />
            <div className="space-y-1">
              <div className="h-3 w-full bg-slate-700/20 rounded" />
              <div className="h-3 w-3/4 bg-slate-700/15 rounded" />
            </div>
            <div className="h-9 w-full bg-slate-700/30 rounded-xl" />
          </div>
        ))}
      </div>

      {/* Tracked entities list */}
      <div className="bg-white/5 border border-white/8 rounded-2xl p-6 space-y-4">
        <div className="h-5 w-36 bg-slate-700/30 rounded" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 py-2 border-b border-slate-700/20">
            <div className="w-8 h-8 rounded-lg bg-slate-700/30 flex-shrink-0" />
            <div className="flex-1 space-y-1">
              <div className="h-4 w-56 bg-slate-700/30 rounded" />
              <div className="h-3 w-32 bg-slate-700/15 rounded" />
            </div>
            <div className="h-8 w-24 bg-slate-700/20 rounded-xl" />
          </div>
        ))}
      </div>
    </div>
  );
}
