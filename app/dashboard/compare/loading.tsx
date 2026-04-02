/**
 * Compare page loading skeleton.
 */
export default function CompareLoading() {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 animate-pulse">
      <div>
        <div className="h-7 w-52 bg-slate-700/40 rounded-lg" />
        <div className="h-4 w-80 bg-slate-700/20 rounded-lg mt-2 ml-8" />
      </div>
      <div className="h-10 w-96 bg-slate-700/20 rounded-xl" />
      <div className="bg-white/5 border border-white/8 rounded-2xl h-96" />
    </div>
  );
}
