/**
 * Loading skeleton for the security settings page (/dashboard/settings/security).
 * Mirrors the 2FA card layout (status badge + QR / action button area).
 * Shown by Next.js App Router during server component data fetching.
 */
export default function SecuritySettingsLoading() {
  return (
    <div className="p-6 space-y-6 animate-pulse">
      {/* Page title */}
      <div className="h-6 w-56 bg-slate-800 rounded-lg" />

      {/* 2FA status card */}
      <div className="bg-white/5 border border-white/8 rounded-2xl p-6 space-y-5 max-w-lg">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-slate-700/40" />
          <div className="space-y-1.5">
            <div className="h-5 w-52 bg-slate-700/40 rounded" />
            <div className="h-3 w-72 bg-slate-700/20 rounded" />
          </div>
        </div>

        {/* Status badge */}
        <div className="h-6 w-28 bg-slate-700/30 rounded-full" />

        {/* Action button placeholder */}
        <div className="h-10 w-40 bg-slate-700/30 rounded-xl" />
      </div>
    </div>
  );
}
