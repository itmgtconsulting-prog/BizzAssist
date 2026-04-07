/**
 * Loading skeleton for the Universal Search page (`/dashboard/search`).
 *
 * Shown by Next.js App Router while the page component is being streamed.
 * Matches the full layout of the search page: header, tab bar, and result cards.
 * No 'use client' needed — this is a pure server component.
 */
export default function SearchLoading() {
  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#0a1020]">
      {/* ─── Header skeleton ───────────────────────────────────────────── */}
      <div className="px-6 sm:px-8 pt-8 pb-6 border-b border-slate-700/40 shrink-0 animate-pulse">
        {/* Title */}
        <div className="h-7 w-48 bg-slate-700/60 rounded-lg mb-2" />
        {/* Subtitle */}
        <div className="h-4 w-72 bg-slate-700/40 rounded mb-5" />
        {/* Search input */}
        <div className="max-w-2xl h-14 bg-slate-800/60 border border-slate-700/50 rounded-2xl" />
      </div>

      {/* ─── Tab bar skeleton ──────────────────────────────────────────── */}
      <div className="flex items-center gap-6 border-b border-slate-700/40 px-6 sm:px-8 py-3 shrink-0 animate-pulse">
        {['w-24', 'w-28', 'w-20'].map((w, i) => (
          <div key={i} className={`h-4 ${w} bg-slate-700/40 rounded`} />
        ))}
      </div>

      {/* ─── Result cards skeleton ─────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden px-6 sm:px-8 py-6 animate-pulse">
        <div className="space-y-3 max-w-2xl">
          {Array.from({ length: 7 }, (_, i) => (
            <div
              key={i}
              className="bg-[#0f172a] border border-slate-700/50 rounded-xl p-4 flex items-center gap-4"
            >
              <div className="w-9 h-9 rounded-lg bg-slate-700/60 shrink-0" />
              <div className="flex-1 space-y-2">
                <div
                  className={`h-3.5 bg-slate-700/60 rounded ${i % 3 === 0 ? 'w-3/5' : i % 3 === 1 ? 'w-2/3' : 'w-4/5'}`}
                />
                <div className={`h-3 bg-slate-700/40 rounded ${i % 2 === 0 ? 'w-2/5' : 'w-1/2'}`} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
