/**
 * Loading skeleton for /dashboard/forsikring/[id].
 */
export default function ForsikringDetailLoading() {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 animate-pulse">
      <div className="h-4 w-32 bg-slate-700/30 rounded" />
      <div className="space-y-2">
        <div className="h-8 w-72 bg-slate-800 rounded-lg" />
        <div className="h-4 w-96 bg-slate-800/60 rounded" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-white/5 border border-white/8 rounded-2xl p-5 h-32" />
        ))}
      </div>
      <div className="bg-white/5 border border-white/8 rounded-2xl h-64" />
    </div>
  );
}
