/**
 * Loading skeleton for /dashboard/admin/service-management.
 * Shown by Next.js App Router while the page component hydrates.
 */
export default function ServiceManagementLoading() {
  return (
    <div className="min-h-screen bg-[#0a1020] p-8 animate-pulse">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Back link */}
        <div className="h-4 w-28 bg-slate-700/30 rounded" />

        {/* Header */}
        <div className="h-7 w-64 bg-slate-800 rounded-lg" />
        <div className="h-4 w-40 bg-slate-700/30 rounded" />

        {/* Cards grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mt-4">
          {Array.from({ length: 10 }).map((_, i) => (
            <div
              key={i}
              className="bg-[#0f172a] border border-slate-700/50 rounded-xl p-5 space-y-3"
            >
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-slate-800" />
                <div className="space-y-1.5">
                  <div className="h-4 w-28 bg-slate-700/40 rounded" />
                  <div className="h-3 w-20 bg-slate-700/20 rounded" />
                </div>
              </div>
              <div className="h-4 w-24 bg-slate-700/30 rounded" />
              <div className="h-3 w-full bg-slate-700/20 rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
