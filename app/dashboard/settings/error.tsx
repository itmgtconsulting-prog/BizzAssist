'use client';

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';

/**
 * Route-level error boundary — catches unhandled errors in this dashboard segment.
 * Renders a minimal recovery UI so users can retry without a full page reload.
 *
 * @param error - The error that was thrown, optionally with a server digest
 * @param reset - Callback to re-render the erroring segment
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Log to browser console so errors are visible during development
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[300px] gap-4 text-center px-4">
      <AlertTriangle size={32} className="text-amber-400" />
      <p className="text-slate-300 text-sm">Noget gik galt. Prøv igen.</p>
      <button
        onClick={reset}
        className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm rounded-lg transition-colors"
      >
        Prøv igen
      </button>
    </div>
  );
}
