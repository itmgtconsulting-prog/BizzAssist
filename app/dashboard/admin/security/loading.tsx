/**
 * Loading skeleton for admin security settings (/dashboard/admin/security).
 * Mirrors the session timeout configuration form card layout.
 * Shown by Next.js App Router during server component data fetching.
 */
export default function AdminSecurityLoading() {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 animate-pulse">
      {/* Back link + heading */}
      <div className="h-4 w-24 bg-slate-700/20 rounded" />
      <div className="h-8 w-56 bg-slate-800 rounded-lg" />

      {/* Settings form card */}
      <div className="bg-white/5 border border-white/8 rounded-2xl p-6 space-y-6 max-w-lg">
        <div className="h-5 w-44 bg-slate-700/40 rounded" />

        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="space-y-2">
            <div className="h-4 w-48 bg-slate-700/30 rounded" />
            <div className="h-3 w-64 bg-slate-700/15 rounded" />
            <div className="h-10 w-full bg-slate-700/25 rounded-xl" />
          </div>
        ))}

        <div className="flex justify-end pt-2">
          <div className="h-9 w-28 bg-slate-700/30 rounded-xl" />
        </div>
      </div>
    </div>
  );
}
