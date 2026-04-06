/**
 * Loading skeleton for properties list page.
 * Shown instantly by Next.js when navigating to the properties overview.
 */
export default function PropertiesLoading() {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 animate-pulse">
      <div className="h-7 w-48 bg-slate-700/40 rounded-lg" />
      <div className="h-10 w-full bg-slate-700/20 rounded-xl" />
      <div className="space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="bg-white/5 border border-white/8 rounded-2xl p-4 flex items-center gap-4"
          >
            <div className="w-10 h-10 rounded-lg bg-slate-700/20" />
            <div className="flex-1 space-y-1.5">
              <div className="h-4 w-64 bg-slate-700/20 rounded" />
              <div className="h-3 w-40 bg-slate-700/10 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
