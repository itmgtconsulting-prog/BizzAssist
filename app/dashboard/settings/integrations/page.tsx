'use client';

/**
 * Integrations Settings Page — BIZZ-47 / BIZZ-48
 *
 * Allows users to connect/disconnect third-party integrations:
 * - Gmail (send outreach emails from BizzAssist)
 * - LinkedIn (connect account; profile enrichment requires Partner Program)
 *
 * OAuth flow for each provider:
 *   Clicking "Forbind" redirects to /api/integrations/{provider}/auth
 *   which redirects to the provider's consent screen.
 *   On return, ?{provider}=connected or ?{provider}=error is set in the URL.
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

/** Connection status returned by GET /api/integrations/linkedin */
interface LinkedInStatus {
  connected: boolean;
  name?: string;
  email?: string;
  connectedAt?: string;
  /** ISO timestamp when the 60-day LinkedIn token expires */
  expiresAt?: string;
}

/**
 * IntegrationsContent — inner component that reads search params and manages
 * Gmail and LinkedIn connection state.
 *
 * Separated from the outer page component so it can be wrapped in Suspense
 * (required by useSearchParams in Next.js App Router).
 */
function IntegrationsContent() {
  const searchParams = useSearchParams();

  const [gmailStatus, setGmailStatus] = useState<GmailStatus | null>(null);
  const [linkedInStatus, setLinkedInStatus] = useState<LinkedInStatus | null>(null);
  const [loadingGmail, setLoadingGmail] = useState(true);
  const [loadingLinkedIn, setLoadingLinkedIn] = useState(true);
  const [disconnectingGmail, setDisconnectingGmail] = useState(false);
  const [disconnectingLinkedIn, setDisconnectingLinkedIn] = useState(false);

  const gmailToast = searchParams.get('gmail');
  const gmailToastEmail = searchParams.get('email');
  const linkedInToast = searchParams.get('linkedin');
  const linkedInToastName = searchParams.get('name');

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
      setLoadingGmail(false);
    }
  }, []);

  /**
   * Fetches LinkedIn connection status from the API.
   * Called on mount and after connect/disconnect actions.
   */
  const fetchLinkedInStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/integrations/linkedin');
      if (res.ok) setLinkedInStatus((await res.json()) as LinkedInStatus);
    } catch {
      // ignore — show "not connected" as fallback
    } finally {
      setLoadingLinkedIn(false);
    }
  }, []);

  // Fetch both statuses on mount
  useEffect(() => {
    void fetchGmailStatus();
    void fetchLinkedInStatus();
  }, [fetchGmailStatus, fetchLinkedInStatus]);

  /**
   * Disconnects Gmail by calling DELETE /api/integrations/gmail.
   * Updates local state optimistically on success.
   */
  const disconnectGmail = async () => {
    setDisconnectingGmail(true);
    try {
      await fetch('/api/integrations/gmail', { method: 'DELETE' });
      setGmailStatus({ connected: false });
    } finally {
      setDisconnectingGmail(false);
    }
  };

  /**
   * Disconnects LinkedIn by calling DELETE /api/integrations/linkedin.
   * Updates local state optimistically on success.
   */
  const disconnectLinkedIn = async () => {
    setDisconnectingLinkedIn(true);
    try {
      await fetch('/api/integrations/linkedin', { method: 'DELETE' });
      setLinkedInStatus({ connected: false });
    } finally {
      setDisconnectingLinkedIn(false);
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Integrationer</h1>
        <p className="text-slate-400 text-sm">Forbind tredjeparts-tjenester til BizzAssist</p>
      </div>

      {/* Gmail toast notifications */}
      {gmailToast === 'connected' && (
        <div className="flex items-center gap-2 p-3 bg-emerald-900/50 border border-emerald-700 rounded-lg text-emerald-300 text-sm">
          <CheckCircle className="w-4 h-4 shrink-0" />
          Gmail forbundet ({gmailToastEmail})
        </div>
      )}
      {gmailToast === 'error' && (
        <div className="flex items-center gap-2 p-3 bg-red-900/50 border border-red-700 rounded-lg text-red-300 text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" />
          Gmail-forbindelsen fejlede. Prøv igen.
        </div>
      )}

      {/* LinkedIn toast notifications */}
      {linkedInToast === 'connected' && (
        <div className="flex items-center gap-2 p-3 bg-emerald-900/50 border border-emerald-700 rounded-lg text-emerald-300 text-sm">
          <CheckCircle className="w-4 h-4 shrink-0" />
          LinkedIn forbundet{linkedInToastName ? ` som ${linkedInToastName}` : ''}.
        </div>
      )}
      {linkedInToast === 'error' && (
        <div className="flex items-center gap-2 p-3 bg-red-900/50 border border-red-700 rounded-lg text-red-300 text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" />
          LinkedIn-forbindelsen fejlede. Prøv igen.
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
          {loadingGmail ? (
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
              disabled={disconnectingGmail}
              aria-label="Afbryd Gmail-forbindelse"
              className="px-4 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-700 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            >
              {disconnectingGmail ? 'Afbryder...' : 'Afbryd forbindelse'}
            </button>
          )}
        </div>
      </div>

      {/* LinkedIn Card */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 p-5">
        <div className="flex items-start justify-between gap-4">
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
          {loadingLinkedIn ? (
            <Loader2 className="w-5 h-5 text-slate-400 animate-spin mt-0.5" />
          ) : linkedInStatus?.connected ? (
            <span className="flex items-center gap-1.5 text-xs text-emerald-400 bg-emerald-900/30 px-2.5 py-1 rounded-full border border-emerald-800">
              <CheckCircle className="w-3 h-3" /> Forbundet
            </span>
          ) : (
            <span className="text-xs text-slate-500">Ikke forbundet</span>
          )}
        </div>

        {linkedInStatus?.connected && (
          <div className="mt-4 pt-4 border-t border-slate-700">
            {linkedInStatus.name && (
              <p className="text-sm text-slate-300">
                Forbundet som <span className="font-medium text-white">{linkedInStatus.name}</span>
              </p>
            )}
            {linkedInStatus.email && !linkedInStatus.email.startsWith('linkedin:') && (
              <p className="text-xs text-slate-400 mt-0.5">{linkedInStatus.email}</p>
            )}
            {linkedInStatus.connectedAt && (
              <p className="text-xs text-slate-500 mt-1">
                Tilsluttet {new Date(linkedInStatus.connectedAt).toLocaleDateString('da-DK')}
              </p>
            )}
            {linkedInStatus.expiresAt && (
              <p className="text-xs text-slate-500 mt-0.5">
                Token udløber {new Date(linkedInStatus.expiresAt).toLocaleDateString('da-DK')}{' '}
                (LinkedIn tokens varer 60 dage)
              </p>
            )}
          </div>
        )}

        {/* Partner Program limitation notice */}
        <div className="mt-4 p-3 bg-amber-900/20 border border-amber-800/50 rounded-lg">
          <p className="text-xs text-amber-300">
            Profil-berigelse kræver LinkedIn Partner Program adgang. Forbind din konto nu — manuel
            søgning via LinkedIn er tilgængelig med det samme.
          </p>
          <a
            href="https://developer.linkedin.com/partner-programs/search"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-amber-400 hover:text-amber-300 transition-colors mt-1.5"
          >
            <ExternalLink className="w-3 h-3" />
            Ansøg om LinkedIn Partner Program
          </a>
        </div>

        <div className="mt-4 flex gap-2">
          {!linkedInStatus?.connected ? (
            <a
              href="/api/integrations/linkedin/auth"
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
            >
              Forbind LinkedIn
            </a>
          ) : (
            <button
              type="button"
              onClick={() => void disconnectLinkedIn()}
              disabled={disconnectingLinkedIn}
              aria-label="Afbryd LinkedIn-forbindelse"
              className="px-4 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-700 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            >
              {disconnectingLinkedIn ? 'Afbryder...' : 'Afbryd forbindelse'}
            </button>
          )}
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
