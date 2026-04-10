import { Loader2 } from 'lucide-react';

/**
 * Reusable skeleton loading state for data sections within detail pages.
 *
 * Renders an animated skeleton with a spinner and "Henter data…" label,
 * giving users clear feedback that a section is actively fetching data.
 *
 * @param label   - Loading message shown next to the spinner (default: 'Henter data…')
 * @param rows    - Number of skeleton placeholder rows (default: 3)
 * @param compact - When true, renders an inline spinner + label without the skeleton rows
 */
export default function SektionLoader({
  label = 'Henter data…',
  rows = 3,
  compact = false,
}: {
  label?: string;
  rows?: number;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div className="flex items-center gap-2 py-3">
        <Loader2 size={14} className="text-blue-400 animate-spin flex-shrink-0" />
        <span className="text-slate-400 text-sm">{label}</span>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-700/30 bg-slate-800/20 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Loader2 size={14} className="text-blue-400 animate-spin flex-shrink-0" />
        <span className="text-slate-400 text-sm">{label}</span>
      </div>
      <div className="space-y-2 animate-pulse">
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="h-3 bg-slate-700/40 rounded"
            style={{ width: `${60 + (i % 3) * 15}%` }}
          />
        ))}
      </div>
    </div>
  );
}
