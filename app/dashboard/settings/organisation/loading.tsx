/**
 * Loading skeleton for this settings page.
 * Shown by Next.js App Router during server component data fetching.
 */
export default function Loading() {
  return (
    <div className="p-6 space-y-6 animate-pulse">
      <div className="h-6 w-56 bg-slate-800 rounded-lg" />
      <div className="bg-white/5 border border-white/8 rounded-2xl p-6 space-y-4 max-w-2xl">
        <div className="h-5 w-48 bg-slate-700/40 rounded" />
        <div className="h-4 w-80 bg-slate-700/20 rounded" />
        <div className="h-10 w-full bg-slate-700/30 rounded-xl" />
        <div className="h-10 w-full bg-slate-700/30 rounded-xl" />
        <div className="h-10 w-40 bg-slate-700/30 rounded-xl" />
      </div>
    </div>
  );
}
