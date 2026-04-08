/**
 * Loading skeleton for /dashboard/chat.
 *
 * Shown by Next.js while the chat page hydrates. Mirrors the two-column
 * layout (history sidebar + message area) so there is no layout shift.
 */
export default function ChatLoading() {
  return (
    <div className="flex-1 flex overflow-hidden bg-[#0a1020] animate-pulse">
      {/* Sidebar skeleton */}
      <aside className="w-64 shrink-0 flex flex-col border-r border-white/8 bg-[#0f172a] p-4 gap-3">
        <div className="h-6 w-24 bg-slate-800 rounded-md" />
        <div className="h-9 w-full bg-slate-800 rounded-lg" />
        <div className="mt-2 space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-7 bg-slate-800/60 rounded-md" />
          ))}
        </div>
      </aside>

      {/* Main area skeleton */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 px-6 py-8 space-y-4">
          {/* Empty state placeholder */}
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <div className="w-14 h-14 bg-slate-800 rounded-2xl" />
            <div className="h-5 w-48 bg-slate-800 rounded-md" />
            <div className="h-3 w-64 bg-slate-800/70 rounded-md" />
          </div>
        </div>
        {/* Input bar skeleton */}
        <div className="shrink-0 border-t border-white/8 bg-[#0f172a] px-4 py-3">
          <div className="flex items-end gap-2 max-w-4xl mx-auto">
            <div className="flex-1 h-12 bg-slate-800 rounded-xl" />
            <div className="w-11 h-11 bg-slate-800 rounded-xl" />
          </div>
        </div>
      </div>
    </div>
  );
}
