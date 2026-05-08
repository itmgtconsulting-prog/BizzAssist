/**
 * Loading skeleton for forsikrings-gap-analyse.
 */
export default function ForsikringGapLoading() {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 animate-pulse">
      <div>
        <div className="h-7 w-72 bg-slate-700/40 rounded-lg" />
        <div className="h-4 w-96 bg-slate-700/20 rounded-lg mt-2" />
      </div>
      <div className="bg-white/5 border border-white/8 rounded-2xl p-8">
        <div className="h-5 w-48 bg-slate-700/30 rounded mb-6" />
        <div className="space-y-4">
          <div className="h-10 bg-slate-700/20 rounded-lg" />
          <div className="h-10 bg-slate-700/20 rounded-lg" />
          <div className="h-32 bg-slate-700/15 rounded-lg" />
        </div>
      </div>
    </div>
  );
}
