/**
 * Loading skeleton for /dashboard/analyse/intelligence.
 */
export default function Loading(): React.ReactElement {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="h-8 w-64 bg-slate-800 rounded animate-pulse mb-2" />
        <div className="h-4 w-96 bg-slate-800/70 rounded animate-pulse mb-8" />
        <div className="h-12 w-full bg-slate-800 rounded animate-pulse mb-6" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <div key={i} className="h-10 bg-slate-800/50 rounded animate-pulse" />
          ))}
        </div>
      </div>
    </div>
  );
}
