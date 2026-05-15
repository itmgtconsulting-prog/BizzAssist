/**
 * Loading skeleton for analyse-detail side.
 *
 * @returns Skeleton UI
 */
export default function AnalyseDetailLoading() {
  return (
    <div className="max-w-5xl mx-auto p-6 space-y-4 animate-pulse">
      <div className="h-8 w-64 bg-slate-800 rounded" />
      <div className="grid grid-cols-4 gap-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-20 bg-slate-800/50 rounded-xl" />
        ))}
      </div>
      <div className="h-64 bg-slate-800/30 rounded-2xl" />
    </div>
  );
}
