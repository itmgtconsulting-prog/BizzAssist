/**
 * Loading skeleton for Virksomhedshandler-siden.
 *
 * @module app/dashboard/virksomhedshandler/loading
 */

export default function VirksomhedshandlerLoading() {
  return (
    <div className="p-6 space-y-4 animate-pulse">
      <div className="h-8 w-64 bg-slate-700/40 rounded" />
      <div className="h-4 w-96 bg-slate-700/30 rounded" />
      <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-8">
        <div className="h-64 bg-slate-700/20 rounded" />
      </div>
    </div>
  );
}
