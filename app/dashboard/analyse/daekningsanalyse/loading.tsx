/**
 * Loading skeleton for dækningsanalyse-modul.
 *
 * @module app/dashboard/analyse/daekningsanalyse/loading
 */

export default function DaekningsanalyseLoading() {
  return (
    <div className="p-6 space-y-6 animate-pulse">
      <div className="h-8 w-64 bg-white/5 rounded-lg" />
      <div className="h-4 w-96 bg-white/5 rounded" />
      <div className="h-64 bg-white/5 rounded-xl" />
      <div className="h-96 bg-white/5 rounded-xl" />
    </div>
  );
}
