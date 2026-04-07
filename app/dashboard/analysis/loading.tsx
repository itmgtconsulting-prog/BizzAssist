/**
 * Loading skeleton for the AI Analyse-side.
 *
 * Shown by Next.js App Router while the analysis page is loading.
 * Mirrors the page layout: header, 2x2 card grid.
 */
export default function AnalysisLoading() {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Page header skeleton */}
      <div className="space-y-2">
        <div className="h-8 w-40 rounded-lg bg-white/8 animate-pulse" />
        <div className="h-4 w-64 rounded-lg bg-white/5 animate-pulse" />
      </div>

      {/* 2x2 card grid skeleton */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="rounded-2xl border border-white/8 bg-white/5 p-5 space-y-3 animate-pulse"
          >
            <div className="flex items-start gap-4">
              <div className="w-11 h-11 rounded-xl bg-white/8 shrink-0" />
              <div className="flex-1 space-y-2 pt-1">
                <div className="h-4 w-3/4 rounded bg-white/8" />
                <div className="h-3 w-full rounded bg-white/5" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
