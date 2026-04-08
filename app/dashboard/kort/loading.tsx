/**
 * Loading skeleton for the full-page map (/dashboard/kort).
 * Shows a search bar skeleton over a full-height map placeholder.
 * Shown by Next.js App Router during server component data fetching.
 */
export default function KortLoading() {
  return (
    <div className="flex-1 flex flex-col bg-[#0f172a] animate-pulse overflow-hidden">
      {/* Search + controls bar */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 w-full max-w-xl px-4">
        <div className="flex-1 h-12 bg-slate-800 rounded-2xl" />
        <div className="w-10 h-10 bg-slate-800 rounded-xl" />
        <div className="w-10 h-10 bg-slate-800 rounded-xl" />
      </div>

      {/* Map area placeholder */}
      <div className="flex-1 relative bg-slate-900">
        {/* Subtle grid pattern to suggest a map */}
        <div className="absolute inset-0 bg-slate-800/30" />

        {/* Navigation controls stub */}
        <div className="absolute top-20 right-4 flex flex-col gap-2">
          <div className="w-8 h-8 bg-slate-800 rounded-md" />
          <div className="w-8 h-8 bg-slate-800 rounded-md" />
        </div>

        {/* Style toggle stub (Gadekort / Luftfoto / Lag) */}
        <div className="absolute bottom-8 left-4 flex gap-2">
          <div className="h-8 w-24 bg-slate-800 rounded-xl" />
          <div className="h-8 w-24 bg-slate-800 rounded-xl" />
          <div className="h-8 w-16 bg-slate-800 rounded-xl" />
        </div>

        {/* Zoom badge stub */}
        <div className="absolute bottom-8 right-4 h-6 w-16 bg-slate-800 rounded-md" />
      </div>
    </div>
  );
}
