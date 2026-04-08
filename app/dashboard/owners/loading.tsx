/**
 * Loading skeleton for the people (owners) list page.
 * Mirrors the search bar + recently-visited person cards layout.
 * Shown by Next.js App Router during server component data fetching.
 */
export default function OwnersLoading() {
  return (
    <div className="flex-1 flex flex-col bg-[#0a1628] animate-pulse">
      {/* Header + search bar */}
      <div className="px-8 pt-8 pb-6 border-b border-slate-700/40 space-y-4">
        <div className="h-7 w-36 bg-slate-800 rounded-lg" />
        <div className="h-4 w-72 bg-slate-800/60 rounded" />
        <div className="h-14 w-full bg-slate-800 rounded-2xl mt-5" />
      </div>

      {/* Recent persons grid */}
      <div className="flex-1 px-8 py-6 space-y-4">
        {/* Section heading row */}
        <div className="flex items-center justify-between">
          <div className="h-4 w-40 bg-slate-800 rounded" />
          <div className="h-3 w-20 bg-slate-800/60 rounded" />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="bg-slate-800/40 border border-slate-700/40 rounded-2xl p-5 space-y-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="w-9 h-9 rounded-xl bg-slate-700/60" />
                <div className="h-3 w-20 bg-slate-700/40 rounded mt-1" />
              </div>
              <div className="space-y-1">
                <div className="h-4 w-40 bg-slate-700/60 rounded" />
                <div className="h-3 w-24 bg-slate-700/30 rounded" />
              </div>
              <div className="pt-1 border-t border-slate-700/40 flex justify-end">
                <div className="h-4 w-4 bg-slate-700/40 rounded" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
