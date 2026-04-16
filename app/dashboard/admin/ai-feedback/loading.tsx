/**
 * Loading skeleton for this admin page.
 * Shown by Next.js App Router during server component data fetching.
 */
export default function Loading() {
  return (
    <div className="p-6 space-y-6 animate-pulse">
      <div className="h-6 w-64 bg-slate-800 rounded-lg" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white/5 border border-white/8 rounded-2xl p-5 h-28" />
        <div className="bg-white/5 border border-white/8 rounded-2xl p-5 h-28" />
        <div className="bg-white/5 border border-white/8 rounded-2xl p-5 h-28" />
      </div>
      <div className="bg-white/5 border border-white/8 rounded-2xl p-6 h-64" />
    </div>
  );
}
