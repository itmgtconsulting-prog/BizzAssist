/**
 * Loading skeleton for /dashboard/analyse routes.
 */
export default function AnalyseLoading() {
  return (
    <div className="flex-1 bg-[#0a1628] p-8 animate-pulse">
      <div className="h-7 bg-slate-700/40 rounded w-40 mb-4" />
      <div className="h-4 bg-slate-700/30 rounded w-80 mb-8" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-3xl">
        <div className="h-48 bg-slate-800/40 rounded-2xl" />
        <div className="h-48 bg-slate-800/40 rounded-2xl" />
      </div>
    </div>
  );
}
