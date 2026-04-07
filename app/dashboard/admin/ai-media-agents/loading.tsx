/**
 * Loading skeleton for admin AI media agents config (/dashboard/admin/ai-media-agents).
 * Mirrors the multi-section settings cards layout (general AI, blocked domains,
 * company agent, person agent).
 * Shown by Next.js App Router during server component data fetching.
 */
export default function AdminAiMediaAgentsLoading() {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 animate-pulse">
      {/* Back link + heading */}
      <div className="h-4 w-24 bg-slate-700/20 rounded" />
      <div className="h-8 w-56 bg-slate-800 rounded-lg" />

      {/* Four settings section cards */}
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="bg-white/5 border border-white/8 rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-slate-700/40" />
            <div className="h-5 w-44 bg-slate-700/40 rounded" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {Array.from({ length: 4 }).map((_, j) => (
              <div key={j} className="space-y-2">
                <div className="h-4 w-36 bg-slate-700/25 rounded" />
                <div className="h-10 w-full bg-slate-700/20 rounded-xl" />
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Save button */}
      <div className="flex justify-end">
        <div className="h-9 w-28 bg-slate-700/30 rounded-xl" />
      </div>
    </div>
  );
}
