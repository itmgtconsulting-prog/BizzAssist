'use client';

/**
 * Integrations Settings Page — BIZZ-47
 *
 * Allows users to connect/disconnect third-party integrations:
 * - Gmail (send outreach emails from BizzAssist)
 * - LinkedIn (planned — BIZZ-48)
 *
 * OAuth flow: clicking "Connect" redirects to /api/integrations/gmail/auth
 * which redirects to Google's consent screen.
 */

import { useEffect, useState, useCallback, Suspense } from 'react';
import { Mail, Linkedin, CheckCircle, AlertCircle, Loader2, ExternalLink } from 'lucide-react';
import { useSearchParams } from 'next/navigation';

/** Connection status returned by GET /api/integrations/gmail */
interface GmailStatus {
  connected: boolean;
  email?: string;
  connectedAt?: string;
}

/**
 * IntegrationsContent — inner component that reads search params and manages
 * Gmail connection state.
 *
 * Separated from the outer page component so it can be wrapped in Suspense
 * (required by useSearchParams in Next.js App Router).
 */
function IntegrationsContent() {
  const searchParams = useSearchParams();
  const [gmailStatus, setGmailStatus] = useState<GmailStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);

  const toast = searchParams.get('gmail');
  const toastEmail = searchParams.get('email');

  /**
   * Fetches Gmail connection status from the API.
   * Called on mount and after connect/disconnect actions.
   */
  const fetchGmailStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/integrations/gmail');
      if (res.ok) setGmailStatus((await res.json()) as GmailStatus);
    } catch {
      // ignore — show "not connected" as fallback
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch status on mount
  useEffect(() => {
    void fetchGmailStatus();
  }, [fetchGmailStatus]);

  /**
   * Disconnects Gmail by calling DELETE /api/integrations/gmail.
   * Updates local state optimistically on success.
   */
  const disconnectGmail = async () => {
    setDisconnecting(true);
    try {
      await fetch('/api/integrations/gmail', { method: 'DELETE' });
      setGmailStatus({ connected: false });
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Integrationer</h1>
        <p className="text-slate-400 text-sm">Forbind tredjeparts-tjenester til BizzAssist</p>
      </div>

      {/* Toast */}
      {toast === 'connected' && (
        <div className="flex items-center gap-2 p-3 bg-emerald-900/50 border border-emerald-700 rounded-lg text-emerald-300 text-sm">
          <CheckCircle className="w-4 h-4 shrink-0" />
          Gmail forbundet ({toastEmail})
        </div>
      )}
      {toast === 'error' && (
        <div className="flex items-center gap-2 p-3 bg-red-900/50 border border-red-700 rounded-lg text-red-300 text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" />
          Gmail-forbindelsen fejlede. Prøv igen.
        </div>
      )}

      {/* Gmail Card */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-red-600/20 flex items-center justify-center">
              <Mail className="w-5 h-5 text-red-400" />
            </div>
            <div>
              <h3 className="font-semibold text-white">Gmail</h3>
              <p className="text-sm text-slate-400 mt-0.5">
                Send outreach-emails direkte fra BizzAssist
              </p>
            </div>
          </div>
          {loading ? (
            <Loader2 className="w-5 h-5 text-slate-400 animate-spin mt-0.5" />
          ) : gmailStatus?.connected ? (
            <span className="flex items-center gap-1.5 text-xs text-emerald-400 bg-emerald-900/30 px-2.5 py-1 rounded-full border border-emerald-800">
              <CheckCircle className="w-3 h-3" /> Forbundet
            </span>
          ) : (
            <span className="text-xs text-slate-500">Ikke forbundet</span>
          )}
        </div>

        {gmailStatus?.connected && (
          <div className="mt-4 pt-4 border-t border-slate-700">
            <p className="text-sm text-slate-300">
              Forbundet som <span className="font-medium text-white">{gmailStatus.email}</span>
            </p>
            {gmailStatus.connectedAt && (
              <p className="text-xs text-slate-500 mt-1">
                Tilsluttet {new Date(gmailStatus.connectedAt).toLocaleDateString('da-DK')}
              </p>
            )}
          </div>
        )}

        <div className="mt-4 flex gap-2">
          {!gmailStatus?.connected ? (
            <a
              href="/api/integrations/gmail/auth"
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
            >
              Forbind Gmail
            </a>
          ) : (
            <button
              type="button"
              onClick={() => void disconnectGmail()}
              disabled={disconnecting}
              aria-label="Afbryd Gmail-forbindelse"
              className="px-4 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-700 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            >
              {disconnecting ? 'Afbryder...' : 'Afbryd forbindelse'}
            </button>
          )}
        </div>
      </div>

      {/* LinkedIn Card — Coming Soon */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 p-5 opacity-60">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-600/20 flex items-center justify-center">
              <Linkedin className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <h3 className="font-semibold text-white">LinkedIn</h3>
              <p className="text-sm text-slate-400 mt-0.5">
                Berig person-profiler med LinkedIn-data
              </p>
            </div>
          </div>
          <span className="text-xs text-slate-500 bg-slate-700 px-2.5 py-1 rounded-full">
            Kommer snart
          </span>
        </div>
        <div className="mt-4 flex gap-2">
          <a
            href="https://developer.linkedin.com/product-catalog"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-white transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            LinkedIn Developer Portal
          </a>
        </div>
      </div>
    </div>
  );
}

/**
 * IntegrationsPage — settings page for managing external integrations.
 * Wrapped in Suspense to satisfy Next.js App Router requirements for
 * useSearchParams used inside IntegrationsContent.
 *
 * @returns React element with integration management UI
 */
export default function IntegrationsPage() {
  return (
    <Suspense
      fallback={
        <div className="p-6 flex items-center gap-2 text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin" />
          Indlæser integrationer...
        </div>
      }
    >
      <IntegrationsContent />
    </Suspense>
  );
}
