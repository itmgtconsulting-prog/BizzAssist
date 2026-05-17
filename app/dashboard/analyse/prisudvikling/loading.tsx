/**
 * Loading skeleton for prisudvikling dashboard.
 *
 * @module app/dashboard/analyse/prisudvikling/loading
 */
export default function Loading() {
  return (
    <div className="min-h-screen bg-slate-950 p-8 animate-pulse">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="h-8 w-64 bg-slate-800 rounded" />
        <div className="h-4 w-96 bg-slate-800/50 rounded" />
        <div className="flex gap-3">
          <div className="h-10 flex-1 bg-slate-800 rounded-lg" />
          <div className="h-10 w-24 bg-slate-800 rounded-lg" />
        </div>
        <div className="h-80 bg-slate-900 rounded-lg border border-slate-800" />
        <div className="h-48 bg-slate-900 rounded-lg border border-slate-800" />
      </div>
    </div>
  );
}
