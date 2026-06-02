/**
 * Loading skeleton for /dashboard/analyse/virksomhedshandler.
 *
 * BIZZ-1929: Matches dark theme skeleton pattern.
 */
export default function VirksomhedshandlerLoading() {
  return (
    <div className="flex-1 bg-[#0a1628] p-6 animate-pulse space-y-6">
      <div className="h-7 bg-slate-700/40 rounded w-64" />
      <div className="h-4 bg-slate-700/30 rounded w-96" />
      <div className="h-12 bg-slate-800/40 rounded-xl w-full" />
      <div className="flex gap-3">
        <div className="h-10 bg-slate-800/40 rounded-lg w-32" />
        <div className="h-10 bg-slate-800/40 rounded-lg w-32" />
        <div className="h-10 bg-slate-800/40 rounded-lg w-32" />
        <div className="h-10 bg-slate-800/40 rounded-lg w-40" />
      </div>
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-12 bg-slate-800/40 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
