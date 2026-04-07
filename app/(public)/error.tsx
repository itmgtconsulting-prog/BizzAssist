'use client';
import { useEffect } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

/**
 * Public route group error boundary — catches unhandled errors in the public UI tree.
 * Renders a recovery UI instead of crashing the entire page.
 *
 * @param error - The error that was thrown
 * @param reset - Callback to attempt re-rendering the segment
 */
export default function PublicError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[Public] Unhandled error:', error);
  }, [error]);

  return (
    <div className="flex flex-1 items-center justify-center min-h-[400px] p-8">
      <div className="max-w-md w-full bg-[#1e293b] border border-red-500/20 rounded-2xl p-8 text-center shadow-2xl">
        <div className="w-12 h-12 bg-red-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
          <AlertCircle size={24} className="text-red-400" />
        </div>
        <h2 className="text-white text-xl font-semibold mb-2">Noget gik galt</h2>
        <p className="text-slate-400 text-sm mb-6">
          Der opstod en uventet fejl. Prøv at genindlæse siden.
          {error.digest && (
            <span className="block mt-2 font-mono text-xs text-slate-600">
              Fejlkode: {error.digest}
            </span>
          )}
        </p>
        <button
          onClick={reset}
          className="flex items-center gap-2 mx-auto bg-blue-600 hover:bg-blue-500 text-white font-medium px-5 py-2.5 rounded-xl transition-colors"
        >
          <RefreshCw size={15} />
          Prøv igen
        </button>
      </div>
    </div>
  );
}
